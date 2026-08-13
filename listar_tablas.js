require('dotenv').config();
const sql = require('mssql');
const imp = require('./importer');

(async () => {
  const p = await sql.connect(imp.getConfig());
  
  // Check NOMINAL_TRAMA_NUEVO
  const cols = await imp.getTableColumns(p, 'dbo', 'NOMINAL_TRAMA_NUEVO');
  console.log('=== Columnas de NOMINAL_TRAMA_NUEVO ===');
  cols.forEach(c => console.log(`  ${c.COLUMN_NAME} (${c.DATA_TYPE})`));
  
  // Count rows
  const cnt = await p.request().query('SELECT COUNT(*) as total FROM [dbo].[NOMINAL_TRAMA_NUEVO]');
  console.log(`\nFilas actuales: ${cnt.recordset[0].total}`);
  
  await p.close();
})().catch(e => console.error(e.message));
