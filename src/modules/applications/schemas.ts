import { z } from "zod";

/** Mirrors the seeded key style (NA_PISTA, UL_CONSOLE, ...) — see db/seed/data.ts. */
const APPLICATION_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export const createApplicationSchema = z.object({
  key: z.string().regex(APPLICATION_KEY_PATTERN, "key must be upper snake case (e.g. NA_PISTA)"),
  name: z.string().min(1),
  description: z.string().optional(),
});

export const updateApplicationSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    status: z.enum(["ACTIVE", "SUSPENDED", "DEPRECATED"]).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined || v.status !== undefined, {
    message: "At least one field must be provided",
  });
