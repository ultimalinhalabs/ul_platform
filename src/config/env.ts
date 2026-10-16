import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * Fase 16 environment strategy — distinct from NODE_ENV on purpose.
   * NODE_ENV controls Node/library optimizations (staging and production
   * both run with NODE_ENV=production); APP_ENV is UL Platform's own
   * three-way distinction (development/staging/production) used for
   * decisions NODE_ENV can't express, like refusing to boot staging or
   * production with a silently-defaulted CORS origin below. See
   * README "Environment Strategy".
   */
  APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),
  /** Base64, must decode to exactly 32 bytes — AES-256-GCM key for webhook secret storage. See modules/webhooks/crypto.ts. */
  WEBHOOK_SECRET_ENCRYPTION_KEY: z
    .string()
    .min(1)
    .refine((v) => {
      try {
        return Buffer.from(v, "base64").length === 32;
      } catch {
        return false;
      }
    }, "WEBHOOK_SECRET_ENCRYPTION_KEY must be base64 decoding to exactly 32 bytes"),
  /**
   * Comma-separated browser origins allowed to call this API with credentials
   * (CORS) — the UL Console (and, later, other first-party consoles) are
   * browser clients that send `Authorization: Bearer <JWT>` directly, so
   * their origin must be explicitly allow-listed. Never `*`: this API expects
   * an Authorization header, and a wildcard origin combined with credentialed
   * requests is exactly the CSRF-adjacent shape CORS exists to prevent.
   * Service-to-service (API key) callers are unaffected — they never run in
   * a browser, so CORS (a browser-only mechanism) does not apply to them.
   */
  // No default here (unlike Fase 15) — see the APP_ENV check below for why.
  PLATFORM_ALLOWED_ORIGINS: z.string().min(1).optional(),
  /**
   * Maximum organizations one user may create in a rolling 24 hours
   * (`POST /v1/organizations`; counted from `organizations.created_by`, so it
   * holds across instances, and applies to every creation path — the route
   * and proposal acceptance with `organization.create`). Default 10 (owner's
   * initial proposal, 2026-10-15); `0` disables the window.
   */
  ORGANIZATION_CREATION_DAILY_LIMIT: z.coerce.number().int().min(0).default(10),
  /**
   * Migration 0024 — how long a self-service offer (the frozen proposal built from the catalog) stays open for
   * acceptance. A technical default (24 h), not a commercial condition; price/period/terms come from the catalog.
   */
  SELF_SERVICE_OFFER_VALIDITY_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  /** Migration 0025 — how long a team invitation stays open (technical default: 7 days). */
  INVITATION_VALIDITY_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  /** Worker — how often active contracts past their end are persisted as expired (default 5 min). */
  CONTRACT_EXPIRY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(10_000).default(300_000),
  /**
   * Migration 0026 — renewal: how many days before the current period ends the next one is prepared
   * (awaiting payment) under a standing authorization. A technical default (7 days), shown to the client.
   */
  RENEWAL_LEAD_DAYS: z.coerce.number().int().min(1).max(60).default(7),
  /**
   * Migration 0027 — payment instructions shown to the client (owner decision 2026-10-16: IBAN transfer or
   * Multicaixa Express, then upload the PDF proof). Public business data, not secrets; a method whose values
   * are not set is simply not offered.
   */
  PAYMENT_BANK_NAME: z.string().trim().min(1).optional(),
  PAYMENT_ACCOUNT_HOLDER: z.string().trim().min(1).optional(),
  PAYMENT_IBAN: z.string().trim().min(1).optional(),
  PAYMENT_MCX_EXPRESS_NUMBER: z.string().trim().min(1).optional(),
  /**
   * Migration 0028 — transactional email over SMTP (AngoWeb mailbox in production). Without SMTP_HOST the
   * worker leaves messages pending (nothing is lost). SMTP_PASSWORD is a secret.
   */
  SMTP_HOST: z.string().trim().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_SECURE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  SMTP_USER: z.string().trim().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  EMAIL_FROM: z.string().trim().min(3).default("Última Linha <nao-responder@ultimalinha.ao>"),
  EMAIL_REPLY_TO: z.string().trim().min(3).optional(),
  /** Where UL operations are told a proof arrived (e.g. financeiro@ultimalinha.ao); unset = no such email. */
  PAYMENTS_NOTIFY_EMAIL: z.string().trim().email().optional(),
  /** Public app URLs used in email links (no secrets in links). */
  UL_CLIENT_URL: z.string().url().default("http://localhost:3002"),
  UL_CONSOLE_URL: z.string().url().default("http://localhost:3010"),
  EMAIL_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
  RENEWAL_SWEEP_INTERVAL_MS: z.coerce.number().int().min(10_000).default(3_600_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

/**
 * `PLATFORM_ALLOWED_ORIGINS` may only fall back to the localhost default in
 * `development`. Staging and production must set it explicitly — silently
 * defaulting a deployed environment's CORS allow-list to `localhost:3000`
 * would either lock out the real Console origin or (worse, if someone
 * "fixes" the default later) quietly widen it. Config validation failing
 * startup here is the whole point of Fase 16 §10: an environment
 * misconfiguration must be loud, not a runtime surprise.
 */
if (parsed.data.APP_ENV !== "development" && !parsed.data.PLATFORM_ALLOWED_ORIGINS) {
  console.error(
    `PLATFORM_ALLOWED_ORIGINS is required when APP_ENV=${parsed.data.APP_ENV} — refusing to fall back to the development default.`,
  );
  throw new Error("Invalid environment configuration");
}

export const env = {
  ...parsed.data,
  PLATFORM_ALLOWED_ORIGINS: (parsed.data.PLATFORM_ALLOWED_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
};
