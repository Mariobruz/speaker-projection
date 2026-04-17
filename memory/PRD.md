# PRD - Voce Istantanea (PT → IT Real-Time Event Translator)

## Overview
Web app for conference/event interpretation. A Portuguese speaker talks into the microphone; the app transcribes audio via OpenAI Whisper, translates to Italian via GPT, and displays the translation on a large projection screen in real time.

## User Roles
- **Speaker**: creates a session, records audio from browser mic, sees confirmation of what was transcribed/translated.
- **Projector**: opens a public projector view via session code or QR; displays huge Italian translation on the projector screen.

## Features
- Create session with short 6-char alphanumeric code
- Speaker mobile/web view with big mic button (toggle record/stop) and QR code to share
- Continuous chunked audio capture (5s chunks via MediaRecorder) sent to backend
- Whisper STT (language=pt) + GPT-4o-mini translation PT → IT
- Noise/hallucination filtering for silent chunks
- Projector view polls every 1.4s and shows latest phrase in huge type + history fading out
- Dark Swiss/High-Contrast theme optimized for projection screens

## Backend (FastAPI + MongoDB)
- POST /api/sessions - create session
- GET /api/sessions/{code} - get session
- POST /api/sessions/{code}/transcribe - upload audio chunk (multipart)
- GET /api/sessions/{code}/phrases?since_iso= - poll phrases
- POST /api/sessions/{code}/clear - clear phrases

## Integrations
- **Groq Cloud** (free tier) — OpenAI-compatible endpoints
  - STT: `whisper-large-v3-turbo` (Portuguese) via `/audio/transcriptions`
  - Translation: `llama-3.3-70b-versatile` via `/chat/completions`
- API key stored as `GROQ_API_KEY` in `/app/backend/.env`
- Legacy Emergent LLM Key kept in `.env` but no longer used by default

## Known Constraints
- Microphone capture requires the web platform (MediaRecorder API); native Expo builds don't record yet
- Audio chunks smaller than ~2KB are skipped on server
