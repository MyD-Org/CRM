ALTER TABLE "tenants" ADD COLUMN "schedule" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN "open_weekdays";
