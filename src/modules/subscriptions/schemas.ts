import { z } from "zod";

export const createSubscriptionSchema = z.object({
  applicationKey: z.string().min(1),
  planKey: z.string().min(1),
});

/** Only cancellation is supported in v1 — no arbitrary status writes. */
export const cancelSubscriptionSchema = z.object({
  status: z.literal("canceled"),
});
