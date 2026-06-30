CREATE TABLE "catalog_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"alegra_id" text NOT NULL,
	"name" text NOT NULL,
	"parent_alegra_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"alegra_id" text NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"description" text,
	"category_alegra_id" text,
	"prices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stock" numeric,
	"status" text DEFAULT 'active' NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_sync_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"items_synced" integer DEFAULT 0 NOT NULL,
	"categories_synced" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "alegra_email" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "alegra_token" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "alegra_mock" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_categories" ADD CONSTRAINT "catalog_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_sync_log" ADD CONSTRAINT "catalog_sync_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cat_tenant_alegra" ON "catalog_categories" USING btree ("tenant_id","alegra_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cp_tenant_alegra" ON "catalog_products" USING btree ("tenant_id","alegra_id");--> statement-breakpoint
CREATE INDEX "cp_tenant_code" ON "catalog_products" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "cp_tenant_category" ON "catalog_products" USING btree ("tenant_id","category_alegra_id");--> statement-breakpoint
CREATE INDEX "csl_tenant_started" ON "catalog_sync_log" USING btree ("tenant_id","started_at");