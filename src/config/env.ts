import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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
  PLATFORM_ALLOWED_ORIGINS: z.string().min(1).default("http://localhost:3000"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = {
  ...parsed.data,
  PLATFORM_ALLOWED_ORIGINS: parsed.data.PLATFORM_ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
};
