import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { contractItems, contracts, contractVersions } from "../../db/schema/index.js";
import { NotFoundError } from "../../shared/errors.js";
import { contractItemDto, contractSummaryDto } from "./serializers.js";

/**
 * Block 1C — a client organization's own contracts. Authorization is done by
 * the route (active membership + OWNER of THIS organization); every query is
 * additionally scoped by `organization_id`, so a contract of another
 * organization is simply not found.
 */
export async function listOrganizationContracts(organizationId: string) {
  const rows = await db
    .select({ contract: contracts, version: contractVersions })
    .from(contracts)
    .leftJoin(contractVersions, eq(contractVersions.id, contracts.currentVersionId))
    .where(eq(contracts.organizationId, organizationId))
    .orderBy(desc(contracts.createdAt));
  return rows.map(({ contract, version }) => contractSummaryDto(contract, version));
}

/** The contract with its current version's photograph (parties, option, items, terms) exactly as frozen. */
export async function getOrganizationContract(organizationId: string, contractId: string) {
  const [contract] = await db
    .select()
    .from(contracts)
    .where(and(eq(contracts.id, contractId), eq(contracts.organizationId, organizationId)))
    .limit(1);
  if (!contract) throw new NotFoundError("Contract not found");
  const [version] = contract.currentVersionId
    ? await db.select().from(contractVersions).where(eq(contractVersions.id, contract.currentVersionId)).limit(1)
    : [];
  const items = version
    ? await db.select().from(contractItems).where(eq(contractItems.contractVersionId, version.id)).orderBy(asc(contractItems.sort), asc(contractItems.createdAt))
    : [];
  return {
    ...contractSummaryDto(contract, version ?? null),
    snapshot: version?.snapshot ?? null,
    items: items.map(contractItemDto),
  };
}
