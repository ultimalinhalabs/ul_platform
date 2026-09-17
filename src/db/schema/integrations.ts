import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { applications } from "./applications.js";

/**
 * A directional, platform-level statement: "Application A is formally
 * registered to communicate with Application B" — never the reverse
 * direction unless a second row explicitly says so (see README
 * "Integrations": A→B and B→A are different rows, never implied by each
 * other, enforced by the unique index below on the ordered pair).
 *
 * This is NOT authorization. It answers "is this pair allowed to know
 * about each other at all" — a coarser, separate question from "may this
 * specific credential call this specific capability" (Service Scopes) or
 * "may this operation touch this organization's data" (organization
 * context). See README "Integration ≠ Authorization". Actual API calls
 * between products still require the target's own service-scope and
 * organization-context checks; a registered integration alone grants
 * nothing beyond appearing in Service Discovery.
 *
 * Deliberately no `organizationId`: v1 keeps integrations platform-level
 * only (CLAUDE.md's discovery prompt §22 explicitly prefers this over
 * inventing an organization-scoped integration concept without a
 * concrete need for one).
 */
export const applicationIntegrations = pgTable(
  "application_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceApplicationId: uuid("source_application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "restrict" }),
    targetApplicationId: uuid("target_application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "restrict" }),
    status: text("status", { enum: ["ACTIVE", "INACTIVE"] })
      .notNull()
      .default("ACTIVE"),
    description: text("description"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("application_integrations_source_target_unique").on(
      table.sourceApplicationId,
      table.targetApplicationId,
    ),
  ],
);
