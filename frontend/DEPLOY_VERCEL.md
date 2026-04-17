# Deploy frontend su Vercel — guida 5 minuti

Il backend resta su Emergent (`https://speaker-projection.emergent.host/api`). Il frontend lo pubblichiamo gratis su Vercel così hai un URL stabile.

## 1. Scarica il codice

Nell'editor Emergent premi **"Save to GitHub"** e segui la procedura. Otterrai un URL repo tipo `github.com/tuonome/voce-istantanea`.

## 2. Vai su Vercel

1. Apri https://vercel.com — registrati/accedi **con GitHub** (gratis)
2. Premi **"Add New..."** → **"Project"**
3. Seleziona la repo `voce-istantanea` (dai i permessi a Vercel)

## 3. Configura il progetto

Nella schermata di configurazione Vercel:

- **Framework Preset**: scegli **"Other"** (non React/Next)
- **Root Directory**: clicca **"Edit"** → inserisci `frontend`
- **Build Command**: dovrebbe auto-rilevare `yarn build` dal `vercel.json` (se non lo fa, scrivilo a mano)
- **Output Directory**: `dist`

### Environment Variables (FONDAMENTALE!)

Apri la sezione **"Environment Variables"** e aggiungi questa SINGOLA variabile:

| Name | Value |
|---|---|
| `EXPO_PUBLIC_BACKEND_URL` | `https://speaker-projection.emergent.host` |

⚠️ Senza questa variabile il frontend parla al backend sbagliato e non funziona.

## 4. Deploy

Premi **"Deploy"**. Attendi 2-3 minuti.

Al termine ottieni un URL tipo:
- `https://voce-istantanea.vercel.app/`
- `https://voce-istantanea-<hash>.vercel.app/`

## 5. Usa l'URL all'evento

| Chi | URL |
|---|---|
| 🎤 Speaker | `https://voce-istantanea.vercel.app/` |
| 📺 Proiettore | `https://voce-istantanea.vercel.app/projector/<CODICE>` |

## 6. (Opzionale) dominio custom

Da Vercel → **Settings** → **Domains** → aggiungi il tuo `traduzione.miosito.it` (serve settare un CNAME nel tuo provider DNS).

---

## Troubleshooting rapido

### "404 NOT_FOUND" su /speaker/ABC123
Il `vercel.json` già gestisce il rewrite. Se non funziona vai su Vercel → Settings → Rewrites e verifica che esistano:
- `/speaker/:code` → `/speaker/[code].html`
- `/projector/:code` → `/projector/[code].html`

### Frontend carica ma "Sessione non trovata" o errori di rete
La env var `EXPO_PUBLIC_BACKEND_URL` non è impostata o punta al URL sbagliato. Correggi su Vercel → Settings → Environment Variables e fai **Redeploy**.

### "CORS error" in console
Il backend Emergent ha `allow_origins=["*"]` quindi non dovrebbe succedere. Se succede, verifica che l'URL in EXPO_PUBLIC_BACKEND_URL sia scritto senza slash finale.

### WebSocket non si connette (si vede "SYNC" invece di "LIVE")
Assicurati che l'URL backend sia HTTPS (lo è). Il client converte automaticamente a `wss://`. Se il browser blocca "mixed content", è perché hai messo `http://` invece di `https://` come valore della env var.
