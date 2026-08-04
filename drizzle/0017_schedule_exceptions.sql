ALTER TABLE "tenants" ADD COLUMN "schedule_exceptions" jsonb NOT NULL DEFAULT '[]'::jsonb;
