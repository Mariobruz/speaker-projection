# PRD - Voce Istantanea (PT → Multi-Lang Real-Time Event Translator)

## Overview
Web + mobile app for conference/event interpretation. A Portuguese speaker talks into the microphone; the app transcribes audio via Groq Whisper, translates to Italian (default) / English / Spanish / French / German / Portuguese via Groq Llama, and displays the translation on a large projection screen in real time.

## User Roles
- **Speaker**: creates a session, records audio from browser mic (web) or native mic (iOS/Android via expo-audio), sees confirmation of transcription/translation.
- **Projector**: opens a public projector view via session code or QR; displays huge translation on projector; can change output language with pills (IT/EN/ES/FR/DE/PT), zoom font size, toggle dark/light theme.

## Features
- 6-char alphanumeric session codes
- Continuous 5s chunked audio capture (MediaRecorder on web, expo-audio on native)
- Groq whisper-large-v3-turbo STT (language=pt)
- Groq llama-3.3-70b-versatile translation (6 target languages)
- Whisper noise/hallucination filter for silent chunks
- Per-phrase translation cache in MongoDB (translated once per language)
- WebSocket push realtime for `phrase`, `clear`, `translation` events (2.5s polling fallback)
- Dark / Light theme + 7 font-zoom levels (70% → 190%) persisted in localStorage
- Language selector pills on projector (persisted)

## Backend (FastAPI + MongoDB)
- POST /api/sessions
- GET /api/sessions/{code}
- POST /api/sessions/{code}/transcribe (multipart audio)
- GET /api/sessions/{code}/phrases?since_iso=
- POST /api/sessions/{code}/phrases/{phrase_id}/translate?lang=<code>
- POST /api/sessions/{code}/clear
- WS /api/sessions/{code}/ws

## Integrations
- **Groq Cloud** (free tier, OpenAI-compatible)
  - STT: whisper-large-v3-turbo via /audio/transcriptions, **language auto-detect** via `response_format=verbose_json`
  - Chat: llama-3.3-70b-versatile via /chat/completions
- API key: `GROQ_API_KEY` in /app/backend/.env
- Source language normalized to ISO-639-1 (pt, en, es, fr, de, it). Unknown languages fallback to `pt`.
- Translation uses detected source language → target language (dynamic)

## Permissions
- iOS: `NSMicrophoneUsageDescription`
- Android: `android.permission.RECORD_AUDIO`
- Plugin: `expo-audio` with microphonePermission message

## Known Constraints
- Audio chunks <2KB are skipped server-side
- On web, requires Chrome/Edge for MediaRecorder + WebSocket
- Native recording requires expo-audio (installed, plugin configured)
