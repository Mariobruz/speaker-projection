import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
  ScrollView,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL as string;

export default function Home() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startSession = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/sessions`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      router.push(`/speaker/${data.code}`);
    } catch (e: any) {
      setError(`Errore creazione sessione: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  const joinAsProjector = async () => {
    const code = joinCode.trim().toUpperCase();
    if (code.length < 4) {
      setError("Inserisci un codice sessione valido");
      return;
    }
    setError(null);
    setJoining(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/sessions/${code}`);
      if (!res.ok) {
        if (res.status === 404) {
          setError("Sessione non trovata");
        } else {
          setError(`Errore: HTTP ${res.status}`);
        }
        return;
      }
      router.push(`/projector/${code}`);
    } catch (e: any) {
      setError(`Errore: ${e?.message || e}`);
    } finally {
      setJoining(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} testID="home-screen">
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Text style={styles.caption} testID="app-caption">REAL-TIME · PT → IT</Text>
            <Text style={styles.title}>Voce</Text>
            <Text style={styles.titleAccent}>Istantanea.</Text>
            <Text style={styles.subtitle}>
              Parla in portoghese. Proietta la traduzione italiana in diretta.
            </Text>
          </View>

          <View style={styles.card} testID="speaker-card">
            <Text style={styles.cardLabel}>01 · SPEAKER</Text>
            <Text style={styles.cardTitle}>Crea una sessione</Text>
            <Text style={styles.cardDesc}>
              Avvia il microfono, parla in portoghese e condividi il codice con chi gestisce il
              proiettore.
            </Text>
            <TouchableOpacity
              style={[styles.primaryBtn, loading && { opacity: 0.6 }]}
              onPress={startSession}
              disabled={loading}
              testID="start-session-btn"
            >
              {loading ? (
                <ActivityIndicator color="#000" />
              ) : (
                <Text style={styles.primaryBtnText}>INIZIA COME SPEAKER →</Text>
              )}
            </TouchableOpacity>
          </View>

          <View style={styles.card} testID="projector-card">
            <Text style={styles.cardLabel}>02 · PROIETTORE</Text>
            <Text style={styles.cardTitle}>Entra con un codice</Text>
            <Text style={styles.cardDesc}>
              Apri questa vista sullo schermo grande. Mostrerà il testo tradotto in tempo reale.
            </Text>
            <TextInput
              style={styles.input}
              value={joinCode}
              onChangeText={(t) => setJoinCode(t.toUpperCase())}
              placeholder="CODICE SESSIONE"
              placeholderTextColor="#52525B"
              autoCapitalize="characters"
              maxLength={8}
              testID="join-code-input"
            />
            <TouchableOpacity
              style={[styles.secondaryBtn, joining && { opacity: 0.6 }]}
              onPress={joinAsProjector}
              disabled={joining}
              testID="join-projector-btn"
            >
              {joining ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.secondaryBtnText}>APRI PROIEZIONE →</Text>
              )}
            </TouchableOpacity>
          </View>

          {error && (
            <Text style={styles.error} testID="home-error">
              {error}
            </Text>
          )}

          <Text style={styles.footer}>
            Funziona meglio su Chrome · Richiede accesso al microfono
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#050505" },
  container: {
    padding: 24,
    paddingBottom: 64,
    gap: 20,
  },
  header: {
    marginTop: 24,
    marginBottom: 12,
  },
  caption: {
    color: "#A1A1AA",
    fontSize: 12,
    letterSpacing: 3,
    fontWeight: "600",
    marginBottom: 16,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 56,
    fontWeight: "900",
    letterSpacing: -2,
    lineHeight: 58,
  },
  titleAccent: {
    color: "#FF3333",
    fontSize: 56,
    fontWeight: "900",
    letterSpacing: -2,
    lineHeight: 58,
  },
  subtitle: {
    color: "#A1A1AA",
    fontSize: 16,
    marginTop: 16,
    lineHeight: 24,
    maxWidth: 520,
  },
  card: {
    backgroundColor: "#0F0F0F",
    borderColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderRadius: 16,
    padding: 24,
    gap: 12,
  },
  cardLabel: {
    color: "#52525B",
    fontSize: 11,
    letterSpacing: 3,
    fontWeight: "700",
  },
  cardTitle: {
    color: "#FFFFFF",
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  cardDesc: {
    color: "#A1A1AA",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 8,
  },
  primaryBtn: {
    backgroundColor: "#FFFFFF",
    paddingVertical: 18,
    alignItems: "center",
    borderRadius: 4,
    marginTop: 8,
  },
  primaryBtnText: {
    color: "#000",
    fontWeight: "800",
    letterSpacing: 1,
    fontSize: 14,
  },
  secondaryBtn: {
    borderColor: "#FFFFFF",
    borderWidth: 1,
    paddingVertical: 18,
    alignItems: "center",
    borderRadius: 4,
  },
  secondaryBtnText: {
    color: "#FFFFFF",
    fontWeight: "800",
    letterSpacing: 1,
    fontSize: 14,
  },
  input: {
    backgroundColor: "#050505",
    borderColor: "rgba(255,255,255,0.12)",
    borderWidth: 1,
    borderRadius: 4,
    paddingVertical: 16,
    paddingHorizontal: 16,
    color: "#FFFFFF",
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: 4,
    textAlign: "center",
    marginTop: 4,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  error: {
    color: "#FF3333",
    fontSize: 13,
    textAlign: "center",
    marginTop: 4,
  },
  footer: {
    color: "#52525B",
    fontSize: 11,
    textAlign: "center",
    marginTop: 16,
    letterSpacing: 2,
  },
});
