/* autocomplete.js — context-aware suggestions for the SQL editor.
   Parses the current statement up to the caret: tracks FROM/JOIN/UPDATE/INTO table
   references and their aliases, then suggests
     · tables after FROM / JOIN / UPDATE / INSERT INTO / REFERENCES
     · columns of the tables in scope after SELECT / WHERE / ON / SET / GROUP BY / …
     · only that table's columns after `alias.`
     · complete `JOIN x ON a.id = x.a_id` snippets from FK metadata after JOIN
   Falls back to the old keyword/table/column prefix match when the context is unclear. */
let acItems = [], acSel = 0;
const sqlbox = document.getElementById("sqlbox");
const acdrop = document.getElementById("acdrop");
const acmirror = document.getElementById("acmirror");

function caretXY() {
  // mirror-div technique: replicate text up to the caret, measure a marker span
  const cs = getComputedStyle(sqlbox);
  ["fontFamily","fontSize","lineHeight","padding","border","boxSizing","letterSpacing"].forEach(p => acmirror.style[p] = cs[p]);
  acmirror.style.width = sqlbox.clientWidth + "px";
  const upto = sqlbox.value.slice(0, sqlbox.selectionStart);
  acmirror.innerHTML = escPre(upto).replace(/\n/g, "<br>") + '<span id="acmark">​</span>';
  const mark = document.getElementById("acmark");
  return { left: mark.offsetLeft, top: mark.offsetTop - sqlbox.scrollTop + 22 };
}
function currentToken() {
  const upto = sqlbox.value.slice(0, sqlbox.selectionStart);
  const m = upto.match(/[\w_]+$/);
  return m ? m[0] : "";
}

/* ──── statement parser ──── */
const AC_NOT_ALIAS = new Set(["where","on","set","join","left","right","inner","outer","full","cross","group","order","limit","offset","having","using","values","select","natural","union","returning","as","and","or","when","then","for","fetch"]);
// keywords that flip the suggestion mode; longest match wins via the scan below
const AC_TABLE_KW = new Set(["from", "join", "update", "into", "references", "table"]);
const AC_COL_KW = new Set(["select", "where", "on", "and", "or", "set", "by", "having", "returning", "using", "distinct", "when", "then", "else", "between", "coalesce"]);

function parseContext(tok) {
  const upto = sqlbox.value.slice(0, sqlbox.selectionStart);
  // mask strings/comments with spaces so positions survive
  const masked = upto
    .replace(/'(?:[^']|'')*('|$)/g, m => " ".repeat(m.length))
    .replace(/--[^\n]*/g, m => " ".repeat(m.length))
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, m => " ".repeat(m.length));
  const stmt = masked.slice(masked.lastIndexOf(";") + 1);
  const s = schemaCache[currentDb];
  const ctx = { scope: [], aliases: new Map(), mode: null, lastKw: null, dotAlias: null };
  if (!s) return ctx;

  const resolve = raw => {
    const parts = raw.replace(/"/g, "").split(".");
    const [sch, tbl] = parts.length === 2 ? parts : ["public", parts[0]];
    if (s.tables.some(t => t.schema === sch && t.name === tbl)) return { schema: sch, table: tbl };
    const hit = s.tables.find(t => t.name === tbl);
    return hit ? { schema: hit.schema, table: hit.name } : null;
  };
  // table references + aliases in this statement
  const tref = /\b(from|join|update|into)\s+([\w".]+)(?:\s+(?:as\s+)?("?[A-Za-z_]\w*"?))?/gi;
  let m;
  while ((m = tref.exec(stmt))) {
    const t = resolve(m[2]);
    if (!t) continue;
    let alias = m[3] ? m[3].replace(/"/g, "") : null;
    if (alias && AC_NOT_ALIAS.has(alias.toLowerCase())) alias = null;
    const entry = { ...t, alias: alias || t.table };
    ctx.scope.push(entry);
    ctx.aliases.set(entry.alias.toLowerCase(), entry);
    ctx.aliases.set(t.table.toLowerCase(), entry); // bare table name always resolves too
  }
  // `alias.` immediately before the token being typed?
  const beforeTok = stmt.slice(0, stmt.length - tok.length);
  const dm = beforeTok.match(/("?[A-Za-z_]\w*"?)\.$/);
  if (dm) ctx.dotAlias = dm[1].replace(/"/g, "").toLowerCase();
  // last significant keyword before the token decides table vs column mode
  const kws = [...beforeTok.matchAll(/\b(select|from|join|update|into|set|where|on|and|or|having|by|returning|references|using|table|values|when|then|else|between|limit|offset)\b/gi)];
  if (kws.length) {
    ctx.lastKw = kws[kws.length - 1][1].toLowerCase();
    if (AC_TABLE_KW.has(ctx.lastKw)) ctx.mode = "table";
    else if (AC_COL_KW.has(ctx.lastKw)) ctx.mode = "column";
  }
  return ctx;
}

/* FK-powered `JOIN x ON a.col = x.col` completions for tables already in scope */
function fkJoinSnippets(ctx, lo) {
  const s = schemaCache[currentDb];
  if (!s?.fks) return [];
  const out = [];
  const inScope = (sch, tbl) => ctx.scope.find(t => t.schema === sch && t.table === tbl);
  for (const f of s.fks) {
    const src = inScope(f.src_schema, f.src_table);
    const dst = inScope(f.dst_schema, f.dst_table);
    let other = null, anchor = null, on = null;
    if (src && !dst) { other = f.dst_table; anchor = src; on = f.src_cols.map((c, i) => [c, f.dst_cols[i]]); }
    else if (dst && !src) { other = f.src_table; anchor = dst; on = f.dst_cols.map((c, i) => [c, f.src_cols[i]]); }
    if (!other || !other.toLowerCase().startsWith(lo)) continue;
    const conds = on.map(([ac, oc]) => `${anchor.alias}.${qid(ac)} = ${other}.${qid(oc)}`).join(" AND ");
    out.push({ t: `${other} ON ${conds}`, kind: "fk join" });
    if (out.length >= 4) break;
  }
  return out;
}

function buildCandidates(tok) {
  const lo = tok.toLowerCase();
  const out = [];
  const s = schemaCache[currentDb];
  const ctx = parseContext(tok);

  // `alias.` → that table's columns only (exclusive — nothing else makes sense here)
  if (ctx.dotAlias && ctx.aliases.has(ctx.dotAlias)) {
    const t = ctx.aliases.get(ctx.dotAlias);
    for (const c of s.columns)
      if (c.schema === t.schema && c.table === t.table && c.name.toLowerCase().startsWith(lo))
        out.push({ t: c.name, kind: "col · " + t.table });
    return out.filter(x => x.t.toLowerCase() !== lo).slice(0, 12);
  }

  if (ctx.mode === "table" && s) {
    if (ctx.lastKw === "join") out.push(...fkJoinSnippets(ctx, lo));
    for (const t of s.tables) if (t.name.toLowerCase().startsWith(lo)) out.push({ t: t.name, kind: t.kind });
    // a few structural keywords still make sense mid-clause (LEFT JOIN, ON …)
    for (const k of ["LEFT","RIGHT","INNER","OUTER","ON","AS","LATERAL","ONLY"]) if (k.toLowerCase().startsWith(lo)) out.push({ t: k, kind: "keyword" });
  } else if (ctx.mode === "column" && s && ctx.scope.length) {
    const seen = new Set();
    for (const t of ctx.scope)
      for (const c of s.columns)
        if (c.schema === t.schema && c.table === t.table && c.name.toLowerCase().startsWith(lo) && !seen.has(c.name)) {
          seen.add(c.name);
          out.push({ t: c.name, kind: "col · " + t.table });
        }
    for (const k of SQL_KEYWORDS) if (k.toLowerCase().startsWith(lo)) out.push({ t: k, kind: "keyword" });
  } else {
    // unclear context — original keyword/table/column prefix match
    for (const k of SQL_KEYWORDS) if (k.toLowerCase().startsWith(lo)) out.push({ t: k, kind: "keyword" });
    if (s) {
      for (const t of s.tables) if (t.name.toLowerCase().startsWith(lo)) out.push({ t: t.name, kind: t.kind });
      const seen = new Set();
      for (const c of s.columns) if (c.name.toLowerCase().startsWith(lo) && !seen.has(c.name)) { seen.add(c.name); out.push({ t: c.name, kind: "col · " + c.table }); }
    }
  }
  // full statements from history that continue what's typed on this line
  const upto = sqlbox.value.slice(0, sqlbox.selectionStart);
  const line = upto.slice(upto.lastIndexOf("\n") + 1).replace(/^\s+/, "");
  if (line.length >= 3) {
    const seenH = new Set();
    for (const h of getHist()) {
      const one = h.sql.trim();
      if (one.toLowerCase().startsWith(line.toLowerCase()) && one.length > line.length && !seenH.has(one)) {
        seenH.add(one);
        out.unshift({ t: one, kind: "history · " + h.db, line });
        if (seenH.size >= 3) break;
      }
    }
  }
  // exact match alone isn't a suggestion
  return out.filter(x => x.t.toLowerCase() !== lo).slice(0, 12);
}
function showAc() {
  const tok = currentToken();
  // open on a 2+ char token, or immediately after `alias.`
  const afterDot = !tok && /[\w"]\.$/.test(sqlbox.value.slice(0, sqlbox.selectionStart));
  if (tok.length < 2 && !afterDot) return hideAc();
  acItems = buildCandidates(tok);
  if (!acItems.length) return hideAc();
  acSel = 0;
  const { left, top } = caretXY();
  acdrop.style.left = Math.min(left, sqlbox.clientWidth - 220) + "px";
  acdrop.style.top = top + "px";
  acdrop.classList.remove("hidden");
  renderAc();
}
function renderAc() {
  acdrop.innerHTML = acItems.map((x, i) =>
    `<div class="ac-item ${i === acSel ? "sel" : ""}" data-i="${i}"><span class="ac-text">${esc(x.t)}</span><span class="ac-kind">${esc(x.kind)}</span></div>`).join("");
  acdrop.querySelectorAll(".ac-item").forEach(d => d.addEventListener("mousedown", e => { e.preventDefault(); acSel = Number(d.dataset.i); acceptAc(); }));
}
function hideAc() { acdrop.classList.add("hidden"); acItems = []; }
function acceptAc() {
  if (!acItems.length) return;
  const item = acItems[acSel];
  const pos = sqlbox.selectionStart;
  if (item.line !== undefined) {
    // history item: replace the whole current line (keeping its indentation)
    const lineStart = sqlbox.value.lastIndexOf("\n", pos - 1) + 1;
    const indent = (sqlbox.value.slice(lineStart, pos).match(/^\s*/) || [""])[0];
    const start = lineStart + indent.length;
    sqlbox.value = sqlbox.value.slice(0, start) + item.t + sqlbox.value.slice(pos);
    sqlbox.selectionStart = sqlbox.selectionEnd = start + item.t.length;
  } else {
    const tok = currentToken();
    sqlbox.value = sqlbox.value.slice(0, pos - tok.length) + item.t + sqlbox.value.slice(pos);
    sqlbox.selectionStart = sqlbox.selectionEnd = pos - tok.length + item.t.length;
  }
  hideAc();
  sqlbox.focus();
}
sqlbox.addEventListener("input", showAc);
sqlbox.addEventListener("blur", () => setTimeout(hideAc, 150));
sqlbox.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runQuery(); return; }
  if (acdrop.classList.contains("hidden")) return;
  if (e.key === "ArrowDown") { e.preventDefault(); acSel = (acSel + 1) % acItems.length; renderAc(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); acSel = (acSel - 1 + acItems.length) % acItems.length; renderAc(); }
  else if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); acceptAc(); }
  else if (e.key === "Escape") hideAc();
});
