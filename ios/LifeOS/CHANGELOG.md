# LifeOS iOS — registro delle versioni

Versione nel formato **MAJOR.MINOR.PATCH** (es. `1.0.0`). Il file `VERSION` è l'unica fonte di verità
e si aggiorna solo con `scripts/bump-version.py`, mai a mano.

## Legenda

| Numero | Quando sale | Esempi |
|---|---|---|
| **MAJOR** (1.x.x) | Cambio che rompe la compatibilità o ridisegno completo: nuova architettura, API del server incompatibile, app riprogettata. Raro, va deciso apposta. | nuovo server, cambio login, nuova grafica per tutta l'app |
| **MINOR** (x.1.x) | Una funzione o una sezione nuova, o un'integrazione nuova. | Apple Promemoria, Apple Salute, nuovo grafico, nuova scheda |
| **PATCH** (x.x.1) | Correzione di un errore o ritocco piccolo che non aggiunge funzioni. | bug, testo, colore, spaziatura, valore sbagliato |

Regole:
1. A ogni aggiornamento, anche minimo, sale **un solo** numero e **di uno**: da `1.0.0` si va solo a `2.0.0`, `1.1.0` o `1.0.1`.
2. Quando sale un numero, quelli a destra tornano a **0** (`1.4.2` + minor = `1.5.0`).
3. Nel dubbio tra due livelli si sceglie il **più basso**.
4. Ogni versione ha almeno una voce, sotto **Aggiunto**, **Modificato** o **Corretto**.
5. Il numero di build (`CURRENT_PROJECT_VERSION`) sale di 1 a ogni versione, qualunque sia il livello.

Comando:

```bash
python3 scripts/bump-version.py minor --added "Cosa è stato aggiunto"
python3 scripts/bump-version.py patch --fixed "Cosa è stato corretto" --changed "Cosa è cambiato"
```

<!-- nuove versioni sotto questa riga -->

## 1.14.1 — 2026-10-25

**Corretto**
- Rinnovo automatico sull'iPhone: il progetto Xcode viene rigenerato a ogni rinnovo, così include i file nuovi


## 1.14.0 — 2026-10-18

**Aggiunto**
- Finanze: categorie predefinite per spese ed entrate e possibilità di crearne di nuove
- Finanze: conti con il logo delle principali banche
- Finanze: ogni movimento ha descrizione, data scelta, categoria e conto, con il logo della banca nella lista


## 1.13.0 — 2026-10-15

**Aggiunto**
- Notifiche: resoconto IA del mattino (ora a scelta, predefinita 06:00) e avviso la sera prima di ogni verifica, attivabili da Profilo


## 1.12.11 — 2026-10-09

**Corretto**
- Salute: «Passi oggi» e «Kcal attive» mostravano sempre 0 perché leggevano il giorno di domani; ora mostrano i valori di oggi


## 1.12.10 — 2026-10-09

**Modificato**
- Salute: scrive in console i valori letti di passi e kcal attive per giorno (diagnosi)


## 1.12.9 — 2026-10-09

**Aggiunto**
- Salute: se passi o kcal attive sono a 0, la scheda spiega il motivo (permesso mancante o nessun dato in Salute)


## 1.12.8 — 2026-10-09

**Corretto**
- Salute: passi e kcal attive restavano a 0 — ora l'app richiede di nuovo a Apple Salute il permesso per passi e calorie attive, mostra l'errore invece di 0 e non carica più sul server valori a 0 che sovrascrivevano quelli buoni


## 1.12.7 — 2026-10-09

**Modificato**
- Salute: modifica annullata per errore (passi e kcal attive erano state tolte e sono state rimesse in 1.12.8)


## 1.12.6 — 2026-10-08

**Corretto**
- iPhone: tolta la capability iCloud, che i team di sviluppo personali non supportano e impediva l'installazione; il profilo si sincronizza comunque tramite il server


## 1.12.5 — 2026-10-08

**Corretto**
- Icona iPhone: ora è un'icona classica da 1024 px nel catalogo asset (il formato .icon non compariva sul telefono); su Mac resta l'icona in vetro


## 1.12.4 — 2026-10-08

**Corretto**
- Icona dell'app: ripristinato il disegno originale del segno (le modifiche precedenti facevano sparire il logo sul telefono)


## 1.12.3 — 2026-10-08

**Corretto**
- Icona dell'app: il segno usa solo curve di Bézier invece degli archi SVG, perché sul telefono l'icona usciva senza logo


## 1.12.2 — 2026-10-08

**Corretto**
- Icona dell'app (Mac e iPhone): il segno è ora una forma piena, così il vetro non crea più la piega diagonale dentro la L


## 1.12.1 — 2026-10-08

**Corretto**
- Mac: il logo (la L con il punto) era quasi invisibile in vetro a dimensione piccola; ora è bianco pieno come nel file del logo


## 1.12.0 — 2026-10-08

**Modificato**
- Nuova palette dei temi, senza viola: scuro grafite con riflessi freddi blu/petrolio, chiaro bianco-azzurro morbido (iPhone e Mac)


## 1.11.3 — 2026-10-08

**Modificato**
- Mac: sfondo più vivido perché il Liquid Glass delle card si veda; i dettagli (profilo, informazioni, investimento) si aprono in una finestra

**Corretto**
- Mac: tolta la barra grigia in alto (la barra di sistema è sostituita da una barra interna in Liquid Glass con logo, sezioni, BTC/EUNL, orologio, tema e profilo)


## 1.11.2 — 2026-10-08

**Corretto**
- Mac: tolta la barra grigia in alto, anche a schermo intero: lo sfondo ora passa sotto la barra del titolo


## 1.11.1 — 2026-10-08

**Corretto**
- Mac: logo e voci della barra in alto centrati nelle pillole in vetro (altezze fisse, logo fuori dalla pillola condivisa, orologio su una riga)


## 1.11.0 — 2026-10-08

**Modificato**
- App Mac ridisegnata come la web: barra in alto in Liquid Glass (logo, sezioni, BTC/EUNL, orologio, tema, profilo), card affiancate in righe, barra "Chiedi a Jarvis" in basso (⌘K)


## 1.10.0 — 2026-10-08

**Aggiunto**
- Salute condivisa: l'iPhone legge Apple Salute e carica i dati sul server, e Mac e web mostrano gli stessi numeri (passi, calorie attive, sonno, peso, battito a riposo)


## 1.9.0 — 2026-10-08

**Aggiunto**
- App nativa per macOS (target LifeOSMac): stessa app, con barra laterale, scorciatoie ⌘1–⌘5 e ⌘R per aggiornare

**Modificato**
- Codice condiviso tra iOS e macOS; su Mac Salute mostra che Apple Salute vive su iPhone


## 1.8.0 — 2026-10-08

**Aggiunto**
- Passkey iCloud per la web app: «Entra con passkey» nella pagina di accesso, registrazione e gestione da Profilo (Gestisci passkey). La password resta valida. L'app continua a usare la password


## 1.7.2 — 2026-10-08

**Corretto**
- Verifiche e compiti già passati non vengono più mostrati: il filtro è ora sul server, quindi vale anche per la web


## 1.7.1 — 2026-10-08

**Corretto**
- Home: le verifiche già passate non vengono più mostrate (restano quelle di oggi e dei giorni successivi)


## 1.7.0 — 2026-10-08

**Aggiunto**
- Siri e Comandi rapidi: «Chiedi a LifeOS» (la richiesta a voce va all'IA del server, che può aggiungere promemoria, spese, pasti ed eventi, e Siri legge la risposta) e «Aggiungi un promemoria con LifeOS» (direttamente nell'app Promemoria)


## 1.6.0 — 2026-10-08

**Aggiunto**
- Il tuo profilo: foto (dalla libreria o dalla tua scheda Contatti) e dati personali (nome, email, telefono, città, nascita, ruolo), salvati sul server e mostrati anche nella web app


## 1.5.0 — 2026-10-08

**Aggiunto**
- Profilo sincronizzato: tema, IA per sezione e calendari visibili sono salvati sul server (li vede anche la web app) e copiati su iCloud per i tuoi dispositivi

**Modificato**
- Il modello locale si chiama Groq anche sulla web (prima Qwen2.5)


## 1.4.0 — 2026-10-08

**Modificato**
- Interfaccia in Liquid Glass nativo di iOS 26 (glassEffect e GlassEffectContainer): schede, bottoni, campi, chip, fumetti della chat; barra delle tab che si riduce scorrendo. Prima di iOS 26 resta un vetro semitrasparente


## 1.3.0 — 2026-10-08

**Aggiunto**
- Home: scheda Briefing delle 6:00 con meteo e cose da fare di oggi (impegni e promemoria), presa dal messaggio del bot Telegram; "Leggi tutto" apre le cinque sezioni complete


## 1.2.0 — 2026-10-08

**Aggiunto**
- Logo vettoriale (una L con un punto) in Liquid Glass: icona dell'app e logo in accesso e Informazioni; sorgenti SVG in Branding/


## 1.1.0 — 2026-10-08

**Aggiunto**
- Schermata Informazioni in Profilo: versione e build, autore, server, collegamenti attivi e cronologia delle versioni letta dal registro


## 1.0.0 — 2026-10-08

Prima versione: tutta la web app LifeOS portata in nativo (SwiftUI, iOS 17+).

**Aggiunto**
- Accesso con utente e password del bridge (sessione a cookie), stesso server della web app.
- Home: prezzi BTC/EUNL, sessione con promemoria, abitudini del giorno, agenda a 7 giorni con scorrimento e filtro calendari, verifiche e compiti, automazioni.
- Dettaglio in un modal per eventi, verifiche e compiti.
- Interruttori per attivare e disattivare le automazioni cron (timer systemd solo in lettura).
- Promemoria con Apple Promemoria (EventKit): aggiunta e completamento.
- Finanze: patrimonio, conti, investimenti con grafico e acquisti, passività, movimenti, acquisti ricorrenti.
- Salute: nutrizione per giorno con i dati FatSecret, pasti con ricerca FatSecret o manuale, allenamenti, trend IA.
- Apple Salute (HealthKit): passi, calorie attive, sonno, peso, battito a riposo.
- Review settimanale delle abitudini.
- Profilo: abitudini, IA per sezione (Claude, Gemini, Groq), chiave Gemini, collegamento FatSecret, tema.
- Chat con le IA (pulsante ✦) in Home, Finanze, Salute e Review, con scelta del modello.
