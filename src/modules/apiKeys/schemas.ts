import { z } from "zod";

export const createApiKeySchema = z.object({
  applicationKey: z.string().min(1),
  expiresAt: z.coerce.date().optional(),
  /** Validated against the global registry and the application's allowlist — see modules/serviceScopes/service.ts. Omitted/empty means the key is granted no scopes. */
  scopes: z.array(z.string().min(1)).optional().default([]),
});
