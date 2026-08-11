ALTER TABLE "decisions" ADD COLUMN "authority" jsonb;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "technical_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "external_enforcement" jsonb;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "latest_enforcement_result" jsonb;
