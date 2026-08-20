-- Datos legales del tenant (razón social, CUIT, domicilio, mail de contacto) para las
-- páginas públicas de /legal.
--
-- Antes vivían en env vars `{PREFIX}_LEGAL_*`. Se mueven a la DB por consistencia con el
-- resto de la config del tenant, que ya sale de acá: dar de alta un cliente no debería
-- requerir tocar variables de entorno ni un redeploy.
--
-- Escrita a mano, como 0014-0018: los snapshots de drizzle-kit quedaron congelados en 0013
-- y `db:generate` pide resolver drift viejo (business_hours) ajeno a este cambio.
--
-- Append-only y con DEFAULT '': las filas existentes quedan válidas y las páginas siguen
-- marcando cada dato faltante como "[pendiente: ...]" en vez de romper.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "legal_name"    text NOT NULL DEFAULT '';
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "legal_tax_id"  text NOT NULL DEFAULT '';
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "legal_address" text NOT NULL DEFAULT '';
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "legal_email"   text NOT NULL DEFAULT '';
