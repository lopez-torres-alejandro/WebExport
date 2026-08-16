const { sql, getConfig } = require('./sql');
const XLSX = require('xlsx');



const MAX_LEN = (c) => {
  const len = c.CHARACTER_MAXIMUM_LENGTH;
  if (len === -1 || len == null || len === undefined) return sql.MAX;
  return len;
};

const TYPES = {
  bigint: () => sql.BigInt,
  int: () => sql.Int,
  smallint: () => sql.SmallInt,
  tinyint: () => sql.TinyInt,
  bit: () => sql.Bit,
  decimal: (c) => sql.Decimal(c.NUMERIC_PRECISION, c.NUMERIC_SCALE),
  numeric: (c) => sql.Decimal(c.NUMERIC_PRECISION, c.NUMERIC_SCALE),
  money: () => sql.Money,
  smallmoney: () => sql.Money,
  float: () => sql.Float,
  real: () => sql.Real,
  date: () => sql.Date,
  datetime: () => sql.DateTime,
  datetime2: (c) => sql.DateTime2(c.DATETIME_PRECISION || 7),
  smalldatetime: () => sql.SmallDateTime,
  time: () => sql.Time,
  datetimeoffset: () => sql.DateTimeOffset,
  char: (c) => sql.Char(c.CHARACTER_MAXIMUM_LENGTH),
  nchar: (c) => sql.NChar(c.CHARACTER_MAXIMUM_LENGTH),
  varchar: (c) => sql.VarChar(MAX_LEN(c)),
  nvarchar: (c) => sql.NVarChar(MAX_LEN(c)),
  text: () => sql.Text,
  ntext: () => sql.NText,
  uniqueidentifier: () => sql.UniqueIdentifier,
  binary: (c) => sql.VarBinary(MAX_LEN(c)),
  varbinary: (c) => sql.VarBinary(MAX_LEN(c)),
  image: () => sql.VarBinary(sql.MAX),
  xml: () => sql.NVarChar(sql.MAX),
};

const typeOf = (c) => (TYPES[c.DATA_TYPE] ? TYPES[c.DATA_TYPE](c) : sql.NVarChar(4000));

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const br = (s) => `[${s}]`;
const IS_DATE = (t) => ['date', 'datetime', 'datetime2', 'smalldatetime'].includes(t);

const excelSerialToDate = (serial) => {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return isNaN(d) ? null : d;
};

const toDbValue = (v, col) => {
  if (v === null || v === undefined || v === '') return null;
  const isString = ['varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext'].includes(col.DATA_TYPE);
  if (v instanceof Date) {
    if (isString) return v.toISOString().slice(0, 19).replace('T', ' ');
    return v;
  }
  if (typeof v === 'number') {
    if (IS_DATE(col.DATA_TYPE)) return excelSerialToDate(v);
    if (isString) return String(v);
    return v;
  }
  const s = String(v).trim();
  if (IS_DATE(col.DATA_TYPE) && s) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
    return null;
  }
  return s;
};

const splitTable = (t) => {
  const p = String(t || '').split('.');
  if (p.length !== 2 || !p[0] || !p[1]) {
    throw new Error(`Tabla invalida '${t}'. Usa formato esquema.tabla (ej: dbo.MAESTRO_PACIENTE).`);
  }
  return [p[0], p[1]];
};

const splitTabla = (t) => {
  const p = String(t || '').split('.');
  if (p.length === 2 && p[0] && p[1]) return [null, p[0], p[1]];
  if (p.length === 3 && p[0] && p[1] && p[2]) return [p[0], p[1], p[2]];
  throw new Error(`Tabla invalida '${t}'. Usa formato esquema.tabla o base.esquema.tabla (ej: dbo.MAESTRO_PACIENTE o dbEstrategias.INM.VRS_2026).`);
};

const listTables = async (pool) => {
  const r = await pool.request().query(
    "SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME"
  );
  return r.recordset.map((x) => `${x.TABLE_SCHEMA}.${x.TABLE_NAME}`);
};

const getTableColumns = async (pool, schema, table, db) => {
  const dbp = db ? `[${db}].` : '';
  const objId = db ? `OBJECT_ID(@d + '.' + @s + '.' + @t)` : `OBJECT_ID(@s + '.' + @t)`;
  const r = await pool.request()
    .input('s', sql.NVarChar, schema)
    .input('t', sql.NVarChar, table)
    .input('d', sql.NVarChar, db || null)
    .query(`SELECT c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION,
                   c.NUMERIC_SCALE, c.DATETIME_PRECISION, c.COLLATION_NAME, col.is_identity, col.is_computed
            FROM ${dbp}INFORMATION_SCHEMA.COLUMNS c
            JOIN ${dbp}sys.columns col
              ON col.object_id = ${objId} AND col.name = c.COLUMN_NAME
            WHERE c.TABLE_SCHEMA = @s AND c.TABLE_NAME = @t
            ORDER BY c.ORDINAL_POSITION`);
  if (!r.recordset.length) {
    throw new Error(`Tabla '${db ? db + '.' : ''}${schema}.${table}' no encontrada en la base.`);
  }
  return r.recordset.filter((c) => !c.is_identity && !c.is_computed);
};

const readExcel = (buffer, sheetName) => {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[sheetName || wb.SheetNames[0]];
  if (!ws) throw new Error(`Hoja '${sheetName}' no encontrada en el Excel.`);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  if (!rows.length) throw new Error('El Excel esta vacio.');
  return { rows, sheetName: sheetName || wb.SheetNames[0] };
};

const indexOf = (columns, name) => columns.findIndex((c) => norm(c.COLUMN_NAME) === norm(name));

const compararColumnas = (rows, columns) => {
  const headers = (rows[0] || []).map(norm).filter(Boolean);
  const faltan = columns.filter((c) => !headers.includes(norm(c.COLUMN_NAME))).map((c) => c.COLUMN_NAME);
  const sobran = headers.filter((h) => !columns.some((c) => norm(c.COLUMN_NAME) === h));
  return { faltan, sobran };
};

const processRows = (rows, columns, keys) => {
  const keyList = Array.isArray(keys) ? keys : [keys];
  const headers = rows[0].map(norm);
  const headerIdx = new Map();
  headers.forEach((h, i) => { if (h && !headerIdx.has(h)) headerIdx.set(h, i); });

  const keyIdxs = keyList.map((k) => {
    const idx = indexOf(columns, k);
    if (idx === -1) throw new Error(`La clave '${k}' no existe en la tabla.`);
    if (!headers.includes(norm(k))) {
      throw new Error(`La columna clave '${k}' no existe en el Excel. Columnas encontradas: ${headers.filter(Boolean).join(', ')}`);
    }
    return idx;
  });
  const keyCols = keyIdxs.map((i) => columns[i]);
  const normKey = (row) => {
    let out = '';
    for (let i = 0; i < keyIdxs.length; i++) {
      const raw = row[keyIdxs[i]];
      if (raw === null || raw === undefined || raw === '') return null;
      const ci = !!keyCols[i].COLLATION_NAME && /(_CI|_AI)(_|$)/i.test(keyCols[i].COLLATION_NAME);
      out += (ci ? String(raw).toLowerCase() : String(raw)) + String.fromCharCode(30);
    }
    return out;
  };

  const indexes = columns.map((c) => ({ col: c, idx: headerIdx.get(norm(c.COLUMN_NAME)) }));
  const noMap = indexes.filter((x) => x.idx === undefined).map((x) => x.col.COLUMN_NAME);

  const skipped = [];
  const seen = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const nk = normKey(row);
    if (nk === null) { skipped.push(r + 1); continue; }
    const values = indexes.map(({ col, idx }) => (idx === undefined ? null : toDbValue(row[idx], col)));
    seen.set(nk, values);
  }

  return {
    uniqueRows: [...seen.values()],
    skipped,
    indexes,
    noMap,
    duplicadas: rows.length - 1 - seen.size,
  };
};

const runImport = async (pool, schema, table, columns, keys, uniqueRows) => {
  const keyList = Array.isArray(keys) ? keys : [keys];
  const qualified = `${br(schema)}.${br(table)}`;
  const allCols = columns.map((c) => c.COLUMN_NAME);
  const setCols = allCols.filter((n) => !keyList.some((k) => norm(k) === norm(n)));

  let insertados = 0;
  let actualizados = 0;
  for (const values of uniqueRows) {
    const req = pool.request();
    columns.forEach((c, j) => {
      req.input(`p${j}`, typeOf(c), values[j]);
    });
    const src = columns.map((c, j) => `@p${j} AS ${br(c.COLUMN_NAME)}`).join(', ');
    const onClause = keyList.map((k) => `t.${br(k)} = s.${br(k)}`).join(' AND ');
    const merge = `
      MERGE ${qualified} AS t
      USING (SELECT ${src}) AS s
      ON ${onClause}
      WHEN MATCHED THEN UPDATE SET ${setCols.map((n) => `t.${br(n)} = s.${br(n)}`).join(', ')}
      WHEN NOT MATCHED THEN INSERT (${allCols.map(br).join(', ')})
        VALUES (${allCols.map((n) => `s.${br(n)}`).join(', ')})
      OUTPUT $action;`;

    const r = await req.query(merge);
    const action = r.recordset.length ? String(r.recordset[0][Object.keys(r.recordset[0])[0]]) : '';
    if (action === 'INSERT') insertados++;
    else if (action === 'UPDATE') actualizados++;
  }
  return { insertados, actualizados };
};

module.exports = {
  getConfig,
  listTables,
  getTableColumns,
  readExcel,
  processRows,
  runImport,
  toDbValue,
  splitTable,
  splitTabla,
  norm,
  br,
  typeOf,
  compararColumnas,
};