require('dotenv').config();
const sql = require('mssql');

(async () => {
  const p = await sql.connect({
    server: process.env.DB_SERVER,
    port: Number(process.env.DB_PORT) || 1433,
    database: process.env.DB_DATABASE,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: { encrypt: false, trustServerCertificate: true },
    requestTimeout: 120000,
  });

  await p.request().query('DELETE FROM inmu.VRS_2026;');

  const rows = [
    ['Gestante', '3 Meses', 1, 'ENERO', 5, 'NT9589', '90678', '46115827', 'GESTANTE', 'POSITIVO', 1201],
    ['Gestante', '2 Meses', 1, 'ENERO', 12, 'NT9589', '90678', '75239014', 'GESTANTE', 'POSITIVO', 1202],
    ['Gestante', '4 Meses', 2, 'FEBRERO', 3, 'NT9592', '90678', '42550763', 'GESTANTE', 'POSITIVO', 1203],
    ['RN/<6M - 50 mg', '15 Días', 1, 'ENERO', 8, 'NT9589', '90380', '78854112', 'RN/<6M - 50 mg', 'POSITIVO', 1301],
    ['RN/<6M - 50 mg', '28 Días', 2, 'FEBRERO', 18, 'NT9592', '90380', '79960245', 'RN/<6M - 50 mg', 'POSITIVO', 1302],
    ['RN/<6M - 50 mg', '2 Meses', 3, 'MARZO', 21, 'NT9592', '90380', '73418850', 'RN/<6M - 50 mg', 'POSITIVO', 1303],
    ['RN/<6M - 100 mg', '3 Días', 1, 'ENERO', 15, 'AZ250063', '90381', '70124478', 'RN/<6M - 100 mg', 'POSITIVO', 1401],
    ['RN/<6M - 100 mg', '10 Días', 2, 'FEBRERO', 6, 'AZ250063', '90381', '75423961', 'RN/<6M - 100 mg', 'POSITIVO', 1402],
    ['RN/<6M - 100 mg', '1 Mes', 3, 'MARZO', 27, 'AZ260019', '90381', '79255136', 'RN/<6M - 100 mg', 'POSITIVO', 1403],
    ['RN/<6M - 100 mg', '2 Meses', 4, 'ABRIL', 11, 'AZ260019', '90381', '71766394', 'RN/<6M - 100 mg', 'POSITIVO', 1404],
    ['Otro VRS', '0 Meses', 1, 'ENERO', 9, 'AZ260019', '90378', '76044297', 'ANTICUERPO MONOCLONAL RECOMBINANTE VRS 50 MG', 'POSITIVO', 1501],
    ['Otro VRS', '1 Meses', 2, 'FEBRERO', 14, 'AZ260019', '90379', '70138925', 'INMUNOGLOBULINA VRS (RSV-IGIV)', 'POSITIVO', 1502],
    ['Otro VRS', '6 Meses', 3, 'MARZO', 2, 'NT9589', '90378', '74800371', 'ANTICUERPO MONOCLONAL RECOMBINANTE VRS 50 MG', 'POSITIVO', 1503],
    ['Gestante', '5 Meses', 5, 'MAYO', 19, 'NT9592', '90678', '72977604', 'GESTANTE', 'POSITIVO', 1204],
    ['RN/<6M - 50 mg', '25 Días', 6, 'JUNIO', 30, 'AZ250063', '90380', '76661588', 'RN/<6M - 50 mg', 'POSITIVO', 1304],
  ];

  let d = 1;
  for (const r of rows) {
    await p.request()
      .input('p1', sql.NVarChar, r[0])
      .input('p2', sql.NVarChar, r[1])
      .input('p3', sql.Int, 2026)
      .input('p4', sql.Int, r[2])
      .input('p5', sql.NVarChar, r[3])
      .input('p6', sql.Int, r[4])
      .input('p7', sql.Date, new Date(2026, r[2] - 1, r[4]))
      .input('p8', sql.NVarChar, r[5])
      .input('p9', sql.NVarChar, r[6])
      .input('p10', sql.NVarChar, r[7])
      .input('p11', sql.NVarChar, r[8])
      .input('p12', sql.NVarChar, r[9])
      .input('p13', sql.Int, r[10])
      .input('p14', sql.NVarChar, 'Lima')
      .input('p15', sql.NVarChar, r[2] % 2 === 0 ? 'Cercado de Lima' : 'La Victoria')
      .input('p16', sql.NVarChar, 'Lima Ciudad')
      .input('p17', sql.NVarChar, 'Lima Centro')
      .input('p18', sql.NVarChar, `C.S. Prueba ${d % 3 === 0 ? 'San Juan' : d % 3 === 1 ? 'El Agustino' : 'Rimac'}`)
      .input('p19', sql.NVarChar, 'I-4')
      .input('p20', sql.NVarChar, `40142701 - Personal Prueba ${d}`)
      .query(`INSERT INTO inmu.VRS_2026 (Grupo_riesgo, Edad, Anio, Mes, MesL, Dia, Fecha_Atencion, Lote, Codigo_Item, DNI_Paciente, NombreCPMS, Valor_Lab, Id_dosis, Provincia, Distrito, Red, MicroRed, Nombre_Establecimiento, Categoria_Establecimiento, Personal_Salud)
              VALUES (@p1,@p2,@p3,@p4,@p5,@p6,@p7,@p8,@p9,@p10,@p11,@p12,@p13,@p14,@p15,@p16,@p17,@p18,@p19,@p20)`);
    d++;
  }

  const c = await p.request().query('SELECT COUNT(*) AS n FROM inmu.VRS_2026;');
  console.log('Datos de prueba cargados:', c.recordset[0].n, 'filas en inmu.VRS_2026');
  await p.close();
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});