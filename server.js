// pg-admin-lite — minimal pgAdmin4-style database management UI for the local Postgres.
// Bun built-ins only (Bun.serve, Bun.SQL, Bun.spawn). See ../CLAUDE.md conventions.
// Entry point: route dispatch + static serving. Logic lives in server/*.js modules.
import { PG, getPool, closePool, quoteIdent, validDbName, splitStatements, json, err, readBody } from "./server/db.js";
import { checkAuth, handleLogin } from "./server/auth.js";
import { fetchSchema, fetchFks, buildSuggestions, buildPath } from "./server/schema.js";
import { isMutating, recordAudit, listAudit, listSaved, createSaved, updateSaved, deleteSaved } from "./server/store.js";
import { friendlyError, handleExplain } from "./server/query.js";
import { handleAi, aiConfigured } from "./server/ai.js";

const PORT = Number(process.env.PORT || 4601);
const HOST = process.env.HOST || "0.0.0.0";

// ---------------------------------------------------------------- route handlers
async function handleApi(req, url, ip) {
  const path = url.pathname;
  const method = req.method;

  if (path === "/api/login" && method === "POST") {
    return handleLogin(req, ip);
  }

  if (!checkAuth(req, url)) return err("Unauthorized", 401);

  // ---- databases
  if (path === "/api/databases" && method === "GET") {
    const sql = getPool(PG.maintDb);
    const rows = await sql.unsafe(`
      SELECT d.datname AS name, pg_get_userbyid(d.datdba) AS owner,
             pg_database_size(d.datname) AS bytes,
             pg_encoding_to_char(d.encoding) AS encoding,
             (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname) AS connections
      FROM pg_database d WHERE NOT d.datistemplate ORDER BY d.datname`);
    return json({ databases: rows, ai: aiConfigured() });
  }
  if (path === "/api/databases" && method === "POST") {
    const body = await readBody(req);
    if (!body || !validDbName(body.name)) return err("Invalid database name");
    const sql = getPool(PG.maintDb);
    let ddl = `CREATE DATABASE ${quoteIdent(body.name)}`;
    if (body.owner) ddl += ` OWNER ${quoteIdent(body.owner)}`;
    if (body.template && validDbName(body.template)) ddl += ` TEMPLATE ${quoteIdent(body.template)}`;
    await sql.unsafe(ddl);
    recordAudit({ db: PG.maintDb, sql: ddl, command: "CREATE DATABASE", ok: true, ip });
    return json({ ok: true, ddl });
  }
  let m = path.match(/^\/api\/databases\/([^/]+)$/);
  if (m && method === "DELETE") {
    const name = decodeURIComponent(m[1]);
    if (!validDbName(name)) return err("Invalid database name");
    if (name === PG.maintDb) return err(`Refusing to drop the maintenance database (${PG.maintDb})`);
    await closePool(name); // drop our own connections first
    const sql = getPool(PG.maintDb);
    await sql.unsafe(`DROP DATABASE ${quoteIdent(name)} WITH (FORCE)`);
    recordAudit({ db: PG.maintDb, sql: `DROP DATABASE ${quoteIdent(name)} WITH (FORCE)`, command: "DROP DATABASE", ok: true, ip });
    return json({ ok: true });
  }

  // ---- saved queries (bun:sqlite, local — never written into user DBs)
  if (path === "/api/saved" && method === "GET") return json({ queries: listSaved() });
  if (path === "/api/saved" && method === "POST") {
    const body = await readBody(req);
    if (!body?.name?.trim() || typeof body.sql !== "string" || !body.sql.trim()) return err("Expected { name, sql }");
    try { return json({ id: createSaved({ name: body.name.trim(), sql: body.sql, db: body.db }) }); }
    catch (e) { return err(/UNIQUE/.test(e?.message || "") ? `A saved query named "${body.name.trim()}" already exists` : e.message); }
  }
  m = path.match(/^\/api\/saved\/(\d+)$/);
  if (m && method === "PUT") {
    const body = await readBody(req);
    if (!body?.name?.trim() || typeof body.sql !== "string") return err("Expected { name, sql }");
    return updateSaved(Number(m[1]), { name: body.name.trim(), sql: body.sql, db: body.db })
      ? json({ ok: true }) : err("Not found", 404);
  }
  if (m && method === "DELETE") {
    return deleteSaved(Number(m[1])) ? json({ ok: true }) : err("Not found", 404);
  }

  // ---- audit log (read-only; writes happen inside /api/query)
  if (path === "/api/audit" && method === "GET") {
    return json({ entries: listAudit(url.searchParams.get("limit")) });
  }

  const db = url.searchParams.get("db");
  const needDb = () => { if (!db || !validDbName(db)) throw new Error("Missing or invalid ?db= parameter"); };

  // ---- schema tree (FKs included for context-aware autocomplete)
  if (path === "/api/schema" && method === "GET") {
    needDb();
    const [schema, fks] = await Promise.all([fetchSchema(db), fetchFks(db)]);
    return json({ ...schema, fks });
  }

  // ---- query execution (DDL / DML / DCL)
  if (path === "/api/query" && method === "POST") {
    const body = await readBody(req);
    if (!body || !validDbName(body.db) || typeof body.sql !== "string") return err("Expected { db, sql }");
    const tServer = performance.now(); // request fully received — everything until the return is our cost
    const maxRows = Math.min(Number(body.maxRows) || 500, 5000);
    const stmts = splitStatements(body.sql);
    if (!stmts.length) return err("No statements to execute");
    const pool = getPool(body.db);
    const conn = await pool.reserve(); // one session: BEGIN/COMMIT and SET work across statements
    const results = [];
    try {
      for (const stmt of stmts) {
        const t0 = performance.now();
        try {
          const r = await conn.unsafe(stmt);
          const rows = Array.isArray(r) ? r : [];
          const rowCount = typeof r?.count === "number" && r.count > 0 ? r.count : rows.length;
          results.push({
            ok: true,
            statement: stmt.length > 200 ? stmt.slice(0, 200) + "…" : stmt,
            command: r?.command ?? null,
            rowCount,
            truncated: rows.length > maxRows,
            rows: rows.slice(0, maxRows),
            columns: rows.length ? Object.keys(rows[0]) : [],
            ms: Math.round(performance.now() - t0),
          });
          if (isMutating(stmt)) recordAudit({ db: body.db, sql: stmt, command: r?.command, rowCount, ok: true, ip });
        } catch (e) {
          results.push({
            ok: false,
            statement: stmt.length > 200 ? stmt.slice(0, 200) + "…" : stmt,
            error: e?.message || String(e),
            sqlstate: e?.errno ? String(e.errno) : null,
            ...(await friendlyError(e, body.db)),
            ms: Math.round(performance.now() - t0),
          });
          if (isMutating(stmt)) recordAudit({ db: body.db, sql: stmt, ok: false, ip, error: e?.message });
          try { await conn.unsafe("ROLLBACK"); } catch {} // clear aborted tx so the session is reusable
          break; // stop the batch at first error, like psql ON_ERROR_STOP
        }
      }
    } finally {
      conn.release();
    }
    // serverMs = receive→response-build (pool acquire + split + exec + row shaping); excludes final JSON encode
    return json({ results, serverMs: Math.round(performance.now() - tServer) });
  }

  // ---- AI proxy: NL→SQL generation + error fixing (key stays server-side)
  if (path === "/api/ai" && method === "POST") {
    const body = await readBody(req);
    if (!body || !validDbName(body.db)) return err("Expected { db, mode, … }");
    return handleAi(body);
  }

  // ---- EXPLAIN / query plan (ANALYZE refused server-side for mutating SQL)
  if (path === "/api/explain" && method === "POST") {
    const body = await readBody(req);
    if (!body || !validDbName(body.db) || typeof body.sql !== "string" || !body.sql.trim()) return err("Expected { db, sql }");
    try {
      return json(await handleExplain(body));
    } catch (e) {
      return json({ error: e?.message || String(e), sqlstate: e?.errno ? String(e.errno) : null,
        ...(await friendlyError(e, body.db)) }, 400);
    }
  }

  // ---- join suggestions
  if (path === "/api/joins" && method === "GET") {
    needDb();
    const [schema, fks] = await Promise.all([fetchSchema(db), fetchFks(db)]);
    const table = url.searchParams.get("table");
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    if (from && to) {
      const p = buildPath({ fks, columns: schema.columns }, from, to);
      return json(p ? { path: p } : { path: null, message: "No join path found between these tables" });
    }
    if (!table) return err("Pass ?table= or ?from=&to=");
    return json({ suggestions: buildSuggestions({ fks, columns: schema.columns, pks: schema.pks }, table) });
  }

  // ---- table definition: exact DDL (pg_dump) + index stats
  if (path === "/api/tabledef" && method === "GET") {
    needDb();
    const schema = url.searchParams.get("schema") || "public";
    const table = url.searchParams.get("table");
    if (!table) return err("Pass ?table=");
    const target = `${schema}.${table}`;
    const proc = Bun.spawn(["pg_dump", "-h", PG.host, "-p", String(PG.port), "-U", PG.user,
      "--no-password", "--schema-only", "--no-owner", "--no-privileges", "-t", target, db],
      { env: { ...process.env, PGPASSWORD: PG.password }, stdout: "pipe", stderr: "pipe" });
    const [raw, dumpErr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (code !== 0) return err(`pg_dump failed: ${dumpErr.slice(-500)}`, 500);
    // strip pg_dump preamble noise (SET/SELECT/comment lines), keep the actual DDL
    const ddl = raw.split("\n")
      .filter(l => !/^(SET |SELECT pg_catalog|\\|--($| )|$)/.test(l) || /^\s+/.test(l))
      .join("\n").replace(/\n{3,}/g, "\n\n").trim();
    const sql = getPool(db);
    const [indexes, stats] = await Promise.all([
      sql.unsafe(`
        SELECT s.indexrelname AS name, pg_get_indexdef(s.indexrelid) AS def,
               pg_relation_size(s.indexrelid) AS bytes, s.idx_scan AS scans,
               ix.indisunique AS is_unique, ix.indisprimary AS is_primary
        FROM pg_stat_user_indexes s
        JOIN pg_index ix ON ix.indexrelid = s.indexrelid
        WHERE s.schemaname = $1 AND s.relname = $2
        ORDER BY ix.indisprimary DESC, s.indexrelname`, [schema, table]),
      // per-column cardinality from the planner's statistics (NULL until ANALYZE has run)
      sql.unsafe(`
        SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
               NOT a.attnotnull AS nullable,
               st.n_distinct, st.null_frac, st.avg_width,
               c.reltuples::bigint AS est_rows
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_stats st ON st.schemaname = n.nspname AND st.tablename = c.relname AND st.attname = a.attname
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`, [schema, table]),
    ]);
    return json({ ddl, indexes, stats });
  }

  // ---- roles & grants (DCL support)
  if (path === "/api/roles" && method === "GET") {
    const sql = getPool(PG.maintDb);
    const roles = await sql.unsafe(`
      SELECT rolname AS name, rolsuper AS superuser, rolcreatedb AS createdb,
             rolcreaterole AS createrole, rolcanlogin AS login, rolconnlimit AS conn_limit
      FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname`);
    return json({ roles });
  }
  if (path === "/api/grants" && method === "GET") {
    needDb();
    const sql = getPool(db);
    const grants = await sql.unsafe(`
      SELECT grantee, table_schema AS schema, table_name AS table,
             string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
      FROM information_schema.role_table_grants
      WHERE table_schema NOT IN ('pg_catalog','information_schema')
      GROUP BY grantee, table_schema, table_name
      ORDER BY table_schema, table_name, grantee`);
    return json({ grants });
  }

  // ---- export (pg_dump)
  if (path === "/api/export" && method === "GET") {
    needDb();
    const format = url.searchParams.get("format") === "custom" ? "custom" : "plain";
    const args = ["pg_dump", "-h", PG.host, "-p", String(PG.port), "-U", PG.user,
      "--no-password", format === "custom" ? "-Fc" : "-Fp", db];
    const proc = Bun.spawn(args, {
      env: { ...process.env, PGPASSWORD: PG.password },
      stdout: "pipe", stderr: "pipe",
    });
    const ext = format === "custom" ? "dump" : "sql";
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return new Response(proc.stdout, {
      headers: {
        "content-type": format === "custom" ? "application/octet-stream" : "application/sql",
        "content-disposition": `attachment; filename="${db}-${stamp}.${ext}"`,
      },
    });
  }

  // ---- import (psql for .sql, pg_restore for custom-format dumps)
  if (path === "/api/import" && method === "POST") {
    needDb();
    const create = url.searchParams.get("create") === "1";
    const buf = new Uint8Array(await req.arrayBuffer());
    if (!buf.length) return err("Empty upload");
    if (create) {
      await getPool(PG.maintDb).unsafe(`CREATE DATABASE ${quoteIdent(db)}`);
    }
    const tmp = `/tmp/pg-admin-lite-import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await Bun.write(tmp, buf);
    const isCustom = buf.length >= 5 && String.fromCharCode(...buf.slice(0, 5)) === "PGDMP";
    const args = isCustom
      ? ["pg_restore", "-h", PG.host, "-p", String(PG.port), "-U", PG.user, "--no-password", "-d", db, "--no-owner", tmp]
      : ["psql", "-h", PG.host, "-p", String(PG.port), "-U", PG.user, "--no-password", "-d", db, "-v", "ON_ERROR_STOP=0", "-f", tmp];
    const proc = Bun.spawn(args, { env: { ...process.env, PGPASSWORD: PG.password }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    try { await Bun.file(tmp).delete(); } catch {}
    return json({ ok: code === 0, tool: isCustom ? "pg_restore" : "psql", exitCode: code,
      stdout: stdout.slice(-8000), stderr: stderr.slice(-8000) });
  }

  return err("Not found", 404);
}

// ---------------------------------------------------------------- server
Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 120,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || server.requestIP(req)?.address || "";
        const res = await handleApi(req, url, ip);
        // gzip JSON payloads >1 KB — big result sets shrink ~5-10x, which is most
        // of the browser-observed "wall" time on remote links (server time is ~1ms)
        if (res.headers.get("content-type")?.includes("application/json") &&
            !res.headers.get("content-encoding") &&
            /\bgzip\b/.test(req.headers.get("accept-encoding") || "")) {
          const buf = await res.arrayBuffer();
          if (buf.byteLength > 1024) {
            return new Response(Bun.gzipSync(new Uint8Array(buf), { level: 4 }), {
              status: res.status,
              headers: { "content-type": "application/json", "content-encoding": "gzip", "vary": "accept-encoding" },
            });
          }
          return new Response(buf, { status: res.status, headers: { "content-type": "application/json" } });
        }
        return res;
      } catch (e) {
        return err(e?.message || String(e), 500);
      }
    }
    const gzipOk = /\bgzip\b/.test(req.headers.get("accept-encoding") || "");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const f = Bun.file(import.meta.dir + "/public/index.html");
      if (gzipOk) return new Response(Bun.gzipSync(new Uint8Array(await f.arrayBuffer()), { level: 4 }),
        { headers: { "content-type": "text/html;charset=utf-8", "content-encoding": "gzip", "vary": "accept-encoding" } });
      return new Response(f);
    }
    if (url.pathname.startsWith("/js/") && !url.pathname.includes("..") && url.pathname.endsWith(".js")) {
      const f = Bun.file(import.meta.dir + "/public" + url.pathname);
      if (await f.exists()) {
        if (gzipOk) {
          return new Response(Bun.gzipSync(new Uint8Array(await f.arrayBuffer()), { level: 4 }),
            { headers: { "content-type": "text/javascript;charset=utf-8", "content-encoding": "gzip", "vary": "accept-encoding" } });
        }
        return new Response(f, { headers: { "content-type": "text/javascript;charset=utf-8" } });
      }
    }
    if (url.pathname.startsWith("/assets/") && !url.pathname.includes("..")) {
      const f = Bun.file(import.meta.dir + "/public" + url.pathname);
      if (await f.exists()) {
        // gzip text assets (css); fonts are already compressed
        if (gzipOk && url.pathname.endsWith(".css")) {
          return new Response(Bun.gzipSync(new Uint8Array(await f.arrayBuffer()), { level: 4 }),
            { headers: { "content-type": "text/css", "content-encoding": "gzip", "vary": "accept-encoding", "cache-control": "public, max-age=86400" } });
        }
        return new Response(f, { headers: { "cache-control": "public, max-age=86400" } });
      }
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`pg-admin-lite listening on http://${HOST}:${PORT} (Postgres ${PG.host}:${PG.port} as ${PG.user})`);
