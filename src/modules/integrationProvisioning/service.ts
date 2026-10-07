import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { apiKeyScopes, apiKeys, applications, credentialProvisioningRequests, serviceScopes } from "../../db/schema/index.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { buildApiKeyToken, generateApiKeySecret, hashApiKeySecret } from "../apiKeys/crypto.js";
import { PENDING_CREDENTIAL_WINDOW_MS, PROVISIONER_PURPOSE, PROVISIONER_SCOPE, type VerifiedServiceCredential } from "../apiKeys/service.js";
import { recordAuditEventStrict } from "../audit/service.js";
import { commercialAuthorization } from "./authorization.js";

/**
 * D2-B MVP — managed integration credential provisioning (docs/architecture/D2-B-ARCHITECTURE-REVISION.md).
 * UL Platform is the commercial authority and the only issuer; the product (Na Pista) pulls, stores via
 * F29A and proves possession. Only NA_PISTA is wired; the purpose is the one the product uses to call the
 * platform on behalf of an organization.
 */
export const INTEGRATION_PURPOSE = "platform_integration";
/** Applications whose activation creates an integration provisioning request, and the FIXED scopes of their managed credential. */
export const INTEGRATION_APPLICATIONS: Record<string, { scopes: string[] }> = {
  NA_PISTA: { scopes: ["usage.write", "event.publish"] },
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type PR = typeof credentialProvisioningRequests.$inferSelect;

export class ProvisioningConflictError extends AppError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}

export class ProvisioningNotAuthorizedError extends AppError {
  constructor(reason: string) {
    super(403, "PROVISIONING_NOT_AUTHORIZED", `Provisioning is not authorized: ${reason}`);
  }
}

function serialize(pr: PR, applicationKey: string) {
  return {
    id: pr.id,
    organizationId: pr.organizationId,
    application: applicationKey,
    purpose: pr.purpose,
    kind: pr.kind,
    status: pr.status,
    issueCount: pr.issueCount,
    currentCredentialId: pr.currentCredentialId,
    predecessorId: pr.predecessorId,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
  };
}

type Actor = { userId?: string; apiKeyId?: string; label: string };

function audit(tx: Tx, pr: PR, action: string, actor: Actor, metadata: Record<string, unknown> = {}) {
  // Metadata only — never a secret, token or hash.
  return recordAuditEventStrict(
    {
      actorUserId: actor.userId,
      organizationId: pr.organizationId,
      applicationId: pr.applicationId,
      action,
      targetType: "credential_provisioning_request",
      targetId: pr.id,
      metadata: { actor: actor.label, ...(actor.apiKeyId ? { actorApiKeyId: actor.apiKeyId } : {}), kind: pr.kind, ...metadata },
    },
    tx,
  );
}

async function revokeCredentialInTx(tx: Tx, pr: PR, credentialId: string, reason: string, actor: Actor) {
  const [row] = await tx
    .update(apiKeys)
    .set({ status: "REVOKED", revokedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(apiKeys.id, credentialId), inArray(apiKeys.status, ["PENDING", "ACTIVE"])))
    .returning({ id: apiKeys.id });
  if (row) await audit(tx, pr, "integration.credential.revoked", actor, { credentialId, reason });
}

/** Ends a request: open → CANCELLED, ACTIVE → REVOKED; its current credential is revoked in the same transaction. */
async function endRequestInTx(tx: Tx, pr: PR, reason: string, actor: Actor): Promise<PR> {
  const next = pr.status === "ACTIVE" ? "REVOKED" : "CANCELLED";
  const [updated] = await tx
    .update(credentialProvisioningRequests)
    .set({ status: next, updatedAt: sql`now()` })
    .where(eq(credentialProvisioningRequests.id, pr.id))
    .returning();
  if (pr.currentCredentialId) await revokeCredentialInTx(tx, pr, pr.currentCredentialId, reason, actor);
  if (next === "CANCELLED") await audit(tx, pr, "integration.credential.refused", actor, { reason, previousStatus: pr.status, status: next });
  else await audit(tx, pr, "integration.credential.revoked", actor, { reason, previousStatus: pr.status, status: next });
  return updated!;
}

/**
 * Called inside `activateContract`, right after the grant made the access effective. Creates the
 * initial request only if the commercial authorization holds now and the relation has no open or
 * ACTIVE request (the partial unique indexes make a concurrent duplicate a no-op).
 */
export async function requestInitialProvisioningInTx(
  tx: Tx,
  input: { organizationId: string; applicationId: string; applicationKey: string; contractId: string; entitlementGrantId: string; actorUserId: string },
) {
  if (!INTEGRATION_APPLICATIONS[input.applicationKey]) return null;
  const authz = await commercialAuthorization(tx, input.organizationId, input.applicationId);
  if (!authz.ok) return null;
  const [created] = await tx
    .insert(credentialProvisioningRequests)
    .values({
      organizationId: input.organizationId,
      applicationId: input.applicationId,
      purpose: INTEGRATION_PURPOSE,
      kind: "initial",
      contractId: input.contractId,
      entitlementGrantId: input.entitlementGrantId,
      requestedBy: "system:contract_activation",
    })
    .onConflictDoNothing()
    .returning();
  if (!created) return null;
  await audit(tx, created, "integration.credential.requested", { userId: input.actorUserId, label: "system:contract_activation" }, { contractId: input.contractId });
  return created;
}

/** The provisioner may only operate as the reconciler of its own application: class, purpose and scope, all from the stored credential. */
export function assertProvisioner(credential: VerifiedServiceCredential | undefined): asserts credential is VerifiedServiceCredential {
  if (
    !credential ||
    credential.credentialClass !== "PLATFORM_SERVICE" ||
    credential.purpose !== PROVISIONER_PURPOSE ||
    credential.status !== "ACTIVE" ||
    !credential.scopes.includes(PROVISIONER_SCOPE)
  ) {
    throw new ForbiddenError("This operation requires the application's provisioner credential");
  }
}

/** Open requests (REQUESTED / ISSUED) of the provisioner's OWN application and purpose — never chosen by the caller. */
export async function listOpenProvisioningRequests(provisioner: VerifiedServiceCredential) {
  assertProvisioner(provisioner);
  const rows = await db
    .select()
    .from(credentialProvisioningRequests)
    .where(
      and(
        eq(credentialProvisioningRequests.applicationId, provisioner.applicationId),
        eq(credentialProvisioningRequests.purpose, INTEGRATION_PURPOSE),
        inArray(credentialProvisioningRequests.status, ["REQUESTED", "ISSUED"]),
      ),
    )
    .orderBy(credentialProvisioningRequests.createdAt);
  return rows.map((r) => serialize(r, provisioner.applicationKey));
}

/**
 * Issues (or re-issues) the managed credential of an open request. Authority = the persisted request +
 * the commercial authorization NOW; the body carries only `expectedIssueCount` (optimistic concurrency:
 * at most one issuance per count, so concurrent or replayed calls never mint twice). A re-issue revokes
 * the previous, never-confirmed PENDING credential in the same transaction. The secret is returned in
 * this response only: the platform keeps its hash.
 */
export async function issueIntegrationCredential(provisioner: VerifiedServiceCredential, requestId: string, expectedIssueCount: number) {
  assertProvisioner(provisioner);
  const integration = INTEGRATION_APPLICATIONS[provisioner.applicationKey];
  if (!integration) throw new ForbiddenError("This application has no managed integration");
  const actor: Actor = { apiKeyId: provisioner.apiKeyId, label: "service:provisioner" };
  const secret = generateApiKeySecret();

  const outcome = await db.transaction(async (tx) => {
    const [pr] = await tx.select().from(credentialProvisioningRequests).where(eq(credentialProvisioningRequests.id, requestId)).for("update");
    // Another application's (or purpose's) request does not exist for this provisioner.
    if (!pr || pr.applicationId !== provisioner.applicationId || pr.purpose !== INTEGRATION_PURPOSE) return { kind: "not_found" as const };
    if (pr.status !== "REQUESTED" && pr.status !== "ISSUED") return { kind: "not_open" as const };
    if (pr.issueCount !== expectedIssueCount) return { kind: "stale" as const };

    const authz = await commercialAuthorization(tx, pr.organizationId, pr.applicationId);
    if (!authz.ok) {
      await endRequestInTx(tx, pr, `not_authorized:${authz.reason}`, actor);
      return { kind: "refused" as const, reason: authz.reason };
    }
    if (pr.status === "ISSUED" && pr.currentCredentialId) {
      await revokeCredentialInTx(tx, pr, pr.currentCredentialId, "superseded_unconfirmed", actor);
    }

    const [credential] = await tx
      .insert(apiKeys)
      .values({
        secretHash: hashApiKeySecret(secret),
        applicationId: pr.applicationId,
        organizationId: pr.organizationId,
        credentialClass: "INTEGRATION_MANAGED",
        purpose: INTEGRATION_PURPOSE,
        provisioningRequestId: pr.id,
        status: "PENDING",
      })
      .returning({ id: apiKeys.id });
    const scopeRows = await tx.select({ id: serviceScopes.id }).from(serviceScopes).where(inArray(serviceScopes.key, integration.scopes));
    if (scopeRows.length !== integration.scopes.length) throw new Error("Integration scopes are missing from the registry");
    await tx.insert(apiKeyScopes).values(scopeRows.map((s) => ({ apiKeyId: credential!.id, serviceScopeId: s.id })));

    const [updated] = await tx
      .update(credentialProvisioningRequests)
      .set({ status: "ISSUED", currentCredentialId: credential!.id, issueCount: pr.issueCount + 1, updatedAt: sql`now()` })
      .where(eq(credentialProvisioningRequests.id, pr.id))
      .returning();
    await audit(tx, updated!, "integration.credential.issued", actor, { credentialId: credential!.id, issueCount: updated!.issueCount });
    return { kind: "issued" as const, pr: updated!, credentialId: credential!.id };
  });

  switch (outcome.kind) {
    case "not_found":
      throw new NotFoundError("Provisioning request not found");
    case "not_open":
      throw new ProvisioningConflictError("PROVISIONING_NOT_OPEN", "This provisioning request is not open");
    case "stale":
      throw new ProvisioningConflictError("PROVISIONING_ISSUE_COUNT_MISMATCH", "expectedIssueCount does not match; re-read the request");
    case "refused":
      throw new ProvisioningNotAuthorizedError(outcome.reason);
    case "issued":
      return {
        provisioningRequest: serialize(outcome.pr, provisioner.applicationKey),
        credential: {
          id: outcome.credentialId,
          status: "PENDING" as const,
          // shown exactly once — never persisted, never logged, never re-derivable
          token: buildApiKeyToken(outcome.credentialId, secret),
        },
      };
  }
}

/**
 * Proof of possession: authenticated BY the issued credential itself. PENDING → ACTIVE and the request
 * → ACTIVE, after re-evaluating the commercial authorization. Idempotent for an already-ACTIVE request
 * whose current credential is the caller. For a `rekey`/`rotation`, the predecessor request becomes
 * SUPERSEDED and its credential is revoked in the same transaction (MVP: no overlap window).
 */
export async function confirmIntegrationCredential(credential: VerifiedServiceCredential, requestId: string) {
  if (credential.credentialClass !== "INTEGRATION_MANAGED" || credential.provisioningRequestId !== requestId) {
    throw new NotFoundError("Provisioning request not found");
  }
  const actor: Actor = { apiKeyId: credential.apiKeyId, label: "service:managed_credential" };

  const outcome = await db.transaction(async (tx) => {
    const [pr] = await tx.select().from(credentialProvisioningRequests).where(eq(credentialProvisioningRequests.id, requestId)).for("update");
    if (!pr || pr.organizationId !== credential.organizationId || pr.applicationId !== credential.applicationId) return { kind: "not_found" as const };
    const [key] = await tx
      .select({ status: apiKeys.status, createdAt: apiKeys.createdAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, credential.apiKeyId))
      .for("update");
    if (!key) return { kind: "not_found" as const };

    if (pr.status === "ACTIVE" && pr.currentCredentialId === credential.apiKeyId && key.status === "ACTIVE") return { kind: "confirmed" as const, pr };
    if (pr.status !== "ISSUED" || pr.currentCredentialId !== credential.apiKeyId || key.status !== "PENDING") return { kind: "not_current" as const };
    if (key.createdAt.getTime() + PENDING_CREDENTIAL_WINDOW_MS <= Date.now()) return { kind: "expired" as const };

    const authz = await commercialAuthorization(tx, pr.organizationId, pr.applicationId);
    if (!authz.ok) {
      await endRequestInTx(tx, pr, `not_authorized:${authz.reason}`, actor);
      return { kind: "refused" as const, reason: authz.reason };
    }

    if (pr.predecessorId) {
      const [predecessor] = await tx.select().from(credentialProvisioningRequests).where(eq(credentialProvisioningRequests.id, pr.predecessorId)).for("update");
      if (predecessor?.status === "ACTIVE") {
        await tx.update(credentialProvisioningRequests).set({ status: "SUPERSEDED", updatedAt: sql`now()` }).where(eq(credentialProvisioningRequests.id, predecessor.id));
        if (predecessor.currentCredentialId) await revokeCredentialInTx(tx, predecessor, predecessor.currentCredentialId, `superseded_by_${pr.kind}`, actor);
      }
    }
    await tx.update(apiKeys).set({ status: "ACTIVE", updatedAt: sql`now()` }).where(eq(apiKeys.id, credential.apiKeyId));
    const [updated] = await tx
      .update(credentialProvisioningRequests)
      .set({ status: "ACTIVE", updatedAt: sql`now()` })
      .where(eq(credentialProvisioningRequests.id, pr.id))
      .returning();
    await audit(tx, updated!, "integration.credential.confirmed", actor, { credentialId: credential.apiKeyId });
    return { kind: "confirmed" as const, pr: updated! };
  });

  switch (outcome.kind) {
    case "not_found":
      throw new NotFoundError("Provisioning request not found");
    case "not_current":
      throw new ProvisioningConflictError("PROVISIONING_CREDENTIAL_NOT_CURRENT", "This credential is not the request's pending credential");
    case "expired":
      throw new ProvisioningConflictError("PROVISIONING_CONFIRMATION_EXPIRED", "The confirmation window has passed; a new issuance is required");
    case "refused":
      throw new ProvisioningNotAuthorizedError(outcome.reason);
    case "confirmed":
      return serialize(outcome.pr, credential.applicationKey);
  }
}

/** PLATFORM_ADMIN — ends a request (open → CANCELLED, ACTIVE → REVOKED) and revokes its credential. Idempotent on terminal requests. */
export async function revokeProvisioningRequest(requestId: string, reason: string, actorUserId: string) {
  const actor: Actor = { userId: actorUserId, label: "platform_admin" };
  const pr = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(credentialProvisioningRequests).where(eq(credentialProvisioningRequests.id, requestId)).for("update");
    if (!row) throw new NotFoundError("Provisioning request not found");
    if (!["REQUESTED", "ISSUED", "ACTIVE"].includes(row.status)) return row;
    return endRequestInTx(tx, row, `admin:${reason}`, actor);
  });
  return serialize(pr, await applicationKeyOf(pr.applicationId));
}

/**
 * PLATFORM_ADMIN — explicit recovery for a lost or compromised credential: a `rekey` request whose
 * predecessor is the ACTIVE one. Same commercial authorization as any issuance; the predecessor keeps
 * working until the new credential is confirmed (then it is revoked atomically).
 */
export async function requestRekey(activeRequestId: string, actorUserId: string) {
  const actor: Actor = { userId: actorUserId, label: "platform_admin" };
  const created = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(credentialProvisioningRequests).where(eq(credentialProvisioningRequests.id, activeRequestId)).for("update");
    if (!current) throw new NotFoundError("Provisioning request not found");
    if (current.status !== "ACTIVE") throw new ProvisioningConflictError("PROVISIONING_NOT_ACTIVE", "Only an ACTIVE request can be re-keyed");
    const authz = await commercialAuthorization(tx, current.organizationId, current.applicationId);
    if (!authz.ok) throw new ProvisioningNotAuthorizedError(authz.reason);
    const [row] = await tx
      .insert(credentialProvisioningRequests)
      .values({
        organizationId: current.organizationId,
        applicationId: current.applicationId,
        purpose: current.purpose,
        kind: "rekey",
        predecessorId: current.id,
        requestedBy: `platform_admin:${actorUserId}`,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new ConflictError("An open provisioning request already exists for this integration");
    await audit(tx, row, "integration.credential.requested", actor, { predecessorId: current.id });
    return row;
  });
  return serialize(created, await applicationKeyOf(created.applicationId));
}

/**
 * Called inside `revokeApplicationAccess` (contract termination, grant revocation, manual revocation):
 * every open/ACTIVE request of the relation ends and its credential is revoked in the SAME transaction.
 * Not required for safety — the runtime authorization already refuses the credential once the access or
 * the grant is gone — but it keeps the stored state honest.
 */
export async function endProvisioningForAccessLossInTx(tx: Tx, organizationId: string, applicationId: string, actorUserId: string, reason: string) {
  const open = await tx
    .select()
    .from(credentialProvisioningRequests)
    .where(
      and(
        eq(credentialProvisioningRequests.organizationId, organizationId),
        eq(credentialProvisioningRequests.applicationId, applicationId),
        inArray(credentialProvisioningRequests.status, ["REQUESTED", "ISSUED", "ACTIVE"]),
      ),
    )
    .for("update");
  for (const pr of open) await endRequestInTx(tx, pr, reason, { userId: actorUserId, label: "system:access_revoked" });
}

async function applicationKeyOf(applicationId: string) {
  const [row] = await db.select({ key: applications.key }).from(applications).where(eq(applications.id, applicationId));
  return row!.key;
}
