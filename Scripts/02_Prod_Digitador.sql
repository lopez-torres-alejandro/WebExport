USE [dbEstrategias]
GO

CREATE OR ALTER PROCEDURE dbo.Prod_Digitador @anio int, @mes_inicio int, @mes_final int
AS
BEGIN
    SET NOCOUNT ON;

    INSERT INTO dbo.Reporte_Prod_Digitador (
        Id_Cita, MicroRed, DNI_Paciente, Fecha_Nac_Paciente,
        Id_Registrador, DNI_Registrador, Apellido_Paterno_Registrador,
        Apellido_Materno_Registrador, Nombres_Registrador, Fecha_Registro
    )
    SELECT DISTINCT
        ntn.Id_Cita,
        mhe.MicroRed,
        mp.Numero_Documento_Paciente,
        mp.Fecha_Nacimiento_Paciente,
        ntn.Id_Registrador,
        mg.Numero_Documento_Registrador,
        mg.Apellido_Paterno_Registrador,
        mg.Apellido_Materno_Registrador,
        mg.Nombres_Registrador,
        CAST(ntn.Fecha_Registro AS date)
    FROM dbhisminsa.dbo.nominal_trama_nuevo ntn
    LEFT JOIN dbhisminsa.dbo.MAESTRO_HIS_ESTABLECIMIENTO mhe ON (ntn.Id_Establecimiento = mhe.Id_Establecimiento)
    LEFT JOIN dbhisminsa.dbo.MAESTRO_PACIENTE mp ON (ntn.Id_Paciente = mp.Id_Paciente)
    LEFT JOIN dbhisminsa.dbo.MAESTRO_HIS_ETNIA mhet ON (mp.Id_Etnia = mhet.Id_Etnia)
    LEFT JOIN dbhisminsa.dbo.MAESTRO_HIS_TIPO_DOC mhtd ON (mp.Id_Tipo_Documento_Paciente = mhtd.Id_Tipo_Documento)
    LEFT JOIN dbhisminsa.dbo.MAESTRO_PERSONAL mpe ON (ntn.Id_Personal = mpe.Id_Personal)
    LEFT JOIN dbhisminsa.dbo.MAESTRO_HIS_CONDICION_CONTRATO mhcc ON (mpe.Id_Condicion = mhcc.Id_Condicion)
    LEFT JOIN dbhisminsa.dbo.MAESTRO_HIS_PROFESION mhpro ON (mpe.Id_Profesion = mhpro.Id_Profesion)
    LEFT JOIN dbhisminsa.dbo.MAESTRO_REGISTRADOR mg ON (ntn.Id_Registrador = mg.Id_Registrador)
    WHERE MONTH(ntn.Fecha_Registro) BETWEEN @mes_inicio AND @mes_final
      AND YEAR(ntn.Fecha_Registro) = @anio
      AND ntn.Id_Registrador IN ('9257157','23478930','29870637','19881286','27105944','28265999','28992372','19628492',
                                 '31036931','26625697','40720011','23035904','27005239','22404047','27979798','22983236','26916676',
                                 '26311009');
END;
GO