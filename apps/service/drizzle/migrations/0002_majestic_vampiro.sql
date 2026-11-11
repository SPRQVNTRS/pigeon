CREATE TABLE "dmarc_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"dmarc_report_id" integer NOT NULL,
	"source_ip" "inet" NOT NULL,
	"count" integer NOT NULL,
	"disposition" text,
	"dkim_eval" text,
	"spf_eval" text,
	"header_from" text,
	"envelope_from" text,
	"envelope_to" text,
	"policy_reasons" jsonb,
	"spf_auth_results" jsonb,
	"dkim_auth_results" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "dmarc_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"org_name" text NOT NULL,
	"org_email" text,
	"extra_contact_info" text,
	"source_s3_key" text DEFAULT '' NOT NULL,
	"date_range_begin" timestamp with time zone NOT NULL,
	"date_range_end" timestamp with time zone NOT NULL,
	"policy_domain" text NOT NULL,
	"policy_adkim" text,
	"policy_aspf" text,
	"policy_p" text,
	"policy_sp" text,
	"policy_pct" integer,
	"source_message_id" text,
	"received_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "dmarc_reports_report_id_unique" UNIQUE("report_id")
);
--> statement-breakpoint
ALTER TABLE "domains" ALTER COLUMN "dkim_tokens" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "dmarc_records" ADD CONSTRAINT "dmarc_records_dmarc_report_id_dmarc_reports_id_fk" FOREIGN KEY ("dmarc_report_id") REFERENCES "public"."dmarc_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dmarc_records_dmarc_report_id_idx" ON "dmarc_records" USING btree ("dmarc_report_id");--> statement-breakpoint
CREATE INDEX "dmarc_records_source_ip_idx" ON "dmarc_records" USING btree ("source_ip");--> statement-breakpoint
CREATE INDEX "dmarc_records_header_from_idx" ON "dmarc_records" USING btree ("header_from");--> statement-breakpoint
CREATE INDEX "dmarc_reports_policy_domain_idx" ON "dmarc_reports" USING btree ("policy_domain");--> statement-breakpoint
CREATE INDEX "dmarc_reports_date_range_begin_idx" ON "dmarc_reports" USING btree ("date_range_begin");--> statement-breakpoint
CREATE INDEX "dmarc_reports_received_at_idx" ON "dmarc_reports" USING btree ("received_at");