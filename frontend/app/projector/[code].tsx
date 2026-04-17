import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  Animated,
  Easing,
  Image,
  Dimensions,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

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

type SessionInfo = {
  id: string;
  code: string;
  speaker_name: string;
  logo_base64: string;
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

const FONT_SCALES = [0.6, 0.8, 1.0, 1.2, 1.5, 1.8, 2.2];
const DEFAULT_SCALE_INDEX = 2;

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

export default function ProjectorScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const sessionCode = (code || "").toString().toUpperCase();

  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHeader, setShowHeader] = useState(true);
  const [scaleIndex, setScaleIndex] = useState<number>(() => {
    const s = storageGet("vi.scaleIdx");
    const n = s ? parseInt(s, 10) : NaN;
    return !Number.isNaN(n) && n >= 0 && n < FONT_SCALES.length ? n : DEFAULT_SCALE_INDEX;
  });
  const [targetLang, setTargetLang] = useState<Lang>(() => {
    const s = storageGet("vi.lang");
    if (s && ["it","en","es","fr","de","pt"].includes(s)) return s as Lang;
    return "it";
  });
  const [wsOk, setWsOk] = useState(false);

  const lastSinceRef = useRef<string | null>(null);
  const hideTimer = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<any>(null);
  const loadingRef = useRef<Set<string>>(new Set());

  const scale = FONT_SCALES[scaleIndex];

  useEffect(() => { storageSet("vi.scaleIdx", String(scaleIndex)); }, [scaleIndex]);
  useEffect(() => { storageSet("vi.lang", targetLang); }, [targetLang]);

  const touchReveal = () => {
    setShowHeader(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowHeader(false), 4500);
  };

  useEffect(() => {
    touchReveal();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch session info (name + logo)
  const fetchSession = useCallback(async () => {
    if (!sessionCode) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/sessions/${sessionCode}`);
      if (res.ok) setSession(await res.json());
    } catch {}
  }, [sessionCode]);

  useEffect(() => { fetchSession(); }, [fetchSession]);

  const appendPhrases = useCallback((newPhrases: Phrase[]) => {
    if (!newPhrases.length) return;
    setPhrases((prev) => {
      const seen = new Set(prev.map((p) => p.id));
      const fresh = newPhrases.filter((p) => !seen.has(p.id));
      if (!fresh.length) return prev;
      return [...prev, ...fresh].slice(-40);
    });
    lastSinceRef.current = newPhrases[newPhrases.length - 1].created_at;
  }, []);

  const requestTranslation = useCallback(
    async (phraseId: string, lang: Lang) => {
      const key = `${phraseId}|${lang}`;
      if (loadingRef.current.has(key)) return;
      loadingRef.current.add(key);
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
        loadingRef.current.delete(key);
      }
    },
    [sessionCode]
  );

  useEffect(() => {
    for (const p of phrases) {
      const src = (p.source_lang || "pt").toLowerCase();
      if (targetLang === src) continue;
      const t = p.translations || {};
      if (!t[targetLang]) requestTranslation(p.id, targetLang);
    }
  }, [phrases, targetLang, requestTranslation]);

  const fetchPhrases = useCallback(async () => {
    if (!sessionCode) return;
    try {
      const qs = lastSinceRef.current
        ? `?since_iso=${encodeURIComponent(lastSinceRef.current)}`
        : "";
      const res = await fetch(`${BACKEND_URL}/api/sessions/${sessionCode}/phrases${qs}`);
      if (!res.ok) {
        if (res.status === 404) setError("Sessione non trovata");
        return;
      }
      setError(null);
      const data = await res.json();
      appendPhrases(data.phrases || []);
    } catch {}
  }, [sessionCode, appendPhrases]);

  useEffect(() => {
    fetchPhrases();
    const id = setInterval(() => { if (!wsOk) fetchPhrases(); }, 2500);
    return () => clearInterval(id);
  }, [fetchPhrases, wsOk]);

  // WebSocket
  useEffect(() => {
    if (!sessionCode) return;
    let closed = false;
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
            if (msg.type === "phrase" && msg.phrase) {
              appendPhrases([msg.phrase as Phrase]);
            } else if (msg.type === "clear") {
              setPhrases([]);
              lastSinceRef.current = null;
            } else if (msg.type === "translation" && msg.phrase_id && msg.lang && msg.text) {
              setPhrases((prev) =>
                prev.map((p) =>
                  p.id === msg.phrase_id
                    ? { ...p, translations: { ...(p.translations || {}), [msg.lang]: msg.text } }
                    : p
                )
              );
            } else if (msg.type === "session_update") {
              fetchSession();
            }
          } catch {}
        };
        ws.onclose = () => {
          setWsOk(false);
          if (!closed) {
            if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
            reconnectTimer.current = setTimeout(connect, 2000);
          }
        };
        ws.onerror = () => { try { ws.close(); } catch {} };
      } catch {
        if (!closed) reconnectTimer.current = setTimeout(connect, 2500);
      }
    };
    connect();
    return () => {
      closed = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
    };
  }, [sessionCode, appendPhrases, fetchSession]);

  const getPhraseText = (p: Phrase): string => {
    const src = (p.source_lang || "pt").toLowerCase();
    if (targetLang === src) return p.translations?.[src] || p.pt_text || "";
    if (targetLang === "it") return p.translations?.it || p.it_text || "";
    return p.translations?.[targetLang] || "";
  };

  const current = phrases[phrases.length - 1];
  const sourceLang = (current?.source_lang || "—").toUpperCase();

  // Build ticker text (concat last 5 phrases in chosen lang, separated)
  const tickerText = phrases
    .slice(-5)
    .map((p) => getPhraseText(p))
    .filter(Boolean)
    .join("   •   ") || "In attesa che lo speaker inizi a parlare...";

  // Marquee animation
  const translateX = useRef(new Animated.Value(0)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  const [tickerTextWidth, setTickerTextWidth] = useState(0);
  const [tickerContainerWidth, setTickerContainerWidth] = useState(0);

  useEffect(() => {
    if (animRef.current) {
      try { animRef.current.stop(); } catch {}
      animRef.current = null;
    }
    if (!tickerTextWidth || !tickerContainerWidth) return;
    translateX.setValue(tickerContainerWidth);
    const distance = tickerContainerWidth + tickerTextWidth;
    const duration = Math.max(8000, distance * 18); // ~18ms per px
    animRef.current = Animated.loop(
      Animated.timing(translateX, {
        toValue: -tickerTextWidth,
        duration,
        useNativeDriver: Platform.OS !== "web",
        easing: Easing.linear,
      })
    );
    animRef.current.start();
    return () => {
      if (animRef.current) {
        try { animRef.current.stop(); } catch {}
      }
    };
  }, [tickerText, tickerTextWidth, tickerContainerWidth, translateX]);

  const { height } = Dimensions.get("window");
  const tickerHeight = Math.max(120, Math.min(260, height * 0.22));
  const tickerFontSize = Math.max(48, Math.min(140, tickerHeight * 0.55)) * scale;

  const zoomIn = () => setScaleIndex((i) => Math.min(FONT_SCALES.length - 1, i + 1));
  const zoomOut = () => setScaleIndex((i) => Math.max(0, i - 1));

  const logoSrc = session?.logo_base64 ? session.logo_base64 : null;

  return (
    <View style={styles.root} testID="projector-screen">
      <TouchableOpacity activeOpacity={1} style={StyleSheet.absoluteFill} onPress={touchReveal} />

      {/* Always-visible source-language badge top-right */}
      <View style={styles.srcBadge} pointerEvents="none">
        <View style={[styles.livePulse, { backgroundColor: wsOk ? "#22C55E" : "#FF3333" }]} />
        <Text style={styles.srcBadgeTxt} testID="source-lang-badge">
          INPUT · {sourceLang}  →  {targetLang.toUpperCase()}
        </Text>
      </View>

      {/* Top-left caption */}
      <View style={styles.captionBar} pointerEvents="none">
        <View style={styles.captionBorder} />
        <Text style={styles.captionTxt}>TRADUZIONE IN TEMPO REALE</Text>
      </View>

      {/* Center: logo + speaker name */}
      <View style={styles.center} pointerEvents="none">
        {logoSrc ? (
          <Image
            source={{ uri: logoSrc }}
            style={styles.logo}
            resizeMode="contain"
            testID="projector-logo"
          />
        ) : null}
        {session?.speaker_name ? (
          <Text style={styles.speakerName} testID="speaker-name">{session.speaker_name}</Text>
        ) : null}
      </View>

      {/* Header controls (reveal on tap) */}
      {showHeader && (
        <View style={[styles.topBar, { pointerEvents: "box-none" }]}>
          <TouchableOpacity onPress={() => router.replace("/")} style={styles.exitBtn} testID="projector-exit-btn">
            <Text style={styles.exitTxt}>← ESCI</Text>
          </TouchableOpacity>

          <View style={[styles.langRow, { pointerEvents: "auto" }]}>
            {LANGS.map((L) => {
              const active = L.code === targetLang;
              return (
                <TouchableOpacity
                  key={L.code}
                  onPress={() => setTargetLang(L.code)}
                  style={[styles.langPill, active && styles.langPillActive]}
                  testID={`lang-pill-${L.code}`}
                >
                  <Text style={[styles.langPillTxt, active && styles.langPillTxtActive]}>
                    {L.flag} {L.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={{ flex: 1 }} />

          <View style={[styles.zoomRow, { pointerEvents: "auto" }]}>
            <TouchableOpacity onPress={zoomOut} style={styles.zoomBtn} testID="zoom-out-btn">
              <Text style={styles.zoomBtnTxt}>A−</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setScaleIndex(DEFAULT_SCALE_INDEX)} style={[styles.zoomBtn, { minWidth: 60 }]} testID="zoom-reset-btn">
              <Text style={[styles.zoomBtnTxt, { fontSize: 11 }]}>{Math.round(scale * 100)}%</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={zoomIn} style={styles.zoomBtn} testID="zoom-in-btn">
              <Text style={styles.zoomBtnTxt}>A+</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Bottom ticker (marquee right-to-left) */}
      <View
        style={[styles.tickerWrap, { height: tickerHeight }]}
        onLayout={(e) => setTickerContainerWidth(e.nativeEvent.layout.width)}
      >
        <Animated.Text
          style={[
            styles.tickerTxt,
            { fontSize: tickerFontSize, transform: [{ translateX }] },
          ]}
          onLayout={(e) => setTickerTextWidth(e.nativeEvent.layout.width)}
          numberOfLines={1}
          testID="ticker-text"
        >
          {error ? error : tickerText}
        </Animated.Text>
      </View>

      {/* Session code + credit */}
      <View style={styles.footerRow} pointerEvents="none">
        <Text style={styles.sessionCodeTxt}>Sessione {sessionCode}</Text>
        <Text style={styles.credit} testID="credit">created by Gianni Bruzzese</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },
  srcBadge: {
    position: "absolute",
    top: 20,
    right: 20,
    zIndex: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 4,
    backgroundColor: "rgba(255,51,51,0.12)",
    borderColor: "#FF3333",
    borderWidth: 1,
  },
  livePulse: { width: 8, height: 8, borderRadius: 4 },
  srcBadgeTxt: { color: "#FF3333", fontSize: 13, fontWeight: "900", letterSpacing: 2 },
  captionBar: {
    position: "absolute",
    top: 20,
    left: 20,
    zIndex: 5,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  captionBorder: { width: 32, height: 2, backgroundColor: "#FF3333" },
  captionTxt: { color: "#52525B", fontSize: 11, fontWeight: "800", letterSpacing: 3 },
  topBar: {
    position: "absolute",
    top: 56,
    left: 20,
    right: 20,
    zIndex: 15,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  exitBtn: {
    borderColor: "rgba(255,255,255,0.3)",
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 4,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  exitTxt: { color: "#FFFFFF", fontSize: 12, fontWeight: "800", letterSpacing: 2 },
  langRow: { flexDirection: "row", gap: 4, flexWrap: "wrap" },
  langPill: {
    borderColor: "rgba(255,255,255,0.2)",
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 4,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  langPillActive: { borderColor: "#FF3333", backgroundColor: "rgba(255,51,51,0.2)" },
  langPillTxt: { color: "#FFFFFF", fontSize: 12, fontWeight: "800", letterSpacing: 1 },
  langPillTxtActive: { color: "#FF3333" },
  zoomRow: { flexDirection: "row", gap: 4 },
  zoomBtn: {
    borderColor: "rgba(255,255,255,0.2)",
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 4,
    minWidth: 44,
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  zoomBtnTxt: { color: "#FFFFFF", fontSize: 14, fontWeight: "800", letterSpacing: 1 },
  center: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 260,
    paddingHorizontal: 48,
  },
  logo: { width: "44%", height: "44%", maxWidth: 520, maxHeight: 320, marginBottom: 24 },
  speakerName: {
    color: "#FFFFFF",
    fontSize: 48,
    fontWeight: "900",
    letterSpacing: -1,
    textAlign: "center",
  },
  tickerWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 52,
    backgroundColor: "#000000",
    borderTopWidth: 2,
    borderBottomWidth: 2,
    borderColor: "#FF3333",
    overflow: "hidden",
    justifyContent: "center",
  },
  tickerTxt: {
    color: "#FFFFFF",
    fontWeight: "900",
    letterSpacing: -1,
    paddingHorizontal: 40,
    whiteSpace: "nowrap" as any,
  },
  footerRow: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    zIndex: 5,
  },
  sessionCodeTxt: {
    color: "#52525B",
    fontSize: 12,
    letterSpacing: 4,
    fontWeight: "800",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  credit: {
    color: "#FF3333",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 1,
    fontStyle: "italic",
  },
});
