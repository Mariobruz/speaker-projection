# Test live con microfono USB / Bluetooth — 60 secondi

## Web (Chrome / Edge / Safari su desktop)

1. Collega il mic USB o il mic Bluetooth **prima** di aprire la pagina Speaker.
2. Vai su `https://<tuo-dominio>/speaker/<CODE>`.
3. Al primo avvio, premi il **pulsante microfono** una volta per concedere il permesso.
4. Nella card **TRASCRIZIONE**, tocca **🎙 Microfono predefinito ▼** → la lista mostrerà ora tutti i dispositivi col loro nome reale (es. "Blue Yeti", "AirPods Pro"). Seleziona quello che vuoi.
5. La scelta viene salvata in `localStorage`: riaprendo la pagina resta memorizzata.
6. Avvia la registrazione e parla.

### Verifica rapida
- Nelle **DevTools → Console** dovresti NON vedere errori.
- Se il nome del mic non compare (solo "Microfono 1"), significa che il browser non ha ancora il permesso: premi il pulsante rec una volta.

## iOS / Android (dopo EAS Build)

1. **Collega il mic PRIMA** di aprire l'app:
   - Bluetooth: associa dalle **Impostazioni → Bluetooth** come qualsiasi altro device audio.
   - USB-C: inserisci l'adattatore e il sistema lo riconoscerà.
2. Apri l'app, vai sullo Speaker.
3. Tocca il pulsante mic: il sistema operativo userà **automaticamente** il device collegato (è così che funzionano Zoom, Voice Memos, Teams, etc.).
4. Se colleghi il BT mic **dopo** aver aperto l'app:
   - Tocca **🔄 Re-inizializza audio** per forzare il sistema a rilevarlo.
   - Oppure chiudi e riapri l'app.

### Perché non c'è un picker su nativo
Su iOS/Android non esiste un'API pubblica cross-platform per elencare e selezionare il mic da JavaScript. È una scelta precisa di Apple/Google: l'utente gestisce l'audio dalle impostazioni di sistema / dal control center. Tutte le app pro (Zoom, Teams, GarageBand) seguono questa convenzione.

Se davvero serve un picker nativo custom, richiede:
- iOS: modulo nativo con `AVAudioSession.availableInputs` + `setPreferredInput`
- Android: modulo nativo con `AudioManager.getDevices()` + `setCommunicationDevice`

Fattibile ma è un investimento a parte (serve prebuild + EAS build con native modules).

## Test di regressione rapido (2 minuti)

Con uno speaker portoghese reale (o TTS in PT sul tuo telefono):
1. Crea una sessione → ottieni il codice (es. ABC123)
2. Apri `/projector/ABC123` su un secondo schermo
3. Premi rec sullo Speaker e parla per 10 secondi in portoghese
4. Controlla che entro ~7s sul proiettore appaia:
   - Testo portoghese piccolo (grigio)
   - Traduzione italiana enorme (bianca)
5. Cambia pill lingua sul proiettore → 🇬🇧 EN → il testo grande deve cambiare in inglese (dopo ~1-2s di traduzione Groq)
6. Cambia mic sullo speaker (se hai più di un ingresso audio) → riparti a registrare → verifica che la voce sia quella del nuovo mic (il testo deve riflettere quello che dici nel nuovo mic)

Se tutti e 6 gli step funzionano, l'app è pronta per un evento reale.
