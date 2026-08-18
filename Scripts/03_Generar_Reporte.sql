USE [dbEstrategias]
GO

-- Atajo: ejecuta Prod_Digitador con el periodo fijo (enero-agosto 2026)
-- Uso: EXEC dbo.generar
CREATE OR ALTER PROCEDURE dbo.generar
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @anio int = 2026, @mes_inicio int = 1, @mes_final int = 8;

    EXEC dbo.Prod_Digitador @anio, @mes_inicio, @mes_final;
END;
GO