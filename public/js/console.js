/* console.js — query console: run, browse (keyset pagination), results grid,
   inline cell editing, export, cell inspector, query history. */

function setEditorSql(sql) { document.getElementById("sqlbox").value = sql; }
function insertSnippet() {
  const sel = document.getElementById("snippets");
  if (!sel.value) return;
  const box = document.getElementById("sqlbox");
  box.value = (box.value ? box.value.replace(/\s*$/, "\n\n") : "") + sel.value + "\n";
  sel.value = "";
  box.focus();
}
/* PK + column types for a table, from the schema cache */
function lookupTableMeta(schema, table) {
  const cache = schemaCache[currentDb];
  if (!cache) return null;
  const pk = (cache.pks.find(p => p.schema === schema && p.table === table) || {}).cols || [];
  if (!pk.length) return null;
  const cols = cache.columns.filter(c => c.schema === schema && c.table === table);
  return { schema, table, pk, types: Object.fromEntries(cols.map(c => [c.name, c.type])) };
}
/* if the run is a plain single-table SELECT * and we know its PK, results are editable */
function detectEditable(sql) {
  const m = sql.trim().match(/^select\s+\*\s+from\s+(?:"([^"]+)"\.)?"?([\w]+)"?\s*(?:limit\s+\d+)?\s*;?\s*$/i);
  return m ? lookupTableMeta(m[1] || "public", m[2]) : null;
}
let lastRun = null; // { sql, results, editable }

/* ════════════════ table browse: sort + keyset (cursor) pagination ════════════════
   Interactions compile to SQL — the grid never sorts the DOM. "Next" anchors on the
   last row of the page: WHERE (sort_col, pk…) > (cursor values), never OFFSET. */
let browse = null; // { schema, table, pk, types, sort:{col,dir}|null, pages:[cursorRow|null], page, limit }
function browseFq() { return (browse.schema === "public" ? "" : qid(browse.schema) + ".") + qid(browse.table); }
function compileBrowse() {
  const s = browse.sort;
  const dir = s ? s.dir : "ASC";
  const op = dir === "ASC" ? ">" : "<";
  const orderCols = s ? [s.col, ...browse.pk.filter(k => k !== s.col)] : [...browse.pk];
  const order = orderCols.map(c => `${qid(c)} ${dir}${s && c === s.col ? " NULLS LAST" : ""}`).join(", ");
  let where = "";
  const cur = browse.pages[browse.page]; // last row of the previous page, or null on page 1
  if (cur) {
    const pkTuple = browse.pk.length === 1 ? qid(browse.pk[0]) : `(${browse.pk.map(qid).join(", ")})`;
    const pkVals = browse.pk.length === 1 ? sqlLit(cur[browse.pk[0]], browse.types[browse.pk[0]] || "")
      : `(${browse.pk.map(k => sqlLit(cur[k], browse.types[k] || "")).join(", ")})`;
    if (!s) where = `WHERE ${pkTuple} ${op} ${pkVals}`;
    else {
      const c = qid(s.col), v = cur[s.col];
      if (v === null || v === undefined) where = `WHERE ${c} IS NULL AND ${pkTuple} ${op} ${pkVals}`;
      else {
        const lit = sqlLit(v, browse.types[s.col] || "");
        where = `WHERE (${c} ${op} ${lit} OR (${c} = ${lit} AND ${pkTuple} ${op} ${pkVals}) OR ${c} IS NULL)`;
      }
    }
  }
  return `SELECT * FROM ${browseFq()}\n${where ? where + "\n" : ""}ORDER BY ${order}\nLIMIT ${browse.limit};`;
}
function browseRun() {
  const lim = Number(document.getElementById("maxrows").value) || 100;
  if (lim !== browse.limit && browse.page > 0) { browse.pages = [null]; browse.page = 0; } // page size changed → cursors stale, restart at row 1
  browse.limit = lim;
  setEditorSql(compileBrowse());
  runQuery(true, lookupTableMeta(browse.schema, browse.table));
}
function browseSort(col) {
  if (!browse) return;
  browse.sort = !browse.sort || browse.sort.col !== col ? { col, dir: "ASC" }
    : browse.sort.dir === "ASC" ? { col, dir: "DESC" } : null;
  browse.pages = [null]; browse.page = 0;
  browseRun();
}
function browseNext() {
  const r = lastRun?.results[0];
  if (!browse || !r?.rows.length) return;
  browse.pages[browse.page + 1] = r.rows[r.rows.length - 1];
  browse.page++;
  browseRun();
}
function browsePrev() { if (browse && browse.page > 0) { browse.page--; browseRun(); } }

async function runQuery(skipConfirm = false, editableOverride = null) {
  if (!currentDb) return toast("Select a database in the sidebar first", true);
  const sql = document.getElementById("sqlbox").value.trim();
  if (!sql) return;
  hideAc();
  if (!skipConfirm) {
    const warns = classifyDanger(sql);
    if (warns.length && !(await confirmDanger(warns, sql))) return;
  }
  if (!editableOverride) browse = null; // hand-run SQL leaves browse mode
  pending.clear(); renderSaveBar();
  const out = document.getElementById("results");
  const sumEl = document.getElementById("runsummary");
  sumEl.innerHTML = `<span class="chip"><span class="led led-amber"></span>running on ${esc(currentDb)}…</span>`;
  out.innerHTML = "";
  const t0 = performance.now();
  try {
    const { results, serverMs } = await api("/api/query", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ db: currentDb, sql, maxRows: Number(document.getElementById("maxrows").value) || 100 }),
    });
    const wall = Math.round(performance.now() - t0);
    const dbMs = results.reduce((a, r) => a + (r.ms || 0), 0);
    const srvMs = Math.max(0, (serverMs ?? dbMs) - dbMs); // server cost minus the time already counted as db
    const okAll = results.every(r => r.ok);
    const totalRows = results.reduce((a, r) => a + (r.ok ? r.rowCount : 0), 0);
    sumEl.innerHTML = `
      <span class="chip ${okAll ? "chip-green" : "chip-red"}"><span class="led ${okAll ? "led-green" : "led-red"}"></span>${results.length} statement${results.length === 1 ? "" : "s"}</span>
      <span class="chip" title="time inside PostgreSQL">${ic("zap", 10)} db ${dbMs} ms</span>
      <span class="chip" title="server handling: connection pool, statement split, row shaping">${ic("server", 10)} srv ${srvMs} ms</span>
      <span class="chip" title="pure network: round-trip + transfer — this is your link to the box, not query cost">${ic("clock", 10)} wire ${Math.max(0, wall - dbMs - srvMs)} ms</span>
      <span class="chip">${totalRows} rows</span>`;
    recordHistory({ db: currentDb, sql, ms: dbMs, ok: okAll, rows: totalRows, at: Date.now() });
    lastRun = { sql, results, editable: results.length === 1 && results[0].ok ? (editableOverride || detectEditable(sql)) : null };
    out.innerHTML = "";
    results.forEach((r, si) => {
      const block = document.createElement("div");
      block.className = "panel overflow-clip border-l-2 " + (r.ok ? "!border-l-quill-600" : "!border-l-red-led");
      if (!r.ok) {
        const badId = (String(r.error).match(/"([^"]+)"/) || [])[1] || "";
        block.innerHTML = `
          <div class="flex items-center gap-3 px-3 py-2 bg-paper-800 font-mono text-[11px]">
            <span class="text-red-led font-semibold">✕ ERROR${r.sqlstate ? ` · ${esc(r.sqlstate)}` : ""}</span><span class="text-ink-500 truncate">${esc(r.statement)}</span>
            <span class="ml-auto text-ink-700">${r.ms} ms</span>
          </div>
          <div class="px-3 py-2.5 flex flex-col gap-1.5">
            <div class="text-red-led font-mono text-xs">${esc(r.error)}</div>
            ${r.friendly ? `<div class="text-ink-300 text-xs">${esc(r.friendly)}</div>` : ""}
            ${r.didYouMean ? `<div class="text-xs text-ink-300">did you mean <button class="chip chip-quill cursor-pointer hover:opacity-80" data-dym="${esc(r.didYouMean)}" data-bad="${esc(badId)}">${esc(r.didYouMean)}</button> ?</div>` : ""}
            ${typeof aiAvailable !== "undefined" && aiAvailable ? `<div class="flex mt-1"><button class="btn btn-sm" data-aifix="${si}">${ic("sparkles", 11)} Fix with AI</button></div>` : ""}
          </div>`;
      } else if (r.rows.length) {
        const sortable = browse && lastRun.editable && si === 0;
        let pager = "";
        if (sortable) {
          // row-range pager: each Next compiles the keyset query for the following window
          const start = browse.page * browse.limit + 1;
          const end = start + r.rows.length - 1;
          const atEnd = r.rows.length < browse.limit;
          pager = `
            <span class="flex items-center gap-1.5 mx-1">
              <button class="btn btn-sm" data-pg="prev" title="rows ${Math.max(1, start - browse.limit)}–${start - 1}" ${browse.page === 0 ? 'disabled style="opacity:.4"' : ""}>◂ ${start - browse.limit > 0 ? `${start - browse.limit}–${start - 1}` : "Prev"}</button>
              <span class="chip chip-quill">rows ${start}–${end}${atEnd ? " · end" : ""}</span>
              <button class="btn btn-sm" data-pg="next" title="rows ${end + 1}–${end + browse.limit}" ${atEnd ? 'disabled style="opacity:.4"' : ""}>${end + 1}–${end + browse.limit} ▸</button>
            </span>`;
        }
        block.innerHTML = `
          <div class="flex items-center gap-3 px-3 py-1.5 bg-paper-800 font-mono text-[11px] flex-wrap">
            <span class="text-quill-400 font-semibold">${esc(r.command || "OK")}</span>
            <span class="text-ink-500">${r.rowCount} row${r.rowCount === 1 ? "" : "s"}${r.truncated ? ` · <span class="text-amber-led">first ${r.rows.length} shown</span>` : ""}</span>
            ${sortable && browse.sort ? `<span class="chip chip-quill">${esc(browse.sort.col)} ${browse.sort.dir === "ASC" ? "▲" : "▼"}</span>` : ""}
            <span class="ml-auto flex items-center gap-1.5">
              ${pager}
              ${sortable ? `<button class="btn btn-sm" data-newrow title="Insert a row into ${esc(browse.table)}">${ic("rowinsert", 11)}row</button>` : ""}
              <button class="btn btn-sm" data-exp="sql" data-si="${si}" title="Download as INSERT statements">${ic("download", 11)}sql</button>
              <button class="btn btn-sm" data-exp="json" data-si="${si}" title="Download rows as JSON">${ic("download", 11)}json</button>
              <span class="text-ink-700">${r.ms} ms</span>
            </span>
          </div>
          <div class="gridscroll max-h-[360px]"><table class="grid-table"><thead><tr>${r.columns.map(c => sortable
            ? `<th class="thsort" data-col="${esc(c)}" title="Sort by ${esc(c)}">${esc(c)}${browse.sort?.col === c ? (browse.sort.dir === "ASC" ? " ▲" : " ▼") : ""}</th>`
            : `<th>${esc(c)}</th>`).join("")}</tr></thead>
          <tbody>${r.rows.map((row, ri) => `<tr>${r.columns.map(c => {
            const v = row[c];
            const text = v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
            return `<td class="cellv" data-si="${si}" data-ri="${ri}" data-c="${esc(c)}" title="${esc(text.slice(0, 400))}">${v === null ? '<span class="text-ink-700">∅</span>' : esc(text)}</td>`;
          }).join("")}</tr>`).join("")}</tbody></table></div>`;
      } else {
        block.innerHTML = `
          <div class="flex items-center gap-3 px-3 py-2 bg-paper-800 font-mono text-[11px]">
            <span class="text-quill-400 font-semibold">${esc(r.command || "OK")}</span>
            <span class="text-ink-500">${r.rowCount} row${r.rowCount === 1 ? "" : "s"} affected</span>
            <span class="text-ink-700 truncate">${esc(r.statement)}</span>
            <span class="ml-auto text-ink-700">${r.ms} ms</span>
          </div>`;
      }
      out.appendChild(block);
    });
    const failed = results.some(r => !r.ok);
    if (/\b(create|drop|alter)\b/i.test(sql) && !failed) { loadTree(currentDb); loadDatabases(); tableDefLoadedFor = null; }
  } catch (e) {
    sumEl.innerHTML = `<span class="chip chip-red"><span class="led led-red"></span>failed</span>`;
    out.innerHTML = `<div class="text-red-led font-mono text-xs">${esc(e.message)}</div>`;
  }
}

/* ════════════════ cell inspector / inline editor / export ════════════════ */
let cellClickTimer = null;
document.getElementById("results").addEventListener("click", e => {
  const dym = e.target.closest("[data-dym]");
  if (dym) { // "did you mean X" — swap the misspelled identifier in the editor and re-run
    const box = document.getElementById("sqlbox");
    if (dym.dataset.bad) box.value = box.value.replaceAll(dym.dataset.bad, dym.dataset.dym);
    box.focus();
    runQuery(true);
    return;
  }
  const nr = e.target.closest("[data-newrow]");
  if (nr && browse) return openInsertRow(browse.schema, browse.table);
  const pg = e.target.closest("[data-pg]");
  if (pg) { if (!pg.disabled) pg.dataset.pg === "next" ? browseNext() : browsePrev(); return; }
  const ex = e.target.closest("[data-exp]");
  if (ex) return exportResult(Number(ex.dataset.si), ex.dataset.exp);
  const th = e.target.closest("th.thsort");
  if (th) return browseSort(th.dataset.col);
  const td = e.target.closest("td.cellv");
  if (!td || td.querySelector("input")) return;
  const open = () => openCellModal(Number(td.dataset.si), Number(td.dataset.ri), td.dataset.c);
  if (lastRun?.editable) { // wait: a double-click means inline edit, not the inspector
    clearTimeout(cellClickTimer);
    cellClickTimer = setTimeout(open, 260);
  } else open();
});
document.getElementById("results").addEventListener("dblclick", e => {
  const td = e.target.closest("td.cellv");
  if (!td || !lastRun?.editable || td.querySelector("input")) return;
  clearTimeout(cellClickTimer);
  startInlineEdit(td);
});

/* inline editing — edits accumulate as "pending", saved as one transaction */
const pending = new Map(); // "ri:col" -> {ri, col, text}
const cellText = v => v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
function startInlineEdit(td) {
  const si = Number(td.dataset.si), ri = Number(td.dataset.ri), col = td.dataset.c;
  const ed = lastRun.editable;
  if (ed.pk.includes(col)) return toast("Primary-key cells anchor the UPDATE — not editable", true);
  const orig = lastRun.results[si].rows[ri][col];
  const prev = pending.get(ri + ":" + col);
  td.innerHTML = `<input class="cellinput" spellcheck="false">`;
  const inp = td.querySelector("input");
  inp.value = prev ? prev.text : cellText(orig);
  inp.focus(); inp.select();
  let done = false;
  const finish = commit => {
    if (done) return; done = true;
    if (commit) {
      if (inp.value !== cellText(orig)) pending.set(ri + ":" + col, { ri, col, text: inp.value });
      else pending.delete(ri + ":" + col);
    }
    paintCell(td, si, ri, col);
    renderSaveBar();
  };
  inp.addEventListener("keydown", ev => {
    if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
    else if (ev.key === "Escape") { ev.stopPropagation(); finish(false); }
  });
  inp.addEventListener("blur", () => finish(true));
}
function paintCell(td, si, ri, col) {
  const p = pending.get(ri + ":" + col);
  if (p) {
    td.classList.add("pendingcell");
    td.textContent = p.text === "" ? "''" : p.text;
    td.title = "pending: " + p.text;
  } else {
    td.classList.remove("pendingcell");
    const orig = lastRun.results[si].rows[ri][col];
    if (orig === null) { td.innerHTML = '<span class="text-ink-700">∅</span>'; td.title = ""; }
    else { td.textContent = cellText(orig); td.title = cellText(orig).slice(0, 400); }
  }
}
function renderSaveBar() {
  const bar = document.getElementById("savebar");
  bar.style.display = pending.size ? "flex" : "none";
  if (pending.size) {
    const rows = new Set([...pending.values()].map(p => p.ri)).size;
    document.getElementById("savecount").textContent = `${pending.size} pending edit${pending.size > 1 ? "s" : ""} · ${rows} row${rows > 1 ? "s" : ""}`;
  }
}
function discardPending() {
  pending.clear();
  document.querySelectorAll("#results td.pendingcell").forEach(td => paintCell(td, Number(td.dataset.si), Number(td.dataset.ri), td.dataset.c));
  renderSaveBar();
}
async function savePending() {
  if (!pending.size || !lastRun?.editable) return;
  const ed = lastRun.editable;
  const fq = (ed.schema === "public" ? "" : qid(ed.schema) + ".") + qid(ed.table);
  const byRow = {};
  for (const p of pending.values()) (byRow[p.ri] ||= []).push(p);
  const stmts = Object.entries(byRow).map(([ri, cols]) => {
    const row = lastRun.results[0].rows[ri];
    const sets = cols.map(p => `${qid(p.col)} = ${textToLit(p.text, ed.types[p.col] || "")}`).join(", ");
    const where = ed.pk.map(k => `${qid(k)} = ${sqlLit(row[k], ed.types[k] || "")}`).join(" AND ");
    return `UPDATE ${fq} SET ${sets} WHERE ${where};`;
  });
  const sql = ["BEGIN;", ...stmts, "COMMIT;"].join("\n");
  if (!(await confirmDanger(classifyDanger(sql), sql))) return;
  try {
    const { results } = await api("/api/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ db: currentDb, sql }) });
    const bad = results.find(x => !x.ok);
    if (bad) return toast(bad.error, true); // server already rolled back
    toast(`Posted ${pending.size} edit${pending.size > 1 ? "s" : ""} across ${stmts.length} row${stmts.length > 1 ? "s" : ""}`);
    pending.clear(); renderSaveBar();
    refreshCurrent();
  } catch (e) { toast(e.message, true); }
}
function textToLit(text, type) {
  if (/json/.test(type.toLowerCase())) { try { return sqlLit(JSON.parse(text), type); } catch { /* treat as text */ } }
  return sqlLit(text, type);
}
/* re-run whatever produced the current grid */
function refreshCurrent() {
  if (browse) browseRun();
  else if (lastRun) { setEditorSql(lastRun.sql); runQuery(true, lastRun.editable); }
}

/* export the rows of one result as .sql INSERTs or .json */
function exportResult(si, fmt) {
  const r = lastRun?.results[si];
  if (!r?.rows.length) return;
  const rawName = lastRun.editable ? (lastRun.editable.schema === "public" ? "" : lastRun.editable.schema + ".") + lastRun.editable.table
    : (r.statement.match(/from\s+([\w".]+)/i)?.[1] || "table_name").replace(/"/g, "");
  let content, mime, ext;
  if (fmt === "json") {
    content = JSON.stringify(r.rows, null, 2);
    mime = "application/json"; ext = "json";
  } else {
    const types = lastRun.editable?.types || {};
    const fq = rawName.split(".").map(qid).join(".");
    const colList = r.columns.map(qid).join(", ");
    content = r.rows.map(row =>
      `INSERT INTO ${fq} (${colList}) VALUES (${r.columns.map(c => sqlLit(row[c], types[c] || "")).join(", ")});`
    ).join("\n") + "\n";
    mime = "application/sql"; ext = "sql";
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = `${currentDb}-${rawName.replace(/\./g, "_")}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Exported ${r.rows.length} row${r.rows.length > 1 ? "s" : ""} as .${ext}${r.truncated ? " (fetched rows only)" : ""}`);
}
function openCellModal(si, ri, col) {
  if (!lastRun) return;
  const r = lastRun.results[si]; if (!r || !r.ok) return;
  const row = r.rows[ri]; if (!row) return;
  const v = row[col];
  const isObj = v !== null && typeof v === "object";
  const text = v === null ? "" : isObj ? JSON.stringify(v, null, 2) : String(v);
  const ed = lastRun.editable;
  const isPkCol = !!ed && ed.pk.includes(col);
  const canEdit = !!ed && !isPkCol && ed.pk.every(k => r.columns.includes(k));
  const type = ed ? ed.types[col] || "" : "";
  openModal(`
    <div class="flex items-center gap-2.5 px-5 py-4 border-b border-rule-700 min-w-0">
      <span class="text-quill-400" data-ic="table" data-s="15"></span>
      <span class="font-mono text-[13px] font-bold truncate">${ed ? esc(ed.table) + "." : ""}${esc(col)}</span>
      ${type ? `<span class="chip">${esc(type)}</span>` : ""}
      ${v === null ? '<span class="chip chip-amber">null</span>' : ""}
      ${isPkCol ? '<span class="chip chip-quill">primary key</span>' : ""}
      <span class="mlabel ml-auto flex-none">row ${ri + 1}</span>
      <button class="btn btn-sm btn-icon" onclick="closeModal()" title="Close"><span data-ic="x" data-s="13"></span></button>
    </div>
    <div class="px-5 py-4 flex flex-col gap-3 overflow-y-auto min-h-0">
      <pre class="sqlblock max-h-[38vh] overflow-y-auto" id="cellval">${v === null ? '<span class="cmt">NULL</span>' : escPre(text)}</pre>
      <div class="flex gap-2">
        <button class="btn btn-sm" onclick='navigator.clipboard.writeText(document.getElementById("cellval").textContent); toast("Value copied")'><span data-ic="copy" data-s="12"></span>Copy value</button>
        <button class="btn btn-sm" id="copyrowbtn"><span data-ic="copy" data-s="12"></span>Copy row JSON</button>
      </div>
      ${canEdit ? `
      <div class="h-px bg-rule-700"></div>
      <div class="mlabel">amend entry</div>
      <textarea id="celledit" class="input w-full font-mono text-[12px] min-h-20 resize-y" spellcheck="false">${esc(isObj ? JSON.stringify(v) : v === null ? "" : String(v))}</textarea>
      <label class="text-xs text-ink-500 flex items-center gap-1.5"><input type="checkbox" id="cellnull" class="accent-quill-500" ${v === null ? "checked" : ""}> set NULL</label>
      <div class="mlabel">generated update</div>
      <pre class="sqlblock" id="cellsql"></pre>
      <div class="flex justify-end gap-2">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" id="cellsave"><span data-ic="play" data-s="13"></span>Run UPDATE</button>
      </div>` : ed
        ? `<div class="text-xs text-ink-500">${isPkCol ? "Primary-key cells aren't editable here — they anchor the UPDATE." : "Editing needs every PK column in the result."}</div>`
        : `<div class="text-xs text-ink-500">Read-only: editing needs a plain <span class="font-mono">SELECT * FROM table</span> on a table with a primary key.</div>`}
    </div>`);
  hydrateIcons(modalCard);
  document.getElementById("copyrowbtn").addEventListener("click", () => { navigator.clipboard.writeText(JSON.stringify(row, null, 2)); toast("Row copied as JSON"); });
  if (canEdit) {
    const q = s => '"' + s.replace(/"/g, '""') + '"';
    const fq = (ed.schema === "public" ? "" : q(ed.schema) + ".") + q(ed.table);
    const where = ed.pk.map(k => `${q(k)} = ${sqlLit(row[k], ed.types[k] || "")}`).join(" AND ");
    const editEl = document.getElementById("celledit"), nullEl = document.getElementById("cellnull"), sqlEl = document.getElementById("cellsql");
    const buildUpdate = () => {
      let nv = nullEl.checked ? null : editEl.value;
      if (nv !== null && /json/.test(type.toLowerCase())) { try { nv = JSON.parse(nv); } catch { /* keep as text */ } }
      return `UPDATE ${fq} SET ${q(col)} = ${sqlLit(nv, type)} WHERE ${where};`;
    };
    const renderPrev = () => { sqlEl.innerHTML = hlSql(buildUpdate()); };
    editEl.addEventListener("input", () => { nullEl.checked = false; renderPrev(); });
    nullEl.addEventListener("input", renderPrev);
    renderPrev();
    document.getElementById("cellsave").addEventListener("click", async () => {
      const upd = buildUpdate();
      try {
        const { results } = await api("/api/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ db: currentDb, sql: upd }) });
        if (!results[0].ok) return toast(results[0].error, true);
        toast(`Updated ${results[0].rowCount} row${results[0].rowCount === 1 ? "" : "s"}`);
        closeModal();
        refreshCurrent();
      } catch (e2) { toast(e2.message, true); }
    });
  }
}
/* the console column must never pan horizontally — wide grids scroll inside their own wrappers */
const consolecol = document.getElementById("consolecol");
consolecol.addEventListener("scroll", () => { if (consolecol.scrollLeft) consolecol.scrollLeft = 0; });

/* ════════════════ EXPLAIN viewer ════════════════ */
async function runExplain() {
  if (!currentDb) return toast("Select a database in the sidebar first", true);
  const sql = document.getElementById("sqlbox").value.trim();
  if (!sql) return;
  hideAc();
  const analyzeEl = document.getElementById("explainanalyze");
  let analyze = analyzeEl.checked;
  if (analyze && classifyDanger(sql).length) {
    analyze = false; analyzeEl.checked = false;
    toast("ANALYZE executes the query — switched off for this mutating statement", true);
  }
  const out = document.getElementById("results");
  const sumEl = document.getElementById("runsummary");
  sumEl.innerHTML = `<span class="chip"><span class="led led-amber"></span>explaining on ${esc(currentDb)}…</span>`;
  out.innerHTML = "";
  try {
    const data = await api("/api/explain", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ db: currentDb, sql, analyze }),
    });
    renderExplain(data);
  } catch (e) {
    sumEl.innerHTML = `<span class="chip chip-red"><span class="led led-red"></span>explain failed</span>`;
    out.innerHTML = `<div class="panel p-3 border-l-2 !border-l-red-led"><div class="text-red-led font-mono text-xs">${esc(e.message)}</div></div>`;
  }
}
function explainNodeHtml(n, depth) {
  const est = Number(n["Plan Rows"] ?? 0);
  const act = n["Actual Rows"] !== undefined ? Number(n["Actual Rows"]) : null;
  const seqBig = n["Node Type"] === "Seq Scan" && (act ?? est) > 10000;
  const title = [n["Node Type"], n["Relation Name"] ? `on ${n["Relation Name"]}` : "", n["Alias"] && n["Alias"] !== n["Relation Name"] ? `as ${n["Alias"]}` : "", n["Index Name"] ? `using ${n["Index Name"]}` : ""].filter(Boolean).join(" ");
  const time = n["Actual Total Time"] !== undefined ? `${Number(n["Actual Total Time"]).toFixed(2)} ms` : null;
  let html = `
    <div class="flex items-center gap-2 py-1 font-mono text-[11.5px]" style="margin-left:${depth * 22}px">
      <span class="${depth ? "text-ink-700" : "text-quill-400"}">${depth ? "└" : "▸"}</span>
      <span class="${seqBig ? "chip chip-red" : "chip"}">${esc(n["Node Type"])}</span>
      <span class="text-ink-100">${esc(title.replace(n["Node Type"], "").trim())}</span>
      <span class="text-ink-700 ml-auto flex items-center gap-2 flex-none">
        ${n["Total Cost"] !== undefined ? `cost ${Number(n["Total Cost"]).toFixed(0)}` : ""}
        · rows ${act !== null ? `${act.toLocaleString()} <span class="text-ink-700">(est ${est.toLocaleString()})</span>` : est.toLocaleString()}
        ${time ? `· <span class="${Number(n["Actual Total Time"]) > 100 ? "text-amber-led" : "text-green-led"}">${time}</span>` : ""}
        ${n["Loops"] > 1 ? `· ×${n["Loops"]}` : ""}
      </span>
    </div>
    ${n["Filter"] ? `<div class="font-mono text-[10.5px] text-ink-500 truncate" style="margin-left:${depth * 22 + 26}px" title="${esc(n["Filter"])}">filter: ${esc(n["Filter"])}</div>` : ""}
    ${n["Index Cond"] ? `<div class="font-mono text-[10.5px] text-ink-500 truncate" style="margin-left:${depth * 22 + 26}px">index cond: ${esc(n["Index Cond"])}</div>` : ""}`;
  for (const c of n["Plans"] || []) html += explainNodeHtml(c, depth + 1);
  return html;
}
function renderExplain({ plan, hints, analyzed, note }) {
  const sumEl = document.getElementById("runsummary");
  const out = document.getElementById("results");
  sumEl.innerHTML = `
    <span class="chip chip-green"><span class="led led-green"></span>${analyzed ? "EXPLAIN ANALYZE" : "EXPLAIN"}</span>
    ${plan["Planning Time"] !== undefined ? `<span class="chip">plan ${Number(plan["Planning Time"]).toFixed(2)} ms</span>` : ""}
    ${plan["Execution Time"] !== undefined ? `<span class="chip">${ic("zap", 10)} exec ${Number(plan["Execution Time"]).toFixed(2)} ms</span>` : ""}`;
  const block = document.createElement("div");
  block.className = "panel overflow-clip border-l-2 !border-l-quill-600";
  block.innerHTML = `
    <div class="flex items-center gap-3 px-3 py-1.5 bg-paper-800 font-mono text-[11px]">
      <span class="text-quill-400 font-semibold">${ic("gauge", 11)} QUERY PLAN</span>
      ${analyzed ? '<span class="chip chip-amber">measured — the query ran</span>' : '<span class="chip">estimates only</span>'}
    </div>
    ${note ? `<div class="px-3 py-2 text-xs text-amber-led border-b border-rule-700">${esc(note)}</div>` : ""}
    ${hints.length ? `<div class="px-3 py-2 flex flex-col gap-1 border-b border-rule-700">${hints.map(h =>
      `<div class="flex items-start gap-2 text-xs"><span class="chip chip-amber flex-none">hint</span><span class="text-ink-300">${esc(h)}</span></div>`).join("")}</div>` : ""}
    <div class="px-3 py-2 overflow-x-auto">${explainNodeHtml(plan.Plan, 0)}</div>`;
  out.replaceChildren(block);
}

/* ════════════════ query history (localStorage) ════════════════ */
const HIST_KEY = "pgal_history", HIST_MAX = 100;
const getHist = () => { try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch { return []; } };
function recordHistory(entry) {
  const h = getHist();
  h.unshift(entry);
  localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, HIST_MAX)));
  renderHistory();
}
function clearHistory() { localStorage.removeItem(HIST_KEY); renderHistory(); }
function toggleHistory() {
  const d = document.getElementById("histdrawer");
  const open = d.classList.toggle("hidden");
  d.classList.toggle("flex", !d.classList.contains("hidden"));
  if (!d.classList.contains("hidden")) { // the two drawers share the right edge
    const s = document.getElementById("saveddrawer");
    s.classList.add("hidden"); s.classList.remove("flex");
  }
  localStorage.setItem("pgal_histopen", d.classList.contains("hidden") ? "" : "1");
  renderHistory();
}
function renderHistory() {
  const el = document.getElementById("histlist");
  if (!el || document.getElementById("histdrawer").classList.contains("hidden")) return;
  const h = getHist();
  el.innerHTML = h.length ? "" : `<div class="mlabel p-2">empty — run something</div>`;
  h.forEach((e2, i) => {
    const d = document.createElement("div");
    d.className = "panel !bg-paper-850 p-2 cursor-pointer hover:!border-rule-300 transition-colors";
    d.innerHTML = `
      <div class="flex items-center gap-1.5 mb-1">
        <span class="led ${e2.ok ? "led-green" : "led-red"}" style="width:5px;height:5px"></span>
        <span class="font-mono text-[9.5px] text-quill-400">${esc(e2.db)}</span>
        <span class="font-mono text-[9.5px] text-ink-700 ml-auto">${e2.ms}ms · ${e2.rows}r · ${ago(e2.at)}</span>
      </div>
      <div class="clamp2 font-mono text-[10.5px] text-ink-300 leading-snug">${esc(e2.sql)}</div>`;
    d.title = e2.sql;
    d.addEventListener("click", () => {
      setEditorSql(e2.sql);
      if (e2.db !== currentDb && databases.some(x => x.name === e2.db)) selectDb(e2.db);
      document.getElementById("sqlbox").focus();
    });
    el.appendChild(d);
  });
}
