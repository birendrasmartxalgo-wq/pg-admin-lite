# pg-admin-lite

Minimal pgAdmin4-style web console for the local PostgreSQL (port **4601**, systemd unit `pg-admin-lite.service`, logs `/var/log/pg-admin-lite.log`). Bun built-ins only — `Bun.serve`, `Bun.SQL`, `Bun.spawn` — no npm deps. "The Ledger" design (light parchment/ink-blue/red-margin, accountant's-ledger aesthetic; dark "night ledger" variant via token overrides under `html.dark`, persisted as `pgal_dark` in localStorage): Tailwind 4.3 **standalone binary** (`tools/tailwindcss`, ARM64, no npm) + self-hosted fonts (Fraunces display serif, Libre Franklin UI, Space Mono data/SQL) + inline Lucide SVG icons — zero runtime CDN.

## Layout

- `server.js` — the whole backend. Auth (bearer token, password in `.env` `ADMIN_PASSWORD`), per-database `Bun.SQL` pool cache (`POOL_MAX=2` each — keep small, this box has had PG connection exhaustion), SQL statement splitter (handles `$tag$`, `E''`, comments), and all `/api/*` routes.
- `public/index.html` — the whole frontend, single file, vanilla JS. Features: click table → `SELECT * LIMIT 500`, autocomplete (keywords + live schema tables/columns, caret-positioned via mirror div), query history (localStorage, 100 entries, db/duration/rows per entry), per-table DDL & Indexes inspector tab, db+wall execution-time chips.
- `src/input.css` — Tailwind theme (`@theme` paper/ink/quill/rule color tokens + `*-led` status inks) + component layer (`.panel .btn .chip .led .mlabel .notch .gridbg .tab-btn .grid-table .sqlblock .toastmsg .ac-item`). **After editing index.html or input.css run `bun run css`** (regenerates `public/assets/tw.css`; class names inside JS template strings are scanned too). `tw.css` is served with a 1-day cache — bump the `?v=` query on the stylesheet link in index.html when shipping CSS changes.
- `public/assets/` — built `tw.css` + `fonts/*.woff2` (Fraunces, Libre Franklin, Space Mono — downloaded once from fontsource; served locally with 1-day cache).
- `.env` — `PG_*` superuser credentials (appuser), `ADMIN_PASSWORD`, `PORT`.

## API surface

| Route | Purpose |
|---|---|
| `POST /api/login` | password → bearer token (in-memory, 12 h) |
| `GET/POST/DELETE /api/databases[/:name]` | list / `CREATE DATABASE` / `DROP … WITH (FORCE)` (maintenance DB is drop-protected) |
| `POST /api/query {db, sql}` | DDL/DML/DCL; statements split client-safe and run sequentially on **one reserved connection** (so BEGIN/COMMIT spans statements); stops at first error + auto-ROLLBACK |
| `GET /api/schema?db=` | tables/columns/PKs for the sidebar tree |
| `GET /api/tabledef?db=&schema=&table=` | exact DDL via `pg_dump --schema-only -t` + index defs/sizes/scan counts from `pg_stat_user_indexes` |
| `GET /api/joins?db=&table=` or `&from=&to=` | join suggestions: FK (high) > 2-hop FK (medium) > shared column name+type (low); from/to does BFS over the FK graph with shared-column fallback |
| `GET /api/export?db=&format=plain\|custom` | streams `pg_dump` (`-Fp`/`-Fc`); token accepted via `?token=` for download links |
| `POST /api/import?db=&create=1` | raw body → temp file → `psql -f` or `pg_restore` (auto-detected by `PGDMP` magic) |
| `GET /api/roles`, `GET /api/grants?db=` | DCL inspection; mutations go through `/api/query` |

## Cautions

- Runs as the **superuser** `appuser` and is exposed on `0.0.0.0:4601` behind only the `.env` password — don't weaken the auth, and don't add unauthenticated routes.
- The sibling trading bot/dashboard share this Postgres. Don't drop/alter `paperbot` from here casually; the bot is memory-authoritative for config (see `/var/www/CLAUDE.md`).
- DB names are validated (`validDbName`) and identifiers quoted via `quoteIdent` everywhere they're interpolated — keep that invariant for any new route.
