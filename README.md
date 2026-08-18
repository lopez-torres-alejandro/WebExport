# WebExport - Reportes HIS (SQL Server)

Web app (Node.js) para importar/exportar datos de SQL Server (base de datos **dbEstrategias** / **dbHisminsa**, SQL Server 2025, contenedor sqlserver2025).

## Contenido

| Archivo | Descripción |
|---------|-------------|
| `server.js` | Servidor web principal de la aplicación |
| `db.js` | Conexión y configuración de la base de datos local |
| `importer.js` | Motor de importación de archivos Excel |
| `sql.js` | Utilidades de consultas SQL |
| `index.js` | Punto de entrada de la aplicación |
| `public/` | Vistas web (HTML) de la aplicación |
| `data/` | Base de datos local de la aplicación (configuración) |
| `.env.example` | Plantilla de configuración de conexión |

## Instalación

```bash
npm install
npm start
```

Configura la conexión copiando `.env.example` a `.env` y ajustando los valores (servidor, base de datos, usuario, clave).

## Conexión

- Servidor: `localhost:1434` (contenedor sqlserver2025)
- Bases de datos: `dbHisminsa` (origen de datos), `dbEstrategias` (reportes)