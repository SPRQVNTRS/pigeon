ALTER TABLE "apps" ADD COLUMN "mail_body_retention_days" integer;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "mail_row_retention_days" integer;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_mail_body_retention_days_positive" CHECK ("apps"."mail_body_retention_days" IS NULL OR "apps"."mail_body_retention_days" > 0);--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_mail_row_retention_days_positive" CHECK ("apps"."mail_row_retention_days" IS NULL OR "apps"."mail_row_retention_days" > 0);