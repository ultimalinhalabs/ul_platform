import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { users } from "./users.js";

/**
 * Block 1A — versioned legal terms. The platform never authors legal text:
 * content is provided and approved by Última Linha; the code only stores
 * versions and their hash. Once `approved`, the content (key, version, title,
 * body, body_sha256) is frozen by a trigger (migration 0016) — a change is a
 * new version. `body_sha256` must equal sha256(body) (checked by the same
 * trigger). Only an `approved` template can be attached to a proposal version
 * that is sent (enforced at send time, migration 0017).
 */
export const commercialTermsTemplates = pgTable(
  "commercial_terms_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    bodySha256: text("body_sha256").notNull(),
    status: text("status", { enum: ["draft", "approved", "retired"] })
      .notNull()
      .default("draft"),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "restrict" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (table) => [
    unique("commercial_terms_templates_key_version_unique").on(table.key, table.version),
    check("commercial_terms_templates_status_check", sql`${table.status} in ('draft', 'approved', 'retired')`),
    check("commercial_terms_templates_version_check", sql`${table.version} > 0`),
    check("commercial_terms_templates_key_check", sql`${table.key} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("commercial_terms_templates_sha_check", sql`${table.bodySha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "commercial_terms_templates_approval_check",
      sql`${table.status} = 'draft' or (${table.approvedBy} is not null and ${table.approvedAt} is not null)`,
    ),
  ],
);
