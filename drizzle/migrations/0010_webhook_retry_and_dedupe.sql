CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_application_key" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "locked_by" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "latency_ms" integer;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_idempotency_unique" ON "webhook_events" USING btree ("organization_id","source_application_key","idempotency_key");--> statement-breakpoint
CREATE INDEX "webhook_events_organization_id_idx" ON "webhook_events" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_event_unique" ON "webhook_deliveries" USING btree ("webhook_endpoint_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");