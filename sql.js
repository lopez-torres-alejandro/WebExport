/* Centraliza la conexion a SQL Server.
   - DB_TRUSTED_CONNECTION=true  -> autenticacion Windows (msnodesqlv8 + ODBC).
   - sin la variable (o false)    -> mssql normal con DB_USER / DB_PASSWORD. */
require('dotenv').config();

const usarTrusted = () => process.env.DB_TRUSTED_CONNECTION === 'true';

const DRIVERS_ODBC = [
  'SQL Server Native Client 11.0',
  'ODBC Driver 18 for SQL Server',
  'ODBC Driver 17 for SQL Server',
  'SQL Server',
];

function hostOdbc() {
  const server = String(process.env.DB_SERVER || 'localhost').trim();
  if (server.includes(',')) return server;
  if (server.includes('\\')) return server;
  return `${server},${Number(process.env.DB_PORT) || 1433}`;
}

function cadenaOdbc(driver) {
  return [
    `Driver={${driver}}`,
    `Server=${hostOdbc()}`,
    `Database=${process.env.DB_DATABASE || ''}`,
    'Trusted_Connection=Yes',
    process.env.DB_ENCRYPT === 'true' ? 'Encrypt=Yes' : 'Encrypt=No',
    process.env.DB_TRUST_CERT === 'true' ? 'TrustServerCertificate=Yes' : '',
  ].filter((p) => p).join(';') + ';';
}

let sql = null;

if (usarTrusted()) {
  try {
    sql = require('mssql/msnodesqlv8');
  } catch (e) {
    throw new Error('DB_TRUSTED_CONNECTION=true pero no se pudo cargar msnodesqlv8. Instala el driver con: npm install msnodesqlv8 (' + e.message + ')');
  }
  const conectOriginal = sql.connect.bind(sql);
  sql.connect = async (config) => {
    let ultimoError = null;
    for (const driver of DRIVERS_ODBC) {
      try {
        return await conectOriginal({ ...(config || {}), connectionString: cadenaOdbc(driver) });
      } catch (e) {
        ultimoError = e;
      }
    }
    throw ultimoError || new Error('No se pudo conectar con autenticacion de Windows (ningun driver ODBC respondio).');
  };
} else {
  sql = require('mssql');
}

function getConfig() {
  if (usarTrusted()) {
    return {
      connectionString: cadenaOdbc(DRIVERS_ODBC[0]),
      requestTimeout: 600000,
    };
  }
  return {
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
  };
}

module.exports = { sql, getConfig, cadenaOdbc, usarTrusted, esTrusted: usarTrusted() };