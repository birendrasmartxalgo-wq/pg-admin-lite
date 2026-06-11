/* builder.js — Builder tab.
   Create mode: column grid (null/default/pk/unique/identity/check) + table-level
   constraints (composite unique, check, FK) + indexes → DDL preview → execute.
   Alter mode: pick a table, pick an operation, fill a small form → reviewable DDL
   → execute through the same danger-confirm flow as the console.
   Plus the insert-row modal used by the browse grid and the DDL tab. */
const PG_TYPES = ["BIGSERIAL","SERIAL","BIGINT","INTEGER","SMALLINT","NUMERIC(12,2)","DOUBLE PRECISION","TEXT","VARCHAR(255)","BOOLEAN","DATE","TIMESTAMPTZ","TIMESTAMP","TIME","UUID","JSONB","BYTEA"];
const qi = s => '"' + String(s).replace(/"/g, '""') + '"';
const fqOf = (schema, name) => (schema === "public" ? "" : qi(schema) + ".") + qi(name);

/* ──── mode toggle ──── */
function builderMode(mode) {
  const create = mode === "create";
  document.getElementById("builder-create").classList.toggle("hidden", !create);
  document.getElementById("builder-create").classList.toggle("flex", create);
  document.getElementById("builder-alter").classList.toggle("hidden", create);
  document.getElementById("builder-alter").classList.toggle("flex", !create);
  document.getElementById("bmode-create").classList.toggle("btn-primary", create);
  document.getElementById("bmode-alter").classList.toggle("btn-primary", !create);
  if (!create) fillAltTables();
}

/* ════════════════ CREATE mode ════════════════ */
function addColRow(name = "", type = "TEXT") {
  const div = document.createElement("div");
  div.className = "grid items-center gap-1.5";
  div.style.gridTemplateColumns = "1.1fr 1fr 0.3fr 0.85fr 0.25fr 0.32fr 0.4fr 1fr 0.26fr";
  div.dataset.coldef = "1";
  div.innerHTML = `
    <input class="input font-mono text-xs py-1.5" placeholder="column_name" value="${esc(name)}" oninput="renderDdl()">
    <select class="input text-xs py-1.5 font-mono" oninput="renderDdl()">${PG_TYPES.map(t => `<option ${t === type ? "selected" : ""}>${t}</option>`).join("")}</select>
    <label class="text-[11px] text-ink-500 flex items-center gap-1 justify-center" title="nullable"><input type="checkbox" checked class="accent-quill-500" oninput="renderDdl()">null</label>
    <input class="input font-mono text-xs py-1.5" placeholder="default (raw SQL)" oninput="renderDdl()">
    <label class="text-[11px] text-ink-500 flex items-center gap-1 justify-center" title="primary key"><input type="checkbox" class="accent-amber-led" oninput="renderDdl()">pk</label>
    <label class="text-[11px] text-ink-500 flex items-center gap-1 justify-center" title="UNIQUE"><input type="checkbox" class="accent-quill-500" oninput="renderDdl()">uniq</label>
    <label class="text-[11px] text-ink-500 flex items-center gap-1 justify-center" title="GENERATED ALWAYS AS IDENTITY (use an integer type)"><input type="checkbox" class="accent-quill-500" oninput="renderDdl()">ident</label>
    <input class="input font-mono text-xs py-1.5" placeholder="check, e.g. price > 0" oninput="renderDdl()">
    <button class="btn btn-sm btn-icon btn-danger justify-self-center" onclick="this.parentElement.remove(); renderDdl()">${ic("x", 11)}</button>`;
  document.getElementById("ct-cols").appendChild(div);
  renderDdl();
}

/* table-level constraint / index rows */
function addConstraintRow(kind) {
  const div = document.createElement("div");
  div.className = "flex items-center gap-1.5 flex-wrap";
  div.dataset.ctcon = kind;
  const rm = `<button class="btn btn-sm btn-icon btn-danger" onclick="this.parentElement.remove(); renderDdl()">${ic("x", 11)}</button>`;
  const tableList = (schemaCache[currentDb]?.tables || []).map(t => `<option value="${esc((t.schema === "public" ? "" : t.schema + ".") + t.name)}">`).join("");
  if (kind === "unique") div.innerHTML = `<span class="chip chip-quill">UNIQUE</span>
    <input class="input font-mono text-xs py-1.5 w-72" placeholder="col_a, col_b" oninput="renderDdl()">${rm}`;
  else if (kind === "check") div.innerHTML = `<span class="chip chip-amber">CHECK</span>
    <input class="input font-mono text-xs py-1.5 w-96" placeholder="expression, e.g. qty >= 0" oninput="renderDdl()">${rm}`;
  else if (kind === "fk") div.innerHTML = `<span class="chip chip-green">FK</span>
    <input class="input font-mono text-xs py-1.5 w-40" placeholder="local col(s)" oninput="renderDdl()">
    <span class="mlabel">references</span>
    <input class="input font-mono text-xs py-1.5 w-44" placeholder="ref_table" list="bld-tables" oninput="renderDdl()">
    <input class="input font-mono text-xs py-1.5 w-36" placeholder="ref col(s) = same" oninput="renderDdl()">
    <select class="input text-xs py-1.5" oninput="renderDdl()"><option value="">on delete…</option><option>CASCADE</option><option>SET NULL</option><option>RESTRICT</option></select>
    <datalist id="bld-tables">${tableList}</datalist>${rm}`;
  else if (kind === "index") div.innerHTML = `<span class="chip">INDEX</span>
    <input class="input font-mono text-xs py-1.5 w-72" placeholder="col_a, col_b DESC" oninput="renderDdl()">
    <label class="text-[11px] text-ink-500 flex items-center gap-1"><input type="checkbox" class="accent-quill-500" oninput="renderDdl()">unique</label>
    <input class="input font-mono text-xs py-1.5 w-44" placeholder="name (optional)" oninput="renderDdl()">${rm}`;
  document.getElementById("ct-constraints").appendChild(div);
  renderDdl();
}

const splitCols = v => v.split(",").map(s => s.trim()).filter(Boolean);
/* default FK target: the referenced table's PK (when known), else mirror the local names */
function refColsDefault(refRaw, local) {
  const s = schemaCache[currentDb];
  if (s) {
    const [sch, tbl] = refRaw.includes(".") ? refRaw.split(".") : ["public", refRaw];
    const pk = s.pks.find(p => p.schema === sch && p.table === tbl)?.cols;
    if (pk?.length === local.length) return pk;
  }
  return local;
}
function buildDdl() {
  const schema = document.getElementById("ct-schema").value.trim() || "public";
  const name = document.getElementById("ct-name").value.trim();
  if (!name) return null;
  const lines = [], pks = [], tail = [];
  for (const row of document.querySelectorAll("[data-coldef]")) {
    const inputs = row.querySelectorAll("input"); // [name, null, default, pk, uniq, ident, check]
    const colName = inputs[0].value.trim();
    const type = row.querySelector("select").value;
    if (!colName) continue;
    let l = `  ${qi(colName)} ${type}`;
    if (inputs[5].checked) l += " GENERATED ALWAYS AS IDENTITY";
    if (!inputs[1].checked) l += " NOT NULL";
    if (inputs[2].value.trim() && !inputs[5].checked) l += ` DEFAULT ${inputs[2].value.trim()}`;
    if (inputs[4].checked) l += " UNIQUE";
    if (inputs[6].value.trim()) l += ` CHECK (${inputs[6].value.trim()})`;
    lines.push(l);
    if (inputs[3].checked) pks.push(qi(colName));
  }
  if (!lines.length) return null;
  if (pks.length) lines.push(`  PRIMARY KEY (${pks.join(", ")})`);
  const fq = fqOf(schema, name);
  for (const row of document.querySelectorAll("[data-ctcon]")) {
    const kind = row.dataset.ctcon;
    const inputs = row.querySelectorAll("input");
    if (kind === "unique" && inputs[0].value.trim())
      lines.push(`  UNIQUE (${splitCols(inputs[0].value).map(qi).join(", ")})`);
    else if (kind === "check" && inputs[0].value.trim())
      lines.push(`  CHECK (${inputs[0].value.trim()})`);
    else if (kind === "fk" && inputs[0].value.trim() && inputs[1].value.trim()) {
      const local = splitCols(inputs[0].value), refRaw = inputs[1].value.trim();
      const ref = refRaw.includes(".") ? refRaw.split(".").map(qi).join(".") : qi(refRaw);
      const refCols = inputs[2].value.trim() ? splitCols(inputs[2].value) : refColsDefault(refRaw, local);
      const onDel = row.querySelector("select").value;
      lines.push(`  FOREIGN KEY (${local.map(qi).join(", ")}) REFERENCES ${ref} (${refCols.map(qi).join(", ")})${onDel ? " ON DELETE " + onDel : ""}`);
    } else if (kind === "index" && inputs[0].value.trim()) {
      const uniq = inputs[1].checked;
      const idxName = inputs[2].value.trim() || `idx_${name}_${splitCols(inputs[0].value)[0].replace(/\W/g, "")}`;
      tail.push(`CREATE ${uniq ? "UNIQUE " : ""}INDEX ${qi(idxName)} ON ${fq} (${inputs[0].value.trim()});`);
    }
  }
  return `CREATE TABLE ${fq} (\n${lines.join(",\n")}\n);` + (tail.length ? "\n" + tail.join("\n") : "");
}
function renderDdl() {
  const ddl = buildDdl();
  document.getElementById("ct-ddl").innerHTML = ddl ? hlSql(ddl) : '<span class="cmt">-- add a table name and at least one column</span>';
}
async function execDdl() {
  const ddl = buildDdl();
  if (!ddl) return toast("Add a table name and at least one column", true);
  if (!currentDb) return toast("Select a database first", true);
  try {
    const { results } = await api("/api/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ db: currentDb, sql: ddl }) });
    const bad = results.find(r => !r.ok);
    if (!bad) { toast("Table created in " + currentDb); loadTree(currentDb); }
    else toast(bad.error, true);
  } catch (e) { toast(e.message, true); }
}
function ddlToEditor() { const ddl = buildDdl(); if (ddl) { setEditorSql(ddl); showTab("query"); } }

/* ════════════════ ALTER mode ════════════════ */
let altState = { table: null, op: null, indexes: [] };
function fillAltTables() {
  const sel = document.getElementById("alt-table");
  const cur = sel.value;
  const s = schemaCache[currentDb];
  sel.innerHTML = `<option value="">Pick a table…</option>` + (s ? s.tables.filter(t => t.kind !== "view").map(t => {
    const v = t.schema + "." + t.name;
    return `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc((t.schema === "public" ? "" : t.schema + ".") + t.name)}</option>`;
  }).join("") : "");
}
function altCols() {
  if (!altState.table) return [];
  const s = schemaCache[currentDb];
  return s ? s.columns.filter(c => c.schema === altState.table.schema && c.table === altState.table.name) : [];
}
async function altTableChanged() {
  const v = document.getElementById("alt-table").value;
  if (!v) { altState.table = null; document.getElementById("alt-meta").textContent = ""; return; }
  const [schema, name] = v.split(".");
  altState = { table: { schema, name }, op: altState.op, indexes: [] };
  document.getElementById("alt-meta").textContent = `${altCols().length} columns`;
  if (altState.op) altOp(altState.op); // re-render the form with the new table's columns
  try { // index list for "drop index" (best-effort)
    const { indexes } = await api(`/api/tabledef?db=${encodeURIComponent(currentDb)}&schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(name)}`);
    altState.indexes = indexes || [];
    if (altState.op === "dropidx" || altState.op === "dropcon") altOp(altState.op);
  } catch { /* ignore */ }
}
const altColOptions = () => altCols().map(c => `<option value="${esc(c.name)}">${esc(c.name)} · ${esc(c.type)}</option>`).join("");
function altOp(op) {
  altState.op = op;
  document.querySelectorAll("#alt-ops [data-op]").forEach(b => b.classList.toggle("btn-primary", b.dataset.op === op));
  const form = document.getElementById("alt-form");
  form.classList.remove("hidden");
  if (!altState.table) { form.innerHTML = `<div class="mlabel">pick a table first</div>`; return; }
  const colSel = id => `<select id="${id}" class="input text-xs py-1.5 font-mono w-52" oninput="renderAlterDdl()">${altColOptions()}</select>`;
  const F = {
    addcol: `<div class="flex items-center gap-2 flex-wrap">
      <input id="af-name" class="input font-mono text-xs py-1.5 w-44" placeholder="column_name" oninput="renderAlterDdl()">
      <select id="af-type" class="input text-xs py-1.5 font-mono" oninput="renderAlterDdl()">${PG_TYPES.map(t => `<option>${t}</option>`).join("")}</select>
      <label class="text-[11px] text-ink-500 flex items-center gap-1"><input type="checkbox" id="af-null" checked class="accent-quill-500" oninput="renderAlterDdl()">nullable</label>
      <input id="af-dflt" class="input font-mono text-xs py-1.5 w-44" placeholder="default (raw SQL)" oninput="renderAlterDdl()"></div>`,
    dropcol: `<div class="flex items-center gap-2"><span class="mlabel">column</span>${colSel("af-col")}<span class="chip chip-red">drops the column and its data</span></div>`,
    rencol: `<div class="flex items-center gap-2"><span class="mlabel">column</span>${colSel("af-col")}<span class="mlabel">→</span>
      <input id="af-new" class="input font-mono text-xs py-1.5 w-44" placeholder="new_name" oninput="renderAlterDdl()"></div>`,
    rettype: `<div class="flex items-center gap-2 flex-wrap"><span class="mlabel">column</span>${colSel("af-col")}<span class="mlabel">to</span>
      <input id="af-type" class="input font-mono text-xs py-1.5 w-44" placeholder="new type, e.g. BIGINT" list="af-types" oninput="renderAlterDdl()"><datalist id="af-types">${PG_TYPES.map(t => `<option>${t}</option>`).join("")}</datalist>
      <input id="af-using" class="input font-mono text-xs py-1.5 w-64" placeholder="USING expr (optional), e.g. col::bigint" oninput="renderAlterDdl()"></div>`,
    dflt: `<div class="flex items-center gap-2 flex-wrap"><span class="mlabel">column</span>${colSel("af-col")}
      <select id="af-mode" class="input text-xs py-1.5" oninput="renderAlterDdl()"><option value="set">SET DEFAULT</option><option value="drop">DROP DEFAULT</option></select>
      <input id="af-expr" class="input font-mono text-xs py-1.5 w-56" placeholder="expression, e.g. now()" oninput="renderAlterDdl()"></div>`,
    notnull: `<div class="flex items-center gap-2"><span class="mlabel">column</span>${colSel("af-col")}
      <select id="af-mode" class="input text-xs py-1.5" oninput="renderAlterDdl()"><option value="set">SET NOT NULL</option><option value="drop">DROP NOT NULL</option></select></div>`,
    addidx: `<div class="flex items-center gap-2 flex-wrap">
      <input id="af-cols" class="input font-mono text-xs py-1.5 w-72" placeholder="col_a, col_b DESC" oninput="renderAlterDdl()">
      <label class="text-[11px] text-ink-500 flex items-center gap-1"><input type="checkbox" id="af-uniq" class="accent-quill-500" oninput="renderAlterDdl()">unique</label>
      <input id="af-name" class="input font-mono text-xs py-1.5 w-48" placeholder="index name (optional)" oninput="renderAlterDdl()"></div>`,
    dropidx: `<div class="flex items-center gap-2"><span class="mlabel">index</span>
      <select id="af-idx" class="input text-xs py-1.5 font-mono w-80" oninput="renderAlterDdl()">${altState.indexes.filter(x => !x.is_primary).map(x => `<option value="${esc(x.name)}">${esc(x.name)}${x.is_unique ? " · unique" : ""}</option>`).join("") || "<option value=''>no droppable indexes</option>"}</select></div>`,
    addfk: `<div class="flex items-center gap-2 flex-wrap">
      <span class="mlabel">column(s)</span><input id="af-cols" class="input font-mono text-xs py-1.5 w-44" placeholder="user_id" oninput="renderAlterDdl()">
      <span class="mlabel">references</span>
      <select id="af-ref" class="input text-xs py-1.5 font-mono w-52" oninput="renderAlterDdl()">${(schemaCache[currentDb]?.tables || []).filter(t => t.kind !== "view").map(t => `<option value="${esc(t.schema + "." + t.name)}">${esc((t.schema === "public" ? "" : t.schema + ".") + t.name)}</option>`).join("")}</select>
      <input id="af-refcols" class="input font-mono text-xs py-1.5 w-40" placeholder="ref col(s) = same" oninput="renderAlterDdl()">
      <select id="af-ondel" class="input text-xs py-1.5" oninput="renderAlterDdl()"><option value="">on delete…</option><option>CASCADE</option><option>SET NULL</option><option>RESTRICT</option></select></div>`,
    dropcon: `<div class="flex items-center gap-2 flex-wrap"><span class="mlabel">constraint</span>
      <input id="af-con" class="input font-mono text-xs py-1.5 w-80" placeholder="constraint name" list="af-cons" oninput="renderAlterDdl()">
      <datalist id="af-cons">${(schemaCache[currentDb]?.fks || []).filter(f => f.src_schema === altState.table.schema && f.src_table === altState.table.name).map(f => `<option value="${esc(f.name)}">`).join("")}</datalist>
      <span class="chip chip-amber">FK names suggested · PK/unique/check names from the DDL tab</span></div>`,
  };
  form.innerHTML = F[op] || "";
  renderAlterDdl();
}
const gv = id => document.getElementById(id)?.value?.trim() || "";
function buildAlterDdl() {
  if (!altState.table || !altState.op) return null;
  const fq = fqOf(altState.table.schema, altState.table.name);
  const op = altState.op;
  if (op === "addcol") {
    const n = gv("af-name"); if (!n) return null;
    let l = `ALTER TABLE ${fq} ADD COLUMN ${qi(n)} ${gv("af-type") || "TEXT"}`;
    if (!document.getElementById("af-null")?.checked) l += " NOT NULL";
    if (gv("af-dflt")) l += ` DEFAULT ${gv("af-dflt")}`;
    return l + ";";
  }
  if (op === "dropcol") return gv("af-col") ? `ALTER TABLE ${fq} DROP COLUMN ${qi(gv("af-col"))};` : null;
  if (op === "rencol") return gv("af-col") && gv("af-new") ? `ALTER TABLE ${fq} RENAME COLUMN ${qi(gv("af-col"))} TO ${qi(gv("af-new"))};` : null;
  if (op === "rettype") {
    if (!gv("af-col") || !gv("af-type")) return null;
    return `ALTER TABLE ${fq} ALTER COLUMN ${qi(gv("af-col"))} TYPE ${gv("af-type")}${gv("af-using") ? ` USING ${gv("af-using")}` : ""};`;
  }
  if (op === "dflt") {
    if (!gv("af-col")) return null;
    if (document.getElementById("af-mode").value === "drop")
      return `ALTER TABLE ${fq} ALTER COLUMN ${qi(gv("af-col"))} DROP DEFAULT;`;
    return gv("af-expr") ? `ALTER TABLE ${fq} ALTER COLUMN ${qi(gv("af-col"))} SET DEFAULT ${gv("af-expr")};` : null;
  }
  if (op === "notnull") {
    if (!gv("af-col")) return null;
    return document.getElementById("af-mode").value === "drop"
      ? `ALTER TABLE ${fq} ALTER COLUMN ${qi(gv("af-col"))} DROP NOT NULL;`
      : `ALTER TABLE ${fq} ALTER COLUMN ${qi(gv("af-col"))} SET NOT NULL;`;
  }
  if (op === "addidx") {
    if (!gv("af-cols")) return null;
    const idxName = gv("af-name") || `idx_${altState.table.name}_${splitCols(gv("af-cols"))[0].split(/\s/)[0].replace(/\W/g, "")}`;
    return `CREATE ${document.getElementById("af-uniq")?.checked ? "UNIQUE " : ""}INDEX ${qi(idxName)} ON ${fq} (${gv("af-cols")});`;
  }
  if (op === "dropidx") return gv("af-idx") ? `DROP INDEX ${qi(gv("af-idx"))};` : null;
  if (op === "addfk") {
    if (!gv("af-cols") || !gv("af-ref")) return null;
    const local = splitCols(gv("af-cols"));
    const [rs, rt] = gv("af-ref").split(".");
    const refCols = gv("af-refcols") ? splitCols(gv("af-refcols")) : refColsDefault(gv("af-ref"), local);
    const conName = `fk_${altState.table.name}_${local[0].replace(/\W/g, "")}`;
    return `ALTER TABLE ${fq} ADD CONSTRAINT ${qi(conName)} FOREIGN KEY (${local.map(qi).join(", ")}) REFERENCES ${fqOf(rs, rt)} (${refCols.map(qi).join(", ")})${gv("af-ondel") ? " ON DELETE " + gv("af-ondel") : ""};`;
  }
  if (op === "dropcon") return gv("af-con") ? `ALTER TABLE ${fq} DROP CONSTRAINT ${qi(gv("af-con"))};` : null;
  return null;
}
function renderAlterDdl() {
  const ddl = buildAlterDdl();
  document.getElementById("alt-ddl").innerHTML = ddl ? hlSql(ddl) : '<span class="cmt">-- fill in the form above</span>';
}
async function execAlterDdl() {
  const ddl = buildAlterDdl();
  if (!ddl) return toast("Complete the form first", true);
  if (!currentDb) return toast("Select a database first", true);
  const warns = classifyDanger(ddl);
  if (warns.length && !(await confirmDanger(warns, ddl))) return;
  try {
    const { results } = await api("/api/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ db: currentDb, sql: ddl }) });
    const bad = results.find(r => !r.ok);
    if (bad) return toast(bad.error, true);
    toast("Altered " + altState.table.name);
    await loadTree(currentDb);
    altTableChanged(); // refresh column/index lists
  } catch (e) { toast(e.message, true); }
}
function alterToEditor() { const ddl = buildAlterDdl(); if (ddl) { setEditorSql(ddl); showTab("query"); } }

/* ════════════════ insert-row modal ════════════════ */
function insertInputFor(c, idx) {
  const t = c.type.toLowerCase();
  const base = `data-ins="${idx}" oninput="renderInsertSql()"`;
  if (/bool/.test(t)) return `<select class="input text-xs py-1.5" ${base}><option value="">—</option><option>true</option><option>false</option></select>`;
  if (t === "date") return `<input type="date" class="input text-xs py-1.5" ${base}>`;
  if (/timestamp/.test(t)) return `<input type="datetime-local" step="1" class="input text-xs py-1.5" ${base}>`;
  if (/json/.test(t)) return `<textarea class="input font-mono text-xs py-1.5 min-h-9 resize-y" placeholder='{"k": "v"}' ${base}></textarea>`;
  if (/int|numeric|real|double|decimal/.test(t)) return `<input type="number" step="any" class="input font-mono text-xs py-1.5" ${base}>`;
  return `<input class="input font-mono text-xs py-1.5" ${base}>`;
}
let insMeta = null; // { schema, table, cols }
function openInsertRow(schema, table) {
  const s = schemaCache[currentDb];
  if (!s) return toast("Schema not loaded yet", true);
  const cols = s.columns.filter(c => c.schema === schema && c.table === table);
  if (!cols.length) return toast("No columns found for " + table, true);
  insMeta = { schema, table, cols };
  openModal(`
    <div class="flex items-center gap-2.5 px-5 py-4 border-b border-rule-700">
      <span class="text-quill-400" data-ic="rowinsert" data-s="15"></span>
      <span class="font-display font-semibold italic text-[16px]">New row · <span class="font-mono not-italic text-[13px]">${esc(table)}</span></span>
      <button class="btn btn-sm btn-icon ml-auto" onclick="closeModal()"><span data-ic="x" data-s="13"></span></button>
    </div>
    <div class="px-5 py-4 flex flex-col gap-2 overflow-y-auto min-h-0">
      <div class="mlabel">tick “default” to omit a column (identity / serial / defaulted columns are pre-ticked)</div>
      ${cols.map((c, i) => {
        const auto = /nextval\(/.test(c.dflt || "") || c.dflt;
        return `<div class="grid items-center gap-2" style="grid-template-columns: 1.1fr 0.9fr 2fr 0.6fr">
          <span class="font-mono text-xs ${c.nullable ? "" : "text-ink-100 font-semibold"}">${esc(c.name)}${c.nullable ? "" : " *"}</span>
          <span class="chip justify-self-start">${esc(c.type)}</span>
          ${insertInputFor(c, i)}
          <label class="text-[11px] text-ink-500 flex items-center gap-1"><input type="checkbox" data-insdef="${i}" ${auto ? "checked" : ""} class="accent-quill-500" oninput="renderInsertSql()">default</label>
        </div>`;
      }).join("")}
      <div class="mlabel mt-1">generated insert</div>
      <pre class="sqlblock max-h-40 overflow-y-auto" id="ins-sql"></pre>
    </div>
    <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-rule-700">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="execInsertRow()"><span data-ic="play" data-s="13"></span>Insert row</button>
    </div>`);
  hydrateIcons(modalCard);
  renderInsertSql();
}
function buildInsertSql() {
  if (!insMeta) return null;
  const names = [], vals = [];
  insMeta.cols.forEach((c, i) => {
    if (modalCard.querySelector(`[data-insdef="${i}"]`)?.checked) return; // use column default
    const el = modalCard.querySelector(`[data-ins="${i}"]`);
    let v = el ? el.value : "";
    if (v === "" && c.nullable) { names.push(qi(c.name)); vals.push("NULL"); return; }
    if (v === "") return; // empty + not null + no default → omit and let PG complain explicitly
    const t = c.type.toLowerCase();
    if (/json/.test(t)) { try { v = JSON.parse(v); } catch { /* keep as text */ } }
    if (/timestamp/.test(t) && el.type === "datetime-local") v = v.replace("T", " ");
    names.push(qi(c.name));
    vals.push(sqlLit(v, c.type));
  });
  if (!names.length) return null;
  return `INSERT INTO ${fqOf(insMeta.schema, insMeta.table)} (${names.join(", ")})\nVALUES (${vals.join(", ")});`;
}
function renderInsertSql() {
  const sql = buildInsertSql();
  const el = document.getElementById("ins-sql");
  if (el) el.innerHTML = sql ? hlSql(sql) : '<span class="cmt">-- fill in at least one value</span>';
}
async function execInsertRow() {
  const sql = buildInsertSql();
  if (!sql) return toast("Fill in at least one value", true);
  try {
    const { results } = await api("/api/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ db: currentDb, sql }) });
    if (!results[0].ok) return toast(results[0].error, true);
    toast("Row inserted into " + insMeta.table);
    closeModal();
    refreshCurrent();
  } catch (e) { toast(e.message, true); }
}
