// ai.js — Claude API proxy for NL→SQL generation and error fixing.
// Raw fetch, no SDK (project is zero-npm-dep). The API key never reaches the browser;
// errors are mapped to generic messages so neither the key nor raw provider bodies leak.
import { json, err } from "./db.js";
import { fetchSchema, fetchFks } from "./schema.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = () => process.env.AI_MODEL || "claude-opus-4-8";
export const aiConfigured = () => !!process.env.ANTHROPIC_API_KEY;

const STATIC_INSTRUCTIONS = `You are a PostgreSQL expert embedded in a database console.
Write a single valid PostgreSQL statement (or a short statement batch when genuinely required) for the user's request, using ONLY the tables and columns in the provided schema — never invent identifiers.
Rules:
- Return the SQL in one \`\`\`sql fenced block, followed by exactly one short plain-language sentence describing what it does.
- Prefer SELECT; never produce destructive operations (DROP/DELETE/UPDATE/TRUNCATE) unless the user explicitly asks for them.
- Quote identifiers only when necessary. Add LIMIT 100 to open-ended SELECTs.
- Timestamps in this database are IST trading data; "today" means the current IST calendar day (use (now() AT TIME ZONE 'Asia/Kolkata')::date when comparing dates).`;

// compact, deterministic schema summary — stable text caches well (prompt caching is a prefix match)
async function summarizeSchema(db) {
  const [schema, fks] = await Promise.all([fetchSchema(db), fetchFks(db)]);
  const cols = new Map();
  for (const c of schema.columns) {
    const k = `${c.schema}.${c.table}`;
    if (!cols.has(k)) cols.set(k, []);
    cols.get(k).push(`${c.name} ${c.type}${c.nullable ? "" : " NOT NULL"}`);
  }
  const pkOf = new Map(schema.pks.map(p => [`${p.schema}.${p.table}`, p.cols || []]));
  const lines = [`Database: ${db}`];
  for (const t of schema.tables) {
    const k = `${t.schema}.${t.name}`;
    const pk = pkOf.get(k);
    lines.push(`${k === "public." + t.name ? t.name : k}(${(cols.get(k) || []).join(", ")})${pk?.length ? ` PK(${pk.join(",")})` : ""}`);
  }
  for (const f of fks) {
    lines.push(`fk: ${f.src_table}.${f.src_cols.join(",")} -> ${f.dst_table}.${f.dst_cols.join(",")}`);
  }
  return lines.join("\n");
}

function extractSql(text) {
  const fence = text.match(/```sql\s*\n([\s\S]*?)```/i) || text.match(/```\s*\n([\s\S]*?)```/);
  const sql = (fence ? fence[1] : text).trim();
  const explanation = fence ? text.slice(text.indexOf(fence[0]) + fence[0].length).trim().split("\n")[0].trim() : "";
  return { sql, explanation };
}

export async function handleAi({ db, mode, question, sql, error }) {
  if (!aiConfigured()) return err("AI not configured — set ANTHROPIC_API_KEY in .env", 503);

  let userContent;
  if (mode === "fix") {
    if (!sql || !error) return err("fix mode expects { sql, error }");
    userContent = `This SQL failed:\n\`\`\`sql\n${sql}\n\`\`\`\n\nError:\n${error}\n\nReturn the corrected SQL.`;
  } else {
    if (!question?.trim()) return err("generate mode expects { question }");
    userContent = question.trim();
  }

  let schemaSummary;
  try { schemaSummary = await summarizeSchema(db); }
  catch (e) { return err("Could not read the schema: " + (e?.message || e), 500); }

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL(),
        max_tokens: 2000,
        thinking: { type: "adaptive" }, // adaptive-only on opus-4-8; no temperature/budget_tokens
        system: [
          { type: "text", text: STATIC_INSTRUCTIONS },                                  // frozen prefix
          { type: "text", text: schemaSummary, cache_control: { type: "ephemeral" } },  // cached: schema is stable per-db
        ],
        messages: [{ role: "user", content: userContent }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") return err("AI request timed out", 504);
    console.error("AI fetch failed:", e?.message);
    return err("AI temporarily unreachable", 502);
  }

  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch {}
    console.error(`AI upstream ${res.status}: ${detail.slice(0, 300)}`); // server log only — never echoed
    if (res.status === 401 || res.status === 403) return err("AI auth failed — check ANTHROPIC_API_KEY", 502);
    if (res.status === 429) {
      const retry = res.headers.get("retry-after");
      return err(`AI rate limited — retry ${retry ? "in " + retry + "s" : "shortly"}`, 429);
    }
    if (res.status === 400) return err("AI rejected the request (model/config issue — see server log)", 502);
    return err("AI temporarily unavailable", 502);
  }

  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  if (!text) return err("AI returned an empty response", 502);
  const { sql: outSql, explanation } = extractSql(text);
  if (!outSql) return err("AI response contained no SQL", 502);
  // one-line cache observability (verify hits: cache_read_input_tokens > 0 on the 2nd same-db call)
  const u = data.usage || {};
  console.log(`ai ${mode} db=${db} in=${u.input_tokens} cache_w=${u.cache_creation_input_tokens} cache_r=${u.cache_read_input_tokens} out=${u.output_tokens}`);
  return json({ sql: outSql, explanation });
}
