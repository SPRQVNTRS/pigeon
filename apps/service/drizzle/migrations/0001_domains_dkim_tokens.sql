ALTER TABLE "domains" DROP COLUMN IF EXISTS "dkim_public_key";--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dkim_tokens" text[];
