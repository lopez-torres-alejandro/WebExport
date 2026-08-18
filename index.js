const fs = require('fs');
const readline = require('readline');
const { sql, getConfig } = require('./sql');
const imp = require('./importer');
require('dotenv').config();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((res) => rl.question(question, res));

const parseArgs = () => {
  const out = { table: process.env.DB_TABLE, key: process.env.DB_KEY };
  for (const a of process.argv) {
    if (a.startsWith('--tabla=')) out.table = a.slice(8);
    if (a.startsWith('--clave=')) out.key = a.slice(8);
  }
  return out;
};

const pickFromList = async (items, title) => {
  console.log(`\n${title}`);
  items.forEach((it, i) => console.log(`  ${i + 1}. ${it}`));
  const ans = (await ask('Numero: ')).trim();
  const n = parseInt(ans, 10) - 1;
  if (Number.isNaN(n) || n < 0 || n >= items.length) throw new Error('Seleccion no valida.');
  return items[n];
};

async function main() {
  const mode = process.argv[2];
  const flags = parseArgs();

  const pool = await sql.connect(getConfig());

  if (mode === '--tables') {
    const tablas = await imp.listTables(pool);
    console.log('\nTablas disponibles:');
    tablas.forEach((t) => console.log(`  ${t}`));
    await pool.close();
    return;
  }

  if (mode === '--columns') {
    const t = process.argv[3] || flags.table;
    if (!t) {
      console.error('Usa: node index.js --columns <esquema.tabla>  (ej: dbo.MAESTRO_PACIENTE)');
      await pool.close();
      return;
    }
    const [schema, table] = imp.splitTable(t);
    const cs = await imp.getTableColumns(pool, schema, table);
    console.log(`\nColumnas de ${t}:`);
    for (const c of cs) console.log(`  ${c.COLUMN_NAME}  (${c.DATA_TYPE})`);
    await pool.close();
    return;
  }

  const file = mode;
  if (!file) {
    console.log('Uso:');
    console.log('  node index.js --tables');
    console.log('  node index.js --columns <esquema.tabla>');
    console.log('  node index.js <archivo.xlsx> [--tabla=esquema.tabla] [--clave=columna] [--dry-run]');
    console.log('  (si no pasas --tabla/--clave, se preguntan al momento)');
    await pool.close();
    return;
  }

  const sheetName = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined;
  const dryRun = process.argv.includes('--dry-run');

  const { rows, sheetName: usedSheet } = imp.readExcel(fs.readFileSync(file), sheetName);

  let schema;
  let table;
  if (flags.table) {
    [schema, table] = imp.splitTable(flags.table);
  } else {
    const tablas = await imp.listTables(pool);
    if (!tablas.length) throw new Error('La base no tiene tablas.');
    const picked = await pickFromList(tablas, 'Elige la tabla destino:');
    [schema, table] = imp.splitTable(picked);
  }

  const columns = await imp.getTableColumns(pool, schema, table);

  let key = flags.key;
  if (!key) {
    const opts = columns.map((c) => `${c.COLUMN_NAME} (${c.DATA_TYPE})`);
    key = (await pickFromList(opts, `Elige la columna clave de ${schema}.${table}:`)).split(' ')[0];
  }

  const proc = imp.processRows(rows, columns, key);

  const mapped = proc.indexes.filter((x) => x.idx !== undefined).map((x) => x.col.COLUMN_NAME);
  console.log(`\nArchivo: ${file} (hoja '${usedSheet}')`);
  console.log(`Tabla:  ${schema}.${table}`);
  console.log(`Clave:  ${key}`);
  console.log(`Filas validas: ${proc.uniqueRows.length}${proc.skipped.length ? ` | omitidas sin clave: ${proc.skipped.length}` : ''}`);
  if (proc.duplicadas > 0) console.log(`(aviso) ${proc.duplicadas} filas con clave duplicada en el Excel: se uso la ultima.`);
  console.log(`Columnas mapeadas: ${mapped.join(', ')}`);
  if (proc.noMap.length) console.log(`(aviso) Sin columna en el Excel para: ${proc.noMap.join(', ')}`);

  if (dryRun) {
    console.log('\n(no se escribio nada: modo --dry-run)');
    await pool.close();
    return;
  }

  const { insertados, actualizados } = await imp.runImport(pool, schema, table, columns, key, proc.uniqueRows);

  console.log('\nResultado:');
  console.log(`  Insertados:  ${insertados}`);
  console.log(`  Actualizados: ${actualizados}`);
  if (proc.skipped.length) console.log(`  Omitidos (sin clave): ${proc.skipped.length}`);

  await pool.close();
}

main()
  .then(() => rl.close())
  .catch((err) => {
    console.error(`\nError: ${err.message}`);
    rl.close();
    process.exit(1);
  });