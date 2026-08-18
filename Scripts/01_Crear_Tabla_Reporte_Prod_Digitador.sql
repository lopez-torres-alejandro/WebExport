USE [dbEstrategias]
GO

-- Tabla simple: solo almacena los datos del reporte, sin PRIMARY KEY ni FOREIGN KEY
CREATE TABLE [dbo].[Reporte_Prod_Digitador](
	[Id_Cita] [bigint] NULL,
	[MicroRed] [varchar](255) NULL,
	[DNI_Paciente] [varchar](20) NULL,
	[Fecha_Nac_Paciente] [date] NULL,
	[Id_Registrador] [varchar](20) NULL,
	[DNI_Registrador] [varchar](20) NULL,
	[Apellido_Paterno_Registrador] [varchar](100) NULL,
	[Apellido_Materno_Registrador] [varchar](100) NULL,
	[Nombres_Registrador] [varchar](100) NULL,
	[Fecha_Registro] [date] NULL
) ON [PRIMARY]
GO