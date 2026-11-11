CREATE TABLE "dns_check_results" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"domain" text NOT NULL,
	"record_type" text NOT NULL,
	"status" text NOT NULL,
	"expected" text NOT NULL,
	"actual" text,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dns_check_results" ADD CONSTRAINT "dns_check_results_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dns_check_results_domain_id_record_type_checked_at_idx" ON "dns_check_results" USING btree ("domain_id","record_type","checked_at");