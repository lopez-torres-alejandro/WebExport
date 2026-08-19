const path = require('path');
const express = require('express');
const multer = require('multer');
const os = require('os');
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');
const { sql, getConfig } = require('./sql');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');
const imp = require('./importer');
const db = require('./db');
require('dotenv').config();

const app = express();
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
const PORT = Number(process.env.WEB_PORT) || 3000;
app.use(express.static(path.join(__dirname, 'public')));

db.deleteRecomendacion('dbo.NOMINAL_TRAMA_NUEVO');
db.setTablaVisible('INM', 'VRS_2026_historial', false);
db.setTablaVisible('dbEstrategias.INM', 'VRS_2026_historial', false);

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(500).json({ ok: false, error: e.message }));

const HIST_FILE = path.join(__dirname, 'load_history.json');
let hist = {};
try { hist = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch (_) { hist = {}; }

function histPorFila(tabla) {
  const arr = hist[tabla] || [];
  if (!arr.length) return null;
  const ult = arr[arr.length - 1];
  return ult.filas > 0 ? ult.durMs / ult.filas : null;
}

function histPorFilaGlobal(sufijo) {
  let totalMs = 0, totalFilas = 0, n = 0;
  for (const key of Object.keys(hist)) {
    if (!key.endsWith(sufijo)) continue;
    const es = hist[key];
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.filas > 0 && e.durMs > 0) { totalMs += e.durMs; totalFilas += e.filas; n++; }
    }
  }
  return n > 0 && totalFilas > 0 ? totalMs / totalFilas : null;
}

function histMergePorFila(tabla) {
  const arr = hist[tabla] || [];
  if (!arr.length) return null;
  const ult = arr[arr.length - 1];
  return ult.filas > 0 && ult.mergeMs ? ult.mergeMs / ult.filas : null;
}

function histRegistrar(tabla, filas, durMs, mergeMs) {
  try {
    if (!Array.isArray(hist[tabla])) hist[tabla] = [];
    hist[tabla].push({ filas, durMs, mergeMs: mergeMs || null, ts: Date.now() });
    if (hist[tabla].length > 50) hist[tabla].splice(0, hist[tabla].length - 50);
    fs.writeFileSync(HIST_FILE, JSON.stringify(hist));
  } catch (_) {}
}

async function getKeyMarkers(pool, schema, table) {
  const r = await pool.request()
    .input('s', sql.NVarChar, schema)
    .input('t', sql.NVarChar, table)
    .query(`
      SELECT c.COLUMN_NAME, c.DATA_TYPE,
             CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS es_pk,
             CASE WHEN uq.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS es_unico
      FROM INFORMATION_SCHEMA.COLUMNS c
      LEFT JOIN (
        SELECT kcu.COLUMN_NAME
        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
          ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        WHERE tc.TABLE_SCHEMA = @s AND tc.TABLE_NAME = @t AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
      ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME
      LEFT JOIN (
        SELECT col.name AS COLUMN_NAME
        FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
        WHERE i.object_id = OBJECT_ID(@s + '.' + @t) AND i.is_unique = 1 AND i.is_primary_key = 0
      ) uq ON uq.COLUMN_NAME = c.COLUMN_NAME
      WHERE c.TABLE_SCHEMA = @s AND c.TABLE_NAME = @t
      ORDER BY c.ORDINAL_POSITION;`);
  return r.recordset;
}

async function getPkCols(pool, schema, table) {
  const r = await pool.request()
    .input('s', sql.NVarChar, schema)
    .input('t', sql.NVarChar, table)
    .query(`
      SELECT kcu.COLUMN_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
        ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
      WHERE tc.TABLE_SCHEMA = @s AND tc.TABLE_NAME = @t AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
      ORDER BY kcu.ORDINAL_POSITION;`);
  return r.recordset.map((x) => x.COLUMN_NAME);
}

async function getUniqueIdxCols(pool, schema, table) {
  const r = await pool.request()
    .input('s', sql.NVarChar, schema)
    .input('t', sql.NVarChar, table)
    .query(`
      SELECT TOP 1 i.index_id
      FROM sys.indexes i
      WHERE i.object_id = OBJECT_ID(@s + '.' + @t) AND i.is_unique = 1 AND i.is_primary_key = 0
      ORDER BY i.index_id;`);
  if (!r.recordset.length) return [];
  const idxId = r.recordset[0].index_id;
  const r2 = await pool.request()
    .input('s', sql.NVarChar, schema)
    .input('t', sql.NVarChar, table)
    .input('i', sql.Int, idxId)
    .query(`
      SELECT c.name AS COLUMN_NAME
      FROM sys.index_columns ic
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE ic.object_id = OBJECT_ID(@s + '.' + @t) AND ic.index_id = @i
      ORDER BY ic.key_ordinal;`);
  return r2.recordset.map((x) => x.COLUMN_NAME);
}

app.get('/api/tablas/visibilidad', wrap(async (req, res) => {
  const pool = await new sql.ConnectionPool(getConfig()).connect();
  try {
    const all = (await imp.listTables(pool)).concat(await imp.listTablesDe(pool, 'dbEstrategias'));
    const ocultas = db.getTablasOcultas();
    const ocultasTrab = db.getTablasOcultasTrab();
    const tablas = all.map((t) => ({ tabla: t, visible: !ocultas.has(t), visibleTrab: !ocultasTrab.has(t) }));
    const visibles = tablas.filter((t) => t.visible).map((t) => t.tabla);
    const visiblesTrab = tablas.filter((t) => t.visibleTrab).map((t) => t.tabla);
    res.json({ ok: true, tablas, visibles, visiblesTrab });
  } finally { await pool.close(); }
}));

app.get('/api/tablas', wrap(async (req, res) => {
  const pool = await new sql.ConnectionPool(getConfig()).connect();
  try {
    const all = (await imp.listTables(pool)).concat(await imp.listTablesDe(pool, 'dbEstrategias'));
    const ocultas = db.getTablasOcultas();
    res.json({ ok: true, tablas: all.filter((t) => !ocultas.has(t)) });
  } finally { await pool.close(); }
}));

app.post('/api/tablas/visibilidad', wrap(async (req, res) => {
  const [dbParte, schema, table] = imp.splitTabla(req.body.tabla || '');
  const sc = dbParte ? `${dbParte}.${schema}` : schema;
  if (Object.prototype.hasOwnProperty.call(req.body, 'visibleTrab')) {
    db.setTablaVisibleTrab(sc, table, req.body.visibleTrab !== false && req.body.visibleTrab !== 'false');
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'visible')) {
    db.setTablaVisible(sc, table, req.body.visible !== false && req.body.visible !== 'false');
  }
  res.json({ ok: true, tabla: `${sc}.${table}` });
}));

app.get('/api/columnas', wrap(async (req, res) => {
  const [db, schema, table] = imp.splitTabla(req.query.tabla || '');
  if (db) throw new Error(`La tabla '${db}.${schema}.${table}' es de otra base: solo se puede exportar, no importar.`);
  const pool = await new sql.ConnectionPool(getConfig()).connect();
  try {
    const markers = await getKeyMarkers(pool, schema, table);
    const pkCols = getPkColsFromMarkers(markers);
    const unica = markers.find((m) => m.es_unico && !m.es_pk);
    const recomendada = db.getRecomendacion(`${schema}.${table}`);
    const sugerida = recomendada ? recomendada.columnas : (pkCols.length ? pkCols : (unica ? [unica.COLUMN_NAME] : []));
    res.json({
      ok: true,
      tabla: `${schema}.${table}`,
      columnas: markers.map((m) => ({ nombre: m.COLUMN_NAME, tipo: m.DATA_TYPE, es_pk: !!m.es_pk, es_unico: !!m.es_unico })),
      sugerida,
      pk: pkCols,
      tiene_clave_primaria: pkCols.length > 0,
      recomendada,
    });
  } finally { await pool.close(); }
}));

function getPkColsFromMarkers(markers) {
  return markers.filter((m) => m.es_pk).map((m) => m.COLUMN_NAME);
}

async function analizarUnicidad(pool, schema, table, columns) {
  const pk = await getPkCols(pool, schema, table);
  if (pk.length) return { columnas: pk, total: null, unicos: null, pct: 100, origen: 'pk' };
  const ui = await getUniqueIdxCols(pool, schema, table);
  if (ui.length) return { columnas: ui, total: null, unicos: null, pct: 100, origen: 'indice-unico' };

  const keyLike = (n) => /(^id_|_id$|id$|cod|num|cita|correl|ruc|dni|clave|item|reg|folio|lote)/i.test(n);
  const singles = columns.filter((c) => keyLike(c.COLUMN_NAME)).concat(columns.filter((c) => !keyLike(c.COLUMN_NAME))).slice(0, 6);

  const quals = `${imp.br(schema)}.${imp.br(table)}`;
  const agg1 = singles.map((c, i) => `COUNT(DISTINCT [${c.COLUMN_NAME}]) AS d${i}, COUNT([${c.COLUMN_NAME}]) AS n${i}`).join(', ');
  const r1 = await pool.request().query(`SELECT ${agg1}, COUNT(*) AS total FROM ${quals};`);
  const row = r1.recordset[0];
  const total = row.total || 0;

  const rated = singles.map((c, i) => ({
    col: c.COLUMN_NAME,
    unicos: row[`d${i}`] || 0,
    n: row[`n${i}`] || 0,
    pct: total > 0 && row[`n${i}`] ? Math.round((row[`d${i}`] / row[`n${i}`]) * 1000) / 10 : 0,
  }));
  let best = rated[0] || { col: columns[0].COLUMN_NAME, unicos: 0, n: 0, pct: 0 };

  const top = rated.slice().sort((a, b) => b.pct - a.pct).slice(0, 4);
  const pairs = [];
  for (let a = 0; a < top.length; a++) for (let b = a + 1; b < top.length; b++) pairs.push([top[a], top[b]]);
  if (pairs.length) {
    const agg2 = pairs.map((p, i) => `COUNT(DISTINCT CONCAT([${p[0].col}],'|',[${p[1].col}])) AS p${i}`).join(', ');
    const r2 = await pool.request().query(`SELECT ${agg2} FROM ${quals};`);
    const row2 = r2.recordset[0];
    pairs.forEach((p, i) => {
      const u = row2[`p${i}`] || 0;
      const pct = total > 0 ? Math.round((u / total) * 1000) / 10 : 0;
      if (pct > best.pct || (pct === best.pct && best.pct < 100 && pct === 100)) {
        best = { col: null, unicos: u, n: total, pct, cols: [p[0].col, p[1].col] };
      }
    });
  }
  const columnas = best.cols || [best.col];
  return { columnas, total, unicos: best.unicos, pct: best.pct, origen: 'datos' };
}

app.get('/api/analizar', wrap(async (req, res) => {
  const [db, schema, table] = imp.splitTabla(req.query.tabla || '');
  if (db) throw new Error(`La tabla '${db}.${schema}.${table}' es de otra base: solo se puede exportar, no importar.`);
  const tabla = `${schema}.${table}`;
  const cacheado = db.getRecomendacion(tabla);
  if (cacheado) return res.json({ ok: true, ...cacheado, cache: true });
  const pool = await new sql.ConnectionPool(getConfig()).connect();
  try {
    const columns = await imp.getTableColumns(pool, schema, table);
    const r = await analizarUnicidad(pool, schema, table, columns);
    if (r.origen === 'datos' && r.total != null) db.setRecomendacion(tabla, r.columnas, r.total, r.unicos, r.pct, r.origen);
    res.json({ ok: true, ...r, cache: false });
  } finally { await pool.close(); }
}));

app.get('/api/favoritos', wrap(async (req, res) => {
  const todos = db.listFavoritos();
  const solo = (req.query.tabla || '').trim();
  res.json({ ok: true, favoritos: solo ? todos.filter((f) => f.tablas.includes(solo)) : todos });
}));

app.post('/api/favoritos', wrap(async (req, res) => {
  const nombre = String(req.body.nombre || '').trim();
  const columnas = Array.isArray(req.body.columnas) ? req.body.columnas.map(String).filter(Boolean) : [];
  const tablas = Array.isArray(req.body.tablas) ? req.body.tablas.map(String).filter(Boolean) : [];
  if (!nombre) throw new Error('Escribe un nombre para el favorito.');
  if (!columnas.length) throw new Error('Selecciona al menos una columna clave.');
  if (!tablas.length) throw new Error('Marca al menos una tabla.');
  const id = db.addFavorito(nombre, columnas, tablas);
  res.json({ ok: true, id });
}));

app.delete('/api/favoritos/:id', wrap(async (req, res) => {
  db.deleteFavorito(req.params.id);
  res.json({ ok: true });
}));

app.get('/api/vista', wrap(async (req, res) => {
  const [db, schema, table] = imp.splitTabla(req.query.tabla || '');
  const pool = await new sql.ConnectionPool(getConfig()).connect();
  try {
    const columns = await imp.getTableColumns(pool, schema, table, db);
    const filtros = parseFiltrosParam(req.query.f, columns);
    const dbp = db ? `[${db}].` : '';
    const quals = `${dbp}${imp.br(schema)}.${imp.br(table)}`;
    if (filtros.length) {
      const req = pool.request();
      const where = ' WHERE ' + filtroWhere(filtros, req);
      const c = await req.query(`SELECT COUNT(*) AS n FROM ${quals}${where};`);
      const total = c.recordset[0].n || 0;
      const r = await req.query(`SELECT TOP (10) * FROM ${quals}${where};`);
      res.json({ ok: true, total, columnas: columns.map((c) => c.COLUMN_NAME), filas: r.recordset });
    } else {
      let total = 0;
      if (db) {
        const c = await pool.request().query(`SELECT COUNT(*) AS n FROM ${quals};`);
        total = c.recordset[0].n || 0;
      } else {
        const countR = await pool.request().input('t', sql.NVarChar, `${schema}.${table}`)
          .query('SELECT SUM(p.rows) AS total FROM sys.partitions p WHERE p.object_id = OBJECT_ID(@t) AND p.index_id IN (0,1);');
        total = countR.recordset[0].total || 0;
      }
      const r = await pool.request().query(`SELECT TOP (10) * FROM ${quals};`);
      res.json({ ok: true, total, columnas: columns.map((c) => c.COLUMN_NAME), filas: r.recordset });
    }
  } finally { await pool.close(); }
}));

const EXP_CSV_CELLS = 500000;
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

app.get('/api/exportar', wrap(async (req, res) => {
  const [db, schema, table] = imp.splitTabla(req.query.tabla || '');
  const pool = await new sql.ConnectionPool(getConfig()).connect();
  try {
    const columns = await imp.getTableColumns(pool, schema, table, db);
    const filtros = parseFiltrosParam(req.query.f, columns);
    const dbp = db ? `[${db}].` : '';
    const quals = `${dbp}${imp.br(schema)}.${imp.br(table)}`;
    const reqC = pool.request();
    const whereC = filtros.length ? ' WHERE ' + filtroWhere(filtros, reqC) : '';
    const c = await reqC.query(`SELECT COUNT(*) AS n FROM ${quals}${whereC};`);
    const total = c.recordset[0].n || 0;
    const fname = `${table}_${new Date().toISOString().slice(0, 10)}`;

    const forzarCsv = String(req.query.fmt || '').toLowerCase() === 'csv';
    const grande = forzarCsv || total * columns.length > EXP_CSV_CELLS;
    if (grande) {
      let aborted = false;
      res.on('close', () => { aborted = true; });
      res.on('error', () => { aborted = true; });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}.csv"`);
      res.setHeader('X-Total-Filas', String(total));
      res.setHeader('X-Exportadas', '');
      res.write('\uFEFF');
      res.write(columns.map((x) => csvCell(x.COLUMN_NAME)).join(';') + '\n');
      const CHUNK = 5000;
      let offset = 0;
      while (true) {
        if (aborted) return;
        const rr = pool.request();
        const whereX = filtros.length ? ' WHERE ' + filtroWhere(filtros, rr) : '';
        const sql2 = `SELECT * FROM ${quals}${whereX} ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${CHUNK} ROWS ONLY;`;
        const r2 = await rr.query(sql2);
        const rows = r2.recordset;
        if (!rows.length) break;
        let out = '';
        for (const row of rows) out += columns.map((x) => csvCell(row[x.COLUMN_NAME])).join(';') + '\n';
        if (aborted) return;
        res.write(out);
        offset += rows.length;
        if (rows.length < CHUNK) break;
      }
      if (!aborted) res.end();
      return;
    }

    let recordset = null;
    if (filtros.length) {
      const reqX = pool.request();
      const whereX = ' WHERE ' + filtroWhere(filtros, reqX);
      const rx = await reqX.query(`SELECT * FROM ${quals}${whereX};`);
      recordset = rx.recordset;
    } else {
      const rx = await pool.request().query(`SELECT * FROM ${quals};`);
      recordset = rx.recordset;
    }
    const ws = XLSX.utils.json_to_sheet(recordset, { header: columns.map((c) => c.COLUMN_NAME) });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Datos');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}.xlsx"`);
    res.setHeader('X-Total-Filas', String(total));
    res.setHeader('X-Exportadas', String(recordset.length));
    res.send(buf);
  } finally { await pool.close(); }
}));

const SUG_PAT = /(^mes$|mesl|^anio$|^año$|^dia$|micro|red|establec|renipress|lote|provincia|distrito|ups|turno|condicion|sexo|genero|categoria)/i;
const MESANIO_PAT = /(^mes$|mesl|^anio$|^año$|fecha)/i;
const NUMERIC_TYPES = /^(bigint|int|smallint|tinyint|bit|float|real|decimal|numeric|money|smallmoney)$/i;

const coerceF = (meta, v) => (NUMERIC_TYPES.test(meta.DATA_TYPE) && typeof v === 'string' && v !== '' ? Number(v) : v);

const whereType = (c) => {
  if (['varchar', 'nvarchar', 'char', 'nchar'].includes(c.DATA_TYPE)) {
    const len = c.CHARACTER_MAXIMUM_LENGTH;
    if (len != null && len > 0 && len < 4000) return c.DATA_TYPE.startsWith('n') ? sql.NVarChar(len) : sql.VarChar(len);
  }
  return bulkType(c);
};

const valoresCache = new Map();
const conteoCache = new Map();
const cacheValores = (key) => {
  const c = valoresCache.get(key);
  if (c && Date.now() - c.at < 5 * 60 * 1000) return c.v;
  return null;
};

async function valoresDeColumna(pool, qual, col) {
  const r = await pool.request().query(`SELECT COUNT(DISTINCT [${col.COLUMN_NAME}]) AS n FROM ${qual};`);
  const n = r.recordset[0].n || 0;
  if (n === 0 || n > 500) return { muchos: n > 500, valores: [] };
  const r2 = await pool.request().query(`SELECT DISTINCT TOP 501 [${col.COLUMN_NAME}] AS v FROM ${qual} WHERE [${col.COLUMN_NAME}] IS NOT NULL ORDER BY [${col.COLUMN_NAME}];`);
  return { muchos: false, valores: r2.recordset.map((x) => x.v) };
}

function parseFiltrosParam(f, columns) {
  if (!f) return [];
  return String(f).split(',').map((p) => {
    const parts = p.split(':');
    if (parts.length < 2) return null;
    const nom = String(parts[0]).trim();
    const meta = columns.find((c) => imp.norm(c.COLUMN_NAME) === imp.norm(nom));
    if (!meta) return null;
    if (parts.length >= 3) {
      const desde = parts[1].trim();
      const hasta = parts.slice(2).join(':').trim();
      if (!desde || !hasta) return null;
      return { meta, desde, hasta };
    }
    const valor = parts.slice(1).join(':').trim();
    if (!valor) return null;
    return { meta, valor };
  }).filter(Boolean);
}

function normFiltros(raws, columns) {
  return raws.map((r) => {
    const meta = columns.find((c) => imp.norm(c.COLUMN_NAME) === imp.norm(String(r.columna || '')));
    if (!meta) throw new Error(`La columna filtro '${r.columna}' no existe en la tabla.`);
    const desde = r.desde == null ? '' : String(r.desde).trim();
    const hasta = r.hasta == null ? '' : String(r.hasta).trim();
    if (desde || hasta) {
      if (!desde || !hasta) throw new Error(`El filtro ${meta.COLUMN_NAME} en rango necesita 'desde' y 'hasta'.`);
      return { meta, desde, hasta };
    }
    const valor = r.valor == null ? '' : String(r.valor).trim();
    if (!valor) throw new Error(`El filtro ${meta.COLUMN_NAME} esta vacio: elige o escribe su valor.`);
    return { meta, valor };
  });
}

function filtroWhere(filtros, q) {
  return filtros.map((f, i) => {
    const col = `[${f.meta.COLUMN_NAME}]`;
    if (f.desde !== undefined) {
      q.input('f' + i + 'a', whereType(f.meta), coerceF(f.meta, f.desde));
      q.input('f' + i + 'b', whereType(f.meta), coerceF(f.meta, f.hasta));
      return `(${col} >= @f${i}a AND ${col} <= @f${i}b)`;
    }
    q.input('f' + i, whereType(f.meta), coerceF(f.meta, f.valor));
    return `${col} = @f${i}`;
  }).join(' AND ');
}

function enRango(valorRaw, meta, desdeRaw, hastaRaw) {
  const v = coerceF(meta, String(valorRaw).trim());
  const lo = coerceF(meta, String(desdeRaw).trim());
  const hi = coerceF(meta, String(hastaRaw).trim());
  if (typeof v === 'number' && typeof lo === 'number' && typeof hi === 'number') return v >= lo && v <= hi;
  const s = String(v).toLowerCase(), sl = String(lo).toLowerCase(), sh = String(hi).toLowerCase();
  return s >= sl && s <= sh;
}

const filtroEtiqueta = (f) => (f.desde !== undefined ? `${f.meta.COLUMN_NAME}: ${f.desde}-${f.hasta}` : `${f.meta.COLUMN_NAME}=${f.valor}`);

function resolverAlias(headers, columns, tabla) {
  const porNombre = new Map(columns.map((c) => [imp.norm(c.COLUMN_NAME), c.COLUMN_NAME]));
  const porNombreFold = new Map();
  for (const cn of porNombre.keys()) porNombreFold.set(normClave(cn), porNombre.get(cn));
  const cfg = CONFIG_TABLAS[tabla] || null;
  const usados = new Set();
  const mapa = new Map();
  for (const h of headers) {
    const n = imp.norm(h);
    if (!n || mapa.has(n) || usados.has(n)) continue;
    if (porNombre.has(n)) { usados.add(n); continue; }
    if (cfg) {
      const tgt = cfg.alias[normClave(h)];
      if (tgt && !usados.has(imp.norm(tgt))) {
        mapa.set(n, tgt);
        usados.add(imp.norm(tgt));
        continue;
      }
    }
    const fc = normClave(h);
    if (fc && porNombreFold.has(fc) && !usados.has(porNombreFold.get(fc))) {
      mapa.set(n, porNombreFold.get(fc));
      usados.add(porNombreFold.get(fc));
      continue;
    }
    if (n.length < 5) continue;
    const cands = columns
      .map((c) => imp.norm(c.COLUMN_NAME))
      .filter((cn) => cn.length > n.length && cn.startsWith(n) && cn[n.length] === '_' && !usados.has(cn));
    if (cands.length === 1) {
      mapa.set(n, porNombre.get(cands[0]));
      usados.add(cands[0]);
    }
  }
  return mapa;
}

const normClave = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z]+/g, ' ').replace(/\s+/g, ' ').trim();

const fechaIso = (v) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v).trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : v;
};

const quitarCeros = (v) => {
  const s = String(v).trim();
  return s ? (s.replace(/^0+/, '') || s) : s;
};

const CONFIG_TABLAS = {
  MAESTRO_PADRON_NOMINAL: {
    alias: {
      'tipo de documento de identidad del nino dni cui cnv cod pad': 'TIPO_DOC_N',
      'codigo del padron nominal cod pad': 'COD_PAD_N',
      'numero de certificado de nacido vivo cnv': 'COD_CNV_N',
      'codigo unico de identidad cui': 'COD_CUI_N',
      'numero de documento nacional de identificacion dni': 'COD_DNI_N',
      'apellido paterno del nino': 'PAT_N',
      'apellido materno del nino': 'MAT_N',
      'nombres del nino': 'NOM_N',
      'codigo de sexo del nino masculino femenino': 'GENERO1_N',
      'fecha de nacimiento del nino dd mm aaaa': 'FECH_NAC_N',
      'eje vial': 'EJE_VIAL_N',
      'descripcion': 'DIRECCION_N',
      'referencia de direccion': 'REFERENCIA_N',
      'codigo de ubigeo del distrito': 'UBIGEO_DIST_N',
      'nombre del departamento': 'DEPART_N',
      'nombre de la provincia': 'PROVINCIA_N',
      'nombre del distrito': 'DISTRITO_N',
      'codigo de centro poblado': 'COD_CENTRO_POBLADO_N',
      'nombre de centro poblado': 'NOM_CENTRO_POBLADO_N',
      'area del centro poblado': 'AREA_CENTRO_POBLADO_N',
      'menor visitado': 'MENOR_VISITADO',
      'menor encontrado': 'MENOR_ENCONTRADO',
      'fecha de visita': 'FECH_VISITA_N',
      'fuente de datos': 'FUENTE_DATO_N',
      'fecha de fuente de datos': 'FECH_FUENTE_DATO',
      'codigo del eess nacimiento': 'COD_EESS_N',
      'nombre del eess nacimiento': 'NOM_EESS_N',
      'codigo del eess': 'COD_EESS_ATENCION_N',
      'nombre del eess': 'EESS_ATENCION_N',
      'frecuencia de atencion': 'FRECUENCIA_ATENCION_N',
      'codigo del eess adscripcion': 'COD_EESS_ADSCRIPCION_N',
      'nombre del eess adscripcion': 'NOM_EESS_ADSCRIPTCION_N',
      'tipo de seguro del beneficiario ninguno sis essalud sanidad privado': 'NING_SIS_ESSALUD_SANIDAD_PRIVADO',
      'programas sociales del nino a ninguno pin pvl juntos qaliwarma cuna scd cuna saf': 'PROGRAMA_SOCIAL_N',
      'codigo de institucion educativa': 'COD_IE',
      'nombre de institucion educativa': 'NOM_IE',
      'tipo de documento de la madre': 'TIPO_DOC_MA',
      'numero de documento de la madre del menor de edad': 'DNI_MA',
      'apellido paterno de la madre del menor de edad': 'APE_PATERNO_MA',
      'apellido materno de la madre del menor de edad': 'APE_MATERNO_MA',
      'nombres de la madre del menor de edad': 'NOMBRE_MA',
      'numero de celular de la madre': 'CELULAR_MA',
      'direccion de correo electronico de la madre': 'CORREO_MA',
      'grado de instruccion de la madre del menor de edad': 'GRADO_INST_MA',
      'lengua habitual de la madre del menor de edad': 'LENGUA_MA',
      'tipo de documento del jefe de familia': 'TIPO_DOC_PA',
      'numero de documento del jefe de familia del menor de edad': 'DNI_PA',
      'apellido paterno del jefe de familia del menor de edad': 'APE_PATERNO_PA',
      'apellido materno del jefe de familia del menor de edad': 'APE_MATERNO_PA',
      'nombres del jefe de familia del menor de edad': 'NOM_PA',
      'estado registro inactivo activo activo observado': 'EstadoRegistro',
      'fecha creacion de registro': 'FECHA_REGISTRO',
      'usuario que crea': 'USUARIO_CREA_REG',
      'fecha de modificacion del registro': 'FECHA_MODIFICA_REG',
      'usuario que modifica': 'USUARIO_MODIFICA_REG',
      'entidad': 'ENTIDAD',
    },
    convertir: {
      'GENERO1_N': (v) => (v === '1' ? 'M' : v === '2' ? 'F' : v),
      'FECH_NAC_N': fechaIso,
      'FECHA_REGISTRO': fechaIso,
      'FECHA_MODIFICA_REG': fechaIso,
      'COD_EESS_N': quitarCeros,
      'COD_EESS_ATENCION_N': quitarCeros,
      'COD_EESS_ADSCRIPCION_N': quitarCeros,
      'PROGRAMA_SOCIAL_N': (v) => String(v).replace(/,\s*$/, ''),
    },
    copiar: { 'cod_dni': 'COD_DNI_N' },
    constantes: {
      'dni': '1', 'cui': '1', 'cnv': '1', 'cod_padron': '1', 'estado': '1',
      'prog_soc_pin': '0', 'prog_soc_pvl': '0', 'prog_soc_cuna_mas': '0',
      'prog_soc_juntos': '0', 'prog_soc_otros': '0', 'prog_soc_ninguno': '0',
      'programassocialesnino': '',
    },
  },
};

function extraerRarSync(buffer, nombre) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rar_'));
  const rar = path.join(tmp, nombre);
  fs.writeFileSync(rar, buffer);
  try {
    execFileSync('tar', ['-xf', rar, '-C', tmp], { timeout: 90000, windowsHide: true });
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    throw new Error('No se pudo extraer el RAR: ' + String(e.message || '').slice(0, 200));
  }
  try { fs.rmSync(rar, { force: true }); } catch (_) {}
  return tmp;
}

function ddlType(c) {
  const t = String(c.DATA_TYPE || '').toLowerCase();
  if (/char|binary|text|image/.test(t)) {
    return `${t}${c.CHARACTER_MAXIMUM_LENGTH == null ? '' : c.CHARACTER_MAXIMUM_LENGTH === -1 ? '(MAX)' : '(' + c.CHARACTER_MAXIMUM_LENGTH + ')'}`;
  }
  if (/decimal|numeric/.test(t)) return `${t}(${c.NUMERIC_PRECISION},${c.NUMERIC_SCALE})`;
  if (/^(datetime2|datetimeoffset|time)$/.test(t)) return `${t}(${c.DATETIME_PRECISION || 7})`;
  return t;
}

async function insertarStaging(pool, schema, table, stagingId, columns, uniqueRows, send, extraFactor, extraFijo, pctBase, tablaKey) {
  const base = pctBase || 30;
  const stagingQual = `${imp.br(schema)}.${imp.br(stagingId)}`;
  const ddl = columns.map((c) => `[${c.COLUMN_NAME}] ${ddlType(c)} NULL`).join(', ');
  await pool.request().query(`CREATE TABLE ${stagingQual} (${ddl}, _rn INT IDENTITY(1,1) PRIMARY KEY);`);
  const total = uniqueRows.length;
  const t0S = Date.now();
  const priorMs = histPorFila(String(tablaKey).startsWith('@') ? tablaKey : tablaKey + '@estandar') || histPorFilaGlobal('@estandar');
  const priorS = priorMs != null ? (priorMs / 1000) * total : null;
  const inicial = priorS != null ? Math.round(priorS * (1 + (extraFactor || 1)) + (extraFijo || 15)) : undefined;
  send('progress', { pct: base, msg: `Insertando ${total} filas en staging...`, eta: inicial });
  const BATCH = 20000;
  const insertarChunk = async (desde, hasta) => {
    for (let i = desde; i < hasta; i += BATCH) {
      const batch = uniqueRows.slice(i, Math.min(i + BATCH, hasta));
      await insertarFilasDirectas(pool.request(), stagingQual, columns, batch, 2000);
    }
  };
  let hecho = 0;
  const notificar = () => {
    const el = (Date.now() - t0S) / 1000;
    const rps = el > 0 ? hecho / el : 0;
    let eta;
    if (rps > 0) {
      const medido = total / rps;
      const w = 0.15 + 0.55 * (hecho / total);
      const estSt = priorS != null ? Math.round(w * medido + (1 - w) * priorS) : Math.round(medido);
      eta = Math.round((estSt - el) + estSt * (extraFactor || 1) + (extraFijo || 15));
    }
    send('progress', {
      pct: Math.round(base + (hecho / total) * 20),
      msg: `Staging: ${hecho} de ${total}...`,
      eta,
    });
  };
  const nHilos = total > 20000 ? 2 : 1;
  const tam = Math.ceil(total / nHilos);
  const tareas = [];
  for (let k = 0; k < nHilos; k++) {
    const desde = k * tam;
    const hasta = Math.min(total, desde + tam);
    tareas.push(insertarChunk(desde, hasta).then(() => {
      hecho += hasta - desde;
      notificar();
    }));
  }
  await Promise.all(tareas);
  return { stagingQual, durMs: Date.now() - t0S };
}

class InfraError extends Error {
  constructor(m) { super(m); this.name = 'InfraError'; }
}

const SEP = '|';
const CONT = process.env.DOCKER_CONTAINER || 'sqlserver2025';
const RUTA_IMPORT = '/var/opt/mssql/imports';

function execDocker(args) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: 90000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || stdout || err.message || '').trim();
        reject(new InfraError(msg ? `Docker: ${msg.slice(0, 300)}` : 'Docker no disponible.'));
      } else resolve(String(stdout || '').trim());
    });
  });
}

async function containerListo() {
  try {
    const out = await execDocker(['ps', '--filter', `name=${CONT}`, '--format', '{{.Names}}']);
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).includes(CONT);
  } catch (_) {
    return false;
  }
}
async function asegurarImportDir() {
  await execDocker(['exec', CONT, 'mkdir', '-p', RUTA_IMPORT]);
}
async function copiarAlContenedor(hostPath, name) {
  await execDocker(['cp', hostPath, `${CONT}:${RUTA_IMPORT}/${name}`]);
}
async function borrarEnContenedor(name) {
  try { await execDocker(['exec', CONT, 'rm', '-f', `${RUTA_IMPORT}/${name}`]); } catch (_) {}
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseSharedStrings(xml) {
  const strings = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(m[1]))) text += unescapeXml(t[1]);
    strings.push(text);
  }
  return strings;
}

function colRefToIdx(ref) {
  let i = 0;
  for (const ch of ref) {
    if (ch >= 'A' && ch <= 'Z') i = i * 26 + (ch.charCodeAt(0) - 64);
    else break;
  }
  return i - 1;
}

function sheetXmlRows(xml, sharedStrings) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let m;
  while ((m = rowRe.exec(xml))) {
    const cells = [];
    const cRe = /<c\b([^>]*)\/?>/g;
    let cm;
    while ((cm = cRe.exec(m[1]))) {
      const tag = cm[1];
      const rm = /r="([A-Z]+)\d+"/.exec(tag);
      const idx = rm ? colRefToIdx(rm[1]) : cells.length;
      const tm = /t="([^"]*)"/.exec(tag);
      const tipo = tm ? tm[1] : '';
      let val = '';
      if (!cm[0].endsWith('/>')) {
        const closeIdx = m[1].indexOf('</c>', cRe.lastIndex);
        const end = closeIdx === -1 ? m[1].length : closeIdx;
        const inner = m[1].slice(cRe.lastIndex, end);
        cRe.lastIndex = closeIdx === -1 ? m[1].length : closeIdx + 4;
        const vRe = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (tipo === 's') {
          const si = vRe ? parseInt(vRe[1], 10) : -1;
          val = sharedStrings[si] == null ? '' : sharedStrings[si];
        } else if (tipo === 'inlineStr') {
          let t = '';
          const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
          let x;
          while ((x = tRe.exec(inner))) t += unescapeXml(x[1]);
          val = t;
        } else if (tipo === 'str') {
          val = vRe ? unescapeXml(vRe[1]) : '';
        } else if (vRe) {
          val = unescapeXml(vRe[1]);
        }
      }
      cells[idx] = val;
    }
    rows.push(cells);
  }
  return rows;
}

function readEntry(zip, name) {
  const e = zip.getEntry(name);
  return e ? e.getData().toString('utf8') : null;
}

function sanitizeCell(s) {
  return String(s).replace(/\r/g, ' ').replace(/\n/g, ' ').replace(/\|/g, ' ');
}

function xlsxToCsvFast(buffer) {
  const zip = new AdmZip(buffer);
  const wbXml = readEntry(zip, 'xl/workbook.xml') || '';
  const relsXml = readEntry(zip, 'xl/_rels/workbook.xml.rels') || '';
  let rid = 'rId1';
  let sheetName = 'Hoja 1';
  const sheetRe = /<sheet\b[^>]*r:id="(rId\d+)"[^>]*name="([^"]*)"[^>]*\/?>/g;
  const first = sheetRe.exec(wbXml);
  if (first) { rid = first[1]; sheetName = first[2]; }
  let target = 'xl/worksheets/sheet1.xml';
  if (relsXml) {
    const relRe = new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]*)"[^>]*/?>`);
    const rel = relRe.exec(relsXml);
    if (rel) target = rel[1].replace(/^\//, '');
  }
  if (!/^worksheets\//.test(target)) target = 'xl/' + target;
  const sheetXml = readEntry(zip, target);
  if (!sheetXml) throw new Error('No se encontro la hoja en el XLSX.');
  const shared = zip.getEntry('xl/sharedStrings.xml') ? parseSharedStrings(readEntry(zip, 'xl/sharedStrings.xml')) : [];
  const rows = sheetXmlRows(sheetXml, shared);
  if (!rows.length) throw new Error('El Excel esta vacio.');
  let nCols = rows[0].length;
  for (const r of rows) if (r.length > nCols) nCols = r.length;
  const headers = rows[0].slice();
  for (let i = headers.length; i < nCols; i++) headers.push('');
  const csv = rows.map((r) => {
    const out = [];
    for (let i = 0; i < nCols; i++) out.push(r[i] === undefined ? '' : r[i]);
    return out.map(sanitizeCell).join(SEP);
  }).join('\n');
  return { csv, headers, sheetName };
}

function parseCsvLine(line, sep) {
  const out = [];
  let cur = '', inq = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inq) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inq = false;
      } else cur += ch;
    } else if (ch === '"') inq = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function csvCanonical(text) {
  const t = String(text).replace(/^\uFEFF/, '').replace(/\u0000/g, '');
  const lines = t.split(/\r\n|\r|\n/);
  const cand = [';', '\t', '|', ','];
  let sep = ',';
  let best = -1;
  for (const s of cand) {
    let n = 0, inq = false;
    for (const ch of lines[0] || '') {
      if (ch === '"') inq = !inq;
      else if (ch === s && !inq) n++;
    }
    if (n > best) { best = n; sep = s; }
  }
  const headers = parseCsvLine(lines[0] || '', sep).map(sanitizeCell);
  const nCols = headers.length;
  const out = [headers.join(SEP)];
  for (let i = 1; i < lines.length; i++) {
    if (!String(lines[i]).trim()) continue;
    const f = parseCsvLine(lines[i], sep);
    if (f.length > nCols) throw new Error('Fila con mas columnas que la cabecera.');
    const row = [];
    for (let j = 0; j < nCols; j++) row.push(f[j] === undefined ? '' : f[j]);
    out.push(row.map(sanitizeCell).join(SEP));
  }
  return { csv: out.join('\n'), headers, sheetName: '' };
}

function decodeBuffer(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (_) { return buf.toString('latin1'); }
}

function xlsxToCsvSheetjs(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const csv = XLSX.utils.sheet_to_csv(ws, { FS: SEP, RS: '\n', blankrows: false, raw: true });
  const lines = csv.split('\n').filter((l) => String(l).trim());
  const headers = parseCsvLine(lines[0] || '', SEP).map(sanitizeCell);
  const nCols = headers.length;
  const out = [headers.join(SEP)];
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i], SEP);
    if (f.length > nCols) throw new Error('Fila con mas columnas que la cabecera.');
    const row = [];
    for (let j = 0; j < nCols; j++) row.push(f[j] === undefined ? '' : f[j]);
    out.push(row.map(sanitizeCell).join(SEP));
  }
  return { csv: out.join('\n'), headers, sheetName: wb.SheetNames[0] };
}

function esFecha(t) {
  return ['date', 'datetime', 'datetime2', 'smalldatetime'].includes(t);
}

function serialToDateStr(serial, onlyDate) {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  if (onlyDate) return base;
  return `${base} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function valorJs(col, raw) {
  if (esFecha(col.DATA_TYPE) && /^-?\d+(\.\d+)?$/.test(raw)) {
    return serialToDateStr(Number(raw), col.DATA_TYPE === 'date');
  }
  return raw;
}

function enRangoLike(raw, f) {
  if (NUMERIC_TYPES.test(f.meta.DATA_TYPE)) {
    const v = Number(raw);
    const lo = Number(String(f.desde).trim());
    const hi = Number(String(f.hasta).trim());
    return !isNaN(v) && !isNaN(lo) && !isNaN(hi) && v >= lo && v <= hi;
  }
  const s = raw.toLowerCase();
  return s >= String(f.desde).trim().toLowerCase() && s <= String(f.hasta).trim().toLowerCase();
}

function fechaSql(v) {
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?)?$/);
  if (m) {
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    if (!m[4]) return d;
    const ms = m[7] ? (m[7] + '000').slice(0, 3) : '000';
    return `${d}T${m[4]}:${m[5]}:${m[6]}.${ms}`;
  }
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:[ T](\d{1,2}):(\d{2}):(\d{2}))?$/);
  if (m) {
    const d = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (!m[4]) return d;
    return `${d}T${m[4].padStart(2, '0')}:${m[5]}:${m[6]}.000`;
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.000`;
}

function fmtValSql(v, c) {
  if (v == null || v === '') return 'NULL';
  if (v instanceof Date && !isNaN(v.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    const f = `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())}T${p(v.getUTCHours())}:${p(v.getUTCMinutes())}:${p(v.getUTCSeconds())}.000`;
    return c.DATA_TYPE === 'date' ? `'${f.split('T')[0]}'` : `'${f}'`;
  }
  if (esFecha(c.DATA_TYPE)) {
    const f = fechaSql(v);
    if (f !== null) return c.DATA_TYPE === 'date' ? `'${f.split('T')[0]}'` : `'${f}'`;
  }
  if (NUMERIC_TYPES.test(c.DATA_TYPE)) {
    const n = typeof v === 'number' ? v : Number(String(v));
    if (!isNaN(n)) return String(n);
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function insertarFilasDirectas(req, qual, columns, filas, tamChunk) {
  const chunkSize = Math.min(tamChunk || 400, 1000);
  const colsQ = columns.map((c) => `[${c.COLUMN_NAME}]`).join(', ');
  const withCols = columns.map((c) => {
    let tip = String(c.DATA_TYPE || 'varchar');
    const len = c.CHARACTER_MAXIMUM_LENGTH;
    if (len != null && /^(var|nvar)?char$/i.test(tip)) tip = `${tip}(${len === -1 ? 'max' : len})`;
    return `[${c.COLUMN_NAME}] ${tip} '$.${c.COLUMN_NAME}'`;
  }).join(', ');
  const valorJson = (v, c) => {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v.getTime())) {
      const p = (n) => String(n).padStart(2, '0');
      const f = `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())}T${p(v.getUTCHours())}:${p(v.getUTCMinutes())}:${p(v.getUTCSeconds())}.000`;
      return c.DATA_TYPE === 'date' ? f.split('T')[0] : f;
    }
    if (esFecha(c.DATA_TYPE)) {
      const f = fechaSql(v);
      return f !== null ? f : null;
    }
    if (NUMERIC_TYPES.test(c.DATA_TYPE)) {
      const n = typeof v === 'number' ? v : Number(String(v));
      if (!isNaN(n)) return n;
    }
    return String(v);
  };
  let buf = [];
  let total = 0;
  const run = async () => {
    const json = JSON.stringify(buf);
    if (!req.parameters.imp_json) req.input('imp_json', sql.NVarChar(sql.MAX), json);
    else req.parameters.imp_json.value = json;
    const r = await req.query(`INSERT INTO ${qual} (${colsQ}) SELECT ${colsQ} FROM OPENJSON(@imp_json) WITH (${withCols});`);
    total += r.rowsAffected[0] || 0;
    buf = [];
  };
  for (const fila of filas) {
    const o = {};
    for (let j = 0; j < columns.length; j++) o[columns[j].COLUMN_NAME] = valorJson(fila[j], columns[j]);
    buf.push(o);
    if (buf.length >= chunkSize) await run();
  }
  if (buf.length) await run();
  return total;
}

async function cargarRapido({ req, tabla, schema, table, columns, filtros, reemplazar, send, claves = [] }) {
  const buffer = req.file.buffer;
  const originalname = req.file.originalname;
  const ext = originalname.split('.').pop().toLowerCase();
  send('progress', { pct: 8, msg: 'Camino rapido: extrayendo datos del archivo...' });
  const qual = `${imp.br(schema)}.${imp.br(table)}`;
  const pool = await sql.connect(getConfig());
  const keyCols = [];
  const keyIdx = [];
  for (const k of claves) {
    const ci = columns.findIndex((c) => imp.norm(c.COLUMN_NAME) === imp.norm(k));
    if (ci === -1) throw new Error(`Columna(s) clave inexistente(s) en la tabla ${schema}.${table}: ${String(k)}`);
    keyCols.push(columns[ci].COLUMN_NAME);
    keyIdx.push(ci);
  }
  let tx = null;
  let txDeleteP = null;
  let keySet = null;
  let tmpFile = null;
  let containerName = null;
  let eliminadas = 0;
  try {
    const conDocker = await containerListo();
    tx = new sql.Transaction(pool);
    await tx.begin();
    if (reemplazar) {
      if (!filtros.length && keyCols.length) {
        keySet = new Set();
      } else {
        txDeleteP = (async () => {
          if (filtros.length) {
            const cq = new sql.Request(tx);
            const cwd = filtroWhere(filtros, cq);
            const cr = await cq.query(`SELECT COUNT(*) AS n, (SELECT COUNT(*) FROM ${qual} WHERE ${cwd}) AS m FROM ${qual};`);
            const n = cr.recordset[0].n || 0;
            const m = cr.recordset[0].m || 0;
            if (n === m) {
              await new sql.Request(tx).query(`TRUNCATE TABLE ${qual};`);
              eliminadas = n;
            } else {
              const dq = new sql.Request(tx);
              const wd = filtroWhere(filtros, dq);
              const dr = await dq.query(`DELETE FROM ${qual} WHERE ${wd};`);
              eliminadas = dr.rowsAffected[0] || 0;
            }
          } else {
            const cr = await new sql.Request(tx).query(`SELECT COUNT(*) AS n FROM ${qual};`);
            eliminadas = cr.recordset[0].n || 0;
            await new sql.Request(tx).query(`TRUNCATE TABLE ${qual};`);
          }
        })();
        txDeleteP.catch(() => {});
      }
    }

    let buf = buffer;
    let innerName = originalname;
    let csvText, headers, sheetName;
    if (ext === 'zip') {
      const zip = new AdmZip(buffer);
      const target = zip.getEntries().find((e) => !e.isDirectory && /\.(xlsx?|csv)$/i.test(e.entryName));
      if (!target) throw new InfraError('No se encontro un Excel/CSV dentro del ZIP.');
      buf = target.getData();
      innerName = target.entryName;
    } else if (ext === 'rar') {
      const tmp = extraerRarSync(buffer, originalname);
      try {
        const cs = fs.readdirSync(tmp).filter((f) => /\.csv$/i.test(f)).sort();
        const xls = fs.readdirSync(tmp).filter((f) => /\.xlsx?$/i.test(f));
        if (cs.length >= 2) {
          let nCols = -1;
          const partes = [];
          for (const f of cs) {
            const t = decodeBuffer(fs.readFileSync(path.join(tmp, f)));
            const lines = t.split(/\r?\n/).filter((l) => l.trim().length);
            if (!lines.length) continue;
            const cel = (l) => l.trim().replace(/^"|"$/g, '');
            const sep = lines[0].includes('|') ? '|' : ';';
            const k = lines[0].split(sep).map(cel).join('\u0001');
            if (nCols === -1) nCols = k;
            else if (k !== nCols) throw new InfraError('Los CSV del RAR tienen cabeceras distintas.');
            partes.push(partes.length ? lines.slice(1).join('\n') : lines.join('\n'));
          }
          csvText = partes.join('\n');
          ({ csv: csvText, headers, sheetName } = csvCanonical(csvText));
          innerName = 'combinado.csv';
        } else if (xls.length) {
          buf = fs.readFileSync(path.join(tmp, xls[0]));
          innerName = xls[0];
        } else if (cs.length === 1) {
          buf = fs.readFileSync(path.join(tmp, cs[0]));
          innerName = cs[0];
        } else {
          throw new InfraError('No se encontro un Excel/CSV dentro del RAR.');
        }
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
      }
    }
    const innerExt = innerName.split('.').pop().toLowerCase();
    try {
      if (csvText === undefined) {
        if (innerExt === 'xlsx') {
          try { ({ csv: csvText, headers, sheetName } = xlsxToCsvFast(buf)); }
          catch (_) { ({ csv: csvText, headers, sheetName } = xlsxToCsvSheetjs(buf)); }
        } else if (innerExt === 'xls') {
          ({ csv: csvText, headers, sheetName } = xlsxToCsvSheetjs(buf));
        } else if (innerExt === 'csv') {
          ({ csv: csvText, headers, sheetName } = csvCanonical(decodeBuffer(buf)));
        } else {
          throw new Error('Formato no soportado por el camino rapido.');
        }
      }
    } catch (e) {
      throw new InfraError('No se pudo extraer el archivo: ' + (e.message || ''));
    }
    if (csvText === undefined) throw new InfraError('No se pudo extraer el archivo.');
    if (!csvText.trim()) throw new Error('El archivo esta vacio.');
    send('progress', { pct: 12, msg: `Camino rapido: ${headers.length} columnas detectadas.` });

  const cfg = CONFIG_TABLAS[table] || null;
  const aliasMap = resolverAlias(headers, columns, table);
  if (aliasMap.size) headers = headers.map((h) => aliasMap.get(imp.norm(h)) || h);
  const normHeaders = headers.map((h) => imp.norm(h));
  const headerIdx = new Map();
  normHeaders.forEach((h, i) => { if (h && !headerIdx.has(h)) headerIdx.set(h, i); });
  const faltan = [];
  for (const c of columns) {
    if (headerIdx.has(imp.norm(c.COLUMN_NAME))) continue;
    if (cfg && cfg.constantes[imp.norm(c.COLUMN_NAME)] !== undefined) continue;
    if (cfg && cfg.copiar && cfg.copiar[imp.norm(c.COLUMN_NAME)] !== undefined) continue;
    const ff = filtros.find((f) => f.desde === undefined && imp.norm(f.meta.COLUMN_NAME) === imp.norm(c.COLUMN_NAME));
    if (ff) continue;
    faltan.push(c.COLUMN_NAME);
  }
  if (faltan.length) {
    const sobran = normHeaders.filter((h) => h && !columns.some((c) => imp.norm(c.COLUMN_NAME) === h));
    throw new Error(`El archivo no corresponde a la tabla ${schema}.${table}: faltan las columnas ${faltan.join(', ')}.` +
      (sobran.length ? ` Ademas, el archivo trae columnas que la tabla no tiene: ${sobran.join(', ')}.` : ''));
  }
  for (const f of filtros) {
    if (f.desde !== undefined && !headerIdx.has(imp.norm(f.meta.COLUMN_NAME))) {
      throw new Error(`El archivo no trae la columna ${f.meta.COLUMN_NAME}, necesaria para el rango del periodo.`);
    }
  }

  const nT = columns.length;
  const srcIdx = new Array(nT);
  const fillVal = new Array(nT);
  for (let j = 0; j < nT; j++) {
    const c = columns[j];
    const i = headerIdx.get(imp.norm(c.COLUMN_NAME));
    srcIdx[j] = i === undefined ? -1 : i;
    fillVal[j] = null;
    if (i === undefined) {
      const cst = cfg && cfg.constantes[imp.norm(c.COLUMN_NAME)];
      if (cst !== undefined) fillVal[j] = cst;
      else {
        const fEq = filtros.find((f) => f.desde === undefined && imp.norm(f.meta.COLUMN_NAME) === imp.norm(c.COLUMN_NAME));
        if (fEq) fillVal[j] = String(fEq.valor).trim();
      }
    }
  }
  const convCfg = cfg ? cfg.convertir : null;
  const copiarCfg = cfg ? cfg.copiar : null;
  const colIdx = copiarCfg ? new Map(columns.map((c, j) => [imp.norm(c.COLUMN_NAME), j])) : null;
  const eqFillByFileCol = new Map();
  for (const f of filtros) {
    if (f.desde !== undefined) continue;
    const fi = headerIdx.get(imp.norm(f.meta.COLUMN_NAME));
    if (fi === undefined) continue;
    eqFillByFileCol.set(fi, String(f.valor).trim());
  }
  const guardDe = new Map();
  for (const f of filtros) {
    if (MESANIO_PAT.test(f.meta.COLUMN_NAME) && headerIdx.has(imp.norm(f.meta.COLUMN_NAME))) {
      guardDe.set(f, { f, dentro: 0, extra: new Map() });
    }
  }

  const lines = csvText.split('\n');
  const outLines = [columns.map((c) => c.COLUMN_NAME).join(SEP)];
  let nLineas = 0;
  let validas = 0;
  let sinFiltro = 0;
  let mezclaOmitida = 0;
  let rellenadas = 0;
  for (let L = 1; L < lines.length; L++) {
    if (!String(lines[L]).trim()) continue;
    nLineas++;
    const src = lines[L].split(SEP);
    let ok = true;
    for (const f of filtros) {
      const fi = headerIdx.get(imp.norm(f.meta.COLUMN_NAME));
      if (fi === undefined) continue;
      const raw = src[fi] == null ? '' : String(src[fi]).trim();
      if (raw === '') continue;
      const g = guardDe.get(f);
      if (f.desde !== undefined) {
        if (enRangoLike(raw, f)) { if (g) g.dentro++; }
        else { if (g) g.extra.set(raw.toLowerCase(), (g.extra.get(raw.toLowerCase()) || 0) + 1); ok = false; break; }
      } else {
        if (raw.toLowerCase() === String(f.valor).trim().toLowerCase()) { if (g) g.dentro++; }
        else { if (g) g.extra.set(raw.toLowerCase(), (g.extra.get(raw.toLowerCase()) || 0) + 1); ok = false; break; }
      }
    }
    if (!ok) { mezclaOmitida++; continue; }
    const row = new Array(nT);
    let allEmpty = true;
    for (let j = 0; j < nT; j++) {
      let v;
      if (srcIdx[j] === -1) {
        v = fillVal[j];
        rellenadas++;
      } else {
        const raw = src[srcIdx[j]] == null ? '' : String(src[srcIdx[j]]).trim();
        if (raw === '') {
          const fv = eqFillByFileCol.get(srcIdx[j]);
          if (fv != null) { v = fv; rellenadas++; }
          else v = '';
        } else {
          v = valorJs(columns[j], raw);
          const conv = convCfg && convCfg[columns[j].COLUMN_NAME];
          if (conv) v = conv(v);
          if (esFecha(columns[j].DATA_TYPE) && typeof v === 'string' && v !== '') {
            const f = fechaSql(v);
            if (f !== null) v = columns[j].DATA_TYPE === 'date' ? f.split('T')[0] : f;
          }
        }
      }
      if (v !== '') allEmpty = false;
      row[j] = v;
    }
    if (copiarCfg) {
      for (const dest of Object.keys(copiarCfg)) {
        const dj = colIdx.get(imp.norm(dest));
        const sj = colIdx.get(imp.norm(copiarCfg[dest]));
        if (dj !== undefined && sj !== undefined) row[dj] = row[sj];
      }
    }
    if (allEmpty) { sinFiltro++; continue; }
    if (keySet) {
      const partesK = [];
      let okK = true;
      for (const kj of keyIdx) {
        const v = row[kj] == null ? '' : String(row[kj]).trim();
        if (v === '') { okK = false; break; }
        partesK.push(v);
      }
      if (okK) keySet.add(partesK.join('\u0001'));
    }
    validas++;
    outLines.push(row.join(SEP));
  }

  if (guardDe.size) {
    for (const g of guardDe.values()) {
      if (g.dentro === 0 && g.extra.size > 0) {
        const top = [...g.extra.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
        const lista = top.map(([v, n]) => `'${String(v).slice(0, 40)}' (${n} filas)`).join(', ');
        const desc = g.f.desde !== undefined
          ? `${g.f.meta.COLUMN_NAME} entre '${g.f.desde}' y '${g.f.hasta}'`
          : `${g.f.meta.COLUMN_NAME}='${g.f.valor}'`;
        throw new Error(`El archivo NO contiene datos del periodo ${desc}. El archivo trae ${lista}${top.length > 6 ? ', ...' : ''}. Revisa el periodo elegido en el calendario antes de cargar.`);
      }
      if (g.dentro > 0 && g.extra.size > 0) {
        const fuera = [...g.extra.values()].reduce((a, b) => a + b, 0);
        send('progress', { pct: 20, msg: `El archivo trae ${fuera.toLocaleString()} filas de ${g.f.meta.COLUMN_NAME} fuera del periodo elegido: solo se insertaran las que coinciden.` });
      }
    }
  }

  const filasValidas = outLines.length - 1;
  if (!filasValidas) throw new Error('El archivo no tiene filas validas.');
  send('progress', { pct: 16, msg: `Camino rapido: ${filasValidas.toLocaleString()} filas validas.` });

  if (keySet && keySet.size) {
    const c0K = Date.now();
    const combos = [...keySet];
    eliminadas = 0;
    let deletesOk = false;
    try {
      const keyColsSql = keyCols.map((kc, i) => `[k${i}] varchar(255) NOT NULL`).join(', ');
      await new sql.Request(tx).query(`CREATE TABLE #imp_claves (${keyColsSql});`);
      const kCols = keyCols.map((kc, i) => ({ COLUMN_NAME: `k${i}`, DATA_TYPE: 'varchar', CHARACTER_MAXIMUM_LENGTH: 255 }));
      const filasK = combos.map((combo) => combo.split('\u0001'));
      await insertarFilasDirectas(new sql.Request(tx), '#imp_claves', kCols, filasK, 1000);
      await new sql.Request(tx).query(`CREATE INDEX IX_imp_claves ON #imp_claves (${keyCols.map((_, i) => `[k${i}]`).join(', ')});`);
      const joinConds = keyCols.map((kc, i) => `t.[${kc}] = s.[k${i}]`).join(' AND ');
      const dr = await new sql.Request(tx).query(`DELETE t FROM ${qual} AS t INNER JOIN #imp_claves AS s ON ${joinConds};`);
      eliminadas = dr.rowsAffected[0] || 0;
      deletesOk = true;
    } catch (_) {
      deletesOk = false;
    }
    if (!deletesOk) {
      for (let ci = 0; ci < combos.length; ci += 2000) {
        const chunk = combos.slice(ci, ci + 2000);
        const conds = chunk.map((combo) => {
          const vs = combo.split('\u0001');
          return `(${vs.map((v, i) => `[${keyCols[i]}] = '${String(v).replace(/'/g, "''")}'`).join(' AND ')})`;
        }).join(' OR ');
        const dr = await new sql.Request(tx).query(`DELETE FROM ${qual} WHERE ${conds};`);
        eliminadas += dr.rowsAffected[0] || 0;
      }
    }
    send('progress', { pct: 18, msg: `Reemplazo por clave: ${eliminadas.toLocaleString()} registros eliminados en ${((Date.now() - c0K) / 1000).toFixed(1)} s.` });
  } else {
    if (txDeleteP) await txDeleteP;
  }

  const priorB = histPorFila(tabla + '@rapido') || histPorFilaGlobal('@rapido');
  const priorBS = priorB != null ? (priorB / 1000) * filasValidas : null;
  let estB = priorBS != null ? Math.round(priorBS + 8) : undefined;
  const tB0 = Date.now();
  let insertados = 0;
  if (conDocker) {
    await asegurarImportDir();
    send('progress', { pct: 22, msg: 'Camino rapido: BULK INSERT...', eta: estB });
    tmpFile = path.join(os.tmpdir(), `imp_${Date.now()}_${Math.random().toString(36).slice(2)}.csv`);
    containerName = `import_${Date.now()}_${Math.random().toString(36).slice(2)}.csv`;
    fs.writeFileSync(tmpFile, outLines.join('\n') + '\n', 'utf8');
    await copiarAlContenedor(tmpFile, containerName);
    try {
      const br = await new sql.Request(tx).query(`BULK INSERT ${qual} FROM '${RUTA_IMPORT}/${containerName}' WITH (FIRSTROW=2, FIELDTERMINATOR='|', ROWTERMINATOR='0x0A', MAXERRORS=0, TABLOCK); SELECT @@ROWCOUNT AS n;`);
      insertados = (br.recordset && br.recordset[0] && br.recordset[0].n) || br.rowsAffected[0] || 0;
    } catch (e) {
      if (e instanceof InfraError) throw e;
      throw new InfraError('BULK INSERT fallo: ' + (e.message || '').slice(0, 300));
    }
  } else {
    send('progress', { pct: 22, msg: 'Camino rapido sin Docker: insertando por lotes directos...', eta: estB });
    const filasArr = [];
    for (let L = 1; L < outLines.length; L++) {
      if (!String(outLines[L]).trim()) continue;
      const celdas = outLines[L].split(SEP);
      filasArr.push(columns.map((c, j) => (celdas[j] == null ? '' : String(celdas[j]))));
    }
    try {
      insertados = await insertarFilasDirectas(new sql.Request(tx), qual, columns, filasArr, 1000);
    } catch (e) {
      throw new InfraError('La insercion rapida sin Docker fallo: ' + (e.message || '').slice(0, 300));
    }
  }
  if (!insertados) throw new Error('El archivo no tiene filas validas.');
  await tx.commit();
  tx = null;
  histRegistrar(tabla + '@rapido', filasValidas, Date.now() - tB0, null);

  send('progress', { pct: 95, msg: 'Carga completa.' });
  return {
    archivo: originalname,
    tabla: `${schema}.${table}`,
    reemplazar,
    filtros: filtros.map(filtroEtiqueta),
    totalFilas: nLineas,
    filasValidas,
    insertados,
    eliminadas,
    rellenadas,
    omitidas: sinFiltro + mezclaOmitida,
    mezclaOmitida,
  };
  } finally {
    if (tx) {
      try { if (txDeleteP) await txDeleteP.catch(() => {}); } catch (_) {}
      try { await tx.rollback(); } catch (_) {}
    }
    try { if (tmpFile) fs.unlinkSync(tmpFile); } catch (_) {}
    try { if (containerName) await borrarEnContenedor(containerName); } catch (_) {}
  }
}

app.get('/api/filtros', wrap(async (req, res) => {
  const [db, schema, table] = imp.splitTabla(req.query.tabla || '');
  const tabla = `${db ? db + '.' : ''}${schema}.${table}`;
  const pool = await new sql.ConnectionPool(getConfig()).connect();
  try {
    const columns = await imp.getTableColumns(pool, schema, table, db);
    const dbp = db ? `[${db}].` : '';
    const qual = `${dbp}${imp.br(schema)}.${imp.br(table)}`;
    const sugeridos = columns.map((c) => c.COLUMN_NAME).filter((n) => SUG_PAT.test(n)).slice(0, 10);

    let totalFilas = 0;
    if (db) {
      const szR = await pool.request().query(`SELECT COUNT(*) AS n FROM ${qual};`);
      totalFilas = szR.recordset[0].n || 0;
    } else {
      const szR = await pool.request().input('q', sql.NVarChar, qual)
        .query('SELECT SUM(p.rows) AS n FROM sys.partitions p WHERE p.object_id = OBJECT_ID(@q) AND p.index_id IN (0,1);');
      totalFilas = szR.recordset[0].n || 0;
    }
    const grande = totalFilas > 300000;

    const pedida = String(req.query.col || '').trim();
    if (pedida) {
      const c = columns.find((x) => imp.norm(x.COLUMN_NAME) === imp.norm(pedida));
      if (!c) throw new Error(`Columna '${pedida}' no existe en ${tabla}.`);
      const key = `${tabla}|${c.COLUMN_NAME}`;
      let vv = cacheValores(key);
      if (!vv) { vv = await valoresDeColumna(pool, qual, c); valoresCache.set(key, { at: Date.now(), v: vv }); }
      return res.json({ ok: true, tabla, columna: c.COLUMN_NAME, ...vv });
    }

    const valores = {};
    if (!grande) {
      for (const c of columns.filter((x) => sugeridos.includes(x.COLUMN_NAME)).slice(0, 6)) {
        const key = `${tabla}|${c.COLUMN_NAME}`;
        let vv = cacheValores(key);
        if (!vv) { vv = await valoresDeColumna(pool, qual, c); valoresCache.set(key, { at: Date.now(), v: vv }); }
        valores[c.COLUMN_NAME] = vv;
      }
    }

    let count = null;
    const filtros = parseFiltrosParam(req.query.f, columns);
    if (filtros.length) {
      const ck = `${tabla}|${filtros.map(filtroEtiqueta).join(',')}`;
      const cc = conteoCache.get(ck);
      if (cc && Date.now() - cc.at < 20 * 1000) {
        count = cc.n;
      } else {
        const q = pool.request();
        const where = filtroWhere(filtros, q);
        const r = await q.query(`SELECT COUNT(*) AS c FROM ${qual} WHERE ${where};`);
        count = r.recordset[0].c;
        conteoCache.set(ck, { at: Date.now(), n: count });
      }
    }
    res.json({
      ok: true, tabla, totalFilas, grande,
      columnas: columns.map((c) => ({ nombre: c.COLUMN_NAME, tipo: c.DATA_TYPE })),
      sugeridos, valores,
      count,
      filtros: filtros.map((f) => f.desde !== undefined ? { columna: f.meta.COLUMN_NAME, desde: f.desde, hasta: f.hasta } : { columna: f.meta.COLUMN_NAME, valor: f.valor }),
    });
  } finally { await pool.close(); }
}));

app.post('/api/ejecutar-sp', wrap(async (req, res) => {
  const sp = String(req.body.sp || '').trim();
  const tabla = String(req.body.tabla || '').trim();
  if (!sp) throw new Error('Falta el nombre del procedimiento.');
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.]*$/.test(sp)) throw new Error('Procedimiento invalido.');
  const params = req.body.params && typeof req.body.params === 'object' && !Array.isArray(req.body.params)
    ? req.body.params : {};
  const pares = Object.entries(params)
    .filter(([k]) => /^@?[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => {
      const nom = k.startsWith('@') ? k : '@' + k;
      let val;
      if (v === null || v === undefined || v === '') val = 'NULL';
      else if (typeof v === 'number') val = String(v);
      else val = `N'${String(v).replace(/'/g, "''")}'`;
      return `${nom} = ${val}`;
    });
  const pool = await new sql.ConnectionPool(getConfig()).connect();
  try {
    const t0 = Date.now();
    await pool.request().query(pares.length ? `EXEC ${sp} ${pares.join(', ')};` : `EXEC ${sp};`);
    const durMs = Date.now() - t0;
    histRegistrar(`${sp}@sp`, 1, durMs, null);
    let filas = 0;
    if (tabla) {
      const [db, schema, table] = imp.splitTabla(tabla);
      const dbp = db ? `[${db}].` : '';
      const r = await pool.request().query(`SELECT COUNT(*) AS n FROM ${dbp}${imp.br(schema)}.${imp.br(table)};`);
      filas = r.recordset[0].n || 0;
    }
    res.json({ ok: true, filas, durMs });
  } finally { await pool.close(); }
}));

app.post('/api/cargar-mes', upload.single('archivo'), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

  const t0 = Date.now();
  let pool;
  let stagingId = null;
  try {
    const tabla = req.body.tabla;
    if (!req.file) throw new Error('No se recibio ningun archivo.');
    if (!tabla) throw new Error('Selecciona una tabla destino.');

    let raws = [];
    try { raws = JSON.parse(req.body.filtros || '[]'); } catch (_) { raws = []; }
    if (!Array.isArray(raws)) raws = [];
    const reemplazar = String(req.body.reemplazar) !== 'false';

    const [schema, table] = imp.splitTable(tabla);
    pool = await sql.connect(getConfig());

    send('progress', { pct: 10, msg: 'Obteniendo columnas...' });
    const columns = await imp.getTableColumns(pool, schema, table);

    const filtros = normFiltros(raws, columns);
    if (filtros.length > 8) throw new Error('Maximo 8 filtros por carga.');

    const esNominal = /nominal[\s_]?trama/i.test(table);
    const tieneMesAnio = columns.some((c) => MESANIO_PAT.test(c.COLUMN_NAME));
    if (esNominal && tieneMesAnio && !filtros.some((f) => MESANIO_PAT.test(f.meta.COLUMN_NAME))) {
      throw new Error(`La tabla ${schema}.${table} requiere un filtro de Mes o Año para la carga por periodo.`);
    }

    try {
      const done = await cargarRapido({ req, tabla, schema, table, columns, filtros, reemplazar, send });
      done.durMs = Date.now() - t0;
      try { send('done', done); } catch (_) {}
      try { res.end(); } catch (_) {}
      try { await pool.close(); } catch (_) {}
      pool = null;
      return;
    } catch (e) {
      if (!(e instanceof InfraError)) throw e;
      console.error('[cargarRapido]', e.message);
      send('progress', { pct: 15, msg: 'Camino rapido no disponible, usando ruta estandar.' });
    }

    send('progress', { pct: 5, msg: 'Leyendo archivo...' });
    let { rows, sheetName } = parseFileBuffer(req.file.buffer, req.file.originalname);
    let totalFilas = rows.length - 1;
    if (totalFilas <= 0) throw new Error('El archivo esta vacio.');
    if (totalFilas > 2000000) throw new Error('El archivo supera el limite de 2.000.000 de filas.');

    const aliasMap = resolverAlias(rows[0] || [], columns, table);
    if (aliasMap.size) rows[0] = rows[0].map((h) => aliasMap.get(imp.norm(h)) || h);

    send('progress', { pct: 15, msg: `${totalFilas} filas en '${sheetName}'.` });

    const { faltan, sobran } = imp.compararColumnas(rows, columns);
    const faltanSinFiltros = faltan.filter((c) => !filtros.some((f) => imp.norm(f.meta.COLUMN_NAME) === imp.norm(c)));
    if (faltanSinFiltros.length) {
      const extra = sobran.length ? ` Ademas, el archivo trae columnas que la tabla no tiene: ${sobran.join(', ')}.` : '';
      throw new Error(`El archivo no corresponde a la tabla ${schema}.${table}: faltan las columnas ${faltanSinFiltros.join(', ')}.${extra}`);
    }

    const headers = (rows[0] || []).map(imp.norm);
    let rellenadas = 0;
    let mezclaOmitida = 0;
    for (const f of filtros) {
      const idx = headers.indexOf(imp.norm(f.meta.COLUMN_NAME));
      const esRango = f.desde !== undefined;
      if (idx === -1) {
        if (esRango) throw new Error(`El archivo no trae la columna ${f.meta.COLUMN_NAME}, necesaria para el rango del periodo.`);
        rows[0].push(f.meta.COLUMN_NAME);
        headers.push(imp.norm(f.meta.COLUMN_NAME));
        for (let r = 1; r < rows.length; r++) { if (!rows[r]) rows[r] = []; rows[r].push(f.valor); }
        rellenadas += rows.length - 1;
        continue;
      }
      const extra = new Map();
      let dentro = 0;
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row) continue;
        const v = row[idx];
        if (v === null || v === undefined || String(v).trim() === '') {
          if (!esRango) { row[idx] = f.valor; rellenadas++; }
          continue;
        }
        const ok = esRango ? enRango(v, f.meta, f.desde, f.hasta) : String(v).trim().toLowerCase() === f.valor.trim().toLowerCase();
        if (ok) dentro++;
        else extra.set(String(v).trim(), (extra.get(String(v).trim()) || 0) + 1);
      }
      if (!extra.size) continue;
      if (MESANIO_PAT.test(f.meta.COLUMN_NAME)) {
        const lista = [...extra.entries()].slice(0, 6).map(([v, n]) => `'${v}' (${n} filas)`).join(', ');
        const desc = esRango ? `${f.meta.COLUMN_NAME} entre '${f.desde}' y '${f.hasta}'` : `${f.meta.COLUMN_NAME}='${f.valor}'`;
        if (dentro === 0) {
          throw new Error(`El archivo NO contiene datos del periodo ${desc}. El archivo trae ${lista}${extra.size > 6 ? ', ...' : ''}. Revisa el periodo elegido en el calendario antes de cargar.`);
        }
        send('progress', { pct: 22, msg: `El archivo trae ${extra.size} valores de ${f.meta.COLUMN_NAME} fuera del periodo elegido: solo se insertaran las filas que coinciden.` });
      } else {
        send('progress', { pct: 22, msg: `El archivo trae ${extra.size} valores de ${f.meta.COLUMN_NAME} fuera del rango elegido: solo se insertaran las filas que coinciden.` });
      }
      const fval = f.valor ? f.valor.trim().toLowerCase() : null;
      rows = rows.filter((row, r) => r === 0 || !row || row[idx] == null || String(row[idx]).trim() === '' ||
        (esRango ? enRango(row[idx], f.meta, f.desde, f.hasta) : String(row[idx]).trim().toLowerCase() === fval));
      mezclaOmitida += totalFilas - (rows.length - 1);
      totalFilas = rows.length - 1;
    }

    send('progress', { pct: 25, msg: 'Mapeando datos...' });
    const indexes = columns.map((c) => ({ col: c, idx: headers.indexOf(imp.norm(c.COLUMN_NAME)) }));
    let claves = [];
    try {
      const pk = await getPkCols(pool, schema, table);
      claves = pk.length ? pk : await getUniqueIdxCols(pool, schema, table);
    } catch (_) {}
    if (!claves.length) claves = [columns[0].COLUMN_NAME];
    const keyIdxMap = claves.map((c) => columns.findIndex((col) => imp.norm(col.COLUMN_NAME) === imp.norm(c)));
    const seen = new Map();
    let sinFiltro = 0;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const values = indexes.map(({ col, idx }) => {
        if (idx === undefined) return null;
        const v = imp.toDbValue(row[idx], col);
        return coerceF(col, v);
      });
      const k = keyIdxMap.map((i) => (values[i] instanceof Date ? 'D' + values[i].getTime() : values[i] == null ? '' : String(values[i]))).join('\u001e');
      if (!k) { sinFiltro++; continue; }
      seen.set(k, values);
    }
    const uniqueRows = [...seen.values()];
    const duplicadasEnArchivo = totalFilas - uniqueRows.length - sinFiltro;
    if (!uniqueRows.length) throw new Error('El archivo no tiene filas validas.');

    const qual = `${imp.br(schema)}.${imp.br(table)}`;

    let eliminadas = 0;
    if (reemplazar) {
      send('progress', { pct: 30, msg: filtros.length ? 'Contando filas existentes del periodo...' : 'Contando filas existentes de la tabla...' });
      if (filtros.length) {
        const cq = pool.request();
        const cwd = filtroWhere(filtros, cq);
        const rc = await cq.query(`SELECT COUNT(*) AS c FROM ${qual} WHERE ${cwd};`);
        eliminadas = rc.recordset[0].c;
        if (eliminadas) {
          send('progress', { pct: 40, msg: `Eliminando ${eliminadas.toLocaleString()} filas del periodo...` });
          const dq = pool.request();
          const dwd = filtroWhere(filtros, dq);
          await dq.query(`DELETE FROM ${qual} WHERE ${dwd};`);
        }
      } else {
        const rc = await pool.request().query(`SELECT COUNT(*) AS c FROM ${qual};`);
        eliminadas = rc.recordset[0].c;
        if (eliminadas) {
          send('progress', { pct: 40, msg: `Eliminando ${eliminadas.toLocaleString()} filas de la tabla...` });
          await pool.request().query(`DELETE FROM ${qual};`);
        }
      }
    }

    stagingId = `tmp${Date.now()}`;
    send('progress', { pct: 45, msg: 'Creando tabla staging...' });
    const resSt = await insertarStaging(pool, schema, table, stagingId, columns, uniqueRows, send, 1, 15, 45, tabla);

    const tIns0 = Date.now();
    send('progress', { pct: 80, msg: 'Insertando en la tabla final...', eta: Math.round(resSt.durMs / 1000 + 15) });
    const allCols = columns.map((c) => c.COLUMN_NAME);
    await pool.request().query(
      `INSERT INTO ${qual} (${allCols.map((n) => `[${n}]`).join(', ')})
       SELECT ${allCols.map((n) => `[${n}]`).join(', ')} FROM ${imp.br(schema)}.${imp.br(stagingId)};`
    );
    histRegistrar(tabla + '@estandar', uniqueRows.length, resSt.durMs, Date.now() - tIns0);
    const ic = await pool.request().query(`SELECT COUNT(*) AS c FROM ${imp.br(schema)}.${imp.br(stagingId)};`);
    const insertados = ic.recordset[0].c;

    await pool.request().query(`DROP TABLE ${imp.br(schema)}.${imp.br(stagingId)};`);
    await pool.close(); pool = null;

    send('progress', { pct: 100, msg: 'Carga completa.', eta: 0 });
    send('done', {
      archivo: req.file.originalname, tabla, reemplazar,
      filtros: filtros.map(filtroEtiqueta),
      totalFilas, filasValidas: uniqueRows.length,
      insertados, eliminadas, rellenadas,
      duplicadas: duplicadasEnArchivo, omitidas: sinFiltro + mezclaOmitida,
      mezclaOmitida,
      durMs: Date.now() - t0,
    });
    res.end();
  } catch (e) {
    try { fs.appendFileSync(path.join(__dirname, 'err_dump.log'), JSON.stringify({ msg: e && e.message, stack: e && e.stack, name: e && e.name }) + '\n'); } catch (_) {}
    console.error('[cargar] ERROR:', e && e.stack ? e.stack : e);
    if (pool && stagingId) {
      try { await pool.request().query(`IF OBJECT_ID('${imp.br(schema)}.${imp.br(stagingId)}') IS NOT NULL DROP TABLE ${imp.br(schema)}.${imp.br(stagingId)};`); } catch (_) {}
    }
    if (pool) { try { await pool.close(); } catch (_) {} }
    send('error', { message: e.message }); res.end();
  }
});

function parseFileBuffer(buffer, originalname) {
  const ext = originalname.split('.').pop().toLowerCase();
  if (ext === 'zip') {
    const zip = new AdmZip(buffer);
    const target = zip.getEntries().find((e) => !e.isDirectory && /\.(xlsx?|csv)$/i.test(e.entryName));
    if (!target) throw new Error('No se encontro un archivo Excel o CSV dentro del ZIP.');
    const innerExt = target.entryName.split('.').pop().toLowerCase();
    const buf = target.getData();
    const readOpts = innerExt === 'csv' ? { type: 'string', raw: true } : { type: 'buffer', cellDates: true };
    const raw = innerExt === 'csv' ? buf.toString('utf8') : buf;
    const wb = XLSX.read(raw, readOpts);
    const ws = wb.Sheets[wb.SheetNames[0]];
    return { rows: XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }), sheetName: wb.SheetNames[0] };
  }
  if (ext === 'rar') {
    const tmp = extraerRarSync(buffer, originalname);
    try {
      const cs = fs.readdirSync(tmp).filter((f) => /\.csv$/i.test(f)).sort();
      const xls = fs.readdirSync(tmp).filter((f) => /\.xlsx?$/i.test(f));
      if (cs.length >= 2) {
        let nCols = -1;
        const partes = [];
        for (const f of cs) {
          const t = decodeBuffer(fs.readFileSync(path.join(tmp, f)));
          const lines = t.split(/\r?\n/).filter((l) => l.trim().length);
          if (!lines.length) continue;
          const cel = (l) => l.trim().replace(/^"|"$/g, '');
          const sep = lines[0].includes('|') ? '|' : ';';
          const k = lines[0].split(sep).map(cel).join('\u0001');
          if (nCols === -1) nCols = k;
          else if (k !== nCols) throw new Error('Los CSV del RAR tienen cabeceras distintas.');
          partes.push(partes.length ? lines.slice(1).join('\n') : lines.join('\n'));
        }
        const { csv, headers } = csvCanonical(partes.join('\n'));
        return { rows: [headers, ...csv.split('\n').map((l) => l.split(SEP))], sheetName: 'combinado.csv' };
      }
      const inner = xls.length ? xls[0] : cs.length ? cs[0] : null;
      if (!inner) throw new Error('No se encontro un archivo Excel o CSV dentro del RAR.');
      const innerExt = inner.split('.').pop().toLowerCase();
      const raw = fs.readFileSync(path.join(tmp, inner));
      const readOpts = innerExt === 'csv' ? { type: 'string', raw: true } : { type: 'buffer', cellDates: true };
      const wb = XLSX.read(innerExt === 'csv' ? raw.toString('utf8') : raw, readOpts);
      const ws = wb.Sheets[wb.SheetNames[0]];
      return { rows: XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }), sheetName: wb.SheetNames[0] };
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  }
  if (ext === 'csv') {
    const wb = XLSX.read(buffer.toString('utf8'), { type: 'string', raw: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return { rows: XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }), sheetName: wb.SheetNames[0] };
  }
  return imp.readExcel(buffer);
}

function bulkType(c) {
  if (['text', 'ntext'].includes(c.DATA_TYPE)) return sql.NVarChar(sql.MAX);
  if (['varchar', 'nvarchar', 'char', 'nchar'].includes(c.DATA_TYPE)) {
    const len = c.CHARACTER_MAXIMUM_LENGTH;
    if (len != null && len > 0 && len < 4000) {
      return c.DATA_TYPE.startsWith('n') ? sql.NVarChar(len) : sql.VarChar(len);
    }
  }
  return imp.typeOf(c);
}

app.post('/api/cargar', upload.single('archivo'), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

  const t0 = Date.now();
  try {
    const tabla = req.body.tabla;
    if (!req.file) throw new Error('No se recibio ningun archivo.');
    if (!tabla) throw new Error('Selecciona una tabla destino.');

    const [schema, table] = imp.splitTable(tabla);

    send('progress', { pct: 5, msg: 'Obteniendo columnas...' });
    const pool = await sql.connect(getConfig());
    const columns = await imp.getTableColumns(pool, schema, table);

    const rawClave = req.body.clave || '';
    let claves = [];
    if (rawClave) {
      try {
        const p = JSON.parse(rawClave);
        claves = Array.isArray(p) ? p : [String(p)];
      } catch (_) {
        claves = [String(rawClave)];
      }
      claves = claves.map((c) => String(c).trim()).filter(Boolean);
      if (claves.length) {
        const noExisten = claves.filter((c) => !columns.some((col) => imp.norm(col.COLUMN_NAME) === imp.norm(c)));
        if (noExisten.length) throw new Error(`Columna(s) clave inexistente(s) en la tabla: ${noExisten.join(', ')}`);
        claves = claves.map((c) => columns.find((col) => imp.norm(col.COLUMN_NAME) === imp.norm(c)).COLUMN_NAME);
      }
    }

    const done = await cargarRapido({
      req, tabla, schema, table, columns,
      filtros: [],
      reemplazar: true,
      claves,
      send,
    });
    done.durMs = Date.now() - t0;
    done.clave = claves.join(' + ');
    done.filasValidas = done.filasValidas != null ? done.filasValidas : done.insertados;
    done.actualizados = 0;
    done.errores = 0;
    done.duplicadas = 0;
    done.omitidas = (done.omitidas || 0) + (done.mezclaOmitida || 0);
    delete done.mezclaOmitida;
    send('done', done);
    res.end();
  } catch (e) {
    try { fs.appendFileSync(path.join(__dirname, 'err_dump.log'), JSON.stringify({ msg: e && e.message, stack: e && e.stack, name: e && e.name }) + '\n'); } catch (_) {}
    console.error('[cargar] ERROR:', e && e.stack ? e.stack : e);
    try { send('error', { message: e.message }); } catch (_) {}
    res.end();
  }
});

app.listen(PORT, () => console.log(`Web lista: http://localhost:${PORT}`));