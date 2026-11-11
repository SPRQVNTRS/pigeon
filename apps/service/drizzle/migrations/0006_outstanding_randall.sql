CREATE TABLE "inbound_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"region" text DEFAULT 'eu-central-1' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_emails" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"inbound_domain_id" text NOT NULL,
	"ses_message_id" text NOT NULL,
	"s3_bucket" text NOT NULL,
	"s3_key" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"recipient_count" integer NOT NULL,
	"recipients" text[] NOT NULL,
	"verdicts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_inbound_domain_id_inbound_domains_id_fk" FOREIGN KEY ("inbound_domain_id") REFERENCES "public"."inbound_domains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_domains_name_uidx" ON "inbound_domains" USING btree ("name");--> statement-breakpoint
CREATE INDEX "inbound_domains_app_id_idx" ON "inbound_domains" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_emails_ses_message_domain_uidx" ON "inbound_emails" USING btree ("ses_message_id","inbound_domain_id");--> statement-breakpoint
CREATE INDEX "inbound_emails_app_id_idx" ON "inbound_emails" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "inbound_emails_created_at_idx" ON "inbound_emails" USING btree ("created_at");