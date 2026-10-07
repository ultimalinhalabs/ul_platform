import { z } from "zod";

export const createApiKeySchema = z.object({
  applicationKey: z.string().min(1),
  expiresAt: z.coerce.date().optional(),
  /** Validated against the global registry and the application's allowlist — see modules/serviceScopes/service.ts. Omitted/empty means the key is granted no scopes. */
  scopes: z.array(z.string().min(1)).optional().default([]),
});

/** D2-B — platform credentials only: `PROVISIONER` marks the product's reconciler credential (scope `credential.provision` only). */
export const createPlatformApiKeySchema = createApiKeySchema.extend({
  purpose: z.literal("PROVISIONER").optional(),
});
