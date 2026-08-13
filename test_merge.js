require('dotenv').config();
const sql = require('mssql');
const imp = require('./importer');

(async () => {
  const pool = await sql.connect(imp.getConfig());
  const columns = await imp.getTableColumns(pool, 'dbo', 'NOMINAL_TRAMA_NUEVO');
  const stagingId = 'tmpbulk_simple2';
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
  await pool.request().query(`CREATE TABLE [dbo].[${stagingId}] (${colDefs});`);

  const allCols = columns.map(c => `[${c.COLUMN_NAME}]`).join(', ');
  const placeholders = columns.map((_, j) => `@p${j}`).join(', ');

  // Test: single row with actual CSV values
  const csvRow = ['1387334856',2026,5,4,'2026-05-04','WPF',1,1,'303203',40670,'274134040670','26725640670','267256','2','R','R',23,'A',23,11,14,'N','99208','D','',1,1,'71.00','156.00','','','','','32702','','','','','2026-05-01 06:38:38','2026-05-31 12:04:13','PER','','','','','32702','','15','',''];
  
  // Only use the values that match column count
  const req = pool.request();
  columns.forEach((c, j) => {
    const raw = j < csvRow.length ? csvRow[j] : null;
    let val = raw;
    if (val === '' || val === undefined || val === null) val = null;
    req.input(`p${j}`, imp.typeOf(c), val);
  });
  
  try {
    await req.query(`INSERT INTO [dbo].[${stagingId}] (${allCols}) VALUES (${placeholders})`);
    console.log('INSERT OK - 1 real row');
  } catch (e) {
    console.error('INSERT ERROR:', e.message.substring(0, 300));
  }

  await pool.request().query(`DROP TABLE [dbo].[${stagingId}]`);
  await pool.close();
})().catch(e => console.error('FATAL:', e.message));
