import { z } from "zod";

/**
 * `target`/`environment` only — deliberately no `source`/`organizationId`
 * field: source identity comes exclusively from the authenticated service
 * credential (CLAUDE.md's discovery prompt §19), and discovery is not
 * organization-scoped at all (§21/§22) — accepting either field here would
 * invite a caller to believe supplying them does something.
 */
export const discoverQuerySchema = z.object({
  target: z.string().min(1),
  environment: z.string().min(1),
});
