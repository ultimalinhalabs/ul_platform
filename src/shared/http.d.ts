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

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedActor;
      membership?: OrganizationMembershipContext;
    }
  }
}

export {};
