ALTER TABLE "inbound_emails" ADD COLUMN "sender_hash" text;--> statement-breakpoint
CREATE INDEX "inbound_emails_app_id_sender_hash_idx" ON "inbound_emails" USING btree ("app_id","sender_hash");