ALTER TYPE "public"."site_role_name" RENAME VALUE 'assistant' TO 'authorized_user';--> statement-breakpoint
ALTER TYPE "public"."assistant_approval_status" RENAME TO "request_approval_status";--> statement-breakpoint
ALTER TABLE "assistant_approval_requests" RENAME TO "request_approvals";--> statement-breakpoint
ALTER TABLE "request_approvals" RENAME COLUMN "assistant_id" TO "requester_user_id";
