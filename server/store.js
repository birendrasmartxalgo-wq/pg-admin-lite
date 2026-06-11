// store.js — local bun:sqlite store for saved queries + audit log.
// Deliberately NOT in Postgres: this tool manages many DBs and must not write
// into user databases (the trading bot's `paperbot` especially).
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

const DATA_DIR = import.meta.dir + "/../data";
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DATA_DIR + "/pgadmin.sqlite", { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS saved_queries (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sql TEXT NOT NULL,
    db TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    db TEXT,
    sql TEXT,
    command TEXT,
    row_count INTEGER,
    ok INTEGER,
    ip TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
`);

// ---------------------------------------------------------------- audit log
const MUTATING_RE = /^\s*(insert|update|delete|create|alter|drop|truncate|grant|revoke|vacuum|reindex)\b/i;
export const isMutating = (stmt) => MUTATING_RE.test(stmt);

const insAudit = db.prepare(
  "INSERT INTO audit_log (at, db, sql, command, row_count, ok, ip, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
export function recordAudit({ db: dbName, sql, command, rowCount, ok, ip, error }) {
  try {
    insAudit.run(Date.now(), dbName ?? null, String(sql).slice(0, 20000), command ?? null,
      rowCount ?? null, ok ? 1 : 0, ip ?? null, error ? String(error).slice(0, 2000) : null);
  } catch (e) { console.error("audit write failed:", e?.message); }
}
const selAudit = db.prepare("SELECT * FROM audit_log ORDER BY at DESC LIMIT ?");
export function listAudit(limit = 200) {
  return selAudit.all(Math.min(Math.max(Number(limit) || 200, 1), 2000));
}

// ---------------------------------------------------------------- saved queries
const selSaved = db.prepare("SELECT id, name, sql, db, created_at, updated_at FROM saved_queries ORDER BY updated_at DESC");
const insSaved = db.prepare("INSERT INTO saved_queries (name, sql, db, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
const updSaved = db.prepare("UPDATE saved_queries SET name = ?, sql = ?, db = ?, updated_at = ? WHERE id = ?");
const delSaved = db.prepare("DELETE FROM saved_queries WHERE id = ?");

export function listSaved() { return selSaved.all(); }
export function createSaved({ name, sql, db: dbName }) {
  const now = Date.now();
  const r = insSaved.run(String(name).slice(0, 200), String(sql), dbName ?? null, now, now);
  return Number(r.lastInsertRowid);
}
export function updateSaved(id, { name, sql, db: dbName }) {
  return updSaved.run(String(name).slice(0, 200), String(sql), dbName ?? null, Date.now(), id).changes > 0;
}
export function deleteSaved(id) { return delSaved.run(id).changes > 0; }
