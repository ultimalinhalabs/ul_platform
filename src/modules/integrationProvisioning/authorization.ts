import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { AppError, ApplicationAccessRequiredError } from "../../shared/errors.js";
import type { VerifiedServiceCredential } from "../apiKeys/service.js";

type Executor = Pick<typeof db, "execute">;

export type CommercialAuthorization =
  | { ok: true }
  | { ok: false; reason: "ORGANIZATION_NOT_ACTIVE" | "APPLICATION_NOT_ACTIVE" | "APPLICATION_ACCESS_REQUIRED" | "CONTRACTUAL_GRANT_REQUIRED" };

/**
 * D2-B — the current commercial authority of an Organization × Application, evaluated NOW (in the
 * caller's transaction when one is given). Every condition is a read-time predicate, so it holds
 * even when no job has flipped a stored status (a grant past `ends_at` stops authorizing at once):
 *  - organization `active`;
 *  - application `ACTIVE`;
 *  - effective application access (active row, not backed by an active grant whose `ends_at` passed);
 *  - an effective CONTRACTUAL grant (status `active`, `ends_at` null or in the future) — manual
 *    access granted without a contract never authorizes a managed integration credential.
 */
export async function commercialAuthorization(executor: Executor, organizationId: string, applicationId: string): Promise<CommercialAuthorization> {
  const rows = (await executor.execute(sql`
    select o.status as organization_status,
           a.status as application_status,
           exists (
             select 1 from organization_application_access x
             where x.organization_id = o.id and x.application_id = a.id and x.status = 'active'
               and not exists (
                 select 1 from entitlement_grants g
                 where g.application_access_id = x.id and g.status = 'active' and g.ends_at is not null and g.ends_at <= now()
               )
           ) as access_effective,
           exists (
             select 1 from entitlement_grants g
             where g.organization_id = o.id and g.application_id = a.id and g.status = 'active'
               and (g.ends_at is null or g.ends_at > now())
           ) as grant_effective
    from organizations o, applications a
    where o.id = ${organizationId} and a.id = ${applicationId}
  `)) as unknown as Array<{ organization_status: string; application_status: string; access_effective: boolean; grant_effective: boolean }>;
  const row = rows[0];
  if (!row || row.organization_status !== "active") return { ok: false, reason: "ORGANIZATION_NOT_ACTIVE" };
  if (row.application_status !== "ACTIVE") return { ok: false, reason: "APPLICATION_NOT_ACTIVE" };
  if (!row.access_effective) return { ok: false, reason: "APPLICATION_ACCESS_REQUIRED" };
  if (!row.grant_effective) return { ok: false, reason: "CONTRACTUAL_GRANT_REQUIRED" };
  return { ok: true };
}

export class CredentialNotAuthorizedError extends AppError {
  constructor() {
    super(403, "CREDENTIAL_NOT_AUTHORIZED", "This credential is not currently authorized for this organization and application");
  }
}

/**
 * D2-B — runtime authorization of an org-scoped credential, at every authenticated request
 * (`authenticate` calls it after the credential's identity and the organization's status were
 * verified). Nothing here trusts how the key was created, a worker, or a cache:
 *  - ORGANIZATION: the organization must have EFFECTIVE access to the key's application now
 *    (G6 was enforced at creation only; this completes it at use time);
 *  - INTEGRATION_MANAGED (ACTIVE): all of the commercial authorization above, AND its provisioning
 *    request is ACTIVE with this exact credential as its current one;
 *  - PLATFORM_SERVICE: not organization-scoped — unchanged (org routes refuse it by construction).
 * PENDING credentials never reach this function (rejected by `authenticate` except on the two
 * routes that exist for them).
 */
export async function assertServiceCredentialAuthorizedNow(credential: VerifiedServiceCredential): Promise<void> {
  if (credential.credentialClass === "PLATFORM_SERVICE" || !credential.organizationId) return;

  if (credential.credentialClass === "ORGANIZATION") {
    const authz = await commercialAuthorization(db, credential.organizationId, credential.applicationId);
    // Only effective access is required for an OWNER key; a contractual grant is not (manual access is legitimate for it).
    if (!authz.ok && authz.reason !== "CONTRACTUAL_GRANT_REQUIRED") {
      throw new ApplicationAccessRequiredError(`The organization has no active access to ${credential.applicationKey}`);
    }
    return;
  }

  // INTEGRATION_MANAGED
  const authz = await commercialAuthorization(db, credential.organizationId, credential.applicationId);
  if (!authz.ok) throw new CredentialNotAuthorizedError();
  const rows = (await db.execute(sql`
    select 1 from credential_provisioning_requests
    where id = ${credential.provisioningRequestId} and status = 'ACTIVE' and current_credential_id = ${credential.apiKeyId}
  `)) as unknown as unknown[];
  if (rows.length !== 1) throw new CredentialNotAuthorizedError();
}
