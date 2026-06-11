/* app.js — global state, auth, tabs, database sidebar/tree, table selection, DDL inspector. */

/* ════════════════ state ════════════════ */
let token = localStorage.getItem("pgal_token") || "";
let currentDb = localStorage.getItem("pgal_db") || "";
let activeTable = null;          // {schema, name}
let schemaCache = {};            // db -> {tables, columns, pks, fks}

/* ════════════════ auth ════════════════ */
function showLogin() { document.getElementById("login").style.display = "flex"; }
async function doLogin() {
  const pw = document.getElementById("pw").value;
  try {
    const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Login failed");
    token = data.token; localStorage.setItem("pgal_token", token);
    document.getElementById("login").style.display = "none";
    init();
  } catch (e) { document.getElementById("loginerr").textContent = "✕ " + e.message; }
}
document.getElementById("pw").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
function logout() { localStorage.removeItem("pgal_token"); token = ""; showLogin(); }

/* ════════════════ tabs ════════════════ */
function showTab(name) {
  document.querySelectorAll(".tabpane").forEach(p => p.removeAttribute("data-on"));
  document.querySelectorAll("nav .tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.getElementById("tab-" + name).setAttribute("data-on", "");
  if (name === "roles") { loadRoles(); loadGrants(); loadAudit(); }
  if (name === "joins") fillTableSelects();
  if (name === "impexp") fillDbSelects();
  if (name === "table") loadTableDef();
}

/* ════════════════ databases sidebar ════════════════ */
let databases = [];
async function loadDatabases() {
  const t0 = performance.now();
  const { databases: dbs, ai } = await api("/api/databases");
  const ms = Math.round(performance.now() - t0);
  document.getElementById("latency").innerHTML = `<span class="led led-green"></span><span>online · ${ms}ms</span>`;
  aiSetAvailable(ai);
  databases = dbs;
  const el = document.getElementById("dblist");
  el.innerHTML = "";
  for (const d of dbs) {
    const item = document.createElement("div");
    item.className = "mb-0.5";
    item.innerHTML = `
      <div class="dbrow group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer hover:bg-paper-800 ${d.name === currentDb ? "bg-paper-700 ring-1 ring-rule-500" : ""}" data-db="${esc(d.name)}">
        <span class="text-quill-400">${ic("database", 13)}</span>
        <span class="dbname font-medium text-[12.5px] flex-1 truncate">${esc(d.name)}</span>
        <span class="font-mono text-[10px] text-ink-700">${fmtBytes(d.bytes)} · ${d.connections}c</span>
        <button class="btn btn-sm btn-icon btn-danger opacity-0 group-hover:opacity-100 transition-opacity" title="Drop database" data-drop="${esc(d.name)}">${ic("trash", 11)}</button>
      </div>
      <div class="tree ml-4 border-l border-rule-700 pl-2" id="tree-${esc(d.name)}"></div>`;
    item.querySelector(".dbrow").addEventListener("click", () => selectDb(d.name));
    item.querySelector("[data-drop]").addEventListener("click", e => { e.stopPropagation(); dropDb(d.name); });
    el.appendChild(item);
  }
  fillDbSelects();
  if (currentDb && dbs.some(d => d.name === currentDb)) selectDb(currentDb, true);
}
async function selectDb(name) {
  if (currentDb !== name) browse = null; // cursors are per-table, per-db
  currentDb = name;
  localStorage.setItem("pgal_db", name);
  document.getElementById("curdb").textContent = name;
  document.querySelectorAll(".dbrow").forEach(r => {
    const on = r.dataset.db === name;
    r.classList.toggle("bg-paper-700", on);
    r.classList.toggle("ring-1", on);
    r.classList.toggle("ring-rule-500", on);
  });
  await loadTree(name);
  fillTableSelects();
}
async function loadTree(db) {
  const el = document.getElementById("tree-" + db);
  if (!el) return;
  el.innerHTML = `<div class="mlabel py-1">loading…</div>`;
  try {
    const schema = await api("/api/schema?db=" + encodeURIComponent(db));
    schemaCache[db] = schema;
    el.innerHTML = "";
    for (const t of schema.tables) {
      const cols = schema.columns.filter(c => c.schema === t.schema && c.table === t.name);
      const pk = (schema.pks.find(p => p.schema === t.schema && p.table === t.name) || {}).cols || [];
      const node = document.createElement("div");
      const label = (t.schema !== "public" ? t.schema + "." : "") + t.name;
      node.innerHTML = `
        <div class="tnode flex items-center gap-1 px-1 py-[3px] rounded cursor-pointer hover:bg-paper-800 text-[12px]" title="Browse rows (sortable, paginated)">
          <span class="chev text-ink-700 transition-transform duration-150" style="display:inline-flex">${ic("chevron", 11)}</span>
          <span class="${t.kind === "view" ? "text-blue-led" : "text-ink-500"}">${ic(t.kind === "view" ? "eye" : "table", 12)}</span>
          <span class="flex-1 truncate text-ink-300">${esc(label)}</span>
          <span class="font-mono text-[9.5px] text-ink-700">${Number(t.est_rows) >= 0 ? "~" + t.est_rows : ""}</span>
        </div>
        <div class="cols hidden ml-6 py-0.5 font-mono text-[10.5px] leading-[1.7] text-ink-500">${cols.map(c =>
          `<div class="truncate">${pk.includes(c.name) ? `<span class="text-amber-led">${ic("keyround", 9)}</span>` : "<span class='inline-block w-[9px]'></span>"} ${esc(c.name)} <span class="text-ink-700">${esc(c.type)}${c.nullable ? "" : " !"}</span></div>`).join("")}
        </div>`;
      const chev = node.querySelector(".chev");
      const cd = node.querySelector(".cols");
      chev.addEventListener("click", e => {
        e.stopPropagation();
        cd.classList.toggle("hidden");
        chev.style.transform = cd.classList.contains("hidden") ? "" : "rotate(90deg)";
      });
      node.querySelector(".tnode").addEventListener("click", () => selectTable(t.schema, t.name));
      el.appendChild(node);
    }
    if (!schema.tables.length) el.innerHTML = `<div class="mlabel py-1">no tables</div>`;
  } catch (e) { el.innerHTML = `<div class="text-red-led text-xs py-1">${esc(e.message)}</div>`; }
}
function showCreateDb() { const d = document.getElementById("createdb"); d.style.display = d.style.display === "none" ? "flex" : "none"; }
async function createDb() {
  const name = document.getElementById("newdbname").value.trim();
  const owner = document.getElementById("newdbowner").value.trim();
  if (!name) return toast("Enter a database name", true);
  try {
    await api("/api/databases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, owner: owner || undefined }) });
    toast("Database " + name + " created");
    document.getElementById("createdb").style.display = "none";
    document.getElementById("newdbname").value = "";
    loadDatabases();
  } catch (e) { toast(e.message, true); }
}
function dropDb(name) {
  openModal(`
    <div class="flex items-center gap-3 px-5 py-4 border-b border-rule-700">
      <span class="led led-red"></span>
      <span class="font-display font-semibold italic text-[16px]">Strike from the ledger</span>
      <span class="chip chip-red ml-auto">irreversible</span>
    </div>
    <div class="px-5 py-4 flex flex-col gap-3">
      <div class="text-ink-300 text-xs"><span class="font-mono text-red-led font-bold">DROP DATABASE "${esc(name)}" WITH (FORCE)</span> — every table, row and index in it is gone for good, and open connections are severed.</div>
      <label class="mlabel">type the database name to confirm</label>
      <input id="dropconfirm" class="input font-mono" placeholder="${esc(name)}" autocomplete="off" spellcheck="false">
    </div>
    <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-rule-700">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" id="dropgo" disabled style="opacity:.45"><span data-ic="trash" data-s="13"></span>Drop database</button>
    </div>`);
  hydrateIcons(modalCard);
  const inp = document.getElementById("dropconfirm"), go = document.getElementById("dropgo");
  inp.focus();
  inp.addEventListener("input", () => {
    const ok = inp.value === name;
    go.disabled = !ok; go.style.opacity = ok ? "1" : ".45";
  });
  inp.addEventListener("keydown", e => { if (e.key === "Enter" && !go.disabled) go.click(); });
  go.addEventListener("click", async () => {
    closeModal();
    try {
      await api("/api/databases/" + encodeURIComponent(name), { method: "DELETE" });
      toast("Dropped " + name);
      if (currentDb === name) { currentDb = ""; document.getElementById("curdb").textContent = "—"; }
      loadDatabases();
    } catch (e) { toast(e.message, true); }
  });
}

/* ════════════════ table selection → browse + DDL tab ════════════════ */
function fqtn(schema, name) { return (schema === "public" ? "" : '"' + schema + '".') + '"' + name + '"'; }
function selectTable(schema, name) {
  activeTable = { schema, name };
  const btn = document.getElementById("tabbtn-table");
  btn.disabled = false;
  document.getElementById("tabbtn-table-label").textContent = name;
  document.getElementById("tbl-title").textContent = (schema === "public" ? "" : schema + ".") + name;
  tableDefLoadedFor = null;
  showTab("query");
  const meta = lookupTableMeta(schema, name);
  if (meta) {
    // PK known → browse mode: sortable headers + keyset pagination
    browse = { schema, table: name, pk: meta.pk, types: meta.types, sort: null, pages: [null], page: 0, limit: 100 };
    browseRun();
  } else {
    browse = null;
    setEditorSql(`SELECT * FROM ${fqtn(schema, name)} LIMIT 100;`);
    runQuery(true);
  }
}

/* ════════════════ DDL & indexes inspector ════════════════ */
let tableDefLoadedFor = null;
async function loadTableDef(force) {
  if (!activeTable || !currentDb) return;
  const key = currentDb + "/" + activeTable.schema + "." + activeTable.name;
  if (!force && tableDefLoadedFor === key) return;
  const ddlEl = document.getElementById("tbl-ddl");
  const idxEl = document.getElementById("tbl-indexes");
  const statsEl = document.getElementById("tbl-stats");
  ddlEl.textContent = "loading…"; idxEl.innerHTML = ""; statsEl.innerHTML = "";
  try {
    const { ddl, indexes, stats = [] } = await api(`/api/tabledef?db=${encodeURIComponent(currentDb)}&schema=${encodeURIComponent(activeTable.schema)}&table=${encodeURIComponent(activeTable.name)}`);
    tableDefLoadedFor = key;
    ddlEl.innerHTML = hlSql(ddl);
    const estRows = stats.length ? Math.max(0, Number(stats[0].est_rows)) : 0;
    const fmtDistinct = nd => {
      if (nd === null || nd === undefined) return '<span class="text-ink-700">—</span>';
      const n = Number(nd);
      if (n === -1) return '<span class="chip chip-green">unique</span>';
      if (n < 0) return `~${Math.round(-n * estRows).toLocaleString()} <span class="text-ink-700">· ${(-n * 100).toFixed(0)}% of rows</span>`;
      return "~" + n.toLocaleString();
    };
    statsEl.innerHTML = stats.length
      ? `<table class="grid-table w-full"><thead><tr><th>column</th><th>type</th><th>constraint</th><th>null %</th><th>distinct · cardinality</th><th>avg width</th></tr></thead>
        <tbody>${stats.map(c => `<tr>
          <td class="text-ink-100">${esc(c.name)}</td>
          <td>${esc(c.type)}</td>
          <td>${c.nullable ? "" : '<span class="chip chip-amber">not null</span>'}</td>
          <td>${c.null_frac == null ? '<span class="text-ink-700">—</span>' : (Number(c.null_frac) * 100).toFixed(1) + "%"}</td>
          <td>${fmtDistinct(c.n_distinct)}</td>
          <td>${c.avg_width == null ? '<span class="text-ink-700">—</span>' : c.avg_width + " B"}</td>
        </tr>`).join("")}</tbody></table>` + (stats.every(c => c.n_distinct == null)
          ? `<div class="mlabel mt-2">no statistics yet — run <span class="text-quill-400">ANALYZE ${esc(activeTable.name)}</span> in the console</div>`
          : `<div class="mlabel mt-2">≈ ${estRows.toLocaleString()} rows (planner estimate)</div>`)
      : `<div class="mlabel py-2">—</div>`;
    idxEl.innerHTML = indexes.length
      ? `<table class="grid-table w-full"><thead><tr><th>index</th><th>type</th><th>size</th><th>scans</th><th>definition</th></tr></thead>
        <tbody>${indexes.map(x => `<tr>
          <td class="text-ink-100">${esc(x.name)}</td>
          <td>${x.is_primary ? '<span class="chip chip-amber">primary</span>' : x.is_unique ? '<span class="chip chip-quill">unique</span>' : '<span class="chip">btree</span>'}</td>
          <td>${fmtBytes(x.bytes)}</td>
          <td class="${Number(x.scans) === 0 ? "text-ink-700" : "text-green-led"}">${x.scans}</td>
          <td class="!whitespace-normal !max-w-none font-mono text-[11px]">${esc(x.def)}</td>
        </tr>`).join("")}</tbody></table>`
      : `<div class="mlabel py-2">no indexes</div>`;
  } catch (e) { ddlEl.textContent = e.message; }
}
function copyDdl() {
  navigator.clipboard.writeText(document.getElementById("tbl-ddl").textContent);
  toast("DDL copied");
}
