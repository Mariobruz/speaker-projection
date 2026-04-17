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
GROQ_CHAT_MODEL = os.environ.get("GROQ_CHAT_MODEL", "llama-3.1-8b-instant")
GROQ_BASE = "https://api.groq.com/openai/v1"

# Per-session cache of detected source language to skip verbose_json after first chunk
_SESSION_LANG_CACHE: Dict[str, str] = {}

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
    speaker_name: str = ""
    logo_base64: str = ""
    created_at: datetime


class SessionUpdate(BaseModel):
    speaker_name: Optional[str] = None
    logo_base64: Optional[str] = None


class Phrase(BaseModel):
    id: str
    session_id: str
    pt_text: str
    it_text: str
    source_lang: str = "pt"
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
    return await translate_to_lang(text, "pt", "it")


async def translate_pt_to_lang(text: str, target_lang: str) -> str:
    return await translate_to_lang(text, "pt", target_lang)


async def translate_to_lang(text: str, source_lang: str, target_lang: str) -> str:
    if not text.strip():
        return ""
    source_lang = (source_lang or "pt").lower()
    target_lang = (target_lang or "it").lower()
    if source_lang == target_lang:
        return text.strip()
    source_name = SUPPORTED_LANGS.get(source_lang, "Portuguese")
    target_name = SUPPORTED_LANGS.get(target_lang, "Italian")
    system_message = (
        "You are a professional real-time conference interpreter. "
        f"Translate the user's {source_name} text into natural, fluent {target_name}. "
        f"Output ONLY the {target_name} translation, without any explanation, quotes, or prefix. "
        "Preserve punctuation and meaning. "
        "CRITICAL: NEVER invent, guess, or make up words. "
        "If a word is unclear, unintelligible, or missing, replace it with '...' (three dots). "
        "If the entire input is gibberish or silence, return an empty string."
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
                "temperature": 0.1,
                "top_p": 0.9,
                "max_tokens": 256,
            },
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Groq chat error {resp.status_code}: {resp.text}")
        data = resp.json()
    return (data["choices"][0]["message"]["content"] or "").strip()


async def groq_transcribe(audio_bytes: bytes, filename: str, language: Optional[str] = None) -> tuple[str, str]:
    """Transcribe audio via Groq Whisper. Returns (text, detected_language).
    If language is None, auto-detect via verbose_json response."""
    async with httpx.AsyncClient(timeout=60.0) as hc:
        files = {"file": (filename, audio_bytes, "application/octet-stream")}
        form = {
            "model": GROQ_STT_MODEL,
            "response_format": "verbose_json",
            "temperature": "0.0",
        }
        if language:
            form["language"] = language
        resp = await hc.post(
            f"{GROQ_BASE}/audio/transcriptions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            data=form,
            files=files,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Groq STT error {resp.status_code}: {resp.text}")
        data = resp.json()
    text = (data.get("text") or "").strip()
    detected = (data.get("language") or language or "pt").lower()
    # Normalize to ISO-639-1 two-letter code
    lang_map = {
        "portuguese": "pt", "italian": "it", "english": "en", "spanish": "es",
        "french": "fr", "german": "de",
    }
    detected = lang_map.get(detected, detected[:2])
    return text, detected


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
        speaker_name="",
        logo_base64="",
        created_at=datetime.now(timezone.utc),
    )
    await db.sessions.insert_one(session.model_dump())
    return session


@api_router.patch("/sessions/{code}", response_model=Session)
async def update_session(code: str, update: SessionUpdate):
    doc = await db.sessions.find_one({"code": code.upper()}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Session not found")

    updates: Dict[str, str] = {}
    if update.speaker_name is not None:
        updates["speaker_name"] = update.speaker_name.strip()[:80]
    if update.logo_base64 is not None:
        # Simple size guard: ~1.5 MB base64 max
        if len(update.logo_base64) > 2_000_000:
            raise HTTPException(status_code=413, detail="Logo too large")
        updates["logo_base64"] = update.logo_base64
    if updates:
        await db.sessions.update_one({"code": code.upper()}, {"$set": updates})
        doc.update(updates)

    # Ensure required defaults
    doc.setdefault("speaker_name", "")
    doc.setdefault("logo_base64", "")

    try:
        # Don't include logo_base64 in broadcast to keep WS light — client will re-fetch
        payload = {"type": "session_update", "speaker_name": doc.get("speaker_name", "")}
        if "logo_base64" in updates:
            payload["logo_updated"] = True
        await manager.broadcast(code.upper(), payload)
    except Exception:
        logger.exception("WS broadcast failed")

    return Session(**doc)


@api_router.get("/sessions/{code}", response_model=Session)
async def get_session(code: str):
    doc = await db.sessions.find_one({"code": code.upper()}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Session not found")
    doc.setdefault("speaker_name", "")
    doc.setdefault("logo_base64", "")
    return Session(**doc)


@api_router.post("/sessions/{code}/transcribe", response_model=TranscribeResponse)
async def transcribe_audio(code: str, audio: UploadFile = File(...)):
    session_doc = await db.sessions.find_one({"code": code.upper()}, {"_id": 0})
    if not session_doc:
        raise HTTPException(status_code=404, detail="Session not found")

    audio_bytes = await audio.read()
    if not audio_bytes or len(audio_bytes) < 1500:
        return TranscribeResponse(skipped=True, reason="Audio too short")

    # Determine filename with extension for Whisper
    filename = audio.filename or "audio.webm"
    if "." not in filename:
        filename = "audio.webm"

    cached_lang = _SESSION_LANG_CACHE.get(code.upper())
    try:
        source_text, source_lang = await groq_transcribe(audio_bytes, filename, language=cached_lang)
    except Exception as e:
        logger.exception("Groq transcription failed")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")

    if not source_text or len(source_text) < 2:
        return TranscribeResponse(skipped=True, reason="Empty transcription")

    # Filter out common Whisper hallucinations on silence
    lowered = source_text.lower().strip(" .!?,")
    noise_patterns = {"obrigado", "obrigada", "muito obrigado", "muito obrigada",
                      "legendas pela comunidade", "subtitles by the community",
                      "thank you", "thanks for watching", "grazie", "grazie mille"}
    if lowered in noise_patterns and len(source_text) < 30:
        return TranscribeResponse(skipped=True, reason="Noise phrase filtered")

    if source_lang not in SUPPORTED_LANGS:
        source_lang = "pt"

    # Cache per session for faster subsequent chunks
    _SESSION_LANG_CACHE[code.upper()] = source_lang

    try:
        it_text = await translate_to_lang(source_text, source_lang, "it")
    except Exception as e:
        logger.exception("Translation failed")
        raise HTTPException(status_code=500, detail=f"Translation failed: {e}")

    if not it_text:
        return TranscribeResponse(skipped=True, reason="Empty translation")

    translations = {source_lang: source_text, "it": it_text}
    phrase = Phrase(
        id=str(uuid.uuid4()),
        session_id=session_doc["id"],
        pt_text=source_text,
        it_text=it_text,
        source_lang=source_lang,
        translations=translations,
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
    source_lang = (phrase_doc.get("source_lang") or "pt").lower()
    # Backfill legacy phrases
    if "it" not in translations and phrase_doc.get("it_text"):
        translations["it"] = phrase_doc["it_text"]
    if source_lang not in translations and phrase_doc.get("pt_text"):
        translations[source_lang] = phrase_doc["pt_text"]

    if lang in translations and translations[lang]:
        return TranslationResponse(
            phrase_id=phrase_id, lang=lang, text=translations[lang], cached=True
        )

    try:
        src_text = translations.get(source_lang) or phrase_doc.get("pt_text") or ""
        text = await translate_to_lang(src_text, source_lang, lang)
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
