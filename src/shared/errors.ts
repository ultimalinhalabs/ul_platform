export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ValidationError extends AppError {
  constructor(message = "Invalid request") {
    super(400, "VALIDATION_ERROR", message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Insufficient permissions") {
    super(403, "FORBIDDEN", message);
  }
}

/** Fase 6 — the platform user is `disabled` (users.status); a valid IdP session is not enough. */
export class AccountDisabledError extends AppError {
  constructor(message = "This account is disabled") {
    super(403, "ACCOUNT_DISABLED", message);
  }
}

/** Fase 6 — the organization is `suspended` (organizations.status); normal operation is blocked. */
export class OrganizationSuspendedError extends AppError {
  constructor(message = "This organization is suspended") {
    super(403, "ORGANIZATION_SUSPENDED", message);
  }
}

/** Block 0 — the plan is contracted through Última Linha (proposal → contract), not self-subscribed. */
export class PlanRequiresContractError extends AppError {
  constructor(message = "This plan is contracted through Última Linha and cannot be self-subscribed") {
    super(403, "PLAN_REQUIRES_CONTRACT", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, "NOT_FOUND", message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflicting resource state") {
    super(409, "CONFLICT", message);
  }
}

/**
 * The Postgres error code, walking `.cause` chains — drizzle-orm wraps the
 * driver's raw `PostgresError` (which carries `.code` directly) inside its
 * own `DrizzleQueryError`, which does not itself expose `.code` but carries
 * the original as `.cause`. Checking only the top-level error therefore
 * silently never matches; this recurses until it finds one or runs out of
 * causes.
 */
function extractPostgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  if ("cause" in error) {
    return extractPostgresErrorCode((error as { cause: unknown }).cause);
  }
  return undefined;
}

/**
 * Detects a Postgres unique_violation (23505) — the same code `errorHandler`
 * already maps to 409 for HTTP-reached routes. Services with no HTTP write
 * path yet (environments, endpoints, integrations — see
 * modules/environments|endpoints|integrations) are called directly by
 * tests/future callers, not through that handler, so they translate this
 * themselves into a `ConflictError` at the point of insert rather than
 * letting a raw driver error escape.
 */
export function isUniqueViolationError(error: unknown): boolean {
  return extractPostgresErrorCode(error) === "23505";
}

/**
 * Block 1B — the commercial history guards (migrations 0016–0019) raise
 * SQLSTATE UL001 when a frozen record is changed; services raise the same
 * semantic error up-front so the API answers identically either way.
 */
export class CommercialRecordImmutableError extends AppError {
  constructor(message = "This commercial record can no longer be changed") {
    super(409, "COMMERCIAL_RECORD_IMMUTABLE", message);
  }
}

/** UL001 — a commercial record frozen by a database trigger. */
export function isCommercialImmutableError(error: unknown): boolean {
  return extractPostgresErrorCode(error) === "UL001";
}

/** 23514 — check_violation (including business rules enforced by commercial triggers). */
export function isCheckViolationError(error: unknown): boolean {
  return extractPostgresErrorCode(error) === "23514";
}

/** 23503 — foreign_key_violation (e.g. history that RESTRICTs a delete). */
export function isForeignKeyViolationError(error: unknown): boolean {
  return extractPostgresErrorCode(error) === "23503";
}
