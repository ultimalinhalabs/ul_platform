CREATE TABLE "application_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"type" text NOT NULL,
	"base_url" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"key" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_application_id" uuid NOT NULL,
	"target_application_id" uuid NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_endpoints" ADD CONSTRAINT "application_endpoints_environment_id_application_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."application_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_environments" ADD CONSTRAINT "application_environments_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_integrations" ADD CONSTRAINT "application_integrations_source_application_id_applications_id_fk" FOREIGN KEY ("source_application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_integrations" ADD CONSTRAINT "application_integrations_target_application_id_applications_id_fk" FOREIGN KEY ("target_application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_endpoints_environment_type_unique" ON "application_endpoints" USING btree ("environment_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "application_environments_application_key_unique" ON "application_environments" USING btree ("application_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "application_integrations_source_target_unique" ON "application_integrations" USING btree ("source_application_id","target_application_id");