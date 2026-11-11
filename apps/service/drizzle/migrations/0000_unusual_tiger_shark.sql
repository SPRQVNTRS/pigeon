CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"deactivated" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"password" text NOT NULL,
	"role" text DEFAULT 'editor' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workflow_locks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "workflow_locks_entity_unique" UNIQUE("entity_type","entity_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"type" text NOT NULL,
	"stage" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_stage" text,
	"checkpoint_status" text,
	"error_message" text,
	"template_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"job_id" text
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"hashed_key" text NOT NULL,
	"prefix" text NOT NULL,
	"rate_limit_per_second" integer DEFAULT 10,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"region" text DEFAULT 'eu-central-1',
	"dkim_selector" text DEFAULT 'sprqvntrs',
	"dkim_public_key" text,
	"spf_status" text DEFAULT 'pending',
	"dkim_status" text DEFAULT 'pending',
	"dmarc_status" text DEFAULT 'pending',
	"mx_status" text DEFAULT 'pending',
	"verified_at" timestamp with time zone,
	"last_verification_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"api_key_id" text NOT NULL,
	"idempotency_key" text,
	"message_id" text,
	"from_address" text NOT NULL,
	"to_addresses" text[] NOT NULL,
	"cc_addresses" text[] DEFAULT '{}',
	"bcc_addresses" text[] DEFAULT '{}',
	"reply_to" text,
	"subject" text NOT NULL,
	"html" text,
	"text" text,
	"headers" jsonb DEFAULT '{}'::jsonb,
	"attachments_count" integer DEFAULT 0,
	"status" text DEFAULT 'queued',
	"failure_reason" text,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"email_id" text NOT NULL,
	"type" text NOT NULL,
	"subtype" text,
	"raw" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audiences" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"audience_id" text NOT NULL,
	"email" "citext" NOT NULL,
	"first_name" text,
	"last_name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"status" text DEFAULT 'subscribed',
	"unsubscribed_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"complained_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"email" "citext" NOT NULL,
	"reason" text NOT NULL,
	"source_email_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"url" text NOT NULL,
	"signing_secret" text NOT NULL,
	"event_types" text[] DEFAULT '{"*"}',
	"enabled" boolean DEFAULT true,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotent_requests" (
	"api_key_id" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotent_requests_api_key_id_key_pk" PRIMARY KEY("api_key_id","key")
);
--> statement-breakpoint
ALTER TABLE "workflow_locks" ADD CONSTRAINT "workflow_locks_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_operations" ADD CONSTRAINT "workflow_operations_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_locks_workflow_id_idx" ON "workflow_locks" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_locks_expires_at_idx" ON "workflow_locks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "workflow_operations_workflow_id_idx" ON "workflow_operations" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_operations_status_idx" ON "workflow_operations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflow_operations_workflow_stage_idx" ON "workflow_operations" USING btree ("workflow_id","stage");--> statement-breakpoint
CREATE INDEX "workflows_status_idx" ON "workflows" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflows_type_idx" ON "workflows" USING btree ("type");--> statement-breakpoint
CREATE INDEX "workflows_created_at_idx" ON "workflows" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "workflows_type_status_idx" ON "workflows" USING btree ("type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hashed_key_idx" ON "api_keys" USING btree ("hashed_key");--> statement-breakpoint
CREATE INDEX "api_keys_app_id_idx" ON "api_keys" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "api_keys_prefix_idx" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_name_idx" ON "domains" USING btree ("name");--> statement-breakpoint
CREATE INDEX "domains_app_id_idx" ON "domains" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_message_id_idx" ON "emails" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_app_id_idempotency_key_idx" ON "emails" USING btree ("app_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "emails_app_id_status_idx" ON "emails" USING btree ("app_id","status");--> statement-breakpoint
CREATE INDEX "emails_app_id_domain_id_idx" ON "emails" USING btree ("app_id","domain_id");--> statement-breakpoint
CREATE INDEX "email_events_email_id_idx" ON "email_events" USING btree ("email_id");--> statement-breakpoint
CREATE INDEX "email_events_app_id_occurred_at_idx" ON "email_events" USING btree ("app_id","occurred_at");--> statement-breakpoint
CREATE INDEX "email_events_received_at_idx" ON "email_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "audiences_app_id_idx" ON "audiences" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_audience_id_email_idx" ON "contacts" USING btree ("audience_id","email");--> statement-breakpoint
CREATE INDEX "contacts_app_id_status_idx" ON "contacts" USING btree ("app_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_app_id_email_idx" ON "suppressions" USING btree ("app_id","email");--> statement-breakpoint
CREATE INDEX "webhooks_app_id_idx" ON "webhooks" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idempotent_requests_created_at_idx" ON "idempotent_requests" USING btree ("created_at");