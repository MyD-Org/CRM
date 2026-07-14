CREATE TABLE "conversation_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"operator_id" uuid NOT NULL,
	"department" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_assignments" ADD CONSTRAINT "conversation_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_assignments" ADD CONSTRAINT "conversation_assignments_operator_id_admin_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ca_tenant_conversation" ON "conversation_assignments" USING btree ("tenant_id","conversation_id");--> statement-breakpoint
CREATE INDEX "ca_tenant_operator" ON "conversation_assignments" USING btree ("tenant_id","operator_id");