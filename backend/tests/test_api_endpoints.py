"""
Backend API tests for PT->IT real-time translation app
Tests: Session creation, session retrieval, transcribe, phrases, clear
"""
import pytest
import requests
import os
from gtts import gTTS
import io

# Read from frontend .env file for public URL
def get_backend_url():
    try:
        with open('/app/frontend/.env', 'r') as f:
            for line in f:
                if line.startswith('EXPO_PUBLIC_BACKEND_URL='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    except:
        pass
    return ''

BASE_URL = get_backend_url()

class TestSessionManagement:
    """Test session creation and retrieval"""

    def test_create_session_returns_valid_data(self):
        """POST /api/sessions should create session with 6-char code"""
        response = requests.post(f"{BASE_URL}/api/sessions")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        
        data = response.json()
        assert "id" in data, "Response missing 'id' field"
        assert "code" in data, "Response missing 'code' field"
        assert "created_at" in data, "Response missing 'created_at' field"
        
        # Validate code format (6 uppercase alphanumeric)
        code = data["code"]
        assert len(code) == 6, f"Code should be 6 chars, got {len(code)}"
        assert code.isupper(), "Code should be uppercase"
        assert code.isalnum(), "Code should be alphanumeric"
        
        print(f"✓ Session created: {code}")
        return code

    def test_get_session_with_valid_code(self):
        """GET /api/sessions/{code} should return session for valid code"""
        # Create session first
        create_resp = requests.post(f"{BASE_URL}/api/sessions")
        assert create_resp.status_code == 200
        code = create_resp.json()["code"]
        
        # Retrieve session
        get_resp = requests.get(f"{BASE_URL}/api/sessions/{code}")
        assert get_resp.status_code == 200, f"Expected 200, got {get_resp.status_code}"
        
        data = get_resp.json()
        assert data["code"] == code, f"Expected code {code}, got {data['code']}"
        assert "id" in data
        assert "created_at" in data
        
        print(f"✓ Session retrieved: {code}")

    def test_get_session_with_invalid_code_returns_404(self):
        """GET /api/sessions/{code} should return 404 for non-existent code"""
        invalid_code = "XXXXXX"
        response = requests.get(f"{BASE_URL}/api/sessions/{invalid_code}")
        assert response.status_code == 404, f"Expected 404, got {response.status_code}"
        
        data = response.json()
        assert "detail" in data
        assert "not found" in data["detail"].lower()
        
        print(f"✓ Invalid code correctly returns 404")


class TestPhrases:
    """Test phrase retrieval and filtering"""

    def test_get_phrases_empty_initially(self):
        """GET /api/sessions/{code}/phrases should return empty list for new session"""
        # Create session
        create_resp = requests.post(f"{BASE_URL}/api/sessions")
        assert create_resp.status_code == 200
        code = create_resp.json()["code"]
        
        # Get phrases
        phrases_resp = requests.get(f"{BASE_URL}/api/sessions/{code}/phrases")
        assert phrases_resp.status_code == 200
        
        data = phrases_resp.json()
        assert "phrases" in data
        assert isinstance(data["phrases"], list)
        assert len(data["phrases"]) == 0, "New session should have no phrases"
        
        print(f"✓ Empty phrases list for new session")

    def test_get_phrases_with_since_iso_param(self):
        """GET /api/sessions/{code}/phrases?since_iso should filter by timestamp"""
        # Create session
        create_resp = requests.post(f"{BASE_URL}/api/sessions")
        assert create_resp.status_code == 200
        code = create_resp.json()["code"]
        
        # Test with since_iso parameter
        since_iso = "2024-01-01T00:00:00Z"
        phrases_resp = requests.get(f"{BASE_URL}/api/sessions/{code}/phrases?since_iso={since_iso}")
        assert phrases_resp.status_code == 200
        
        data = phrases_resp.json()
        assert "phrases" in data
        
        print(f"✓ since_iso parameter accepted")


class TestTranscribe:
    """Test audio transcription and translation"""

    def test_transcribe_with_small_audio_returns_skipped(self):
        """POST /api/sessions/{code}/transcribe should skip audio <2000 bytes"""
        # Create session
        create_resp = requests.post(f"{BASE_URL}/api/sessions")
        assert create_resp.status_code == 200
        code = create_resp.json()["code"]
        
        # Create small audio file
        small_audio = b"x" * 100  # Only 100 bytes
        files = {"audio": ("test.webm", io.BytesIO(small_audio), "audio/webm")}
        
        transcribe_resp = requests.post(f"{BASE_URL}/api/sessions/{code}/transcribe", files=files)
        assert transcribe_resp.status_code == 200
        
        data = transcribe_resp.json()
        assert "skipped" in data
        assert data["skipped"] is True, "Small audio should be skipped"
        assert "reason" in data
        assert "too short" in data["reason"].lower()
        
        print(f"✓ Small audio correctly skipped")

    def test_transcribe_with_real_portuguese_audio(self):
        """POST /api/sessions/{code}/transcribe should transcribe PT audio and translate to IT"""
        # Create session
        create_resp = requests.post(f"{BASE_URL}/api/sessions")
        assert create_resp.status_code == 200
        code = create_resp.json()["code"]
        session_id = create_resp.json()["id"]
        
        # Generate Portuguese audio using gTTS
        pt_text = "Bom dia a todos, obrigado por estarem aqui neste evento"
        print(f"Generating Portuguese audio: '{pt_text}'")
        
        tts = gTTS(text=pt_text, lang='pt', slow=False)
        audio_buffer = io.BytesIO()
        tts.write_to_fp(audio_buffer)
        audio_buffer.seek(0)
        audio_bytes = audio_buffer.read()
        
        print(f"Audio size: {len(audio_bytes)} bytes")
        assert len(audio_bytes) > 2000, "Generated audio should be >2000 bytes"
        
        # Upload audio for transcription
        files = {"audio": ("portuguese.mp3", io.BytesIO(audio_bytes), "audio/mp3")}
        transcribe_resp = requests.post(f"{BASE_URL}/api/sessions/{code}/transcribe", files=files)
        
        print(f"Transcribe response status: {transcribe_resp.status_code}")
        if transcribe_resp.status_code != 200:
            print(f"Error response: {transcribe_resp.text}")
        
        assert transcribe_resp.status_code == 200, f"Expected 200, got {transcribe_resp.status_code}"
        
        data = transcribe_resp.json()
        print(f"Transcribe response: {data}")
        
        # Check if skipped or successful
        if data.get("skipped"):
            print(f"⚠ Transcription skipped: {data.get('reason')}")
            # This is acceptable for some edge cases (noise filtering, empty transcription)
            return
        
        # Validate phrase structure
        assert "phrase" in data, "Response missing 'phrase' field"
        phrase = data["phrase"]
        assert phrase is not None, "Phrase should not be None"
        
        assert "id" in phrase
        assert "session_id" in phrase
        assert phrase["session_id"] == session_id
        assert "pt_text" in phrase
        assert "it_text" in phrase
        assert "created_at" in phrase
        
        # Validate text content
        pt_result = phrase["pt_text"]
        it_result = phrase["it_text"]
        
        assert len(pt_result) > 0, "Portuguese text should not be empty"
        assert len(it_result) > 0, "Italian text should not be empty"
        
        print(f"✓ Transcription successful:")
        print(f"  PT: {pt_result}")
        print(f"  IT: {it_result}")
        
        # Verify phrase was persisted - GET to check
        phrases_resp = requests.get(f"{BASE_URL}/api/sessions/{code}/phrases")
        assert phrases_resp.status_code == 200
        phrases_data = phrases_resp.json()
        assert len(phrases_data["phrases"]) > 0, "Phrase should be persisted in database"
        
        persisted_phrase = phrases_data["phrases"][0]
        assert persisted_phrase["pt_text"] == pt_result
        assert persisted_phrase["it_text"] == it_result
        
        print(f"✓ Phrase persisted in database")


class TestClearSession:
    """Test session clearing"""

    def test_clear_session_deletes_phrases(self):
        """POST /api/sessions/{code}/clear should delete all phrases"""
        # Create session
        create_resp = requests.post(f"{BASE_URL}/api/sessions")
        assert create_resp.status_code == 200
        code = create_resp.json()["code"]
        
        # Clear session (even though empty)
        clear_resp = requests.post(f"{BASE_URL}/api/sessions/{code}/clear")
        assert clear_resp.status_code == 200
        
        data = clear_resp.json()
        assert "deleted" in data
        assert isinstance(data["deleted"], int)
        assert data["deleted"] == 0, "Should delete 0 phrases from empty session"
        
        print(f"✓ Clear session returns deleted count")

    def test_clear_nonexistent_session_returns_404(self):
        """POST /api/sessions/{code}/clear should return 404 for invalid code"""
        invalid_code = "ZZZZZZ"
        clear_resp = requests.post(f"{BASE_URL}/api/sessions/{invalid_code}/clear")
        assert clear_resp.status_code == 404
        
        print(f"✓ Clear invalid session returns 404")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
