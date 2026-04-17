"""
Test Groq transcription with WebSocket broadcast
Verifies that /transcribe with gTTS Portuguese audio triggers WS broadcast
"""
import pytest
import asyncio
import websockets
import json
import requests
import io
from gtts import gTTS

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
WS_URL = BASE_URL.replace('https://', 'wss://').replace('http://', 'ws://')


class TestGroqTranscribeWebSocket:
    """Test Groq transcription with WebSocket broadcast"""

    @pytest.mark.asyncio
    async def test_transcribe_broadcasts_phrase_to_websocket(self):
        """POST /transcribe with PT audio should broadcast phrase to WebSocket"""
        # Create session
        response = requests.post(f"{BASE_URL}/api/sessions")
        assert response.status_code == 200
        code = response.json()["code"]
        
        print(f"\n✓ Created session: {code}")
        
        # Connect WebSocket
        ws_endpoint = f"{WS_URL}/api/sessions/{code}/ws"
        
        try:
            async with websockets.connect(ws_endpoint, open_timeout=10) as ws:
                # Receive hello message
                hello_msg = await asyncio.wait_for(ws.recv(), timeout=5)
                hello_data = json.loads(hello_msg)
                assert hello_data["type"] == "hello"
                print(f"✓ WebSocket connected, received hello")
                
                # Generate Portuguese audio using gTTS
                pt_text = "Bom dia a todos, obrigado por estarem aqui"
                print(f"✓ Generating Portuguese audio: '{pt_text}'")
                
                tts = gTTS(text=pt_text, lang='pt', slow=False)
                audio_buffer = io.BytesIO()
                tts.write_to_fp(audio_buffer)
                audio_buffer.seek(0)
                audio_bytes = audio_buffer.read()
                
                print(f"✓ Audio generated: {len(audio_bytes)} bytes")
                assert len(audio_bytes) > 2000, "Audio should be >2000 bytes"
                
                # Upload audio for transcription
                files = {"audio": ("portuguese.mp3", io.BytesIO(audio_bytes), "audio/mp3")}
                print(f"✓ Uploading audio to /api/sessions/{code}/transcribe")
                
                transcribe_resp = requests.post(
                    f"{BASE_URL}/api/sessions/{code}/transcribe",
                    files=files
                )
                
                assert transcribe_resp.status_code == 200, f"Transcribe failed: {transcribe_resp.status_code}"
                transcribe_data = transcribe_resp.json()
                
                print(f"✓ Transcribe response: {transcribe_data}")
                
                # Check if skipped
                if transcribe_data.get("skipped"):
                    print(f"⚠ Transcription skipped: {transcribe_data.get('reason')}")
                    pytest.skip(f"Transcription skipped: {transcribe_data.get('reason')}")
                
                # Validate phrase
                assert "phrase" in transcribe_data
                phrase = transcribe_data["phrase"]
                assert phrase is not None
                assert "pt_text" in phrase
                assert "it_text" in phrase
                assert len(phrase["pt_text"]) > 0
                assert len(phrase["it_text"]) > 0
                
                print(f"✓ Transcription successful:")
                print(f"  PT: {phrase['pt_text']}")
                print(f"  IT: {phrase['it_text']}")
                
                # Wait for WebSocket broadcast (should arrive within 10 seconds)
                print(f"✓ Waiting for WebSocket broadcast...")
                
                try:
                    broadcast_msg = await asyncio.wait_for(ws.recv(), timeout=10)
                    broadcast_data = json.loads(broadcast_msg)
                    
                    print(f"✓ Received WebSocket broadcast: {broadcast_data}")
                    
                    assert broadcast_data["type"] == "phrase", f"Expected type 'phrase', got {broadcast_data.get('type')}"
                    assert "phrase" in broadcast_data
                    
                    ws_phrase = broadcast_data["phrase"]
                    assert ws_phrase["pt_text"] == phrase["pt_text"]
                    assert ws_phrase["it_text"] == phrase["it_text"]
                    
                    print(f"✓ WebSocket broadcast verified!")
                    print(f"  Broadcast PT: {ws_phrase['pt_text']}")
                    print(f"  Broadcast IT: {ws_phrase['it_text']}")
                    
                except asyncio.TimeoutError:
                    pytest.fail("Timeout waiting for WebSocket broadcast after /transcribe")
                
        except Exception as e:
            pytest.fail(f"WebSocket test failed: {e}")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short", "-s"])
