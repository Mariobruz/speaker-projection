# Build EAS per iOS/Android — Guida rapida

Questa app è già pronta per EAS Build (`/app/frontend/eas.json` configurato con 3 profili).
Dal tuo computer locale (non dal sandbox Emergent):

## 1. Clona il codice
Scarica il progetto (tasto "Save to GitHub" su Emergent oppure zip).
Apri la cartella `frontend/` nel terminale.

## 2. Installa EAS CLI
```bash
npm install -g eas-cli
```

## 3. Login Expo
```bash
eas login
```
Se non hai un account: https://expo.dev/signup

## 4. Collega il progetto
```bash
eas init
```
Questo crea `extra.eas.projectId` in `app.json`.

## 5. Build

### Android APK (preview, installabile direttamente)
```bash
eas build --platform android --profile preview
```
Quando pronto scarichi `.apk` dal link e lo installi su un device Android.

### iOS Simulator (gratis, senza Apple Dev account)
```bash
eas build --platform ios --profile development
```

### iOS Device / App Store (richiede Apple Developer $99/anno)
```bash
eas build --platform ios --profile preview
# poi
eas submit --platform ios
```

### Android Play Store
```bash
eas build --platform android --profile production
eas submit --platform android
```

## Note
- Il backend `https://speaker-projection.preview.emergentagent.com` è già dentro `eas.json → env → EXPO_PUBLIC_BACKEND_URL` per tutti i profili. Se cambi backend (es. deploy definitivo) aggiorna lì.
- Permessi microfono iOS/Android sono già in `app.json`.
- Per il WebSocket realtime il backend deve essere raggiungibile dal device.
