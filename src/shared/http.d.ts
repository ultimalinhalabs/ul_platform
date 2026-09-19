export interface AuthenticatedActor {
  userId: string;
  email: string | undefined;
}

export interface OrganizationMembershipContext {
  organizationId: string;
  membershipId: string;
  roleId: string;
  roleKey: string;
}

/**
 * A verified machine credential (API key), never a human — see
 * modules/apiKeys/service.ts. `req.auth` and `req.service` are mutually
 * exclusive: `authenticate` sets exactly one of them per request.
 * Existing human-only routes are automatically closed to service
 * credentials without any change to those routes — they all check
 * `req.auth`/`req.membership`, which stay unset for a service request.
 */
export interface ServiceAuthContext {
  apiKeyId: string;
  applicationId: string;
  applicationKey: string;
  organizationId: string | null;
  /** Persisted grants only — see modules/serviceScopes/service.ts. Never re-derived from anything client-supplied on this request. */
  scopes: string[];
}

/**
 * Resolved by `middleware/platformContext.ts` from `req.auth.userId` alone
 * — there is no route param to scope this by (unlike
 * `OrganizationMembershipContext`, which is per-:organizationId): the
 * platform has exactly one control plane, not many tenants. Presence of
 * this field means "this human is an active platform administrator"; its
 * absence never implies anything about any `req.membership` and vice versa
 * — see CLAUDE.md's Phase 13 brief "PLATFORM_ADMIN ≠ unrestricted tenant
 * access".
 */
export interface PlatformAdminContext {
  platformMembershipId: string;
  platformRoleId: string;
  platformRoleKey: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedActor;
      membership?: OrganizationMembershipContext;
      service?: ServiceAuthContext;
      platformAdmin?: PlatformAdminContext;
      /** Set by middleware/requestId.ts before any other middleware runs — see that file for the trust boundary on a client-supplied value. */
      requestId: string;
    }
  }
}

export {};
