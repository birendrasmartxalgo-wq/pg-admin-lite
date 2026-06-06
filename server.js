// pg-admin-lite — minimal pgAdmin4-style database management UI for the local Postgres.
// Bun built-ins only (Bun.serve, Bun.SQL, Bun.spawn). See ../CLAUDE.md conventions.
import { SQL } from "bun";

const PORT = Number(process.env.PORT || 4601);
const HOST = process.env.HOST || "0.0.0.0";
const PG = {
  host: process.env.PG_HOST || "localhost",
  port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER || "appuser",
  password: process.env.PG_PASSWORD || "",
  maintDb: process.env.PG_MAINT_DB || "postgres",
};
const POOL_MAX = Number(process.env.POOL_MAX || 2);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD is not set in .env — refusing to start.");
  process.exit(1);
}

// ---------------------------------------------------------------- pools
const pools = new Map(); // dbname -> SQL
function getPool(db) {
  if (!pools.has(db)) {
    pools.set(db, new SQL({
      hostname: PG.host, port: PG.port, username: PG.user,
      password: PG.password, database: db, max: POOL_MAX, idleTimeout: 60,
    }));
  }
  return pools.get(db);
}
async function closePool(db) {
  const p = pools.get(db);
  if (p) { pools.delete(db); try { await p.close(); } catch {} }
}

const quoteIdent = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const quoteLit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const validDbName = (s) => typeof s === "string" && s.length > 0 && s.length <= 63 && !/[\0\/\\\s"]/.test(s);

// ---------------------------------------------------------------- auth
const sessions = new Map(); // token -> expiry epoch ms
const SESSION_TTL = 12 * 60 * 60 * 1000;
function makeToken() {
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return Buffer.from(b).toString("base64url");
}
function checkAuth(req, url) {
  const h = req.headers.get("authorization");
  let token = h && h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) token = url.searchParams.get("token"); // for <a download> export links
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

// ---------------------------------------------------------------- SQL statement splitter
// Splits a script on top-level semicolons, respecting '…', E'…', "…", $tag$…$tag$,
// -- line comments and (nested) /* */ block comments.
function splitStatements(script) {
  const out = [];
  let i = 0, start = 0, n = script.length;
  while (i < n) {
    const c = script[i];
    if (c === "'") {
      const escaping = /[eE]/.test(script[i - 1] || "") && !/[a-zA-Z0-9_]/.test(script[i - 2] || "");
      i++;
      while (i < n) {
        if (escaping && script[i] === "\\") { i += 2; continue; }
        if (script[i] === "'") { if (script[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
    } else if (c === '"') {
      i++;
      while (i < n) { if (script[i] === '"') { if (script[i + 1] === '"') { i += 2; continue; } i++; break; } i++; }
    } else if (c === "$") {
      const m = /^\$[a-zA-Z_]?[a-zA-Z0-9_]*\$/.exec(script.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = script.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
      } else i++;
    } else if (c === "-" && script[i + 1] === "-") {
      const nl = script.indexOf("\n", i); i = nl === -1 ? n : nl + 1;
    } else if (c === "/" && script[i + 1] === "*") {
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (script[i] === "/" && script[i + 1] === "*") { depth++; i += 2; }
        else if (script[i] === "*" && script[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
    } else if (c === ";") {
      const stmt = script.slice(start, i).trim();
      if (stmt) out.push(stmt);
      i++; start = i;
    } else i++;
  }
  const tail = script.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

// ---------------------------------------------------------------- helpers
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const err = (message, status = 400) => json({ error: message }, status);

async function readBody(req) { try { return await req.json(); } catch { return null; } }

// ---------------------------------------------------------------- schema / relations queries
async function fetchSchema(db) {
  const sql = getPool(db);
  const tables = await sql.unsafe(`
    SELECT n.nspname AS schema, c.relname AS name,
           CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' WHEN 'p' THEN 'table' END AS kind,
           pg_total_relation_size(c.oid) AS bytes,
           c.reltuples::bigint AS est_rows
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','v','m','p')
      AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
    ORDER BY n.nspname, c.relname`);
  const columns = await sql.unsafe(`
    SELECT table_schema AS schema, table_name AS table, column_name AS name,
           data_type AS type, is_nullable = 'YES' AS nullable, column_default AS dflt,
           ordinal_position AS pos
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog','information_schema')
    ORDER BY table_schema, table_name, ordinal_position`);
  const pks = await sql.unsafe(`
    SELECT n.nspname AS schema, c.relname AS table,
           (SELECT array_agg(a.attname ORDER BY x.ord)
              FROM unnest(con.conkey) WITH ORDINALITY x(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS cols
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype = 'p' AND n.nspname NOT IN ('pg_catalog','information_schema')`);
  return { tables, columns, pks };
}

async function fetchFks(db) {
  const sql = getPool(db);
  return await sql.unsafe(`
    SELECT ns1.nspname AS src_schema, c1.relname AS src_table,
           ns2.nspname AS dst_schema, c2.relname AS dst_table,
           (SELECT array_agg(a.attname ORDER BY x.ord)
              FROM unnest(con.conkey) WITH ORDINALITY x(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS src_cols,
           (SELECT array_agg(a.attname ORDER BY x.ord)
              FROM unnest(con.confkey) WITH ORDINALITY x(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = x.attnum) AS dst_cols,
           con.conname AS name
    FROM pg_constraint con
    JOIN pg_class c1 ON c1.oid = con.conrelid
    JOIN pg_namespace ns1 ON ns1.oid = c1.relnamespace
    JOIN pg_class c2 ON c2.oid = con.confrelid
    JOIN pg_namespace ns2 ON ns2.oid = c2.relnamespace
    WHERE con.contype = 'f'
      AND ns1.nspname NOT IN ('pg_catalog','information_schema')`);
}

// ---------------------------------------------------------------- join suggestions
const tkey = (schema, table) => `${schema}.${table}`;
const fqtn = (schema, table) =>
  (schema === "public" ? quoteIdent(table) : quoteIdent(schema) + "." + quoteIdent(table));

function joinSql(steps) {
  // steps: [{schema,table,alias}, {schema,table,alias,on:[[lAlias,lCol,rCol],…]}, …]
  let sqlText = `SELECT ${steps.map(s => s.alias + ".*").join(", ")}\nFROM ${fqtn(steps[0].schema, steps[0].table)} ${steps[0].alias}`;
  for (let i = 1; i < steps.length; i++) {
    const s = steps[i];
    const conds = s.on.map(([la, lc, rc]) => `${la}.${quoteIdent(lc)} = ${s.alias}.${quoteIdent(rc)}`).join(" AND ");
    sqlText += `\nJOIN ${fqtn(s.schema, s.table)} ${s.alias} ON ${conds}`;
  }
  return sqlText + "\nLIMIT 100;";
}

function buildSuggestions({ fks, columns, pks }, target) {
  const colsByTable = new Map();
  for (const c of columns) {
    const k = tkey(c.schema, c.table);
    if (!colsByTable.has(k)) colsByTable.set(k, []);
    colsByTable.get(k).push(c);
  }
  const pkByTable = new Map(pks.map(p => [tkey(p.schema, p.table), p.cols || []]));
  const suggestions = [];
  const [tSchema, tTable] = target.includes(".") ? target.split(".", 2) : ["public", target];
  const tk = tkey(tSchema, tTable);

  // 1. outgoing FKs (high confidence)
  for (const f of fks) {
    if (tkey(f.src_schema, f.src_table) !== tk) continue;
    suggestions.push({
      kind: "fk", confidence: "high",
      title: `${tTable} → ${f.dst_table} (FK ${f.name})`,
      detail: `Foreign key: ${f.src_cols.join(", ")} → ${f.dst_table}(${f.dst_cols.join(", ")})`,
      sql: joinSql([
        { schema: tSchema, table: tTable, alias: "t1" },
        { schema: f.dst_schema, table: f.dst_table, alias: "t2",
          on: f.src_cols.map((c, i) => ["t1", c, f.dst_cols[i]]) },
      ]),
    });
  }
  // 2. incoming FKs (high confidence, reverse direction)
  for (const f of fks) {
    if (tkey(f.dst_schema, f.dst_table) !== tk) continue;
    suggestions.push({
      kind: "fk-reverse", confidence: "high",
      title: `${tTable} ← ${f.src_table} (referenced by FK ${f.name})`,
      detail: `${f.src_table}(${f.src_cols.join(", ")}) references ${tTable}(${f.dst_cols.join(", ")})`,
      sql: joinSql([
        { schema: tSchema, table: tTable, alias: "t1" },
        { schema: f.src_schema, table: f.src_table, alias: "t2",
          on: f.dst_cols.map((c, i) => ["t1", c, f.src_cols[i]]) },
      ]),
    });
  }
  // 3. two-hop FK paths through an intermediate table
  for (const f1 of fks) {
    if (tkey(f1.src_schema, f1.src_table) !== tk) continue;
    const midK = tkey(f1.dst_schema, f1.dst_table);
    for (const f2 of fks) {
      if (tkey(f2.src_schema, f2.src_table) !== midK) continue;
      if (tkey(f2.dst_schema, f2.dst_table) === tk) continue;
      suggestions.push({
        kind: "fk-path", confidence: "medium",
        title: `${tTable} → ${f1.dst_table} → ${f2.dst_table} (2-hop)`,
        detail: `Chain through ${f1.dst_table}`,
        sql: joinSql([
          { schema: tSchema, table: tTable, alias: "t1" },
          { schema: f1.dst_schema, table: f1.dst_table, alias: "t2",
            on: f1.src_cols.map((c, i) => ["t1", c, f1.dst_cols[i]]) },
          { schema: f2.dst_schema, table: f2.dst_table, alias: "t3",
            on: f2.src_cols.map((c, i) => ["t2", c, f2.dst_cols[i]]) },
        ]),
      });
    }
  }
  // 4. shared column name + type heuristic (e.g. security_id across tick/DB tables)
  const myCols = colsByTable.get(tk) || [];
  const seen = new Set(suggestions.map(s => s.title));
  for (const [otherK, otherCols] of colsByTable) {
    if (otherK === tk) continue;
    const [oSchema, oTable] = otherK.split(".");
    const matches = [];
    for (const mc of myCols) {
      const oc = otherCols.find(o => o.name === mc.name && o.type === mc.type);
      if (!oc) continue;
      if (/^(created_at|updated_at|id|name|status|mode|notes|description)$/i.test(mc.name)) continue; // generic noise
      matches.push(mc.name);
    }
    if (!matches.length) continue;
    const otherPk = pkByTable.get(otherK) || [];
    const isPkMatch = matches.some(m => otherPk.includes(m));
    const title = `${tTable} ~ ${oTable} on shared column${matches.length > 1 ? "s" : ""} ${matches.join(", ")}`;
    if (seen.has(title)) continue;
    suggestions.push({
      kind: "shared-column", confidence: isPkMatch ? "medium" : "low",
      title,
      detail: `Same column name & type${isPkMatch ? " (matches the other table's primary key)" : ""} — verify semantics before trusting`,
      sql: joinSql([
        { schema: tSchema, table: tTable, alias: "t1" },
        { schema: oSchema, table: oTable, alias: "t2", on: matches.map(m => ["t1", m, m]) },
      ]),
    });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  suggestions.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
  return suggestions;
}

function buildPath({ fks, columns }, from, to) {
  // BFS over FK edges (both directions); falls back to shared-column edges.
  const edges = new Map(); // key -> [{to, on:[[lCol,rCol]], via}]
  const addEdge = (a, b, on, via) => {
    if (!edges.has(a)) edges.set(a, []);
    edges.get(a).push({ to: b, on, via });
  };
  for (const f of fks) {
    const a = tkey(f.src_schema, f.src_table), b = tkey(f.dst_schema, f.dst_table);
    addEdge(a, b, f.src_cols.map((c, i) => [c, f.dst_cols[i]]), `FK ${f.name}`);
    addEdge(b, a, f.dst_cols.map((c, i) => [c, f.src_cols[i]]), `FK ${f.name} (reverse)`);
  }
  const colsByTable = new Map();
  for (const c of columns) {
    const k = tkey(c.schema, c.table);
    if (!colsByTable.has(k)) colsByTable.set(k, []);
    colsByTable.get(k).push(c);
  }
  const norm = (t) => (t.includes(".") ? t : "public." + t);
  const src = norm(from), dst = norm(to);

  const bfs = (useShared) => {
    const allEdges = new Map(edges);
    if (useShared) {
      const keys = [...colsByTable.keys()];
      for (const a of keys) for (const b of keys) {
        if (a === b) continue;
        const shared = (colsByTable.get(a) || [])
          .filter(ca => !/^(created_at|updated_at|id|name|status|mode)$/i.test(ca.name))
          .filter(ca => (colsByTable.get(b) || []).some(cb => cb.name === ca.name && cb.type === ca.type))
          .map(ca => [ca.name, ca.name]);
        if (shared.length) {
          if (!allEdges.has(a)) allEdges.set(a, []);
          allEdges.get(a).push({ to: b, on: shared, via: `shared column ${shared.map(s => s[0]).join(", ")}` });
        }
      }
    }
    const prev = new Map([[src, null]]);
    const q = [src];
    while (q.length) {
      const cur = q.shift();
      if (cur === dst) break;
      for (const e of allEdges.get(cur) || []) {
        if (prev.has(e.to)) continue;
        prev.set(e.to, { from: cur, edge: e });
        q.push(e.to);
      }
    }
    if (!prev.has(dst)) return null;
    const chain = [];
    let cur = dst;
    while (prev.get(cur)) { chain.unshift({ table: cur, ...prev.get(cur) }); cur = prev.get(cur).from; }
    return chain;
  };

  const chain = bfs(false) || bfs(true);
  if (!chain) return null;
  const steps = [{ schema: src.split(".")[0], table: src.split(".")[1], alias: "t1" }];
  const aliasOf = new Map([[src, "t1"]]);
  const vias = [];
  chain.forEach((step, i) => {
    const alias = "t" + (i + 2);
    aliasOf.set(step.table, alias);
    const [sch, tbl] = step.table.split(".");
    steps.push({ schema: sch, table: tbl, alias, on: step.edge.on.map(([l, r]) => [aliasOf.get(step.from), l, r]) });
    vias.push(step.edge.via);
  });
  return { sql: joinSql(steps), via: vias };
}

// ---------------------------------------------------------------- route handlers
async function handleApi(req, url) {
  const path = url.pathname;
  const method = req.method;

  if (path === "/api/login" && method === "POST") {
    const body = await readBody(req);
    if (!body || body.password !== ADMIN_PASSWORD) return err("Invalid password", 401);
    const token = makeToken();
    sessions.set(token, Date.now() + SESSION_TTL);
    return json({ token });
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
    return json({ databases: rows });
  }
  if (path === "/api/databases" && method === "POST") {
    const body = await readBody(req);
    if (!body || !validDbName(body.name)) return err("Invalid database name");
    const sql = getPool(PG.maintDb);
    let ddl = `CREATE DATABASE ${quoteIdent(body.name)}`;
    if (body.owner) ddl += ` OWNER ${quoteIdent(body.owner)}`;
    if (body.template && validDbName(body.template)) ddl += ` TEMPLATE ${quoteIdent(body.template)}`;
    await sql.unsafe(ddl);
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
    return json({ ok: true });
  }

  const db = url.searchParams.get("db");
  const needDb = () => { if (!db || !validDbName(db)) throw new Error("Missing or invalid ?db= parameter"); };

  // ---- schema tree
  if (path === "/api/schema" && method === "GET") {
    needDb();
    return json(await fetchSchema(db));
  }

  // ---- query execution (DDL / DML / DCL)
  if (path === "/api/query" && method === "POST") {
    const body = await readBody(req);
    if (!body || !validDbName(body.db) || typeof body.sql !== "string") return err("Expected { db, sql }");
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
          results.push({
            ok: true,
            statement: stmt.length > 200 ? stmt.slice(0, 200) + "…" : stmt,
            command: r?.command ?? null,
            rowCount: typeof r?.count === "number" && r.count > 0 ? r.count : rows.length,
            truncated: rows.length > maxRows,
            rows: rows.slice(0, maxRows),
            columns: rows.length ? Object.keys(rows[0]) : [],
            ms: Math.round(performance.now() - t0),
          });
        } catch (e) {
          results.push({
            ok: false,
            statement: stmt.length > 200 ? stmt.slice(0, 200) + "…" : stmt,
            error: e?.message || String(e),
            ms: Math.round(performance.now() - t0),
          });
          try { await conn.unsafe("ROLLBACK"); } catch {} // clear aborted tx so the session is reusable
          break; // stop the batch at first error, like psql ON_ERROR_STOP
        }
      }
    } finally {
      conn.release();
    }
    return json({ results });
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
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, url);
      } catch (e) {
        return err(e?.message || String(e), 500);
      }
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(import.meta.dir + "/public/index.html"));
    }
    if (url.pathname.startsWith("/assets/") && !url.pathname.includes("..")) {
      const f = Bun.file(import.meta.dir + "/public" + url.pathname);
      if (await f.exists()) {
        return new Response(f, { headers: { "cache-control": "public, max-age=86400" } });
      }
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`pg-admin-lite listening on http://${HOST}:${PORT} (Postgres ${PG.host}:${PG.port} as ${PG.user})`);
