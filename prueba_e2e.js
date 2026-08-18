const { execSync } = require('child_process');
const { sql, getConfig } = require('./sql');
require('dotenv').config();

const config = getConfig();

const run = (args) => execSync(`node ${args.join(' ')}`, { stdio: 'inherit', encoding: 'utf8' });

(async () => {
  const pool = await sql.connect(config);

  await pool.request().query(`
    IF OBJECT_ID('dbo.TEST_IMPORTADOR') IS NOT NULL DROP TABLE dbo.TEST_IMPORTADOR;
    CREATE TABLE dbo.TEST_IMPORTADOR (
      Numero_Documento_Paciente varchar(20) NOT NULL,
      Apellido_Paterno_Paciente varchar(50),
      Apellido_Materno_Paciente varchar(50),
      Nombres_Paciente varchar(100),
      Fecha_Nacimiento_Paciente date,
      Genero varchar(10)
    );
  `);
  console.log('\n=== 1. Tabla de prueba creada ===\n');

  console.log('\n=== 2. Primera carga (deberia INSERTAR 2 filas) ===\n');
  run(['index.js', 'ejemplo_pacientes.xlsx', '--tabla=dbo.TEST_IMPORTADOR', '--clave=Numero_Documento_Paciente']);

  const first = await pool.request().query('SELECT COUNT(*) AS n FROM dbo.TEST_IMPORTADOR');
  console.log(`\nFilas en la tabla tras la 1ra carga: ${first.recordset[0].n} (esperado: 2)`);

  const XLSX = require('xlsx');
  const wb = XLSX.readFile('ejemplo_pacientes.xlsx');
  const ws = wb.Sheets['Pacientes'];
  ws['C3'] = { t: 's', v: 'MODIFICADO' };
  XLSX.writeFile(wb, 'ejemplo_pacientes2.xlsx');

  console.log('\n=== 3. Segunda carga con un cambio (deberia ACTUALIZAR 2 filas) ===\n');
  run(['index.js', 'ejemplo_pacientes2.xlsx', '--tabla=dbo.TEST_IMPORTADOR', '--clave=Numero_Documento_Paciente']);

  const chk = await pool.request().query(
    "SELECT Apellido_Materno_Paciente FROM dbo.TEST_IMPORTADOR WHERE Numero_Documento_Paciente = '09876123'"
  );
  console.log(`\nVerificacion Maria: Apellido_Materno = '${chk.recordset[0].Apellido_Materno_Paciente}' (esperado: 'MODIFICADO')`);

  await pool.request().query('DROP TABLE dbo.TEST_IMPORTADOR;');
  console.log('\n=== 4. Tabla de prueba eliminada ===');

  await pool.close();
  console.log('\nPRUEBA FINALIZADA SIN ERRORES');
})().catch((e) => {
  console.error(`\nFallo: ${e.message}`);
  process.exit(1);
});