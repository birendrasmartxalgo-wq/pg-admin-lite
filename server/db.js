// db.js — Postgres connection pools, identifier/literal quoting, statement splitter,
// and tiny HTTP helpers shared by every route module. Bun built-ins only.
import { SQL } from "bun";

export const PG = {
  host: process.env.PG_HOST || "localhost",
  port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER || "appuser",
  password: process.env.PG_PASSWORD || "",
  maintDb: process.env.PG_MAINT_DB || "postgres",
};
export const POOL_MAX = Number(process.env.POOL_MAX || 2);

// ---------------------------------------------------------------- pools
const pools = new Map(); // dbname -> SQL
export function getPool(db) {
  if (!pools.has(db)) {
    pools.set(db, new SQL({
      hostname: PG.host, port: PG.port, username: PG.user,
      password: PG.password, database: db, max: POOL_MAX, idleTimeout: 60,
    }));
  }
  return pools.get(db);
}
export async function closePool(db) {
  const p = pools.get(db);
  if (p) { pools.delete(db); try { await p.close(); } catch {} }
}

export const quoteIdent = (s) => '"' + String(s).replace(/"/g, '""') + '"';
export const quoteLit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
export const validDbName = (s) => typeof s === "string" && s.length > 0 && s.length <= 63 && !/[\0\/\\\s"]/.test(s);

// ---------------------------------------------------------------- SQL statement splitter
// Splits a script on top-level semicolons, respecting '…', E'…', "…", $tag$…$tag$,
// -- line comments and (nested) /* */ block comments.
export function splitStatements(script) {
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

// ---------------------------------------------------------------- HTTP helpers
export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
export const err = (message, status = 400) => json({ error: message }, status);

export async function readBody(req) { try { return await req.json(); } catch { return null; } }
