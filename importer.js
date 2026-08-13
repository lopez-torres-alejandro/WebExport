const sql = require('mssql');
const XLSX = require('xlsx');

const getConfig = () => ({
  server: process.env.DB_SERVER,
  port: Number(process.env.DB_PORT) || 1433,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: process.env.DB_ENCRYPT === 'true',
    trustServerCertificate: process.env.DB_TRUST_CERT === 'true',
  },
  requestTimeout: 600000,
});

const MAX_LEN = (c) => (c.CHARACTER_MAXIMUM_LENGTH === -1 ? sql.MAX : c.CHARACTER_MAXIMUM_LENGTH);

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
  if (v instanceof Date) return v;
  if (typeof v === 'number') {
    if (IS_DATE(col.DATA_TYPE)) return excelSerialToDate(v);
    return v;
  }
  return String(v);
};

const splitTable = (t) => {
  const p = String(t || '').split('.');
  if (p.length !== 2 || !p[0] || !p[1]) {
    throw new Error(`Tabla invalida '${t}'. Usa formato esquema.tabla (ej: dbo.MAESTRO_PACIENTE).`);
  }
  return [p[0], p[1]];
};

const listTables = async (pool) => {
  const r = await pool.request().query(
    "SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME"
  );
  return r.recordset.map((x) => `${x.TABLE_SCHEMA}.${x.TABLE_NAME}`);
};

const getTableColumns = async (pool, schema, table) => {
  const r = await pool.request()
    .input('s', sql.NVarChar, schema)
    .input('t', sql.NVarChar, table)
    .query(`SELECT c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION,
                   c.NUMERIC_SCALE, c.DATETIME_PRECISION, col.is_identity
            FROM INFORMATION_SCHEMA.COLUMNS c
            JOIN sys.columns col
              ON col.object_id = OBJECT_ID(@s + '.' + @t) AND col.name = c.COLUMN_NAME
            WHERE c.TABLE_SCHEMA = @s AND c.TABLE_NAME = @t
            ORDER BY c.ORDINAL_POSITION`);
  if (!r.recordset.length) {
    throw new Error(`Tabla '${schema}.${table}' no encontrada en la base.`);
  }
  return r.recordset.filter((c) => !c.is_identity);
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

const processRows = (rows, columns, key) => {
  const headers = rows[0].map(norm);
  const headerIdx = new Map();
  headers.forEach((h, i) => { if (h && !headerIdx.has(h)) headerIdx.set(h, i); });

  const keyIdx = indexOf(columns, key);
  if (keyIdx === -1) throw new Error(`La clave '${key}' no existe en la tabla.`);

  if (!headers.includes(norm(key))) {
    throw new Error(`La columna clave '${key}' no existe en el Excel. Columnas encontradas: ${headers.filter(Boolean).join(', ')}`);
  }

  const indexes = columns.map((c) => ({ col: c, idx: headerIdx.get(norm(c.COLUMN_NAME)) }));
  const noMap = indexes.filter((x) => x.idx === undefined).map((x) => x.col.COLUMN_NAME);

  const skipped = [];
  const seen = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const keyVal = row[keyIdx] == null ? null : row[keyIdx];
    if (keyVal === null) { skipped.push(r + 1); continue; }
    const values = indexes.map(({ col, idx }) => (idx === undefined ? null : toDbValue(row[idx], col)));
    seen.set(String(keyVal), values);
  }

  return {
    uniqueRows: [...seen.values()],
    skipped,
    indexes,
    noMap,
    duplicadas: rows.length - 1 - seen.size,
  };
};

const runImport = async (pool, schema, table, columns, key, uniqueRows) => {
  const qualified = `${br(schema)}.${br(table)}`;
  const allCols = columns.map((c) => c.COLUMN_NAME);
  const setCols = allCols.filter((n) => norm(n) !== norm(key));

  let insertados = 0;
  let actualizados = 0;
  for (const values of uniqueRows) {
    const req = pool.request();
    columns.forEach((c, j) => {
      req.input(`p${j}`, typeOf(c), values[j]);
    });
    const src = columns.map((c, j) => `@p${j} AS ${br(c.COLUMN_NAME)}`).join(', ');
    const merge = `
      MERGE ${qualified} AS t
      USING (SELECT ${src}) AS s
      ON t.${br(key)} = s.${br(key)}
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
  splitTable,
  norm,
  br,
  typeOf,
};