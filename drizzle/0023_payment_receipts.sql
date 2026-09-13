-- Comprobantes de pago informados por el cliente desde el portal (Pagos → "Informar pago").
--
-- El archivo NO vive acá: está en R2 (bucket del portal). Esta tabla guarda los metadatos,
-- el estado del circuito (subiendo → en proceso → pendiente de cargar en Alegra → cargado) y
-- el resultado del mail a la empresa.
--
-- Escrita a mano, como 0014-0022: los snapshots de drizzle-kit quedaron congelados en 0013
-- y `db:generate` regeneraría todo desde ahí.
--
-- UNA sola migración para todo el cambio (se entrega en varios PRs): un solo db:migrate en prod.
--
-- APLICAR EN PROD ANTES DE MERGEAR. `getTenantByIdFromDb` selecciona las columnas de `tenants`
-- del schema por nombre: si el código llega antes que `receipts_email`, se cae el portal y el
-- backoffice de TODOS los tenants, no solo esta feature.
--
-- Aditiva: no revertir aunque se revierta el código (el código viejo no la lee).

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "receipts_email" text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS "payment_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
  -- Id de contacto en Alegra, de la SESIÓN del portal (nunca del body).
  "codigocliente" text NOT NULL,
  -- Snapshot al informar: el backoffice no le pega a Alegra para listar.
  "razonsocial" text NOT NULL,
  "cuit" text NOT NULL DEFAULT '',
  "client_email" text,

  "amount" numeric(14, 2) NOT NULL,
  "currency" text NOT NULL DEFAULT 'ARS',
  "paid_on" date NOT NULL,
  "method" text NOT NULL,
  "method_other" text,
  "notes" text,

  "status" text NOT NULL DEFAULT 'uploading',
  "processing_started_at" timestamptz,
  "reject_reason" text,

  -- Lo que el cliente DECLARÓ en el init (firma de la URL PUT). El confirm lo contrasta con R2.
  "declared_content_type" text NOT NULL,
  "declared_size" integer NOT NULL,

  -- Lo VERIFICADO en el confirm. file_mime es siempre el sniffeado/convertido, nunca el declarado.
  "file_key" text,
  "file_mime" text,
  "file_size" integer,
  "file_original_name" text,
  "file_sha256" text,
  "converted_from" text,

  "email_status" text NOT NULL DEFAULT 'pending',
  "email_error" text,
  "email_sent_at" timestamptz,
  "email_attempts" integer NOT NULL DEFAULT 0,
  "email_last_attempt_at" timestamptz,

  "loaded_at" timestamptz,
  "loaded_by" uuid REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "loaded_by_name" text,

  "created_at" timestamptz NOT NULL DEFAULT now(),
  "submitted_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "payment_receipts_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "payment_receipts_currency" CHECK ("currency" = 'ARS'),
  CONSTRAINT "payment_receipts_method" CHECK ("method" IN ('transferencia', 'cheque', 'efectivo', 'otro')),
  CONSTRAINT "payment_receipts_method_other" CHECK (
    "method" <> 'otro' OR ("method_other" IS NOT NULL AND char_length(btrim("method_other")) BETWEEN 1 AND 80)
  ),
  CONSTRAINT "payment_receipts_notes_len" CHECK ("notes" IS NULL OR char_length("notes") <= 500),
  CONSTRAINT "payment_receipts_status" CHECK ("status" IN ('uploading', 'processing', 'pending', 'loaded', 'rejected')),
  CONSTRAINT "payment_receipts_email_status" CHECK ("email_status" IN ('pending', 'sent', 'failed', 'skipped')),
  CONSTRAINT "payment_receipts_declared_size" CHECK ("declared_size" > 0 AND "declared_size" <= 20971520),
  CONSTRAINT "payment_receipts_file_size" CHECK ("file_size" IS NULL OR ("file_size" > 0 AND "file_size" <= 20971520)),
  -- Publicado ⇒ archivo verificado completo.
  CONSTRAINT "payment_receipts_published_has_file" CHECK (
    "status" NOT IN ('pending', 'loaded')
    OR ("file_key" IS NOT NULL AND "file_mime" IS NOT NULL AND "file_size" IS NOT NULL
        AND "file_sha256" IS NOT NULL AND "submitted_at" IS NOT NULL)
  ),
  CONSTRAINT "payment_receipts_processing_lease" CHECK ("status" <> 'processing' OR "processing_started_at" IS NOT NULL),
  CONSTRAINT "payment_receipts_loaded_at" CHECK (("status" = 'loaded') = ("loaded_at" IS NOT NULL))
);

-- Backoffice: lista por estado, más recientes primero.
CREATE INDEX IF NOT EXISTS "payment_receipts_tenant_status_submitted_idx"
  ON "payment_receipts" ("tenant_id", "status", "submitted_at" DESC);
-- Portal (historial del cliente), tope diario y aviso de duplicado.
CREATE INDEX IF NOT EXISTS "payment_receipts_tenant_cliente_created_idx"
  ON "payment_receipts" ("tenant_id", "codigocliente", "created_at" DESC);
