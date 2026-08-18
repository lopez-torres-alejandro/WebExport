# WebExport - Reportes HIS (SQL Server)

Web app (Node.js) para importar/exportar datos de SQL Server, junto con los scripts SQL para la generación de reportes en la base de datos **dbEstrategias** (SQL Server 2025, contenedor sqlserver2025).

## Contenido

| Carpeta | Descripción |
|---------|-------------|
| `app/` | Aplicación web Node.js (excel-importer): importador/exportador de Excel contra SQL Server |

| Archivo | Descripción |
|---------|-------------|
| `Scripts/01_Crear_Tabla_Reporte_Prod_Digitador.sql` | Crea la tabla simple `dbo.Reporte_Prod_Digitador` (sin PK/FK) que almacena los reportes del procedimiento `Prod_Digitador` |
| `Scripts/02_Prod_Digitador.sql` | Procedimiento `dbo.Prod_Digitador`: inserta en `Reporte_Prod_Digitador` las citas registradas por los digitadores del periodo indicado |
| `Scripts/03_Generar_Reporte.sql` | Procedimiento `dbo.generar`: atajo para ejecutar `Prod_Digitador` con el periodo fijo (enero-agosto 2026) |
| `Scripts/04_Migracion_VRS.sql` | Migración de VRS a dbEstrategias: tablas `INM.VRS_2026`, `INM.VRS_2026_historial`, función `dbo.mesLetra` y procedimiento `INM.ps_VRS_2026` |

## App web (app/)

Aplicación Node.js para importar archivos Excel a SQL Server. Requiere Node.js y `npm install` (módulos incluidos en `node_modules` no se suben al repo).

```bash
cd app
npm install
npm start
```

Configura la conexión copiando `.env.example` a `.env` y ajustando los valores (servidor, base de datos, usuario, clave).

## Uso (reportes SQL)

```sql
-- Generar el reporte de digitadores (enero-agosto 2026)
EXEC dbEstrategias.dbo.Prod_Digitador @anio = 2026, @mes_inicio = 1, @mes_final = 8;

-- O mediante el atajo
EXEC dbEstrategias.dbo.generar;

-- Consultar el reporte
SELECT * FROM dbEstrategias.dbo.Reporte_Prod_Digitador;
```

## Conexión

- Servidor: `localhost:1434` (contenedor sqlserver2025)
- Bases de datos: `dbHisminsa` (origen de datos), `dbEstrategias` (reportes)