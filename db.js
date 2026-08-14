const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS recomendaciones (
    tabla TEXT PRIMARY KEY,
    columnas TEXT NOT NULL,
    total INTEGER NOT NULL,
    unicos INTEGER NOT NULL,
    pct REAL NOT NULL,
    origen TEXT NOT NULL,
    creado_en TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS favoritos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    columnas TEXT NOT NULL,
    tablas TEXT NOT NULL,
    creado_en TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tablas_visibles (
    schema_name TEXT NOT NULL,
    tabla TEXT NOT NULL,
    visible INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (schema_name, tabla)
  );
`);

const now = () => new Date().toISOString();

const getRecomendacion = (tabla) => {
  const r = db.prepare('SELECT * FROM recomendaciones WHERE tabla = ?').get(String(tabla));
  if (!r) return null;
  return { columnas: JSON.parse(r.columnas), total: r.total, unicos: r.unicos, pct: r.pct, origen: r.origen, creado_en: r.creado_en };
};

const setRecomendacion = (tabla, columnas, total, unicos, pct, origen) => {
  db.prepare(`
    INSERT INTO recomendaciones (tabla, columnas, total, unicos, pct, origen, creado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tabla) DO UPDATE SET
      columnas = excluded.columnas, total = excluded.total, unicos = excluded.unicos,
      pct = excluded.pct, origen = excluded.origen, creado_en = excluded.creado_en
  `).run(String(tabla), JSON.stringify(columnas), total, unicos, pct, origen, now());
};

const deleteRecomendacion = (tabla) => {
  db.prepare('DELETE FROM recomendaciones WHERE tabla = ?').run(String(tabla));
};

const seedRecomendacionSiFalta = (tabla, columnas, total, unicos, origen) => {
  if (getRecomendacion(tabla)) return;
  const pct = total > 0 ? Math.round((unicos / total) * 1000) / 10 : 0;
  setRecomendacion(tabla, columnas, total, unicos, pct, origen);
};

const listFavoritos = () => db.prepare('SELECT * FROM favoritos ORDER BY nombre COLLATE NOCASE').all()
  .map((r) => ({ id: r.id, nombre: r.nombre, columnas: JSON.parse(r.columnas), tablas: JSON.parse(r.tablas), creado_en: r.creado_en }));

const addFavorito = (nombre, columnas, tablas) => {
  const r = db.prepare('INSERT INTO favoritos (nombre, columnas, tablas, creado_en) VALUES (?, ?, ?, ?)')
    .run(String(nombre), JSON.stringify(columnas), JSON.stringify(tablas), now());
  return Number(r.lastInsertRowid);
};

const deleteFavorito = (id) => {
  db.prepare('DELETE FROM favoritos WHERE id = ?').run(Number(id));
};

const getTablasOcultas = () => {
  const rows = db.prepare("SELECT schema_name, tabla FROM tablas_visibles WHERE visible = 0").all();
  return new Set(rows.map((r) => `${r.schema_name}.${r.tabla}`));
};

const setTablaVisible = (schema, tabla, visible) => {
  db.prepare(`
    INSERT INTO tablas_visibles (schema_name, tabla, visible) VALUES (?, ?, ?)
    ON CONFLICT(schema_name, tabla) DO UPDATE SET visible = excluded.visible
  `).run(String(schema), String(tabla), visible ? 1 : 0);
};

module.exports = {
  getRecomendacion,
  setRecomendacion,
  deleteRecomendacion,
  seedRecomendacionSiFalta,
  listFavoritos,
  addFavorito,
  deleteFavorito,
  getTablasOcultas,
  setTablaVisible,
};