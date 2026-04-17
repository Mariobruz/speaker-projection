import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Dimensions,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL as string;

type Phrase = {
  id: string;
  session_id: string;
  pt_text: string;
  it_text: string;
  translations?: Record<string, string>;
  created_at: string;
};

type Theme = "dark" | "light";

const THEMES: Record<Theme, {
  bg: string;
  surface: string;
  text: string;
  sub: string;
  muted: string;
  accent: string;
  accentSoft: string;
  border: string;
}> = {
  dark: {
    bg: "#050505",
    surface: "rgba(255,255,255,0.04)",
    text: "#FFFFFF",
    sub: "#A1A1AA",
    muted: "#52525B",
    accent: "#FF3333",
    accentSoft: "rgba(255,51,51,0.12)",
    border: "rgba(255,255,255,0.12)",
  },
  light: {
    bg: "#FAFAF7",
    surface: "rgba(0,0,0,0.03)",
    text: "#0A0A0A",
    sub: "#3F3F46",
    muted: "#71717A",
    accent: "#E11D48",
    accentSoft: "rgba(225,29,72,0.08)",
    border: "rgba(0,0,0,0.12)",
  },
};

const FONT_SCALES = [0.7, 0.85, 1.0, 1.2, 1.4, 1.65, 1.9];
const DEFAULT_SCALE_INDEX = 2;

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
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  }
  return null;
};

const storageSet = (k: string, v: string) => {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    try {
      window.localStorage.setItem(k, v);
    } catch {}
  }
};

export default function ProjectorScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const sessionCode = (code || "").toString().toUpperCase();

  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showHeader, setShowHeader] = useState(true);
  const [theme, setTheme] = useState<Theme>(() =>
    (storageGet("vi.theme") as Theme) === "light" ? "light" : "dark"
  );
  const [scaleIndex, setScaleIndex] = useState<number>(() => {
    const saved = storageGet("vi.scaleIdx");
    const n = saved ? parseInt(saved, 10) : NaN;
    if (!Number.isNaN(n) && n >= 0 && n < FONT_SCALES.length) return n;
    return DEFAULT_SCALE_INDEX;
  });
  const [targetLang, setTargetLang] = useState<Lang>(() => {
    const saved = storageGet("vi.lang");
    if (saved && ["it", "en", "es", "fr", "de", "pt"].includes(saved)) return saved as Lang;
    return "it";
  });
  const [wsOk, setWsOk] = useState(false);

  const lastSinceRef = useRef<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const hideTimer = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<any>(null);
  const loadingRef = useRef<Set<string>>(new Set());

  const t = THEMES[theme];
  const scale = FONT_SCALES[scaleIndex];

  useEffect(() => { storageSet("vi.theme", theme); }, [theme]);
  useEffect(() => { storageSet("vi.scaleIdx", String(scaleIndex)); }, [scaleIndex]);
  useEffect(() => { storageSet("vi.lang", targetLang); }, [targetLang]);

  const touchReveal = () => {
    setShowHeader(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowHeader(false), 3500);
  };

  useEffect(() => {
    touchReveal();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const appendPhrases = useCallback((newPhrases: Phrase[]) => {
    if (!newPhrases.length) return;
    setPhrases((prev) => {
      const seen = new Set(prev.map((p) => p.id));
      const fresh = newPhrases.filter((p) => !seen.has(p.id));
      if (!fresh.length) return prev;
      const merged = [...prev, ...fresh].slice(-80);
      return merged;
    });
    lastSinceRef.current = newPhrases[newPhrases.length - 1].created_at;
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
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
                ? {
                    ...p,
                    translations: { ...(p.translations || {}), [lang]: data.text },
                  }
                : p
            )
          );
        }
      } catch {
      } finally {
        loadingRef.current.delete(key);
      }
    },
    [sessionCode]
  );

  // Whenever target lang or phrases change, request missing translations
  useEffect(() => {
    for (const p of phrases) {
      const translations = p.translations || {};
      if (targetLang === "it" && p.it_text) continue;
      if (targetLang === "pt" && p.pt_text) continue;
      if (!translations[targetLang]) {
        requestTranslation(p.id, targetLang);
      }
    }
  }, [phrases, targetLang, requestTranslation]);

  const fetchPhrases = useCallback(
    async (initial = false) => {
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
        if (initial) {
          setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 120);
        }
      } catch {}
    },
    [sessionCode, appendPhrases]
  );

  useEffect(() => {
    fetchPhrases(true);
    const id = setInterval(() => { if (!wsOk) fetchPhrases(); }, 2500);
    return () => clearInterval(id);
  }, [fetchPhrases, wsOk]);

  // WebSocket realtime
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
                    ? {
                        ...p,
                        translations: { ...(p.translations || {}), [msg.lang]: msg.text },
                      }
                    : p
                )
              );
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
  }, [sessionCode, appendPhrases]);

  const getPhraseText = (p: Phrase): string => {
    if (targetLang === "it") return p.translations?.it || p.it_text || "";
    if (targetLang === "pt") return p.translations?.pt || p.pt_text || "";
    return p.translations?.[targetLang] || "";
  };

  const { width } = Dimensions.get("window");
  const hugeBase = Math.max(36, Math.min(140, width * 0.055));
  const smallBase = Math.max(14, Math.min(26, width * 0.015));
  const huge = hugeBase * scale;
  const small = smallBase * scale;

  const visible = phrases.slice(-6);
  const current = visible[visible.length - 1];
  const older = visible.slice(0, -1);

  const zoomIn = () => setScaleIndex((i) => Math.min(FONT_SCALES.length - 1, i + 1));
  const zoomOut = () => setScaleIndex((i) => Math.max(0, i - 1));
  const toggleTheme = () => setTheme((th) => (th === "dark" ? "light" : "dark"));
  const resetZoom = () => setScaleIndex(DEFAULT_SCALE_INDEX);

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]} testID="projector-screen">
      <TouchableOpacity activeOpacity={1} style={StyleSheet.absoluteFill} onPress={touchReveal} />

      {showHeader && (
        <View style={styles.topBar} pointerEvents="box-none">
          <TouchableOpacity
            onPress={() => router.replace("/")}
            style={[styles.exitBtn, { borderColor: t.border, backgroundColor: t.surface }]}
            testID="projector-exit-btn"
          >
            <Text style={[styles.exitTxt, { color: t.text }]}>← ESCI</Text>
          </TouchableOpacity>

          <View style={styles.langRow} pointerEvents="auto">
            {LANGS.map((L) => {
              const active = L.code === targetLang;
              return (
                <TouchableOpacity
                  key={L.code}
                  onPress={() => setTargetLang(L.code)}
                  style={[
                    styles.langPill,
                    { borderColor: active ? t.accent : t.border, backgroundColor: active ? t.accentSoft : t.surface },
                  ]}
                  testID={`lang-pill-${L.code}`}
                >
                  <Text style={[styles.langPillTxt, { color: active ? t.accent : t.text }]}>
                    {L.flag} {L.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={{ flex: 1 }} />

          <View style={styles.controlsRow} pointerEvents="auto">
            <TouchableOpacity
              onPress={zoomOut}
              style={[styles.ctrlBtn, { borderColor: t.border, backgroundColor: t.surface }]}
              testID="zoom-out-btn"
            >
              <Text style={[styles.ctrlBtnTxt, { color: t.text }]}>A−</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={resetZoom}
              style={[styles.ctrlBtn, { borderColor: t.border, backgroundColor: t.surface, minWidth: 60 }]}
              testID="zoom-reset-btn"
            >
              <Text style={[styles.ctrlBtnTxt, { color: t.text, fontSize: 11 }]}>
                {Math.round(scale * 100)}%
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={zoomIn}
              style={[styles.ctrlBtn, { borderColor: t.border, backgroundColor: t.surface }]}
              testID="zoom-in-btn"
            >
              <Text style={[styles.ctrlBtnTxt, { color: t.text }]}>A+</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={toggleTheme}
              style={[styles.ctrlBtn, { borderColor: t.border, backgroundColor: t.surface, minWidth: 44 }]}
              testID="theme-toggle-btn"
            >
              <Text style={[styles.ctrlBtnTxt, { color: t.text }]}>
                {theme === "dark" ? "☀" : "☾"}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.badge, { backgroundColor: t.accentSoft, borderColor: t.accent }]}>
            <View style={[styles.livePulse, { backgroundColor: wsOk ? "#22C55E" : t.accent }]} />
            <Text style={[styles.badgeTxt, { color: t.accent }]}>
              {wsOk ? "LIVE" : "SYNC"} · {sessionCode}
            </Text>
          </View>
        </View>
      )}

      <View style={styles.captionBar} pointerEvents="none">
        <View style={[styles.captionBorder, { backgroundColor: t.accent }]} />
        <Text style={[styles.captionTxt, { color: t.muted }]}>
          TRADUZIONE IN TEMPO REALE · PT → {targetLang.toUpperCase()}
        </Text>
      </View>

      {error ? (
        <View style={styles.errorWrap}>
          <Text style={[styles.errorTitle, { color: t.accent }]}>ERRORE</Text>
          <Text style={[styles.errorBody, { color: t.text }]}>{error}</Text>
        </View>
      ) : phrases.length === 0 ? (
        <View style={styles.waitWrap}>
          <Text style={[styles.waitTxt, { fontSize: Math.max(24, huge * 0.4), color: t.muted }]}>
            In attesa che lo speaker inizi a parlare...
          </Text>
          <Text style={[styles.waitSub, { color: t.text }]}>Sessione {sessionCode}</Text>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {older.map((p) => {
            const txt = getPhraseText(p);
            return (
              <View key={p.id} style={[styles.olderBlock, { borderLeftColor: t.border }]}>
                <Text style={[styles.olderPt, { fontSize: small, color: t.sub }]} numberOfLines={2}>
                  {p.pt_text}
                </Text>
                <Text style={[styles.olderIt, { fontSize: huge * 0.42, color: t.text }]}>
                  {txt || "…"}
                </Text>
              </View>
            );
          })}

          {current && (
            <View
              style={[styles.currentBlock, { borderLeftColor: t.accent }]}
              testID="current-phrase"
            >
              <Text style={[styles.currentPt, { fontSize: small * 1.1, color: t.sub }]}>
                {current.pt_text}
              </Text>
              <Text style={[styles.currentIt, { fontSize: huge, color: t.text }]}>
                {getPhraseText(current) || "…"}
              </Text>
            </View>
          )}
          <View style={{ height: 32 }} />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: "row",
    alignItems: "center",
    padding: 20,
    gap: 12,
    flexWrap: "wrap",
  },
  exitBtn: { borderWidth: 1, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 4 },
  exitTxt: { fontSize: 12, fontWeight: "800", letterSpacing: 2 },
  langRow: { flexDirection: "row", alignItems: "center", gap: 4, flexWrap: "wrap" },
  langPill: {
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 4,
  },
  langPillTxt: { fontSize: 12, fontWeight: "800", letterSpacing: 1 },
  controlsRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  ctrlBtn: {
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 4,
    minWidth: 44,
    alignItems: "center",
  },
  ctrlBtnTxt: { fontSize: 14, fontWeight: "800", letterSpacing: 1 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 4,
    borderWidth: 1,
  },
  livePulse: { width: 8, height: 8, borderRadius: 4 },
  badgeTxt: { fontSize: 12, fontWeight: "900", letterSpacing: 2 },
  captionBar: {
    position: "absolute",
    top: 80,
    left: 48,
    right: 48,
    zIndex: 5,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  captionBorder: { width: 32, height: 2 },
  captionTxt: { fontSize: 12, fontWeight: "800", letterSpacing: 4 },
  scroll: { flex: 1, marginTop: 110 },
  scrollContent: { paddingHorizontal: 48, paddingBottom: 48, gap: 32 },
  olderBlock: { opacity: 0.35, gap: 6, borderLeftWidth: 1, paddingLeft: 20 },
  olderPt: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  olderIt: { fontWeight: "800", letterSpacing: -1 },
  currentBlock: { gap: 14, borderLeftWidth: 3, paddingLeft: 24, paddingVertical: 8 },
  currentPt: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  currentIt: { fontWeight: "900", letterSpacing: -2 },
  waitWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 48 },
  waitTxt: {
    fontWeight: "900",
    letterSpacing: -1,
    textAlign: "center",
    maxWidth: 1000,
  },
  waitSub: {
    fontSize: 16,
    letterSpacing: 6,
    marginTop: 32,
    fontWeight: "800",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  errorWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 48 },
  errorTitle: { fontSize: 14, letterSpacing: 6, fontWeight: "900", marginBottom: 16 },
  errorBody: { fontSize: 28, fontWeight: "700", textAlign: "center" },
});
