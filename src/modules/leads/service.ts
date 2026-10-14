import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { applications, commercialLeads } from "../../db/schema/index.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import { recordAuditEvent } from "../audit/service.js";
import type { CreateLeadInput } from "./schemas.js";

type LeadRow = typeof commercialLeads.$inferSelect;

/** What the caller gets back: an acknowledgement, never the personal data it just sent. */
function shapeLead(row: LeadRow, idempotent: boolean) {
  return { id: row.id, status: row.status, createdAt: row.createdAt.toISOString(), idempotent };
}

function toValues(input: CreateLeadInput) {
  return {
    companyName: input.companyName,
    contactName: input.contactName,
    email: input.email,
    phone: input.phone,
    businessArea: input.businessArea,
    desiredService: input.desiredService,
    message: input.message,
    landingPage: input.landingPage ?? null,
    utmSource: input.utm?.source ?? null,
    utmMedium: input.utm?.medium ?? null,
    utmCampaign: input.utm?.campaign ?? null,
    utmTerm: input.utm?.term ?? null,
    utmContent: input.utm?.content ?? null,
    userAgent: input.userAgent ?? null,
  };
}

/** The fields that make two submissions "the same request" for an Idempotency-Key replay. */
function sameSubmission(row: LeadRow, values: ReturnType<typeof toValues>) {
  return (Object.keys(values) as (keyof typeof values)[])
    .filter((key) => key !== "userAgent")
    .every((key) => row[key] === values[key]);
}

/**
 * Records a lead from the credential's own application. A retried call with
 * the same Idempotency-Key resolves to the original row (`idempotent: true`);
 * the same key with a different body is a 409 — never a second lead and
 * never a silent overwrite.
 */
export async function createLead(input: {
  applicationKey: string;
  apiKeyId: string;
  idempotencyKey: string;
  lead: CreateLeadInput;
}) {
  const [application] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(eq(applications.key, input.applicationKey))
    .limit(1);
  if (!application) throw new NotFoundError(`Unknown application: ${input.applicationKey}`);

  const values = toValues(input.lead);

  const [inserted] = await db
    .insert(commercialLeads)
    .values({
      ...values,
      sourceApplicationId: application.id,
      createdByApiKeyId: input.apiKeyId,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({ target: [commercialLeads.sourceApplicationId, commercialLeads.idempotencyKey] })
    .returning();

  if (inserted) {
    // No personal data in the audit trail — the lead row is the record.
    await recordAuditEvent({
      applicationId: application.id,
      action: "commercial.lead.received",
      targetType: "commercial_lead",
      targetId: inserted.id,
      metadata: { applicationKey: input.applicationKey, apiKeyId: input.apiKeyId },
    });
    return shapeLead(inserted, false);
  }

  const [existing] = await db
    .select()
    .from(commercialLeads)
    .where(and(eq(commercialLeads.sourceApplicationId, application.id), eq(commercialLeads.idempotencyKey, input.idempotencyKey)))
    .limit(1);
  if (!existing) throw new Error("Lead idempotency conflict without an existing row");
  if (!sameSubmission(existing, values)) {
    throw new ConflictError("This Idempotency-Key was already used for a different lead");
  }
  return shapeLead(existing, true);
}
