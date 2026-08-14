CREATE TYPE "public"."assistant_approval_status" AS ENUM('pending', 'granted', 'used', 'expired');--> statement-breakpoint
CREATE TYPE "public"."bathroom_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."cleaning_request_status" AS ENUM('authorizing', 'authorized', 'completed', 'canceled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."payment_authorization_status" AS ENUM('requires_capture', 'captured', 'canceled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."qr_token_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."site_role_name" AS ENUM('manager', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."site_role_status" AS ENUM('pending', 'authorized', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "assistant_approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"bathroom_id" uuid NOT NULL,
	"assistant_id" uuid NOT NULL,
	"price_version" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "assistant_approval_status" DEFAULT 'pending' NOT NULL,
	"approved_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bathrooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"label" text NOT NULL,
	"status" "bathroom_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cleaning_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"bathroom_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"price_version" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "cleaning_request_status" DEFAULT 'authorizing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"stripe_payment_intent_id" text NOT NULL,
	"status" "payment_authorization_status" DEFAULT 'requires_capture' NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bathroom_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qr_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bathroom_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" "qr_token_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"user_id" uuid,
	"invited_phone" text,
	"role" "site_role_name" NOT NULL,
	"status" "site_role_status" DEFAULT 'pending' NOT NULL,
	"max_authorization_cents" integer,
	"bathroom_scope" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"timezone" text NOT NULL,
	"currency" text NOT NULL,
	"fixed_price_cents" integer NOT NULL,
	"terms" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cognito_sub" text,
	"phone" text,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_approval_requests" ADD CONSTRAINT "assistant_approval_requests_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_approval_requests" ADD CONSTRAINT "assistant_approval_requests_bathroom_id_bathrooms_id_fk" FOREIGN KEY ("bathroom_id") REFERENCES "public"."bathrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_approval_requests" ADD CONSTRAINT "assistant_approval_requests_assistant_id_users_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_approval_requests" ADD CONSTRAINT "assistant_approval_requests_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bathrooms" ADD CONSTRAINT "bathrooms_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleaning_requests" ADD CONSTRAINT "cleaning_requests_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleaning_requests" ADD CONSTRAINT "cleaning_requests_bathroom_id_bathrooms_id_fk" FOREIGN KEY ("bathroom_id") REFERENCES "public"."bathrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleaning_requests" ADD CONSTRAINT "cleaning_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_authorizations" ADD CONSTRAINT "payment_authorizations_request_id_cleaning_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."cleaning_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_alerts" ADD CONSTRAINT "public_alerts_bathroom_id_bathrooms_id_fk" FOREIGN KEY ("bathroom_id") REFERENCES "public"."bathrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qr_tokens" ADD CONSTRAINT "qr_tokens_bathroom_id_bathrooms_id_fk" FOREIGN KEY ("bathroom_id") REFERENCES "public"."bathrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_roles" ADD CONSTRAINT "site_roles_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_roles" ADD CONSTRAINT "site_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_auth_request_key" ON "payment_authorizations" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_auth_intent_key" ON "payment_authorizations" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qr_tokens_token_hash_key" ON "qr_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "site_roles_site_user_key" ON "site_roles" USING btree ("site_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_cognito_sub_key" ON "users" USING btree ("cognito_sub");