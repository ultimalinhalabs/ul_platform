ALTER TABLE "plans" ADD COLUMN "purchase_mode" text DEFAULT 'contractual' NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "price_minor" bigint;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "period_days" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "terms_template_id" uuid;--> statement-breakpoint
ALTER TABLE "proposal_items" ADD COLUMN "duration_days" integer;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "channel" text DEFAULT 'assisted' NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "request_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "contract_items" ADD COLUMN "duration_days" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_terms_template_id_commercial_terms_templates_id_fk" FOREIGN KEY ("terms_template_id") REFERENCES "public"."commercial_terms_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_request_idempotency_unique" ON "proposals" USING btree ("created_by","request_idempotency_key") WHERE "proposals"."request_idempotency_key" is not null;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_purchase_mode_check" CHECK ("plans"."purchase_mode" in ('contractual', 'self_service'));--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_price_check" CHECK ("plans"."price_minor" is null or "plans"."price_minor" >= 0);--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_currency_check" CHECK ("plans"."currency" is null or "plans"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_period_check" CHECK ("plans"."period_days" is null or "plans"."period_days" between 1 and 3660);--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_self_service_terms_check" CHECK ("plans"."purchase_mode" <> 'self_service' or ("plans"."price_minor" is not null and "plans"."currency" is not null and "plans"."period_days" is not null and "plans"."terms_template_id" is not null));--> statement-breakpoint
ALTER TABLE "proposal_items" ADD CONSTRAINT "proposal_items_duration_days_check" CHECK ("proposal_items"."duration_days" is null or ("proposal_items"."duration_days" > 0 and "proposal_items"."duration_months" is null));--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_channel_check" CHECK ("proposals"."channel" in ('assisted', 'self_service'));--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_request_idempotency_check" CHECK ("proposals"."request_idempotency_key" is null or length("proposals"."request_idempotency_key") between 8 and 200);--> statement-breakpoint
ALTER TABLE "contract_items" ADD CONSTRAINT "contract_items_duration_days_check" CHECK ("contract_items"."duration_days" is null or ("contract_items"."duration_days" > 0 and "contract_items"."duration_months" is null));