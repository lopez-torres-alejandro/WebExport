# WebExport

> Aplicacion web para importar y exportar datos desde/hacia SQL Server.

<p align="left">
  <img src="https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/JavaScript-ES6-F7DF1E?logo=javascript&logoColor=black" alt="JavaScript" />
  <img src="https://img.shields.io/badge/HTML5-5-E34F26?logo=html5&logoColor=white" alt="HTML5" />
  <img src="https://img.shields.io/badge/CSS3-3-1572B6?logo=css3&logoColor=white" alt="CSS3" />
  <img src="https://img.shields.io/badge/SQL-Server-CC2927?logo=microsoftsqlserver&logoColor=white" alt="SQL Server" />
</p>

---

## Caracteristicas

- Importacion de archivos Excel hacia SQL Server
- Exportacion de datos desde SQL Server
- Interfaz web sencilla e intuitiva
- Configuracion de conexion mediante variables de entorno

---

## Estructura del proyecto

| Archivo | Descripcion |
|---------|-------------|
| `server.js` | Servidor web principal de la aplicacion |
| `db.js` | Conexion y configuracion de la base de datos local |
| `importer.js` | Motor de importacion de archivos Excel |
| `sql.js` | Utilidades de consultas SQL |
| `index.js` | Punto de entrada de la aplicacion |
| `public/` | Vistas web (HTML, CSS y JavaScript) |
| `data/` | Base de datos local de la aplicacion (configuracion) |
| `.env.example` | Plantilla de configuracion de conexion |

---

## Instalacion

Requisitos: [Node.js](https://nodejs.org) (version 18 o superior).

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar la conexion
cp .env.example .env   # y ajustar los valores

# 3. Iniciar la aplicacion
npm start
```

---

## Configuracion

La conexion se configura en el archivo `.env`:

| Variable | Descripcion |
|----------|-------------|
| `DB_SERVER` | Servidor de base de datos |
| `DB_PORT` | Puerto de conexion |
| `DB_DATABASE` | Nombre de la base de datos |
| `DB_USER` | Usuario de base de datos |
| `DB_PASSWORD` | Clave del usuario |

> **Nota:** No compartas el archivo `.env`, contiene credenciales.