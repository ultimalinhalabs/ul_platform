import { getApplicationRecord } from "../applications/service.js";
import { getEndpointRecord } from "../endpoints/service.js";
import { getEnvironmentRecord } from "../environments/service.js";
import { getIntegrationRecord } from "../integrations/service.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";

/**
 * "Where do I reach Application B" — never a proxy (CLAUDE.md's discovery
 * prompt §3: UL Platform tells a caller an address, it never forwards the
 * caller's traffic). Deliberately not organization-scoped: discovering an
 * endpoint answers nothing about which of that application's organizations
 * the caller may then act on — that remains entirely the target
 * application's own authorization to enforce (§21).
 *
 * Two distinct rejection shapes, mirroring the same split already used for
 * Service Scopes:
 *  - `NotFoundError` (404) for "there is currently nothing to find" —
 *    unknown/inactive target application, unknown/inactive environment,
 *    no active endpoint. Deliberately uniform: a caller doesn't need to
 *    know *why* an address isn't available right now, only that it isn't.
 *  - `ForbiddenError` (403) for exactly one thing: no registered, ACTIVE
 *    integration from source to target. This is the one authorization
 *    boundary discovery itself enforces (§16) — it does NOT check any
 *    Service Scope; that remains the *target* application's own job once
 *    the source actually calls it (§31), a deliberately separate concern.
 */
export async function discoverService(input: {
  sourceApplicationKey: string;
  targetApplicationKey: string;
  environmentKey: string;
}): Promise<{ application: { key: string }; environment: string; endpoint: { type: string; baseUrl: string } }> {
  const target = await getApplicationRecord(input.targetApplicationKey);
  if (target.status !== "ACTIVE") {
    throw new NotFoundError(`Application "${input.targetApplicationKey}" is not currently discoverable`);
  }

  const source = await getApplicationRecord(input.sourceApplicationKey);

  const integration = await getIntegrationRecord(source.id, target.id).catch(() => null);
  if (!integration || integration.status !== "ACTIVE") {
    throw new ForbiddenError(
      `"${input.sourceApplicationKey}" is not registered to discover "${input.targetApplicationKey}"`,
    );
  }

  const environment = await getEnvironmentRecord(target.id, input.environmentKey);
  if (environment.status !== "ACTIVE") {
    throw new NotFoundError(`Environment "${input.environmentKey}" is not currently active`);
  }

  const endpoint = await getEndpointRecord(environment.id, "API");
  if (endpoint.status !== "ACTIVE") {
    throw new NotFoundError(`No active API endpoint for "${input.targetApplicationKey}"/${input.environmentKey}`);
  }

  return {
    application: { key: target.key },
    environment: environment.key,
    endpoint: { type: endpoint.type, baseUrl: endpoint.baseUrl },
  };
}
