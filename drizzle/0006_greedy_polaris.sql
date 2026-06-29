ALTER TABLE "admin_users" ADD COLUMN "availability" text DEFAULT 'away' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "availability_changed_at" timestamp with time zone;