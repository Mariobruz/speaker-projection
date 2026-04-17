from fastapi import FastAPI, APIRouter, HTTPException, UploadFile, File, WebSocket, WebSocketDisconnect
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import asyncio
import httpx
import os
import io
import json
import logging
import random
import string
import uuid
from pathlib import Path
from pydantic import BaseModel, Field
from typing import Dict, List, Optional, Set
from datetime import datetime, timezone

from emergentintegrations.llm.openai import OpenAISpeechToText  # noqa: F401 (legacy)
from emergentintegrations.llm.chat import LlmChat, UserMessage  # noqa: F401 (legacy)


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")
GROQ_API_KEY = os.environ["GROQ_API_KEY"]
GROQ_STT_MODEL = os.environ.get("GROQ_STT_MODEL", "whisper-large-v3-turbo")
GROQ_CHAT_MODEL = os.environ.get("GROQ_CHAT_MODEL", "llama-3.3-70b-versatile")
GROQ_BASE = "https://api.groq.com/openai/v1"

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
    translations: Dict[str, str] = Field(default_factory=dict)
    created_at: datetime


SUPPORTED_LANGS = {
    "it": "Italian",
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "pt": "Portuguese",
}


class PhrasesResponse(BaseModel):
    phrases: List[Phrase]


class TranscribeResponse(BaseModel):
    phrase: Optional[Phrase] = None
    skipped: bool = False
    reason: Optional[str] = None


# ---------------- WebSocket Manager ----------------

class ConnectionManager:
    def __init__(self) -> None:
        self.active: Dict[str, Set[WebSocket]] = {}
        self.lock = asyncio.Lock()

    async def connect(self, code: str, ws: WebSocket) -> None:
        await ws.accept()
        async with self.lock:
            self.active.setdefault(code, set()).add(ws)

    async def disconnect(self, code: str, ws: WebSocket) -> None:
        async with self.lock:
            conns = self.active.get(code)
            if conns and ws in conns:
                conns.remove(ws)
            if conns is not None and not conns:
                self.active.pop(code, None)

    async def broadcast(self, code: str, payload: dict) -> None:
        data = json.dumps(payload, default=str)
        async with self.lock:
            conns = list(self.active.get(code, set()))
        dead: List[WebSocket] = []
        for ws in conns:
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.disconnect(code, ws)


manager = ConnectionManager()


# ---------------- Helpers ----------------

def generate_code(length: int = 6) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(random.choices(alphabet, k=length))


async def translate_pt_to_it(text: str) -> str:
    return await translate_pt_to_lang(text, "it")


async def translate_pt_to_lang(text: str, target_lang: str) -> str:
    if not text.strip():
        return ""
    lang_name = SUPPORTED_LANGS.get(target_lang, "Italian")
    if target_lang == "pt":
        return text.strip()
    system_message = (
        "You are a professional real-time conference interpreter. "
        f"Translate the user's Portuguese text into natural, fluent {lang_name}. "
        f"Output ONLY the {lang_name} translation, without any explanation, quotes, or prefix. "
        "Preserve punctuation and meaning. If the input is gibberish or silence, return an empty string."
    )
    async with httpx.AsyncClient(timeout=30.0) as hc:
        resp = await hc.post(
            f"{GROQ_BASE}/chat/completions",
            headers={
                "Authorization": f"Bearer {GROQ_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": GROQ_CHAT_MODEL,
                "messages": [
                    {"role": "system", "content": system_message},
                    {"role": "user", "content": text},
                ],
                "temperature": 0.2,
                "max_tokens": 512,
            },
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Groq chat error {resp.status_code}: {resp.text}")
        data = resp.json()
    return (data["choices"][0]["message"]["content"] or "").strip()


async def groq_transcribe(audio_bytes: bytes, filename: str) -> str:
    async with httpx.AsyncClient(timeout=60.0) as hc:
        files = {"file": (filename, audio_bytes, "application/octet-stream")}
        form = {
            "model": GROQ_STT_MODEL,
            "language": "pt",
            "response_format": "json",
            "temperature": "0.0",
        }
        resp = await hc.post(
            f"{GROQ_BASE}/audio/transcriptions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            data=form,
            files=files,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Groq STT error {resp.status_code}: {resp.text}")
        data = resp.json()
    return (data.get("text") or "").strip()


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
        pt_text = await groq_transcribe(audio_bytes, filename)
    except Exception as e:
        logger.exception("Groq transcription failed")
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
    # Broadcast to WebSocket listeners for this session
    try:
        await manager.broadcast(
            code.upper(),
            {"type": "phrase", "phrase": phrase.model_dump(mode="json")},
        )
    except Exception:
        logger.exception("WS broadcast failed")
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
    phrases = []
    for d in docs:
        # Backfill translations dict if older phrase has only it_text
        if not d.get("translations"):
            d["translations"] = {
                "it": d.get("it_text", ""),
                "pt": d.get("pt_text", ""),
            }
        phrases.append(Phrase(**d))
    return PhrasesResponse(phrases=phrases)


class TranslationResponse(BaseModel):
    phrase_id: str
    lang: str
    text: str
    cached: bool


@api_router.post("/sessions/{code}/phrases/{phrase_id}/translate", response_model=TranslationResponse)
async def translate_phrase(code: str, phrase_id: str, lang: str):
    lang = (lang or "").lower().strip()
    if lang not in SUPPORTED_LANGS:
        raise HTTPException(status_code=400, detail=f"Unsupported language: {lang}")

    session_doc = await db.sessions.find_one({"code": code.upper()}, {"_id": 0})
    if not session_doc:
        raise HTTPException(status_code=404, detail="Session not found")

    phrase_doc = await db.phrases.find_one(
        {"id": phrase_id, "session_id": session_doc["id"]}, {"_id": 0}
    )
    if not phrase_doc:
        raise HTTPException(status_code=404, detail="Phrase not found")

    translations = phrase_doc.get("translations") or {}
    # Backfill legacy phrases
    if "it" not in translations and phrase_doc.get("it_text"):
        translations["it"] = phrase_doc["it_text"]
    if "pt" not in translations and phrase_doc.get("pt_text"):
        translations["pt"] = phrase_doc["pt_text"]

    if lang in translations and translations[lang]:
        return TranslationResponse(
            phrase_id=phrase_id, lang=lang, text=translations[lang], cached=True
        )

    try:
        text = await translate_pt_to_lang(phrase_doc["pt_text"], lang)
    except Exception as e:
        logger.exception("Translation failed")
        raise HTTPException(status_code=500, detail=f"Translation failed: {e}")

    translations[lang] = text
    await db.phrases.update_one(
        {"id": phrase_id, "session_id": session_doc["id"]},
        {"$set": {"translations": translations}},
    )

    # Broadcast to WS clients so other projectors get it instantly
    try:
        await manager.broadcast(
            code.upper(),
            {"type": "translation", "phrase_id": phrase_id, "lang": lang, "text": text},
        )
    except Exception:
        logger.exception("WS broadcast failed")

    return TranslationResponse(phrase_id=phrase_id, lang=lang, text=text, cached=False)


@api_router.post("/sessions/{code}/clear")
async def clear_session(code: str):
    session_doc = await db.sessions.find_one({"code": code.upper()}, {"_id": 0})
    if not session_doc:
        raise HTTPException(status_code=404, detail="Session not found")
    result = await db.phrases.delete_many({"session_id": session_doc["id"]})
    try:
        await manager.broadcast(code.upper(), {"type": "clear"})
    except Exception:
        logger.exception("WS broadcast failed")
    return {"deleted": result.deleted_count}


@app.websocket("/api/sessions/{code}/ws")
async def session_ws(websocket: WebSocket, code: str):
    code_up = code.upper()
    session_doc = await db.sessions.find_one({"code": code_up}, {"_id": 0})
    if not session_doc:
        await websocket.close(code=1008)
        return
    await manager.connect(code_up, websocket)
    try:
        # Send a hello so the client knows it's live
        await websocket.send_text(json.dumps({"type": "hello", "code": code_up}))
        while True:
            # Keep connection alive; ignore client messages
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("WS error")
    finally:
        await manager.disconnect(code_up, websocket)


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
