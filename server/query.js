// query.js — friendly Postgres error explanations (SQLSTATE → plain language,
// Levenshtein "did you mean"), server-side destructive-SQL check, and EXPLAIN handler.
import { getPool } from "./db.js";
import { fetchSchema } from "./schema.js";

// ---------------------------------------------------------------- Levenshtein
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function nearest(target, candidates, maxDist = 3) {
  let best = null, bestD = maxDist + 1;
  const lo = target.toLowerCase();
  for (const c of candidates) {
    const d = lev(lo, c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  if (bestD <= Math.max(1, Math.min(maxDist, Math.floor(target.length / 3) + 1))) return best;
  // typo distance too far — fall back to substring containment (pnl → net_pnl)
  if (lo.length >= 3) {
    const contains = candidates.filter(c => c.toLowerCase().includes(lo));
    if (contains.length) return contains.sort((a, b) => a.length - b.length)[0];
  }
  return null;
}

// ---------------------------------------------------------------- friendly errors
// Bun.SQL puts the SQLSTATE in e.errno (e.g. 42703); message holds the PG text.
const SQLSTATE_TEXT = {
  "42703": "That column doesn't exist in the table(s) you're querying.",
  "42P01": "That table (or view) doesn't exist in this database — check the name and schema.",
  "42601": "PostgreSQL couldn't parse the SQL — there's a syntax error near the position shown.",
  "42883": "No function with that name and argument types — check spelling and argument types (casts often fix this).",
  "23505": "A row with this value already exists — the column has a UNIQUE constraint.",
  "23503": "Foreign-key violation — the referenced row doesn't exist (or rows still reference this one).",
  "23502": "A NOT NULL column is missing a value — supply it or give the column a DEFAULT.",
  "22P02": "A value couldn't be converted to the column's type (e.g. text into an integer column).",
  "42702": "The column name is ambiguous — qualify it with the table name or alias.",
  "25P02": "The transaction is aborted — a previous statement failed. ROLLBACK first, then retry.",
  "53300": "Too many connections to PostgreSQL — close idle sessions or raise the limit.",
  "42501": "Permission denied — the connected role lacks rights on this object.",
};

export async function friendlyError(e, db) {
  const state = String(e?.errno || "");
  const out = {};
  if (SQLSTATE_TEXT[state]) out.friendly = SQLSTATE_TEXT[state];
  // "did you mean" for unknown column / table
  if ((state === "42703" || state === "42P01") && db) {
    const msg = e.message || "";
    const m = msg.match(/"([^"]+)"/);
    if (m) {
      try {
        const schema = await fetchSchema(db);
        let names;
        if (state === "42703") {
          // `column "x" of relation "y" does not exist` names the table — scope to it
          const rel = msg.match(/of relation "([^"]+)"/)?.[1];
          const cols = rel ? schema.columns.filter(c => c.table === rel) : schema.columns;
          names = [...new Set(cols.map(c => c.name))];
        } else {
          names = schema.tables.map(t => t.name);
        }
        const hit = nearest(m[1], names.filter(n => n.toLowerCase() !== m[1].toLowerCase()));
        if (hit) out.didYouMean = hit;
      } catch { /* schema lookup is best-effort */ }
    }
  }
  return out;
}

// ---------------------------------------------------------------- destructive check (server-side)
// Mirror of the client classifyDanger — gate for EXPLAIN ANALYZE (which executes the query).
export function isDestructive(sql) {
  const clean = String(sql).replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return clean.split(";").map(s => s.trim()).filter(Boolean)
    .some(s => /^(drop|truncate|delete|update|insert|alter|create|grant|revoke|merge|call|do)\b/i.test(s));
}

// ---------------------------------------------------------------- EXPLAIN
function walkPlan(node, depth, out, analyzed) {
  const rows = Number(node["Plan Rows"] ?? 0);
  const actual = Number(node["Actual Rows"] ?? NaN);
  if (node["Node Type"] === "Seq Scan" && (analyzed ? actual : rows) > 10000) {
    out.hints.push(`Sequential scan on "${node["Relation Name"]}" over ~${(analyzed ? actual : rows).toLocaleString()} rows` +
      (node["Filter"] ? ` filtered by ${node["Filter"]} — an index on the filtered column(s) could help` : " — consider whether an index applies"));
  }
  if (analyzed && Number.isFinite(actual) && rows > 0) {
    const ratio = Math.max(actual, 1) / rows;
    if (ratio > 100 || ratio < 0.01) {
      out.hints.push(`Planner estimate is off ${ratio > 1 ? Math.round(ratio) : "1/" + Math.round(1 / ratio)}× on ${node["Node Type"]}` +
        (node["Relation Name"] ? ` ("${node["Relation Name"]}")` : "") + ` — run ANALYZE to refresh statistics`);
    }
  }
  if (node["Sort Method"] && /external/i.test(node["Sort Method"])) {
    out.hints.push(`Sort spilled to disk (${node["Sort Method"]}, ${node["Sort Space Used"] || "?"} kB) — consider raising work_mem or adding an index matching the ORDER BY`);
  }
  for (const child of node["Plans"] || []) walkPlan(child, depth + 1, out, analyzed);
}

export async function handleExplain({ db, sql, analyze }) {
  const wantAnalyze = !!analyze;
  let analyzed = wantAnalyze;
  let note = null;
  if (wantAnalyze && isDestructive(sql)) {
    analyzed = false;
    note = "ANALYZE actually executes the statement — refused for a mutating/DDL statement. Showing the plain plan instead.";
  }
  const stmt = `EXPLAIN (FORMAT JSON, VERBOSE${analyzed ? ", ANALYZE, BUFFERS" : ""}) ${sql}`;
  const pool = getPool(db);
  const conn = await pool.reserve();
  let raw;
  try {
    raw = await conn.unsafe(stmt);
  } finally {
    conn.release();
  }
  // FORMAT JSON returns one row with a "QUERY PLAN" column holding the JSON (array of {Plan, ...})
  const cell = Array.isArray(raw) && raw[0] ? Object.values(raw[0])[0] : null;
  const planDoc = typeof cell === "string" ? JSON.parse(cell) : cell;
  const root = Array.isArray(planDoc) ? planDoc[0] : planDoc;
  const out = { hints: [] };
  if (root?.Plan) walkPlan(root.Plan, 0, out, analyzed);
  // dedupe hints
  const hints = [...new Set(out.hints)].slice(0, 8);
  return { plan: root, hints, analyzed, note };
}
