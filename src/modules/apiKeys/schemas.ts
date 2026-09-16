import { z } from "zod";

export const createApiKeySchema = z.object({
  applicationKey: z.string().min(1),
  expiresAt: z.coerce.date().optional(),
});
