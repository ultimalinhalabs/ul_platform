CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error_code" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_outbox_dedupe_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "email_outbox_status_check" CHECK ("email_outbox"."status" in ('pending', 'sent', 'failed')),
	CONSTRAINT "email_outbox_kind_check" CHECK ("email_outbox"."kind" ~ '^[a-z][a-z0-9_.]{2,60}$'),
	CONSTRAINT "email_outbox_to_check" CHECK ("email_outbox"."to_email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
	CONSTRAINT "email_outbox_subject_check" CHECK (length("email_outbox"."subject") between 1 and 300),
	CONSTRAINT "email_outbox_attempts_check" CHECK ("email_outbox"."attempts" >= 0),
	CONSTRAINT "email_outbox_sent_check" CHECK (("email_outbox"."status" = 'sent') = ("email_outbox"."sent_at" is not null))
);
--> statement-breakpoint
CREATE INDEX "email_outbox_due_idx" ON "email_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
-- Personal data (recipient email): closed to the Supabase Data API explicitly (RLS on, no policies, no anon/authenticated grants).
ALTER TABLE "email_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE "public"."email_outbox" FROM %I', r);
    END IF;
  END LOOP;
END $$;
