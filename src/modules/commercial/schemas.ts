import { z } from "zod";
import { BILLING_PERIODS, COMMERCIAL_ITEM_KINDS, PROPOSAL_STATUSES } from "../../db/schema/index.js";
import { currencySchema, minorAmountSchema } from "./money.js";

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const atLeastOne = (v: Record<string, unknown>) => Object.values(v).some((value) => value !== undefined);

/** JSON values allowed in `entitlement_spec`: the canonical snapshot only accepts safe integers, strings, booleans, null. */
type SpecValue = null | boolean | string | number | SpecValue[] | { [key: string]: SpecValue };
const specValueSchema: z.ZodType<SpecValue> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.string().max(500), z.number().int().refine(Number.isSafeInteger), z.array(specValueSchema).max(50), z.record(z.string().max(100), specValueSchema)]),
);
const entitlementSpecSchema = z.record(z.string().max(100), specValueSchema).nullable().optional();

export const createProposalSchema = z
  .object({
    prospectCompanyName: text(200),
    prospectTaxId: optionalText(50),
    recipientName: text(200),
    recipientEmail: z.string().trim().toLowerCase().email().max(254),
    organizationId: z.string().uuid().nullable().optional(),
    currency: currencySchema.default("AOA"),
    validUntil: z.coerce.date().nullable().optional(),
    summary: optionalText(5000),
    notes: optionalText(5000),
    termsTemplateId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const updateProposalSchema = z
  .object({
    prospectCompanyName: text(200).optional(),
    prospectTaxId: optionalText(50),
    recipientName: text(200).optional(),
    recipientEmail: z.string().trim().toLowerCase().email().max(254).optional(),
    organizationId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine(atLeastOne, { message: "At least one field must be provided" });

export const listProposalsQuerySchema = z.object({
  status: z.enum(PROPOSAL_STATUSES).optional(),
  organizationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export const updateVersionSchema = z
  .object({
    currency: currencySchema.optional(),
    validUntil: z.coerce.date().nullable().optional(),
    summary: optionalText(5000),
    notes: optionalText(5000),
    termsTemplateId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine(atLeastOne, { message: "At least one field must be provided" });

export const createOptionSchema = z
  .object({
    name: text(120),
    summary: optionalText(2000),
    isRecommended: z.boolean().default(false),
    sort: z.number().int().min(0).max(1000).default(0),
  })
  .strict();

export const updateOptionSchema = z
  .object({
    name: text(120).optional(),
    summary: optionalText(2000),
    isRecommended: z.boolean().optional(),
    sort: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .refine(atLeastOne, { message: "At least one field must be provided" });

const quantitySchema = z.number().int().positive().max(1_000_000);

export const createItemSchema = z
  .object({
    kind: z.enum(COMMERCIAL_ITEM_KINDS),
    title: text(200),
    description: optionalText(5000),
    applicationKey: z.string().min(1).max(100).nullable().optional(),
    planKey: z.string().min(1).max(100).nullable().optional(),
    quantity: quantitySchema.default(1),
    unitPriceMinor: minorAmountSchema,
    billingPeriod: z.enum(BILLING_PERIODS).default("one_time"),
    durationMonths: z.number().int().positive().max(120).nullable().optional(),
    entitlementSpec: entitlementSpecSchema,
    sort: z.number().int().min(0).max(1000).default(0),
  })
  .strict();

export const updateItemSchema = z
  .object({
    kind: z.enum(COMMERCIAL_ITEM_KINDS).optional(),
    title: text(200).optional(),
    description: optionalText(5000),
    applicationKey: z.string().min(1).max(100).nullable().optional(),
    planKey: z.string().min(1).max(100).nullable().optional(),
    quantity: quantitySchema.optional(),
    unitPriceMinor: minorAmountSchema.optional(),
    billingPeriod: z.enum(BILLING_PERIODS).optional(),
    durationMonths: z.number().int().positive().max(120).nullable().optional(),
    entitlementSpec: entitlementSpecSchema,
    sort: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .refine(atLeastOne, { message: "At least one field must be provided" });

export const createAccessLinkSchema = z
  .object({
    expiresAt: z.coerce.date().optional(),
    maxViews: z.number().int().positive().max(10_000).nullable().optional(),
  })
  .strict();

/**
 * Block 1C — acceptance by the verified recipient. The request names the
 * EXACT version, option and content hash it was shown; "the current
 * version" is never accepted implicitly. `organization` is either an
 * existing organization the user OWNS or a new one created in the same
 * transaction. `consent: true` is the user's affirmative act; the consent
 * TEXT is defined by the server (modules/commercial/consent.ts).
 */
export const acceptProposalSchema = z
  .object({
    versionId: z.string().uuid(),
    optionId: z.string().uuid(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    organization: z.union([z.object({ id: z.string().uuid() }).strict(), z.object({ create: z.object({ name: text(120) }).strict() }).strict()]).optional(),
    signerName: text(200),
    signerTitle: optionalText(200),
    consent: z.literal(true),
  })
  .strict();

/** `Idempotency-Key` header: the same key replays the same acceptance. */
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/, "Idempotency-Key must be 8–200 characters of [A-Za-z0-9._:-]");

/** Public resolution: the token travels in the body (request logs only record the path). Shape errors become the uniform 404. */
export const resolvePublicProposalSchema = z.object({ token: z.string().max(200) }).strict();
