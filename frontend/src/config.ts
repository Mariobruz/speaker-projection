// Backend URL resolver
// Priorità:
// 1. Se siamo su un dominio vercel.app (o dominio custom di produzione) -> usa sempre backend production Emergent.
//    Questo protegge da cache/env var sbagliate lato Vercel.
// 2. Altrimenti usa EXPO_PUBLIC_BACKEND_URL (dev, preview, mobile native).
// 3. Come fallback finale, usa il backend di produzione.

const PROD_BACKEND = "https://speaker-projection.emergent.host";

function resolveBackendUrl(): string {
  const envUrl = (process.env.EXPO_PUBLIC_BACKEND_URL as string | undefined) || "";

  if (typeof window !== "undefined" && window.location) {
    const host = window.location.hostname || "";
    // Quando l'app gira su Vercel (produzione) forziamo sempre il backend production
    // per evitare che una env var mal configurata faccia puntare al preview.
    if (host.endsWith(".vercel.app") || host === "voce-istantanea.com") {
      return PROD_BACKEND;
    }
  }

  if (envUrl) return envUrl;
  return PROD_BACKEND;
}

export const BACKEND_URL = resolveBackendUrl();
