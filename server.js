const path = require('path');
const express = require('express');
const multer = require('multer');
const sql = require('mssql');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');
const imp = require('./importer');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
const PORT = Number(process.env.WEB_PORT) || 3000;
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(500).json({ ok: false, error: e.message }));

app.get('/api/tablas', wrap(async (req, res) => {
  const pool = await sql.connect(imp.getConfig());
  try { res.json({ ok: true, tablas: await imp.listTables(pool) }); } finally { await pool.close(); }
}));

app.get('/api/columnas', wrap(async (req, res) => {
  const [schema, table] = imp.splitTable(req.query.tabla || '');
  const pool = await sql.connect(imp.getConfig());
  try {
    const cols = await imp.getTableColumns(pool, schema, table);
    res.json({ ok: true, columnas: cols.map((c) => ({ nombre: c.COLUMN_NAME, tipo: c.DATA_TYPE })) });
  } finally { await pool.close(); }
}));

app.get('/api/vista', wrap(async (req, res) => {
  const [schema, table] = imp.splitTable(req.query.tabla || '');
  const pool = await sql.connect(imp.getConfig());
  try {
    const columns = await imp.getTableColumns(pool, schema, table);
    const countR = await pool.request().input('t', sql.NVarChar, `${schema}.${table}`)
      .query('SELECT SUM(p.rows) AS total FROM sys.partitions p WHERE p.object_id = OBJECT_ID(@t) AND p.index_id IN (0,1);');
    const total = countR.recordset[0].total || 0;
    const r = await pool.request().query(`SELECT TOP (10) * FROM ${imp.br(schema)}.${imp.br(table)};`);
    res.json({ ok: true, total, columnas: columns.map((c) => c.COLUMN_NAME), filas: r.recordset });
  } finally { await pool.close(); }
}));

app.get('/api/exportar', wrap(async (req, res) => {
  const [schema, table] = imp.splitTable(req.query.tabla || '');
  const pool = await sql.connect(imp.getConfig());
  try {
    const columns = await imp.getTableColumns(pool, schema, table);
    const countR = await pool.request().input('t', sql.NVarChar, `${schema}.${table}`)
      .query('SELECT SUM(p.rows) AS total FROM sys.partitions p WHERE p.object_id = OBJECT_ID(@t) AND p.index_id IN (0,1);');
    const total = countR.recordset[0].total || 0;
    const r = await pool.request().query(`SELECT * FROM ${imp.br(schema)}.${imp.br(table)};`);
    const ws = XLSX.utils.json_to_sheet(r.recordset, { header: columns.map((c) => c.COLUMN_NAME) });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Datos');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${table}_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.setHeader('X-Total-Filas', String(total));
    res.setHeader('X-Exportadas', String(r.recordset.length));
    res.send(buf);
  } finally { await pool.close(); }
}));

function parseFileBuffer(buffer, originalname) {
  const ext = originalname.split('.').pop().toLowerCase();
  if (ext === 'zip') {
    const zip = new AdmZip(buffer);
    const target = zip.getEntries().find((e) => !e.isDirectory && /\.(xlsx?|csv)$/i.test(e.entryName));
    if (!target) throw new Error('No se encontro un archivo Excel o CSV dentro del ZIP.');
    const innerExt = target.entryName.split('.').pop().toLowerCase();
    const buf = target.getData();
    const readOpts = { type: innerExt === 'csv' ? 'string' : 'buffer', cellDates: true };
    const raw = innerExt === 'csv' ? buf.toString('utf8') : buf;
    const wb = XLSX.read(raw, readOpts);
    const ws = wb.Sheets[wb.SheetNames[0]];
    return { rows: XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }), sheetName: wb.SheetNames[0] };
  }
  if (ext === 'csv') {
    const wb = XLSX.read(buffer.toString('utf8'), { type: 'string', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return { rows: XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }), sheetName: wb.SheetNames[0] };
  }
  return imp.readExcel(buffer);
}

app.post('/api/cargar', upload.single('archivo'), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

  let pool;
  try {
    const tabla = req.body.tabla;
    const clave = req.body.clave;
    if (!req.file) throw new Error('No se recibio ningun archivo.');
    if (!tabla) throw new Error('Selecciona una tabla destino.');
    if (!clave) throw new Error('Selecciona una columna clave.');

    send('progress', { pct: 5, msg: 'Leyendo archivo...' });
    const { rows, sheetName } = parseFileBuffer(req.file.buffer, req.file.originalname);
    const totalFilas = rows.length - 1;
    if (totalFilas <= 0) throw new Error('El archivo esta vacio.');

    send('progress', { pct: 15, msg: `${totalFilas} filas en '${sheetName}'.` });
    const [schema, table] = imp.splitTable(tabla);
    pool = await sql.connect(imp.getConfig());

    send('progress', { pct: 20, msg: 'Obteniendo columnas...' });
    const columns = await imp.getTableColumns(pool, schema, table);

    send('progress', { pct: 25, msg: 'Mapeando datos...' });
    const proc = imp.processRows(rows, columns, clave);
    const uniqueRows = proc.uniqueRows;
    const total = uniqueRows.length;

    const qualified = `${imp.br(schema)}.${imp.br(table)}`;
    const allCols = columns.map((c) => c.COLUMN_NAME);
    const setCols = allCols.filter((n) => imp.norm(n) !== imp.norm(clave));

    send('progress', { pct: 28, msg: 'Creando tabla temporal...' });
    const stagingId = `tmp${Date.now()}`;
    const colDefs = columns.map((c) => {
      const t = c.DATA_TYPE;
      if (['varchar', 'nvarchar', 'char', 'nchar'].includes(t)) {
        const len = c.CHARACTER_MAXIMUM_LENGTH === -1 ? 'MAX' : (c.CHARACTER_MAXIMUM_LENGTH || 255);
        return `[${c.COLUMN_NAME}] ${t}(${len})`;
      }
      if (t === 'decimal' || t === 'numeric') return `[${c.COLUMN_NAME}] ${t}(${c.NUMERIC_PRECISION || 18},${c.NUMERIC_SCALE || 0})`;
      if (t === 'datetime2') return `[${c.COLUMN_NAME}] datetime2(${c.DATETIME_PRECISION || 7})`;
      return `[${c.COLUMN_NAME}] ${t}`;
    }).join(', ');
    await pool.request().query(`CREATE TABLE ${imp.br(schema)}.${imp.br(stagingId)} (${colDefs});`);

    send('progress', { pct: 30, msg: `Insertando ${total} filas en temporal...` });

    const ROWS_PER_BATCH = 40;
    const colNames = allCols.map((n) => `[${n}]`).join(', ');
    const numCols = columns.length;

    for (let i = 0; i < total; i += ROWS_PER_BATCH) {
      const batch = uniqueRows.slice(i, i + ROWS_PER_BATCH);
      const req = pool.request();
      const valueClauses = [];

      batch.forEach((vals, bIdx) => {
        const placeholders = [];
        columns.forEach((c, j) => {
          const pname = `r${bIdx}_${j}`;
          req.input(pname, imp.typeOf(c), vals[j]);
          placeholders.push(`@${pname}`);
        });
        valueClauses.push(`(${placeholders.join(',')})`);
      });

      await req.query(`INSERT INTO ${imp.br(schema)}.${imp.br(stagingId)} (${colNames}) VALUES ${valueClauses.join(',')}`);

      if (i % 2000 === 0 || i + ROWS_PER_BATCH >= total) {
        send('progress', { pct: Math.round(30 + ((i + batch.length) / total) * 20), msg: `Temporal: ${Math.min(i + batch.length, total)} de ${total}...` });
      }
    }

    send('progress', { pct: 52, msg: 'MERGE en curso...' });

    const countBefore = await pool.request().query(`SELECT COUNT(*) AS c FROM ${qualified};`);
    const beforeCount = countBefore.recordset[0].c;

    const srcCols = columns.map((c) => `s.[${c.COLUMN_NAME}]`).join(', ');
    const tgtCols = allCols.map((n) => `[${n}]`).join(', ');
    const onClause = imp.br(clave);
    const updateSet = setCols.map((n) => `t.[${n}] = s.[${n}]`).join(', ');

    await pool.request().query(`
      MERGE ${qualified} AS t
      USING (SELECT ${columns.map((c) => `[${c.COLUMN_NAME}]`).join(', ')} FROM ${imp.br(schema)}.${imp.br(stagingId)}) AS s
      ON t.${onClause} = s.${onClause}
      WHEN MATCHED THEN UPDATE SET ${updateSet}
      WHEN NOT MATCHED THEN INSERT (${tgtCols})
        VALUES (${columns.map((c) => `s.[${c.COLUMN_NAME}]`).join(', ')});
    `);

    send('progress', { pct: 95, msg: 'Contando resultados...' });
    const countAfter = await pool.request().query(`SELECT COUNT(*) AS c FROM ${qualified};`);
    const afterCount = countAfter.recordset[0].c;
    const netNew = Math.max(0, afterCount - beforeCount);

    await pool.request().query(`DROP TABLE ${imp.br(schema)}.${imp.br(stagingId)};`);
    await pool.close(); pool = null;

    send('progress', { pct: 100, msg: 'Carga completa.' });
    send('done', {
      archivo: req.file.originalname, tabla, clave,
      totalFilas, filasValidas: total, duplicadas: proc.duplicadas, omitidas: proc.skipped.length,
      insertados: netNew, actualizados: total - netNew, errores: 0,
    });
    res.end();
  } catch (e) {
    if (pool) { try { await pool.close(); } catch (_) {} }
    send('error', { message: e.message }); res.end();
  }
});

app.listen(PORT, () => console.log(`Web lista: http://localhost:${PORT}`));
