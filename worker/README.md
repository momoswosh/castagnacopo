# Castagnacopo – backend (Cloudflare Workers + D1)

- `src/index.js` – il backend: stesse funzioni del vecchio Code.gs di Google Apps Script.
- `wrangler.toml` – configurazione del Worker e collegamento al database D1 `castagnacopo`.
- `schema.sql` – tabelle del database.

Il Worker è collegato a questo repository: ogni modifica a questa cartella viene pubblicata da sola (Workers Builds).
La password del report non è qui: nel database c'è solo la sua impronta (SHA-256).
