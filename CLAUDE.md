# pg-admin-lite

pgAdmin4-style web console for the local PostgreSQL (port **4601**, systemd unit `pg-admin-lite.service`, logs `/var/log/pg-admin-lite.log`). Bun built-ins only — `Bun.serve`, `Bun.SQL`, `Bun.spawn`, `bun:sqlite`, native `fetch` — no npm deps. "The Ledger" design (light parchment/ink-blue/red-margin, accountant's-ledger aesthetic; dark "night ledger" variant via token overrides under `html.dark`, persisted as `pgal_dark` in localStorage): Tailwind 4.3 **standalone binary** (`tools/tailwindcss`, ARM64, no npm) + self-hosted fonts (Fraunces display serif, Libre Franklin UI, Space Mono data/SQL) + inline Lucide SVG icons — zero runtime CDN.

## Layout

- `server.js` — entry point: route dispatch (`handleApi`), static serving (`/`, `/js/*`, `/assets/*`), gzip wrapper. Logic lives in `server/`:
  - `server/db.js` — per-database `Bun.SQL` pool cache (`POOL_MAX=2` each — keep small, this box has had PG connection exhaustion), `quoteIdent`/`quoteLit`/`validDbName`, SQL statement splitter (handles `$tag$`, `E''`, comments), `json`/`err` helpers.
  - `server/auth.js` — bearer-token sessions (12 h, in-memory) + login with per-IP rate limit (5 attempts / 15 min → 429, reset on success).
  - `server/schema.js` — `fetchSchema` (tables/columns/PKs), `fetchFks`, join-suggestion builder + BFS path finder.
  - `server/query.js` — friendly error mapper (SQLSTATE from `e.errno` → plain language; Levenshtein + substring "did you mean", scoped to the relation named in the error), server-side destructive-SQL check, `/api/explain` handler (refuses ANALYZE for mutating SQL — ANALYZE executes the query).
  - `server/ai.js` — Claude API proxy (raw `fetch` to `api.anthropic.com`, model `claude-opus-4-8` or `AI_MODEL`, adaptive thinking, schema summary in a `cache_control` system block, 60 s timeout). Key stays server-side; upstream errors mapped to generic messages.
  - `server/store.js` — `bun:sqlite` at `data/pgadmin.sqlite` (WAL): `saved_queries` + `audit_log`. **Deliberately not in Postgres** — this tool manages many DBs and must not write into them.
- `public/index.html` — markup only; the JS lives in `public/js/*.js`, plain `<script>` tags in dependency order (shared globals, no modules/bundler):
  `core.js` (icons, helpers, `api()`, modal, danger guard, `sqlLit`) → `app.js` (state, auth, tabs, sidebar) → `console.js` (run/browse/keyset pagination/cell edit/EXPLAIN viewer/history) → `autocomplete.js` (context-aware: alias tracking, in-scope columns, FK JOIN snippets) → `builder.js` (create/alter table forms + insert-row modal) → `joins.js` → `transfer.js` → `access.js` (+ audit panel) → `saved.js` → `ai.js` (Ask AI + Fix with AI) → `boot.js` (init).
- `src/input.css` — Tailwind theme + component layer. **After editing markup/JS class names run `bun run css`** (auto-scans `public/` including JS template strings) and bump the `?v=` query on the stylesheet link in index.html.
- `data/` — gitignored `bun:sqlite` store (saved queries, audit log).
- `.env` — `PG_*` superuser creds (appuser), `ADMIN_PASSWORD`, `PORT`; optional `ANTHROPIC_API_KEY` + `AI_MODEL` to enable the AI features (UI buttons stay disabled without the key).

## API surface

| Route | Purpose |
|---|---|
| `POST /api/login` | password → bearer token (in-memory, 12 h); per-IP rate-limited |
| `GET/POST/DELETE /api/databases[/:name]` | list / `CREATE DATABASE` / `DROP … WITH (FORCE)` (maintenance DB drop-protected); GET also returns `ai` flag |
| `POST /api/query {db, sql}` | DDL/DML/DCL; one reserved connection per batch (BEGIN/COMMIT spans statements); stops at first error + auto-ROLLBACK; failed statements carry `sqlstate`/`friendly`/`didYouMean`; **mutations are audit-logged** |
| `POST /api/explain {db, sql, analyze}` | `EXPLAIN (FORMAT JSON …)` + heuristics (`hints`); ANALYZE refused server-side for mutating SQL |
| `POST /api/ai {db, mode, question\|sql+error}` | Claude proxy: `generate` (NL→SQL) / `fix` (correct failed SQL); returns `{sql, explanation}`; 503 when unconfigured |
| `GET /api/schema?db=` | tables/columns/PKs **+ FKs** (sidebar tree + autocomplete) |
| `GET /api/tabledef?db=&schema=&table=` | exact DDL via `pg_dump --schema-only -t` + index defs/sizes/scan counts |
| `GET /api/joins?db=&table=` or `&from=&to=` | join suggestions: FK > 2-hop FK > shared column; BFS path with shared-column fallback |
| `GET/POST/PUT/DELETE /api/saved[/:id]` | saved-queries CRUD (bun:sqlite) |
| `GET /api/audit?limit=` | read-only audit log (writes happen inside `/api/query`) |
| `GET /api/export?db=&format=plain\|custom` | streams `pg_dump`; token accepted via `?token=` for download links |
| `POST /api/import?db=&create=1` | raw body → temp file → `psql -f` or `pg_restore` (auto-detected by `PGDMP` magic) |
| `GET /api/roles`, `GET /api/grants?db=` | DCL inspection; mutations go through `/api/query` |

## Cautions

- Runs as the **superuser** `appuser` and is exposed on `0.0.0.0:4601` behind only the `.env` password — don't weaken the auth, and don't add unauthenticated routes.
- The sibling trading bot/dashboard share this Postgres. Don't drop/alter `paperbot` from here casually; the bot is memory-authoritative for config (see `/var/www/CLAUDE.md`).
- DB names are validated (`validDbName`) and identifiers quoted via `quoteIdent` everywhere they're interpolated — keep that invariant for any new route.
- `ANTHROPIC_API_KEY` must never reach the browser: AI calls go through `/api/ai` only, and upstream error bodies are logged server-side, not echoed. Generated SQL is inserted into the editor for review — never auto-executed.
- The audit log and saved queries live in `data/pgadmin.sqlite` — never create pg-admin tables inside user databases.
