import { z } from "zod";

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

/**
 * The lead contract — mirrors the UL landing form so a submission the form
 * accepts is never rejected here (bounds identical to the landing's
 * `lib/validations.ts`). `.strict()`: an unknown field is a 400, not
 * silently dropped, so a contract drift surfaces at the first call.
 */
export const createLeadSchema = z
  .object({
    companyName: text(2, 150),
    contactName: text(2, 120),
    email: z.string().trim().toLowerCase().pipe(z.email()),
    phone: text(8, 20).regex(/^[\d\s+()-]+$/, "phone contains invalid characters"),
    businessArea: text(2, 120),
    desiredService: text(2, 150),
    message: text(10, 2000),
    landingPage: z.string().trim().url().max(500).optional(),
    utm: z
      .object({
        source: optionalText(255),
        medium: optionalText(255),
        campaign: optionalText(255),
        term: optionalText(255),
        content: optionalText(255),
      })
      .strict()
      .optional(),
    userAgent: optionalText(1000),
  })
  .strict();

export type CreateLeadInput = z.infer<typeof createLeadSchema>;

/** Same bounds as the `commercial_leads_idempotency_check` constraint. */
export const idempotencyKeySchema = z.string().min(8).max(200);
