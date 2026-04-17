from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import io
import logging
import random
import string
import uuid
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import datetime, timezone

from emergentintegrations.llm.openai import OpenAISpeechToText
from emergentintegrations.llm.chat import LlmChat, UserMessage


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

EMERGENT_LLM_KEY = os.environ["EMERGENT_LLM_KEY"]

app = FastAPI()
api_router = APIRouter(prefix="/api")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# ---------------- Models ----------------

class Session(BaseModel):
    id: str
    code: str
    created_at: datetime


class Phrase(BaseModel):
    id: str
    session_id: str
    pt_text: str
    it_text: str
    created_at: datetime


class PhrasesResponse(BaseModel):
    phrases: List[Phrase]


class TranscribeResponse(BaseModel):
    phrase: Optional[Phrase] = None
    skipped: bool = False
    reason: Optional[str] = None


# ---------------- Helpers ----------------

def generate_code(length: int = 6) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(random.choices(alphabet, k=length))


async def translate_pt_to_it(text: str) -> str:
    if not text.strip():
        return ""
    system_message = (
        "You are a professional real-time conference interpreter. "
        "Translate the user's Portuguese text into natural, fluent Italian. "
        "Output ONLY the Italian translation, without any explanation, quotes, or prefix. "
        "Preserve punctuation and meaning. If the input is gibberish or silence, return an empty string."
    )
    chat = (
        LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"translator-{uuid.uuid4()}",
            system_message=system_message,
        )
        .with_model("openai", "gpt-4o-mini")
    )
    msg = UserMessage(text=text)
    response = await chat.send_message(msg)
    return (response or "").strip()


# ---------------- Routes ----------------

@api_router.get("/")
async def root():
    return {"message": "Realtime PT->IT Translator API"}


@api_router.post("/sessions", response_model=Session)
async def create_session():
    # Generate a unique short code
    for _ in range(8):
        code = generate_code(6)
        existing = await db.sessions.find_one({"code": code})
        if not existing:
            break
    else:
        raise HTTPException(status_code=500, detail="Could not allocate session code")

    session = Session(
        id=str(uuid.uuid4()),
        code=code,
        created_at=datetime.now(timezone.utc),
    )
    await db.sessions.insert_one(session.model_dump())
    return session


@api_router.get("/sessions/{code}", response_model=Session)
async def get_session(code: str):
    doc = await db.sessions.find_one({"code": code.upper()}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Session not found")
    return Session(**doc)


@api_router.post("/sessions/{code}/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(code: str, audio: UploadFile = File(...)):
    session_doc = await db.sessions.find_one({"code": code.upper()}, {"_id": 0})
    if not session_doc:
        raise HTTPException(status_code=404, detail="Session not found")

    audio_bytes = await audio.read()
    if not audio_bytes or len(audio_bytes) < 2000:
        return TranscribeResponse(skipped=True, reason="Audio too short")

    # Determine filename with extension for Whisper
    filename = audio.filename or "audio.webm"
    if "." not in filename:
        filename = "audio.webm"

    try:
        stt = OpenAISpeechToText(api_key=EMERGENT_LLM_KEY)
        file_like = io.BytesIO(audio_bytes)
        file_like.name = filename
        stt_response = await stt.transcribe(
            file=file_like,
            model="whisper-1",
            response_format="json",
            language="pt",
            temperature=0.0,
        )
        pt_text = (getattr(stt_response, "text", "") or "").strip()
    except Exception as e:
        logger.exception("Whisper transcription failed")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")

    if not pt_text or len(pt_text) < 2:
        return TranscribeResponse(skipped=True, reason="Empty transcription")

    # Filter out common Whisper hallucinations on silence
    lowered = pt_text.lower().strip(" .!?,")
    noise_patterns = {"obrigado", "obrigada", "muito obrigado", "muito obrigada",
                      "legendas pela comunidade", "subtitles by the community"}
    if lowered in noise_patterns and len(pt_text) < 30:
        return TranscribeResponse(skipped=True, reason="Noise phrase filtered")

    try:
        it_text = await translate_pt_to_it(pt_text)
    except Exception as e:
        logger.exception("Translation failed")
        raise HTTPException(status_code=500, detail=f"Translation failed: {e}")

    if not it_text:
        return TranscribeResponse(skipped=True, reason="Empty translation")

    phrase = Phrase(
        id=str(uuid.uuid4()),
        session_id=session_doc["id"],
        pt_text=pt_text,
        it_text=it_text,
        created_at=datetime.now(timezone.utc),
    )
    await db.phrases.insert_one(phrase.model_dump())
    return TranscribeResponse(phrase=phrase, skipped=False)


@api_router.get("/sessions/{code}/phrases", response_model=PhrasesResponse)
async def get_phrases(code: str, since_iso: Optional[str] = None, limit: int = 100):
    session_doc = await db.sessions.find_one({"code": code.upper()}, {"_id": 0})
    if not session_doc:
        raise HTTPException(status_code=404, detail="Session not found")

    query = {"session_id": session_doc["id"]}
    if since_iso:
        try:
            since_dt = datetime.fromisoformat(since_iso.replace("Z", "+00:00"))
            query["created_at"] = {"$gt": since_dt}
        except Exception:
            pass

    cursor = db.phrases.find(query, {"_id": 0}).sort("created_at", 1).limit(limit)
    docs = await cursor.to_list(length=limit)
    phrases = [Phrase(**d) for d in docs]
    return PhrasesResponse(phrases=phrases)


@api_router.post("/sessions/{code}/clear")
async def clear_session(code: str):
    session_doc = await db.sessions.find_one({"code": code.upper()}, {"_id": 0})
    if not session_doc:
        raise HTTPException(status_code=404, detail="Session not found")
    result = await db.phrases.delete_many({"session_id": session_doc["id"]})
    return {"deleted": result.deleted_count}


# Include router and middleware
app.include_router(api_router)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
