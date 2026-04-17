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
  created_at: string;
};

export default function ProjectorScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const sessionCode = (code || "").toString().toUpperCase();

  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showHeader, setShowHeader] = useState(true);
  const lastSinceRef = useRef<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const hideTimer = useRef<any>(null);

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
      const newPhrases: Phrase[] = data.phrases || [];
      if (newPhrases.length) {
        setPhrases((prev) => [...prev, ...newPhrases].slice(-80));
        lastSinceRef.current = newPhrases[newPhrases.length - 1].created_at;
        setTimeout(() => {
          scrollRef.current?.scrollToEnd({ animated: true });
        }, 80);
      }
    } catch {}
  }, [sessionCode]);

  useEffect(() => {
    fetchPhrases();
    const id = setInterval(fetchPhrases, 1400);
    return () => clearInterval(id);
  }, [fetchPhrases]);

  const { width } = Dimensions.get("window");
  const huge = Math.max(36, Math.min(120, width * 0.055));
  const small = Math.max(16, Math.min(28, width * 0.016));

  const visible = phrases.slice(-6);
  const current = visible[visible.length - 1];
  const older = visible.slice(0, -1);

  return (
    <View style={styles.root} testID="projector-screen">
      <TouchableOpacity activeOpacity={1} style={StyleSheet.absoluteFill} onPress={touchReveal} />

      {showHeader && (
        <View style={styles.topBar} pointerEvents="box-none">
          <TouchableOpacity
            onPress={() => router.replace("/")}
            style={styles.exitBtn}
            testID="projector-exit-btn"
          >
            <Text style={styles.exitTxt}>← ESCI</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <View style={styles.badge}>
            <View style={styles.livePulse} />
            <Text style={styles.badgeTxt}>LIVE · {sessionCode}</Text>
          </View>
        </View>
      )}

      <View style={styles.captionBar} pointerEvents="none">
        <View style={styles.captionBorder} />
        <Text style={styles.captionTxt}>TRADUZIONE IN TEMPO REALE · PT → IT</Text>
      </View>

      {error ? (
        <View style={styles.errorWrap}>
          <Text style={styles.errorTitle}>ERRORE</Text>
          <Text style={styles.errorBody}>{error}</Text>
        </View>
      ) : phrases.length === 0 ? (
        <View style={styles.waitWrap}>
          <Text style={[styles.waitTxt, { fontSize: Math.max(28, huge * 0.45) }]}>
            In attesa che lo speaker inizi a parlare...
          </Text>
          <Text style={styles.waitSub}>Sessione {sessionCode}</Text>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {older.map((p) => (
            <View key={p.id} style={styles.olderBlock}>
              <Text style={[styles.olderPt, { fontSize: small }]} numberOfLines={2}>
                {p.pt_text}
              </Text>
              <Text style={[styles.olderIt, { fontSize: huge * 0.42 }]}>{p.it_text}</Text>
            </View>
          ))}

          {current && (
            <View style={styles.currentBlock} testID="current-phrase">
              <Text style={[styles.currentPt, { fontSize: small * 1.1 }]}>{current.pt_text}</Text>
              <Text style={[styles.currentIt, { fontSize: huge }]}>{current.it_text}</Text>
            </View>
          )}
          <View style={{ height: 32 }} />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#050505" },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: "row",
    alignItems: "center",
    padding: 20,
  },
  exitBtn: {
    borderColor: "rgba(255,255,255,0.2)",
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 4,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  exitTxt: { color: "#FFFFFF", fontSize: 12, fontWeight: "800", letterSpacing: 2 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 4,
    backgroundColor: "rgba(255,51,51,0.12)",
    borderColor: "rgba(255,51,51,0.4)",
    borderWidth: 1,
  },
  livePulse: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#FF3333" },
  badgeTxt: { color: "#FF3333", fontSize: 12, fontWeight: "900", letterSpacing: 2 },
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
  captionBorder: { width: 32, height: 2, backgroundColor: "#FF3333" },
  captionTxt: {
    color: "#52525B",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 4,
  },
  scroll: { flex: 1, marginTop: 110 },
  scrollContent: { paddingHorizontal: 48, paddingBottom: 48, gap: 32 },
  olderBlock: { opacity: 0.35, gap: 6, borderLeftColor: "rgba(255,255,255,0.12)", borderLeftWidth: 1, paddingLeft: 20 },
  olderPt: {
    color: "#A1A1AA",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  olderIt: { color: "#FFFFFF", fontWeight: "800", letterSpacing: -1, lineHeight: undefined },
  currentBlock: {
    gap: 14,
    borderLeftColor: "#FF3333",
    borderLeftWidth: 3,
    paddingLeft: 24,
    paddingVertical: 8,
  },
  currentPt: {
    color: "#A1A1AA",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  currentIt: {
    color: "#FFFFFF",
    fontWeight: "900",
    letterSpacing: -2,
    lineHeight: undefined,
  },
  waitWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 48 },
  waitTxt: {
    color: "#52525B",
    fontWeight: "900",
    letterSpacing: -1,
    textAlign: "center",
    maxWidth: 1000,
  },
  waitSub: {
    color: "#FFFFFF",
    fontSize: 16,
    letterSpacing: 6,
    marginTop: 32,
    fontWeight: "800",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  errorWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 48 },
  errorTitle: { color: "#FF3333", fontSize: 14, letterSpacing: 6, fontWeight: "900", marginBottom: 16 },
  errorBody: { color: "#FFFFFF", fontSize: 28, fontWeight: "700", textAlign: "center" },
});
