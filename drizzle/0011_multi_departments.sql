ALTER TABLE "admin_users" ADD COLUMN "departments" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- Backfill: el depto único actual pasa a ser el primer (único) elemento del array.
UPDATE "admin_users" SET "departments" = ARRAY["department"] WHERE "department" IS NOT NULL AND "department" <> '';--> statement-breakpoint
ALTER TABLE "admin_users" DROP COLUMN "department";
