import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Platform,
  Linking,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  useAudioRecorder,
  AudioModule,
  setAudioModeAsync,
  RecordingPresets,
} from "expo-audio";

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL as string;

type Phrase = {
  id: string;
  session_id: string;
  pt_text: string;
  it_text: string;
  source_lang?: string;
  translations?: Record<string, string>;
  created_at: string;
};

type Lang = "it" | "en" | "es" | "fr" | "de" | "pt";
const LANGS: { code: Lang; label: string; flag: string }[] = [
  { code: "it", label: "IT", flag: "🇮🇹" },
  { code: "en", label: "EN", flag: "🇬🇧" },
  { code: "es", label: "ES", flag: "🇪🇸" },
  { code: "fr", label: "FR", flag: "🇫🇷" },
  { code: "de", label: "DE", flag: "🇩🇪" },
  { code: "pt", label: "PT", flag: "🇵🇹" },
];

const storageGet = (k: string): string | null => {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    try { return window.localStorage.getItem(k); } catch { return null; }
  }
  return null;
};
const storageSet = (k: string, v: string) => {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    try { window.localStorage.setItem(k, v); } catch {}
  }
};

const CHUNK_MS = 5000;
const IS_WEB = Platform.OS === "web";

export default function SpeakerScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const sessionCode = (code || "").toString().toUpperCase();

  const [recording, setRecording] = useState(false);
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [status, setStatus] = useState<string>("Pronto.");
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);

  // Web refs
  const mediaRecorderRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunkIntervalRef = useRef<any>(null);
  const recordingRef = useRef(false);

  // Native recorder (expo-audio)
  const nativeRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const nativeCycleTimer = useRef<any>(null);

  const lastSinceRef = useRef<string | null>(null);
  const pollRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsReconnectRef = useRef<any>(null);
  const [wsOk, setWsOk] = useState(false);

  // Mic device selection (web)
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string>(() => storageGet("vi.micId") || "");
  const [showMicList, setShowMicList] = useState(false);

  // Output language (speaker preview)
  const [targetLang, setTargetLang] = useState<Lang>(() => {
    const s = storageGet("vi.speakerLang");
    if (s && ["it", "en", "es", "fr", "de", "pt"].includes(s)) return s as Lang;
    return "it";
  });
  const translateLoadingRef = useRef<Set<string>>(new Set());

  useEffect(() => { storageSet("vi.speakerLang", targetLang); }, [targetLang]);
  useEffect(() => { if (selectedMicId) storageSet("vi.micId", selectedMicId); }, [selectedMicId]);

  const refreshDevices = useCallback(async () => {
    if (!IS_WEB || typeof navigator === "undefined" || !navigator.mediaDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all
        .filter((d) => d.kind === "audioinput")
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Microfono ${i + 1}` }));
      setDevices(inputs);
      if (selectedMicId && !inputs.some((d) => d.id === selectedMicId)) {
        setSelectedMicId("");
      }
    } catch {}
  }, [selectedMicId]);

  useEffect(() => {
    refreshDevices();
    if (IS_WEB && typeof navigator !== "undefined" && navigator.mediaDevices?.addEventListener) {
      const h = () => refreshDevices();
      navigator.mediaDevices.addEventListener("devicechange", h);
      return () => navigator.mediaDevices.removeEventListener("devicechange", h);
    }
  }, [refreshDevices]);

  const requestTranslation = useCallback(async (phraseId: string, lang: Lang) => {
    const key = `${phraseId}|${lang}`;
    if (translateLoadingRef.current.has(key)) return;
    translateLoadingRef.current.add(key);
    try {
      const res = await fetch(
        `${BACKEND_URL}/api/sessions/${sessionCode}/phrases/${phraseId}/translate?lang=${lang}`,
        { method: "POST" }
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.text) {
        setPhrases((prev) =>
          prev.map((p) =>
            p.id === phraseId
              ? { ...p, translations: { ...(p.translations || {}), [lang]: data.text } }
              : p
          )
        );
      }
    } catch {} finally {
      translateLoadingRef.current.delete(key);
    }
  }, [sessionCode]);

  useEffect(() => {
    for (const p of phrases) {
      const src = (p.source_lang || "pt").toLowerCase();
      if (targetLang === src) continue;
      const t = p.translations || {};
      if (!t[targetLang]) requestTranslation(p.id, targetLang);
    }
  }, [phrases, targetLang, requestTranslation]);

  const getPhraseText = (p: Phrase): string => {
    const src = (p.source_lang || "pt").toLowerCase();
    if (targetLang === src) return p.translations?.[src] || p.pt_text || "";
    if (targetLang === "it") return p.translations?.it || p.it_text || "";
    return p.translations?.[targetLang] || "";
  };
  const getPhraseSourceText = (p: Phrase): string => {
    const src = (p.source_lang || "pt").toLowerCase();
    return p.translations?.[src] || p.pt_text || "";
  };

  const projectorUrl =
    typeof window !== "undefined" && window.location
      ? `${window.location.origin}/projector/${sessionCode}`
      : `${BACKEND_URL}/projector/${sessionCode}`;

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(
    projectorUrl
  )}&size=220x220&bgcolor=0A0A0A&color=FFFFFF&qzone=2&margin=0`;

  const fetchPhrases = useCallback(async () => {
    if (!sessionCode) return;
    try {
      const qs = lastSinceRef.current
        ? `?since_iso=${encodeURIComponent(lastSinceRef.current)}`
        : "";
      const res = await fetch(`${BACKEND_URL}/api/sessions/${sessionCode}/phrases${qs}`);
      if (!res.ok) return;
      const data = await res.json();
      const newPhrases: Phrase[] = data.phrases || [];
      if (newPhrases.length) {
        setPhrases((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          const fresh = newPhrases.filter((p) => !seen.has(p.id));
          return fresh.length ? [...prev, ...fresh] : prev;
        });
        lastSinceRef.current = newPhrases[newPhrases.length - 1].created_at;
      }
    } catch {}
  }, [sessionCode]);

  useEffect(() => {
    fetchPhrases();
    pollRef.current = setInterval(() => { if (!wsOk) fetchPhrases(); }, 2500);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchPhrases, wsOk]);

  useEffect(() => {
    if (!sessionCode) return;
    let closed = false;
    const appendOne = (p: Phrase) => {
      setPhrases((prev) => {
        if (prev.some((x) => x.id === p.id)) return prev;
        lastSinceRef.current = p.created_at;
        return [...prev, p];
      });
    };
    const connect = () => {
      if (closed) return;
      try {
        const wsUrl = BACKEND_URL.replace(/^http/, "ws") + `/api/sessions/${sessionCode}/ws`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.onopen = () => setWsOk(true);
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "phrase" && msg.phrase) appendOne(msg.phrase as Phrase);
            else if (msg.type === "clear") {
              setPhrases([]);
              lastSinceRef.current = null;
            }
          } catch {}
        };
        ws.onclose = () => {
          setWsOk(false);
          if (!closed) {
            if (wsReconnectRef.current) clearTimeout(wsReconnectRef.current);
            wsReconnectRef.current = setTimeout(connect, 2000);
          }
        };
        ws.onerror = () => { try { ws.close(); } catch {} };
      } catch {
        if (!closed) wsReconnectRef.current = setTimeout(connect, 2500);
      }
    };
    connect();
    return () => {
      closed = true;
      if (wsReconnectRef.current) clearTimeout(wsReconnectRef.current);
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
    };
  }, [sessionCode]);

  useEffect(() => {
    return () => { stopRecording(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploadFormData = async (fd: FormData) => {
    setUploading((n) => n + 1);
    try {
      const res = await fetch(`${BACKEND_URL}/api/sessions/${sessionCode}/transcribe`, {
        method: "POST",
        body: fd as any,
      });
      if (!res.ok) {
        const txt = await res.text();
        console.error("Transcribe failed", res.status, txt);
        setError(`Errore trascrizione: HTTP ${res.status}`);
      }
    } catch (e: any) {
      setError(`Errore di rete: ${e?.message || e}`);
    } finally {
      setUploading((n) => Math.max(0, n - 1));
    }
  };

  const uploadWebBlob = async (blob: Blob) => {
    if (!blob || blob.size < 2000) return;
    const fd = new FormData();
    (fd as any).append("audio", blob, "chunk.webm");
    await uploadFormData(fd);
  };

  const uploadNativeFile = async (uri: string) => {
    if (!uri) return;
    const fd = new FormData();
    // React Native FormData accepts {uri, name, type}
    const name = "chunk.m4a";
    const type = "audio/m4a";
    (fd as any).append("audio", { uri, name, type } as any);
    await uploadFormData(fd);
  };

  // ---------- Web recording cycle ----------
  const startWebRecorderCycle = (stream: MediaStream) => {
    if (typeof (window as any).MediaRecorder === "undefined") {
      setError("MediaRecorder non supportato in questo browser.");
      return;
    }
    const MR = (window as any).MediaRecorder;
    const mimeCandidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ];
    let mimeType = "";
    for (const m of mimeCandidates) {
      if (MR.isTypeSupported && MR.isTypeSupported(m)) { mimeType = m; break; }
    }
    const rec = mimeType ? new MR(stream, { mimeType }) : new MR(stream);
    const localChunks: Blob[] = [];
    rec.ondataavailable = (e: any) => {
      if (e.data && e.data.size > 0) localChunks.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(localChunks, { type: mimeType || "audio/webm" });
      uploadWebBlob(blob);
      if (recordingRef.current) startWebRecorderCycle(stream);
    };
    rec.start();
    mediaRecorderRef.current = rec;
    chunkIntervalRef.current = setTimeout(() => {
      try { if (rec.state !== "inactive") rec.stop(); } catch {}
    }, CHUNK_MS);
  };

  // ---------- Native recording cycle (expo-audio) ----------
  const startNativeCycle = async () => {
    if (!recordingRef.current) return;
    try {
      await nativeRecorder.prepareToRecordAsync();
      nativeRecorder.record();
    } catch (e: any) {
      setError(`Errore registrazione: ${e?.message || e}`);
      recordingRef.current = false;
      setRecording(false);
      return;
    }
    nativeCycleTimer.current = setTimeout(async () => {
      try {
        await nativeRecorder.stop();
        const uri = nativeRecorder.uri;
        if (uri) uploadNativeFile(uri);
      } catch (e) {
        console.error("native stop failed", e);
      }
      if (recordingRef.current) startNativeCycle();
    }, CHUNK_MS);
  };

  const startRecording = async () => {
    setError(null);
    try {
      if (IS_WEB) {
        const audioConstraints: any = selectedMicId
          ? { deviceId: { exact: selectedMicId } }
          : true;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        streamRef.current = stream;
        // After permission granted, refresh device list with actual labels
        refreshDevices();
        recordingRef.current = true;
        setRecording(true);
        setStatus("In ascolto...");
        startWebRecorderCycle(stream);
      } else {
        const perm = await AudioModule.requestRecordingPermissionsAsync();
        if (!perm.granted) {
          setError("Permesso microfono negato.");
          return;
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        recordingRef.current = true;
        setRecording(true);
        setStatus("In ascolto...");
        startNativeCycle();
      }
    } catch (e: any) {
      setError(`Permesso microfono negato: ${e?.message || e}`);
    }
  };

  const stopRecording = () => {
    recordingRef.current = false;
    setRecording(false);
    setStatus("In pausa.");
    if (chunkIntervalRef.current) {
      clearTimeout(chunkIntervalRef.current);
      chunkIntervalRef.current = null;
    }
    if (nativeCycleTimer.current) {
      clearTimeout(nativeCycleTimer.current);
      nativeCycleTimer.current = null;
    }
    try {
      if (IS_WEB) {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
      } else {
        nativeRecorder.stop().then(() => {
          const uri = nativeRecorder.uri;
          if (uri) uploadNativeFile(uri);
        }).catch(() => {});
      }
    } catch {}
  };

  const toggleRecording = () => {
    if (recording) stopRecording(); else startRecording();
  };

  const clearSession = async () => {
    try {
      await fetch(`${BACKEND_URL}/api/sessions/${sessionCode}/clear`, { method: "POST" });
      setPhrases([]);
      lastSinceRef.current = null;
    } catch {}
  };

  const openProjector = () => {
    if (IS_WEB && typeof window !== "undefined") {
      window.open(projectorUrl, "_blank");
    } else {
      Linking.openURL(projectorUrl);
    }
  };

  return (
    <SafeAreaView style={styles.safe} testID="speaker-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.replace("/")} testID="home-back-btn">
          <Text style={styles.backTxt}>← HOME</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <View style={[styles.dot, recording && styles.dotActive]} />
        <Text style={styles.headerStatus}>{recording ? "LIVE" : "OFFLINE"}</Text>
        <View style={[styles.wsDot, wsOk && styles.wsDotOk]} />
        <Text style={styles.wsLabel}>{wsOk ? "WS" : "—"}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.sessionBox} testID="session-box">
          <Text style={styles.caption}>SESSIONE</Text>
          <Text style={styles.sessionCode} testID="session-code">
            {sessionCode}
          </Text>

          <View style={styles.qrRow}>
            <Image source={{ uri: qrUrl }} style={styles.qr} testID="projector-qr" resizeMode="contain" />
            <View style={{ flex: 1, marginLeft: 16 }}>
              <Text style={styles.qrHint}>
                Inquadra il QR col dispositivo del proiettore, oppure apri:
              </Text>
              <Text style={styles.qrUrl} numberOfLines={2} selectable>
                {projectorUrl}
              </Text>
              <TouchableOpacity style={styles.openBtn} onPress={openProjector} testID="open-projector-btn">
                <Text style={styles.openBtnTxt}>APRI PROIETTORE →</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <View style={styles.transcriptBox}>
          <View style={styles.transcriptHeader}>
            <Text style={styles.caption}>TRASCRIZIONE · OUTPUT {targetLang.toUpperCase()}</Text>
            <TouchableOpacity onPress={clearSession} testID="clear-btn">
              <Text style={styles.clearTxt}>SVUOTA</Text>
            </TouchableOpacity>
          </View>

          {/* Output language pills */}
          <View style={styles.langRow}>
            {LANGS.map((L) => {
              const active = L.code === targetLang;
              return (
                <TouchableOpacity
                  key={L.code}
                  onPress={() => setTargetLang(L.code)}
                  style={[styles.langPill, active && styles.langPillActive]}
                  testID={`speaker-lang-${L.code}`}
                >
                  <Text style={[styles.langPillTxt, active && styles.langPillTxtActive]}>
                    {L.flag} {L.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Mic device selector (web) or OS hint (native) */}
          {IS_WEB ? (
            <View style={styles.micSection}>
              <TouchableOpacity
                onPress={async () => {
                  await refreshDevices();
                  setShowMicList((v) => !v);
                }}
                style={styles.micTrigger}
                testID="mic-picker-trigger"
              >
                <Text style={styles.micTriggerTxt}>
                  🎙  {selectedMicId
                    ? devices.find((d) => d.id === selectedMicId)?.label || "Microfono selezionato"
                    : "Microfono predefinito"}
                </Text>
                <Text style={styles.micChevron}>{showMicList ? "▲" : "▼"}</Text>
              </TouchableOpacity>
              {showMicList && (
                <View style={styles.micList} testID="mic-picker-list">
                  <TouchableOpacity
                    onPress={() => { setSelectedMicId(""); setShowMicList(false); }}
                    style={[styles.micItem, !selectedMicId && styles.micItemActive]}
                    testID="mic-picker-default"
                  >
                    <Text style={styles.micItemTxt}>⚙  Microfono predefinito (sistema)</Text>
                  </TouchableOpacity>
                  {devices.length === 0 ? (
                    <Text style={styles.micEmpty}>
                      Autorizza il microfono una volta (premi il pulsante registra) per vedere qui l&apos;elenco dei dispositivi.
                    </Text>
                  ) : (
                    devices.map((d) => (
                      <TouchableOpacity
                        key={d.id}
                        onPress={() => { setSelectedMicId(d.id); setShowMicList(false); }}
                        style={[styles.micItem, selectedMicId === d.id && styles.micItemActive]}
                        testID={`mic-item-${d.id}`}
                      >
                        <Text style={styles.micItemTxt} numberOfLines={1}>
                          {selectedMicId === d.id ? "✓  " : "    "}
                          {d.label}
                        </Text>
                      </TouchableOpacity>
                    ))
                  )}
                </View>
              )}
            </View>
          ) : (
            <View style={styles.micSection}>
              <View style={[styles.micTrigger, { backgroundColor: "rgba(255,255,255,0.02)" }]}>
                <Text style={styles.micTriggerTxt}>🎙  Microfono gestito dal sistema</Text>
              </View>
              <Text style={styles.micEmpty}>
                Su iOS/Android è il sistema operativo a scegliere l&apos;ingresso audio.
                Collega il mic USB o Bluetooth prima di registrare e lui verrà usato automaticamente.
              </Text>
              <TouchableOpacity
                onPress={async () => {
                  try {
                    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
                    setError(null);
                    setStatus("Audio re-inizializzato.");
                  } catch (e: any) {
                    setError(`Errore: ${e?.message || e}`);
                  }
                }}
                style={[styles.micTrigger, { marginTop: 4 }]}
                testID="audio-reinit-btn"
              >
                <Text style={styles.micTriggerTxt}>🔄  Re-inizializza audio (dopo aver collegato BT/USB)</Text>
              </TouchableOpacity>
            </View>
          )}

          {phrases.length === 0 ? (
            <Text style={styles.empty}>
              Nessuna frase ancora. Premi il microfono e inizia a parlare.
            </Text>
          ) : (
            phrases
              .slice(-20)
              .reverse()
              .map((p) => (
                <View key={p.id} style={styles.phrase} testID={`phrase-${p.id}`}>
                  <Text style={styles.phrasePt}>
                    [{(p.source_lang || "pt").toUpperCase()}] {getPhraseSourceText(p)}
                  </Text>
                  <Text style={styles.phraseIt}>{getPhraseText(p) || "…"}</Text>
                </View>
              ))
          )}
        </View>
      </ScrollView>

      <View style={[styles.controls, { pointerEvents: "box-none" }]}>
        <View style={styles.controlInner}>
          {error && (
            <Text style={styles.errorTxt} testID="speaker-error">{error}</Text>
          )}
          <View style={styles.statusRow}>
            <Text style={styles.statusTxt}>{status}</Text>
            {uploading > 0 && (
              <View style={styles.uploadingRow}>
                <ActivityIndicator color="#A1A1AA" size="small" />
                <Text style={styles.uploadingTxt}>TRADUZIONE...</Text>
              </View>
            )}
          </View>
          <TouchableOpacity
            onPress={toggleRecording}
            style={[styles.fab, recording && styles.fabActive]}
            testID="mic-record-button"
          >
            <View style={[styles.fabInner, recording && styles.fabInnerActive]} />
          </TouchableOpacity>
          <Text style={styles.fabHint}>{recording ? "TOCCA PER FERMARE" : "TOCCA PER PARLARE"}</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0A0A0A" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomColor: "rgba(255,255,255,0.08)",
    borderBottomWidth: 1,
    gap: 8,
  },
  backTxt: { color: "#A1A1AA", fontSize: 12, letterSpacing: 2, fontWeight: "700" },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#52525B" },
  dotActive: { backgroundColor: "#FF3333" },
  headerStatus: { color: "#FFFFFF", fontSize: 12, letterSpacing: 2, fontWeight: "700" },
  wsDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#52525B", marginLeft: 8 },
  wsDotOk: { backgroundColor: "#22C55E" },
  wsLabel: { color: "#52525B", fontSize: 10, letterSpacing: 2, fontWeight: "700" },
  content: { padding: 20, paddingBottom: 280, gap: 20 },
  sessionBox: {
    backgroundColor: "#121212",
    borderColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
  },
  caption: { color: "#52525B", fontSize: 11, letterSpacing: 3, fontWeight: "700" },
  sessionCode: {
    color: "#FFFFFF",
    fontSize: 44,
    fontWeight: "900",
    letterSpacing: 6,
    marginTop: 8,
    marginBottom: 16,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  qrRow: { flexDirection: "row", alignItems: "flex-start" },
  qr: { width: 120, height: 120, backgroundColor: "#0A0A0A", borderRadius: 8 },
  qrHint: { color: "#A1A1AA", fontSize: 12, marginBottom: 6 },
  qrUrl: { color: "#FFFFFF", fontSize: 12, marginBottom: 10 },
  openBtn: {
    borderColor: "#FFFFFF",
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: 4,
  },
  openBtnTxt: { color: "#FFFFFF", fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  transcriptBox: {
    backgroundColor: "#121212",
    borderColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    gap: 14,
  },
  transcriptHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  clearTxt: { color: "#FF3333", fontSize: 11, letterSpacing: 2, fontWeight: "800" },
  empty: { color: "#52525B", fontSize: 14, fontStyle: "italic", paddingVertical: 8 },
  phrase: {
    borderLeftColor: "#FF3333",
    borderLeftWidth: 2,
    paddingLeft: 12,
    paddingVertical: 4,
  },
  phrasePt: {
    color: "#A1A1AA",
    fontSize: 13,
    marginBottom: 4,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  phraseIt: { color: "#FFFFFF", fontSize: 17, fontWeight: "700", lineHeight: 24 },
  langRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  langPill: {
    borderColor: "rgba(255,255,255,0.12)",
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 4,
    backgroundColor: "rgba(255,255,255,0.02)",
  },
  langPillActive: {
    borderColor: "#FF3333",
    backgroundColor: "rgba(255,51,51,0.12)",
  },
  langPillTxt: { color: "#FFFFFF", fontSize: 12, fontWeight: "800", letterSpacing: 1 },
  langPillTxtActive: { color: "#FF3333" },
  micSection: { gap: 6 },
  micTrigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderColor: "rgba(255,255,255,0.12)",
    borderWidth: 1,
    borderRadius: 4,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "rgba(255,255,255,0.02)",
  },
  micTriggerTxt: { color: "#FFFFFF", fontSize: 13, fontWeight: "700", flex: 1 },
  micChevron: { color: "#A1A1AA", fontSize: 12 },
  micList: {
    borderColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderRadius: 4,
    backgroundColor: "#0A0A0A",
    padding: 6,
    gap: 2,
  },
  micItem: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 4 },
  micItemActive: { backgroundColor: "rgba(255,51,51,0.08)" },
  micItemTxt: {
    color: "#FFFFFF",
    fontSize: 12,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  micEmpty: { color: "#52525B", fontSize: 11, fontStyle: "italic", padding: 8 },
  controls: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: 16,
    paddingBottom: 28,
    backgroundColor: "rgba(5,5,5,0.95)",
    borderTopColor: "rgba(255,255,255,0.08)",
    borderTopWidth: 1,
  },
  controlInner: { alignItems: "center", gap: 10 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  statusTxt: { color: "#A1A1AA", fontSize: 12, letterSpacing: 2, fontWeight: "700" },
  uploadingRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  uploadingTxt: { color: "#A1A1AA", fontSize: 11, letterSpacing: 2, fontWeight: "700" },
  fab: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  fabActive: {
    backgroundColor: "#FF3333",
    boxShadow: "0 0 40px rgba(255, 51, 51, 0.6)",
    elevation: 12,
  },
  fabInner: { width: 32, height: 32, borderRadius: 16, backgroundColor: "#000" },
  fabInnerActive: { width: 24, height: 24, borderRadius: 4, backgroundColor: "#FFFFFF" },
  fabHint: { color: "#FFFFFF", fontSize: 11, letterSpacing: 2, fontWeight: "800", marginTop: 6 },
  errorTxt: { color: "#FF3333", fontSize: 12, textAlign: "center", marginBottom: 2 },
});
