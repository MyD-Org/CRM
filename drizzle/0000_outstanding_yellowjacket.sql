CREATE TABLE "client_commercial_conditions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"codigocliente" text NOT NULL,
	"condicion_pago" text NOT NULL,
	"plazo_dias" integer DEFAULT 30 NOT NULL,
	"lista_precios" text DEFAULT '' NOT NULL,
	"descuentos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vendedor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transporte" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"codigocliente" text NOT NULL,
	"factura_id" text NOT NULL,
	"type" text NOT NULL,
	"channel" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"days_before" jsonb DEFAULT '[3,1]'::jsonb NOT NULL,
	"days_after" jsonb DEFAULT '[1,7,15]'::jsonb NOT NULL,
	"channels" jsonb DEFAULT '["email"]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_rules_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"subtitle" text DEFAULT '' NOT NULL,
	"logo_path" text NOT NULL,
	"flexxus_base_url" text DEFAULT '' NOT NULL,
	"flexxus_token" text DEFAULT '' NOT NULL,
	"flexxus_mock" boolean DEFAULT false NOT NULL,
	"whatsapp_number" text DEFAULT '' NOT NULL,
	"resend_from" text NOT NULL,
	"ai_api_url" text DEFAULT '' NOT NULL,
	"ai_api_key" text DEFAULT '' NOT NULL,
	"ai_agent_id" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_commercial_conditions" ADD CONSTRAINT "client_commercial_conditions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ccc_tenant_cliente" ON "client_commercial_conditions" USING btree ("tenant_id","codigocliente");--> statement-breakpoint
CREATE INDEX "nl_tenant_cliente_sent" ON "notification_log" USING btree ("tenant_id","codigocliente","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "nl_dedup" ON "notification_log" USING btree ("tenant_id","codigocliente","factura_id","type","channel");