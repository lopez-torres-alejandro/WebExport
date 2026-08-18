# WebExport

> Aplicacion web para importar y exportar datos desde/hacia SQL Server.

## Lenguajes y tecnologias

| Tecnologia | Uso |
|------------|-----|
| **JavaScript (Node.js)** | Backend y logica de la aplicacion |
| **HTML** | Estructura de las vistas web |
| **CSS** | Estilos e interfaz de usuario |
| **SQL** | Consultas e importacion de datos |

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