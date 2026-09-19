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
