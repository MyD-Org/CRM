-- Vinculación entre una cuenta de acceso (Clerk) y un cliente del ERP.
--
-- Escrita a mano, como 0015-0018: los snapshots de drizzle-kit quedaron en
-- 0013 y `db:generate` diffea contra eso, así que pide resolver drift viejo
-- (business_hours) que las migraciones a mano ya arreglaron en la base.
CREATE TABLE IF NOT EXISTS "portal_client_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id"),
  "clerk_user_id" text NOT NULL,
  "codigocliente" text NOT NULL,
  "razonsocial" text,
  "cuit" text,
  "estado" text DEFAULT 'activa' NOT NULL,
  "metodo" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone
);

-- Un vínculo ACTIVO por usuario y tenant. Índice parcial: un unique común
-- impediría re-vincular después de una revocación.
CREATE UNIQUE INDEX IF NOT EXISTS "pcl_user_activa"
  ON "portal_client_links" ("tenant_id", "clerk_user_id")
  WHERE "estado" = 'activa';

CREATE INDEX IF NOT EXISTS "pcl_cliente"
  ON "portal_client_links" ("tenant_id", "codigocliente");
