# Castagnacopo – Le castagne di Caprese

Pagina ordini: https://castagnacopo.boneggio.it
Report: https://castagnacopo.boneggio.it/report.html

## 1. Google Sheet (archivio ordini)
1. Crea un nuovo Foglio Google chiamato "Castagnacopo ordini".
2. Menu **Estensioni > Apps Script**, cancella il contenuto e incolla `Code.gs`.
3. Cambia `REPORT_KEY` con la tua password per il report. Salva.
4. Seleziona la funzione `setup` e premi **Esegui** (autorizza l'accesso al tuo account).
5. **Distribuisci > Nuova distribuzione > tipo: App web**
   - Esegui come: **Me** · Chi ha accesso: **Chiunque**
6. Copia l'URL che finisce con `/exec`.

## 2. Collega le pagine
In `index.html` e `report.html` sostituisci `INCOLLA_QUI_URL_APPS_SCRIPT` con quell'URL.

## 3. GitHub Pages
1. Nuovo repository pubblico `castagnacopo`, carica: `index.html`, `report.html`, `CNAME`, `logo.svg`, `og-image.jpg`, `apple-touch-icon.png` (e `cover.jpg`, vedi sotto).
2. **Settings > Pages**: Source = branch `main`, cartella `/ (root)`.
3. Custom domain: `castagnacopo.boneggio.it` → Save, poi spunta **Enforce HTTPS** quando disponibile.

## 4. DNS (dal pannello del dominio boneggio.it)
Record **CNAME**: nome `castagnacopo` → valore `TUOUTENTE.github.io`

## Note
- Se modifichi `Code.gs`: Distribuisci > Gestisci distribuzioni > matita > Versione: **Nuova versione** (l'URL resta lo stesso).
- Gli ordini si vedono anche direttamente nel Foglio Google (puoi correggerli o cancellarli lì).

## Grafica
- **Foto di copertina**: carica una tua foto chiamata esattamente `cover.jpg` (orizzontale, circa 1600 px di larghezza, sotto i 500 KB). Se manca, la testata usa uno sfondo autunnale disegnato.
- **Testo di benvenuto e date**: in `index.html` cerca `TESTO DI BENVENUTO` e modifica le frasi e le voci "da definire".
- **Anteprima su WhatsApp**: usa `og-image.jpg`. WhatsApp la mette in cache: se la cambi, può servire qualche ora.
