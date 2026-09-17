-- Cuotas configurables por medio de pago (Configuración → Medios de pago / Cuotas).
-- El CRM guarda QUÉ se ofrece; el Shop lo lee por GET /api/internal/shop/cuotas
-- (contrato platform/contracts/cuotas/v1) y lo cruza con las tasas reales del proveedor.
--
-- Escrita a mano, como 0014-0024: los snapshots de drizzle-kit quedaron congelados en 0013
-- y `db:generate` regeneraría todo desde ahí.
--
-- Aditiva: sólo tablas nuevas. El código viejo no las lee, así que revertir el deploy no
-- requiere down-migration. APLICAR ANTES DE MERGEAR: el tab y las rutas nuevas las consultan.

CREATE TABLE IF NOT EXISTS "payment_methods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
  "proveedor" text NOT NULL,
  "codigo_proveedor" text NOT NULL,
  "nombre" text NOT NULL,
  "activo" boolean NOT NULL DEFAULT true,
  "orden" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Un medio (proveedor + código) una sola vez por tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_methods_tenant_proveedor_codigo_uniq"
  ON "payment_methods" ("tenant_id", "proveedor", "codigo_proveedor");

CREATE TABLE IF NOT EXISTS "installment_options" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
  "payment_method_id" uuid NOT NULL REFERENCES "payment_methods"("id") ON DELETE CASCADE,
  "cuotas" integer NOT NULL,
  "sin_interes" boolean NOT NULL DEFAULT false,
  -- Con IVA.
  "monto_minimo" numeric(14, 2) NOT NULL DEFAULT 0,
  -- Inclusive, hora Argentina. NULL = sin límite de ese lado.
  "vigente_desde" date,
  "vigente_hasta" date,
  "activo" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" text,

  CONSTRAINT "installment_options_cuotas_rango" CHECK ("cuotas" BETWEEN 2 AND 24),
  CONSTRAINT "installment_options_monto_minimo" CHECK ("monto_minimo" >= 0),
  CONSTRAINT "installment_options_vigencia" CHECK (
    "vigente_desde" IS NULL OR "vigente_hasta" IS NULL OR "vigente_desde" <= "vigente_hasta"
  )
);

-- Sin UNIQUE (medio, cuotas): la misma cantidad puede repetirse en vigencias que no se
-- superponen. La superposición se valida en la app con pg_advisory_xact_lock por medio.
CREATE INDEX IF NOT EXISTS "installment_options_tenant_idx" ON "installment_options" ("tenant_id");
CREATE INDEX IF NOT EXISTS "installment_options_method_cuotas_idx"
  ON "installment_options" ("payment_method_id", "cuotas");
