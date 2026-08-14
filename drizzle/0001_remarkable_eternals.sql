CREATE TABLE "demo_invite_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_role_id" uuid NOT NULL,
	"code" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demo_invite_codes" ADD CONSTRAINT "demo_invite_codes_site_role_id_site_roles_id_fk" FOREIGN KEY ("site_role_id") REFERENCES "public"."site_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demo_invite_codes_code_key" ON "demo_invite_codes" USING btree ("code");