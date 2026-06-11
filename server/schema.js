// schema.js — schema introspection (tables/columns/PKs/FKs) and join-suggestion builders.
import { getPool, quoteIdent } from "./db.js";

export async function fetchSchema(db) {
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

export async function fetchFks(db) {
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

export function buildSuggestions({ fks, columns, pks }, target) {
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

export function buildPath({ fks, columns }, from, to) {
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
