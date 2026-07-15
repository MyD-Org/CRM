CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "departments_tenant_key" ON "departments" USING btree ("tenant_id","key");--> statement-breakpoint
-- Backfill: sembrar los 3 departamentos default (Ventas / Cuentas Corrientes / Soporte)
-- para todos los tenants existentes. Reproduce el DEPARTMENT_OPTIONS que estaba hardcodeado
-- en el frontend. Idempotente por el unique index (tenant_id, key).
INSERT INTO "departments" ("tenant_id", "key", "label")
SELECT t."id", v."key", v."label"
FROM "tenants" t
CROSS JOIN (VALUES
  ('ventas', 'Ventas'),
  ('cuentas-corrientes', 'Cuentas Corrientes'),
  ('soporte', 'Soporte')
) AS v("key", "label")
ON CONFLICT ("tenant_id", "key") DO NOTHING;