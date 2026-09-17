import { z } from "zod";

/**
 * Accepts either a JS number or a decimal string, always normalized to a
 * string before it reaches the database — a JSON number is an IEEE-754
 * double, and round-tripping a large/precise value through one would
 * reintroduce the float imprecision `numeric(20,6)` storage exists to
 * avoid (see db/schema/usage.ts). Strictly positive: a usage event
 * represents something that happened, never a zero/negative occurrence.
 */
const quantitySchema = z
  .union([z.number().finite(), z.string().regex(/^\d+(\.\d+)?$/, "quantity must be a positive decimal")])
  .transform((value) => (typeof value === "number" ? value.toString() : value))
  .refine((value) => Number(value) > 0, "quantity must be greater than zero");

export const recordUsageSchema = z.object({
  meterKey: z.string().min(1),
  quantity: quantitySchema,
  occurredAt: z.coerce.date().optional(),
  idempotencyKey: z.string().min(1).max(200),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const usageRangeQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
