-- Cuotas v2: configuración por PROVEEDOR con escalones { cuotasMax, montoMinimo }
-- (contrato platform/contracts/cuotas/v2).
--
-- Escrita a mano, como 0014-0025 (los snapshots de drizzle-kit quedaron congelados en 0013).
--
-- Reusa las tablas de 0025 sin borrar columnas:
--   - payment_methods: una fila por proveedor con codigo_proveedor = 'credito' (todas las
--     tarjetas de crédito). Las filas v1 por marca (visa, master) quedan y se ignoran.
--   - installment_options: un escalón; `cuotas` guarda cuotasMax. sin_interes y vigencias
--     quedan sin uso (false / NULL).
--
-- Cambios:
--   1. El escalón admite 1 cuota ("hasta 1 cuota" = sólo 1 pago desde ese monto): se relaja
--      el CHECK de 2..24 a 1..24. Sigue aceptando todo lo que aceptaba antes.
--   2. Versión de configuración por tenant: se actualiza en CADA escritura (también borrados)
--      para que `actualizadoEn` del contrato cambie aunque la fila ya no exista.
--
-- Aditiva/compatible: el código v1 sigue funcionando con este esquema. APLICAR ANTES DE
-- MERGEAR: las rutas nuevas escriben en payment_config_versions.

ALTER TABLE "installment_options" DROP CONSTRAINT IF EXISTS "installment_options_cuotas_rango";
ALTER TABLE "installment_options"
  ADD CONSTRAINT "installment_options_cuotas_rango" CHECK ("cuotas" BETWEEN 1 AND 24);

CREATE TABLE IF NOT EXISTS "payment_config_versions" (
  "tenant_id" text PRIMARY KEY REFERENCES "tenants"("id"),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
