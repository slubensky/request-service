CREATE TABLE "site_payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"gateway_token" text NOT NULL,
	"display_label" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_payment_methods" ADD CONSTRAINT "site_payment_methods_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_payment_methods" ADD CONSTRAINT "site_payment_methods_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_payment_methods_site_key" ON "site_payment_methods" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cleaning_requests_bathroom_active_key" ON "cleaning_requests" USING btree ("bathroom_id") WHERE "cleaning_requests"."status" IN ('authorizing', 'authorized');