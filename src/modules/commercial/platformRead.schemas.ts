import { z } from "zod";
import { CONTRACT_STATUSES } from "../../db/schema/index.js";
import { PROVISIONING_STATUSES } from "../../db/schema/credentialProvisioning.js";
import { COMMERCIAL_AGGREGATE_TYPES } from "../../db/schema/commercialEvents.js";

/**
 * UL Console MVP — query schemas of the platform commercial READ APIs. Every filter is validated here
 * (unknown keys are rejected) so the service only ever receives typed values; search text is matched
 * as a literal (wildcards escaped), never interpolated into SQL.
 */
const limit = z.coerce.number().int().positive().max(100).default(25);
const cursor = z.string().min(1).max(200).optional();
const uuid = z.string().uuid();

export const listOrganizationsQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(100).optional(),
    status: z.enum(["active", "suspended"]).optional(),
    cursor,
    limit,
  })
  .strict();

export const listContractsQuerySchema = z
  .object({
    organizationId: uuid.optional(),
    status: z.enum(CONTRACT_STATUSES).optional(),
    applicationKey: z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/).optional(),
    cursor,
    limit,
  })
  .strict();

export const listProvisioningsQuerySchema = z
  .object({
    organizationId: uuid.optional(),
    status: z.enum(PROVISIONING_STATUSES).optional(),
    cursor,
    limit,
  })
  .strict();

export const listCommercialEventsQuerySchema = z
  .object({
    organizationId: uuid.optional(),
    eventType: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/).optional(),
    aggregateType: z.enum(COMMERCIAL_AGGREGATE_TYPES).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    cursor,
    limit,
  })
  .strict();

export const organizationIdParam = uuid;
