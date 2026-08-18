USE [dbEstrategias]
GO

/* ========== 1. FUNCION mesLetra ========== */
IF OBJECT_ID('dbo.mesLetra', 'FN') IS NULL
EXEC('
CREATE FUNCTION dbo.mesLetra(@mes int)
RETURNS varchar(15)
AS
BEGIN
    RETURN (SELECT CASE @mes
        WHEN 1  THEN ''Enero''      WHEN 2  THEN ''Febrero''    WHEN 3  THEN ''Marzo''
        WHEN 4  THEN ''Abril''     WHEN 5  THEN ''Mayo''       WHEN 6  THEN ''Junio''
        WHEN 7  THEN ''Julio''     WHEN 8  THEN ''Agosto''     WHEN 9  THEN ''Setiembre''
        WHEN 10 THEN ''Octubre''   WHEN 11 THEN ''Noviembre''  WHEN 12 THEN ''Diciembre''
        ELSE '''' END);
END
');
GO

/* ========== 2. TABLAS ========== */
IF OBJECT_ID('INM.VRS_2026', 'U') IS NOT NULL DROP TABLE INM.VRS_2026;
IF OBJECT_ID('INM.VRS_2026_historial', 'U') IS NOT NULL DROP TABLE INM.VRS_2026_historial;
GO

CREATE TABLE INM.VRS_2026 (
    anio int NULL,
    mes int NULL,
    MesL varchar(20) NULL,
    num_doc varchar(20) NULL,
    fecha_atencion date NULL,
    lote varchar(20) NULL,
    codigo_item varchar(20) NULL,
    Valor_Lab varchar(100) NULL,
    Grupo_riesgo varchar(100) NULL,
    Anio_Actual_Paciente int NULL,
    Tipo_Edad varchar(10) NULL,
    edad varchar(50) NULL,
    Personal_Salud varchar(200) NULL,
    Provincia varchar(100) NULL,
    Distrito varchar(100) NULL,
    Red varchar(150) NULL,
    MicroRed varchar(150) NULL,
    Nombre_Establecimiento varchar(200) NULL,
    Categoria_Establecimiento varchar(20) NULL
);
GO

CREATE TABLE INM.VRS_2026_historial (
    Fecha_Historial date NOT NULL,
    anio smallint NULL,
    mes tinyint NULL,
    MesL varchar(15) NULL,
    num_doc varchar(20) NULL,
    fecha_atencion date NULL,
    lote varchar(20) NULL,
    codigo_item varchar(20) NULL,
    Valor_Lab varchar(100) NULL,
    Grupo_riesgo varchar(100) NULL,
    Anio_Actual_Paciente smallint NULL,
    Tipo_Edad varchar(10) NULL,
    edad varchar(50) NULL,
    Personal_Salud varchar(200) NULL,
    Provincia varchar(100) NULL,
    Distrito varchar(100) NULL,
    Red varchar(150) NULL,
    MicroRed varchar(150) NULL,
    Nombre_Establecimiento varchar(200) NULL,
    Categoria_Establecimiento varchar(20) NULL
);
GO

/* ========== 3. PROCEDIMIENTO (origen: dbhisminsa) ========== */
CREATE OR ALTER PROCEDURE INM.ps_VRS_2026 AS
BEGIN
    SET NOCOUNT ON;

    DELETE FROM INM.VRS_2026_historial WHERE fecha_historial = getdate();

    INSERT INTO INM.VRS_2026_historial
    SELECT getdate(), * FROM INM.VRS_2026;

    DELETE FROM INM.VRS_2026;

    INSERT INTO INM.VRS_2026
    SELECT
        a.anio,
        a.mes,
        dbo.mesLetra(a.mes) AS MesL,
        b.numero_documento_paciente    AS num_doc,
        a.fecha_atencion,
        a.lote,
        a.codigo_item,
        a.Valor_Lab,
        CASE
            WHEN a.codigo_item = '90678' THEN 'Gestante'
            WHEN a.codigo_item = '90380' THEN 'RN/<6M - 50 mg'
            WHEN a.codigo_item = '90381' THEN 'RN/<6M - 100 mg'
            ELSE ''
        END AS Grupo_riesgo,
        a.Anio_Actual_Paciente,
        Tipo_Edad,
        CASE
            WHEN a.codigo_item IN ('90380','90381')
                 AND (a.Anio_Actual_Paciente*12 + a.Mes_Actual_Paciente*30 + a.Dia_Actual_Paciente) BETWEEN 0 AND 29
                 THEN CONCAT((a.Anio_Actual_Paciente*12 + a.Mes_Actual_Paciente*30 + a.Dia_Actual_Paciente), ' días')
            WHEN a.codigo_item IN ('90380','90381')
                 AND (a.Anio_Actual_Paciente*12 + a.Mes_Actual_Paciente) BETWEEN 1 AND 5
                 THEN CONCAT((a.Anio_Actual_Paciente*12 + a.Mes_Actual_Paciente), ' meses')
            WHEN a.codigo_item = '90678'
                 THEN CONCAT((a.Anio_Actual_Paciente*12 + a.Mes_Actual_Paciente), ' meses')
            ELSE ''
        END AS edad,
        CONCAT(c.Numero_Documento_Personal, ' - ',
               c.Nombres_Personal, ' ',
               c.Apellido_Paterno_Personal, ' ',
               c.Apellido_Materno_Personal) AS Personal_Salud,
        d.Provincia,
        d.Distrito,
        d.Red,
        d.MicroRed,
        d.Nombre_Establecimiento,
        d.Categoria_Establecimiento
    FROM dbhisminsa.dbo.nominal_trama_nuevo a
    INNER JOIN dbhisminsa.dbo.maestro_paciente b
        ON a.id_paciente = b.id_paciente
    INNER JOIN dbhisminsa.dbo.MAESTRO_PERSONAL c
        ON a.Id_Personal = c.Id_Personal
    INNER JOIN dbhisminsa.dbo.MAESTRO_HIS_ESTABLECIMIENTO d
        ON a.Id_Establecimiento = d.Id_Establecimiento
    WHERE a.anio = 2026
      AND a.codigo_item IN ('90678','90380','90381');
END
GO