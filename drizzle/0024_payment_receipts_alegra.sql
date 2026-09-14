-- Carga del pago en Alegra desde el backoffice (botón "Cargar en Alegra" del diálogo admin).
--
-- Escrita a mano, como 0014-0023: los snapshots de drizzle-kit quedaron congelados en 0013
-- y `db:generate` regeneraría todo desde ahí.
--
-- Aditiva y totalmente nullable: no cambia nada para las filas existentes. Los comprobantes
-- cargados a mano antes (loaded sin alegra_payment_id) siguen siendo "loaded" plano; las
-- columnas nuevas solo se llenan cuando el admin crea el pago REAL en Alegra desde el diálogo.
--
-- APLICAR EN PROD ANTES DE MERGEAR (mismo criterio que 0023): el código nuevo lee las columnas
-- por nombre vía drizzle; si el código llega antes que la migración, el SELECT de la lista y
-- el detalle del backoffice se caen para TODOS los tenants.

ALTER TABLE "payment_receipts" ADD COLUMN IF NOT EXISTS "alegra_payment_id" integer;
ALTER TABLE "payment_receipts" ADD COLUMN IF NOT EXISTS "alegra_payment_number" text;
ALTER TABLE "payment_receipts" ADD COLUMN IF NOT EXISTS "declared_amount" numeric(14, 2);
ALTER TABLE "payment_receipts" ADD COLUMN IF NOT EXISTS "declared_paid_on" date;
