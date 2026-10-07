# D2-B MVP — Implementation Notes

Implements the controlled MVP of [D2-B-ARCHITECTURE-REVISION.md](./D2-B-ARCHITECTURE-REVISION.md)
(UL Platform side; the Na Pista side lives in the `na-pista` repository). Production untouched.

## What exists

| Piece | Where |
|---|---|
| Credential class (`ORGANIZATION` / `INTEGRATION_MANAGED` / `PLATFORM_SERVICE` + purpose `PROVISIONER`), `PENDING` status, provisioning reference | `api_keys` (migration 0020), `src/db/schema/apiKeys.ts` |
| Provisioning request (`REQUESTED → ISSUED → ACTIVE`, `CANCELLED` / `REVOKED` / `SUPERSEDED`), invariants in DB triggers + partial unique indexes | `credential_provisioning_requests` (0020), `src/db/schema/credentialProvisioning.ts` |
| Initial request created by contract activation (same transaction) | `modules/commercial/activation.service.ts` |
| Issue / confirm / revoke / rekey / end-on-access-loss | `modules/integrationProvisioning/service.ts` |
| Commercial authorization (read-time) + runtime authorization of org-scoped credentials | `modules/integrationProvisioning/authorization.ts`, `middleware/authenticate.ts` |
| Strict (transactional, never swallowed) audit for the credential events | `recordAuditEventStrict` in `modules/audit/service.ts` |

## Endpoints

| Method / path | Caller | Notes |
|---|---|---|
| `GET /v1/service/credential-provisionings` | PROVISIONER credential | Open requests of the credential's OWN application |
| `POST /v1/service/credential-provisionings/:id/issue` | PROVISIONER credential | Body: `{ "expectedIssueCount": n }` only (strict). Returns the secret once (201) |
| `POST /v1/service/credential-provisionings/:id/confirm` | The issued (PENDING) credential | Proof of possession; idempotent |
| `GET /v1/service/me` | Any service credential (PENDING allowed) | Now also returns `credentialClass`, `purpose`, `status`, `provisioningRequestId` |
| `POST /v1/platform/credential-provisionings/:id/revoke` | PLATFORM_ADMIN (`platform.credential.manage`) | `{ "reason" }` |
| `POST /v1/platform/credential-provisionings/:id/rekey` | PLATFORM_ADMIN | Explicit recovery (lost/compromised) |
| `POST /v1/platform/credentials` | PLATFORM_ADMIN | Accepts `purpose: "PROVISIONER"` (exactly one scope: `credential.provision`) |

## Behavioural changes to existing paths

- Every org-scoped `ORGANIZATION` key now requires the organization's **effective** application access at
  use time (403 `APPLICATION_ACCESS_REQUIRED`). Before production rollout: read-only audit of active
  organization keys without effective access (architecture PDP-10).
- A REVOKED `INTEGRATION_MANAGED` credential with a valid secret answers 401 `CREDENTIAL_REVOKED`.
- Generic organization API key routes (list/detail/revoke) only see class `ORGANIZATION`; the
  platform-credential routes only class `PLATFORM_SERVICE`.
- `revokeApplicationAccess` now runs in one transaction with the end of the integration's requests and
  managed credentials.

## Deliberate MVP trade-offs

- PENDING window fixed at 10 minutes (`PENDING_CREDENTIAL_WINDOW_MS`), computed at use time.
- No scheduled rotation, no TTL on managed credentials (PDP-01 pending); `rekey` is explicit, with no
  overlap window (the predecessor is revoked when the new credential is confirmed).
- Only `NA_PISTA` has a managed integration (`INTEGRATION_APPLICATIONS`).
- A confirmation refused for commercial reasons cancels the request (a new one is needed after the
  authority is restored).
- No housekeeping job: a grant that ends by time leaves the request `ACTIVE` in storage while the runtime
  refuses the credential (existence ≠ authorization).
