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

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedActor;
      membership?: OrganizationMembershipContext;
      service?: ServiceAuthContext;
    }
  }
}

export {};
