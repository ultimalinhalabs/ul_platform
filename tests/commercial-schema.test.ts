import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import type { TransactionSql } from "postgres";
import { queryClient } from "../src/db/index.js";
import { PERMISSIONS, PLATFORM_PERMISSIONS } from "../src/db/seed/data.js";
import { seed } from "../src/db/seed/index.js";

/**
 * Block 1A — commercial domain DB foundation, exercised directly in SQL
 * against the disposable test database (guarded by src/db/testDatabaseGuard.ts
 * through src/db/index.ts). Every case runs inside a transaction that is
 * ALWAYS rolled back: commercial history is immutable by design, so tests
 * must never leave it behind. Expected failures run inside savepoints.
 * No network, no auth, no API.
 */

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const ROLLBACK = Symbol("rollback");

async function inRollback(fn: (tx: TransactionSql) => Promise<void>) {
  try {
    await queryClient.begin(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

/** Runs `fn` in a savepoint and asserts it fails with the given SQLSTATE (and optional message fragment). */
async function rejects(tx: TransactionSql, code: string, fn: (sp: TransactionSql) => Promise<unknown>, message?: RegExp) {
  let caught: { code?: string; message?: string } | undefined;
  try {
    await tx.savepoint(async (sp) => {
      await fn(sp);
    });
  } catch (error) {
    caught = error as { code?: string; message?: string };
  }
  assert.ok(caught, `expected failure with SQLSTATE ${code}, but the statement succeeded`);
  assert.equal(caught.code, code, `expected SQLSTATE ${code}, got ${caught.code}: ${caught.message}`);
  if (message) assert.match(caught.message ?? "", message);
}

type Chain = {
  userId: string;
  orgId: string;
  appId: string;
  planId: string;
  termsId: string;
  proposalId: string;
  versionId: string;
  optionId: string;
  itemId: string;
};

let seq = 0;
const number = (prefix: "P" | "C") => `UL-${prefix}-2099-${String(++seq + Math.floor(Math.random() * 1e6)).padStart(6, "0")}${seq}`;

async function user(tx: TransactionSql) {
  const id = randomUUID();
  await tx`insert into users (id, email) values (${id}, ${`b1a+${id}@test.ul-platform.invalid`})`;
  return id;
}

async function organization(tx: TransactionSql, createdBy: string) {
  const [row] = await tx`insert into organizations (name, slug, created_by) values ('B1A Test', ${`b1a-${randomUUID()}`}, ${createdBy}) returning id`;
  return row!.id as string;
}

async function approvedTerms(tx: TransactionSql, approver: string, body = "Texto de teste — não jurídico.") {
  const [row] = await tx`
    insert into commercial_terms_templates (key, version, title, body, body_sha256, status, approved_by, approved_at, created_by)
    values (${`test-terms-${randomUUID().slice(0, 8)}`}, 1, 'Termos de teste', ${body}, ${sha(body)}, 'approved', ${approver}, now(), ${approver})
    returning id`;
  return row!.id as string;
}

/** A draft proposal with one version, one option and one application_plan item (NA_PISTA/BUSINESS from the seed). */
async function draftChain(tx: TransactionSql): Promise<Chain> {
  const userId = await user(tx);
  const orgId = await organization(tx, userId);
  const [plan] = await tx`select p.id as plan_id, a.id as app_id from plans p join applications a on a.id = p.application_id where a.key = 'NA_PISTA' and p.key = 'BUSINESS'`;
  const termsId = await approvedTerms(tx, userId);
  const [proposal] = await tx`
    insert into proposals (number, prospect_company_name, recipient_name, recipient_email, organization_id, owner_user_id, created_by)
    values (${number("P")}, 'Empresa Teste', 'Destinatário', 'destinatario@example.invalid', ${orgId}, ${userId}, ${userId}) returning id`;
  const [version] = await tx`
    insert into proposal_versions (proposal_id, version_no, currency, valid_until, terms_template_id, created_by)
    values (${proposal!.id}, 1, 'AOA', now() + interval '30 days', ${termsId}, ${userId}) returning id`;
  const [option] = await tx`insert into proposal_options (version_id, name, is_recommended, total_minor) values (${version!.id}, 'Essencial', true, 25000000) returning id`;
  const [item] = await tx`
    insert into proposal_items (option_id, kind, title, application_id, plan_id, quantity, unit_price_minor, line_total_minor, billing_period, duration_months)
    values (${option!.id}, 'application_plan', 'Na Pista Business', ${plan!.app_id}, ${plan!.plan_id}, 1, 25000000, 25000000, 'monthly', 1) returning id`;
  return {
    userId,
    orgId,
    appId: plan!.app_id,
    planId: plan!.plan_id,
    termsId,
    proposalId: proposal!.id,
    versionId: version!.id,
    optionId: option!.id,
    itemId: item!.id,
  };
}

const SNAPSHOT_HASH = sha("canonical-snapshot");

async function send(tx: TransactionSql, c: Chain) {
  await tx`update proposal_versions set status = 'sent', sent_at = now(), sent_by = ${c.userId}, snapshot = '{"v":1}'::jsonb, content_sha256 = ${SNAPSHOT_HASH} where id = ${c.versionId}`;
}

async function accept(tx: TransactionSql, c: Chain) {
  const [row] = await tx`
    insert into proposal_acceptances (proposal_id, version_id, option_id, content_sha256, organization_id, accepted_by_user_id, signer_name, signer_email,
      terms_template_id, consent_text, consent_sha256, ip, user_agent, idempotency_key)
    values (${c.proposalId}, ${c.versionId}, ${c.optionId}, ${SNAPSHOT_HASH}, ${c.orgId}, ${c.userId}, 'Signatário', 'destinatario@example.invalid',
      ${c.termsId}, 'Aceito.', ${sha("Aceito.")}, '127.0.0.1', 'test-agent', ${`idem-${randomUUID()}`})
    returning id`;
  return row!.id as string;
}

async function contract(tx: TransactionSql, c: Chain, acceptanceId: string) {
  const [k] = await tx`
    insert into contracts (number, organization_id, source_acceptance_id, currency, total_minor, effective_at)
    values (${number("C")}, ${c.orgId}, ${acceptanceId}, 'AOA', 25000000, now()) returning id`;
  const [cv] = await tx`
    insert into contract_versions (contract_id, version_no, parties, snapshot, content_sha256, terms_template_id, terms_sha256, created_by)
    values (${k!.id}, 1, '{}'::jsonb, '{}'::jsonb, ${SNAPSHOT_HASH}, ${c.termsId}, ${sha("terms")}, ${c.userId}) returning id`;
  const [ci] = await tx`
    insert into contract_items (contract_version_id, source_proposal_item_id, kind, title, application_id, plan_id, quantity, unit_price_minor, line_total_minor, billing_period, duration_months)
    values (${cv!.id}, ${c.itemId}, 'application_plan', 'Na Pista Business', ${c.appId}, ${c.planId}, 1, 25000000, 25000000, 'monthly', 1) returning id`;
  return { contractId: k!.id as string, versionId: cv!.id as string, itemId: ci!.id as string };
}

before(async () => {
  await seed();
});

after(async () => {
  await queryClient.end();
});

test("permissions: 5 commercial platform permissions granted to PLATFORM_ADMIN, org commercial.read unassigned, no invoice/payment permissions", async () => {
  const keys = ["platform.commercial.read", "platform.proposal.manage", "platform.proposal.send", "platform.contract.manage", "platform.entitlement.grant"];
  for (const key of keys) assert.ok(PLATFORM_PERMISSIONS.some((p) => p.key === key), `${key} missing from seed data`);
  const granted = await queryClient`
    select p.key from platform_role_permissions rp join platform_roles r on r.id = rp.platform_role_id join platform_permissions p on p.id = rp.platform_permission_id
    where r.key = 'PLATFORM_ADMIN' and p.key = any(${keys})`;
  assert.equal(granted.length, 5);
  assert.equal((await queryClient`select 1 from platform_permissions where key in ('platform.invoice.manage', 'platform.payment.confirm')`).length, 0);
  assert.ok(PERMISSIONS.some((p) => p.key === "commercial.read"));
  const [perm] = await queryClient`select id from permissions where key = 'commercial.read'`;
  assert.ok(perm, "commercial.read must exist");
  assert.equal((await queryClient`select 1 from role_permissions where permission_id = ${perm!.id}`).length, 0, "commercial.read is not assigned to any role yet");
});

test("RLS on every commercial table, no policies; money columns are bigint; sequences exist", async () => {
  const tables = ["commercial_events", "commercial_terms_templates", "proposals", "proposal_versions", "proposal_options", "proposal_items", "proposal_access_links", "proposal_acceptances", "contracts", "contract_versions", "contract_items", "entitlement_grants"];
  const rows = await queryClient`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any(${tables})`;
  assert.equal(rows.length, tables.length);
  for (const r of rows) assert.equal(r.relrowsecurity, true, `${r.relname} must have RLS enabled`);
  assert.equal((await queryClient`select 1 from pg_policies where schemaname = 'public' and tablename = any(${tables})`).length, 0);
  const money = await queryClient`select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' and column_name like '%\_minor'`;
  assert.ok(money.length >= 6);
  for (const m of money) assert.equal(m.data_type, "bigint", `${m.table_name}.${m.column_name} must be bigint`);
  assert.equal((await queryClient`select 1 from pg_class where relkind = 'S' and relname in ('commercial_proposal_number_seq', 'commercial_contract_number_seq')`).length, 2);
});

test("proposal number is unique and well-formed; currency, quantity and line total are checked; large amounts are exact", async () => {
  await inRollback(async (tx) => {
    const c = await draftChain(tx);
    const [p] = await tx`select number from proposals where id = ${c.proposalId}`;
    await rejects(tx, "23505", (sp) => sp`insert into proposals (number, prospect_company_name, recipient_name, recipient_email, owner_user_id, created_by) values (${p!.number}, 'X', 'Y', 'y@example.invalid', ${c.userId}, ${c.userId})`);
    await rejects(tx, "23514", (sp) => sp`insert into proposals (number, prospect_company_name, recipient_name, recipient_email, owner_user_id, created_by) values ('P-1', 'X', 'Y', 'y@example.invalid', ${c.userId}, ${c.userId})`);
    for (const currency of ["aoa", "AO", "AOAA", "A1A"]) {
      await rejects(tx, "23514", (sp) => sp`update proposal_versions set currency = ${currency} where id = ${c.versionId}`);
    }
    await tx`update proposal_versions set currency = 'USD' where id = ${c.versionId}`; // not hard-coded to AOA
    for (const quantity of [0, -1]) {
      await rejects(tx, "23514", (sp) => sp`update proposal_items set quantity = ${quantity}, line_total_minor = 0 where id = ${c.itemId}`);
    }
    await rejects(tx, "23514", (sp) => sp`update proposal_items set quantity = 2, line_total_minor = 25000000 where id = ${c.itemId}`);
    await rejects(tx, "23514", (sp) => sp`update proposal_items set unit_price_minor = -1, line_total_minor = -1 where id = ${c.itemId}`);
    const big = "25000000000000"; // far beyond int32 — must round-trip exactly
    await tx`update proposal_items set quantity = 3, unit_price_minor = ${big}, line_total_minor = ${(3n * BigInt(big)).toString()} where id = ${c.itemId}`;
    const [i] = await tx`select line_total_minor::text as t from proposal_items where id = ${c.itemId}`;
    assert.equal(i!.t, (3n * BigInt(big)).toString());
    await rejects(tx, "23514", (sp) => sp`update proposal_items set kind = 'application_plan', plan_id = null where id = ${c.itemId}`);
  });
});

test("items: a plan must belong to the item's application", async () => {
  await inRollback(async (tx) => {
    const c = await draftChain(tx);
    const [other] = await tx`select a.id from applications a where a.key = 'QUALE_A_DICA'`;
    await rejects(tx, "23514", (sp) => sp`update proposal_items set application_id = ${other!.id} where id = ${c.itemId}`, /plan_id does not belong/);
  });
});

test("versions: unique (proposal, version_no); at most one draft and one sent; at most one recommended option", async () => {
  await inRollback(async (tx) => {
    const c = await draftChain(tx);
    await rejects(tx, "23505", (sp) => sp`insert into proposal_versions (proposal_id, version_no, currency, created_by) values (${c.proposalId}, 1, 'AOA', ${c.userId})`);
    await rejects(tx, "23505", (sp) => sp`insert into proposal_versions (proposal_id, version_no, currency, created_by) values (${c.proposalId}, 2, 'AOA', ${c.userId})`); // second draft
    await rejects(tx, "23505", (sp) => sp`insert into proposal_options (version_id, name, is_recommended) values (${c.versionId}, 'Advanced', true)`);
    await tx`insert into proposal_options (version_id, name, is_recommended) values (${c.versionId}, 'Advanced', false)`;
    await send(tx, c);
    const [v2] = await tx`insert into proposal_versions (proposal_id, version_no, currency, valid_until, terms_template_id, created_by) values (${c.proposalId}, 2, 'AOA', now() + interval '30 days', ${c.termsId}, ${c.userId}) returning id`;
    await tx`insert into proposal_options (version_id, name) values (${v2!.id}, 'Essencial')`;
    await rejects(tx, "23505", (sp) => sp`update proposal_versions set status = 'sent', sent_at = now(), sent_by = ${c.userId}, snapshot = '{}'::jsonb, content_sha256 = ${SNAPSHOT_HASH} where id = ${v2!.id}`);
    await tx`update proposal_versions set status = 'superseded' where id = ${c.versionId}`;
    await tx`update proposal_versions set status = 'sent', sent_at = now(), sent_by = ${c.userId}, snapshot = '{}'::jsonb, content_sha256 = ${SNAPSHOT_HASH} where id = ${v2!.id}`;
  });
});

test("versions: created as draft only; sending needs approved terms and at least one option", async () => {
  await inRollback(async (tx) => {
    const c = await draftChain(tx);
    await rejects(tx, "23514", (sp) => sp`insert into proposal_versions (proposal_id, version_no, status, currency, sent_at, sent_by, snapshot, content_sha256, terms_template_id, valid_until, created_by) values (${c.proposalId}, 9, 'sent', 'AOA', now(), ${c.userId}, '{}'::jsonb, ${SNAPSHOT_HASH}, ${c.termsId}, now() + interval '1 day', ${c.userId})`);
    const draftBody = "Rascunho.";
    const [draftTerms] = await tx`insert into commercial_terms_templates (key, version, title, body, body_sha256, created_by) values ('draft-terms', 1, 'Rascunho', ${draftBody}, ${sha(draftBody)}, ${c.userId}) returning id`;
    await tx`update proposal_versions set terms_template_id = ${draftTerms!.id} where id = ${c.versionId}`;
    await rejects(tx, "23514", (sp) => send(sp, c), /approved terms/);
    await tx`update proposal_versions set terms_template_id = ${c.termsId} where id = ${c.versionId}`;
    await tx`delete from proposal_options where version_id = ${c.versionId}`;
    await rejects(tx, "23514", (sp) => send(sp, c), /at least one option/);
  });
});

test("a sent version is immutable: content, options and items are frozen; only sent -> superseded | withdrawn", async () => {
  await inRollback(async (tx) => {
    const c = await draftChain(tx);
    await send(tx, c);
    await rejects(tx, "UL001", (sp) => sp`update proposal_versions set summary = 'changed' where id = ${c.versionId}`);
    await rejects(tx, "UL001", (sp) => sp`update proposal_versions set snapshot = '{"v":2}'::jsonb where id = ${c.versionId}`);
    await rejects(tx, "UL001", (sp) => sp`delete from proposal_versions where id = ${c.versionId}`);
    await rejects(tx, "UL001", (sp) => sp`update proposal_options set total_minor = 1 where id = ${c.optionId}`);
    await rejects(tx, "UL001", (sp) => sp`insert into proposal_options (version_id, name) values (${c.versionId}, 'Nova')`);
    await rejects(tx, "UL001", (sp) => sp`delete from proposal_options where id = ${c.optionId}`);
    await rejects(tx, "UL001", (sp) => sp`update proposal_items set title = 'x' where id = ${c.itemId}`);
    await rejects(tx, "UL001", (sp) => sp`delete from proposal_items where id = ${c.itemId}`);
    await rejects(tx, "UL001", (sp) => sp`update proposal_versions set status = 'draft' where id = ${c.versionId}`);
    await tx`update proposal_versions set status = 'withdrawn' where id = ${c.versionId}`;
    await rejects(tx, "UL001", (sp) => sp`update proposal_versions set status = 'sent' where id = ${c.versionId}`);
  });
});

test("a draft version (with options/items) can be discarded; proposals themselves are never deleted", async () => {
  await inRollback(async (tx) => {
    const c = await draftChain(tx);
    await tx`delete from proposal_versions where id = ${c.versionId}`;
    assert.equal((await tx`select 1 from proposal_items where id = ${c.itemId}`).length, 0);
    await rejects(tx, "UL001", (sp) => sp`delete from proposals where id = ${c.proposalId}`);
    await rejects(tx, "UL001", (sp) => sp`truncate proposals cascade`);
  });
});

test("access links: token hash unique and hex-only, never deleted, identity and revocation final", async () => {
  await inRollback(async (tx) => {
    const c = await draftChain(tx);
    const token = sha(randomBytes(32).toString("base64url"));
    const [link] = await tx`insert into proposal_access_links (proposal_id, token_sha256, recipient_email, expires_at, created_by) values (${c.proposalId}, ${token}, 'destinatario@example.invalid', now() + interval '30 days', ${c.userId}) returning id`;
    await rejects(tx, "23505", (sp) => sp`insert into proposal_access_links (proposal_id, token_sha256, recipient_email, expires_at, created_by) values (${c.proposalId}, ${token}, 'x@example.invalid', now() + interval '1 day', ${c.userId})`);
    await rejects(tx, "23514", (sp) => sp`insert into proposal_access_links (proposal_id, token_sha256, recipient_email, expires_at, created_by) values (${c.proposalId}, 'plain-token-not-a-hash', 'x@example.invalid', now() + interval '1 day', ${c.userId})`);
    await tx`update proposal_access_links set view_count = view_count + 1, first_viewed_at = now(), last_viewed_at = now() where id = ${link!.id}`;
    await rejects(tx, "UL001", (sp) => sp`update proposal_access_links set token_sha256 = ${sha("other")} where id = ${link!.id}`);
    await tx`update proposal_access_links set revoked_at = now(), revoked_by = ${c.userId} where id = ${link!.id}`;
    await rejects(tx, "UL001", (sp) => sp`update proposal_access_links set revoked_at = null, revoked_by = null where id = ${link!.id}`);
    await rejects(tx, "UL001", (sp) => sp`delete from proposal_access_links where id = ${link!.id}`);
  });
});

test("acceptance: must match the exact sent version/option/hash/terms; one per proposal; idempotency key unique; append-only", async () => {
  await inRollback(async (tx) => {
    const c = await draftChain(tx);
    await rejects(tx, "23514", (sp) => accept(sp, c), /currently sent/); // still a draft
    await send(tx, c);
    await rejects(tx, "23514", (sp) => sp`insert into proposal_acceptances (proposal_id, version_id, option_id, content_sha256, organization_id, accepted_by_user_id, signer_name, signer_email, terms_template_id, consent_text, consent_sha256, idempotency_key) values (${c.proposalId}, ${c.versionId}, ${c.optionId}, ${sha("tampered")}, ${c.orgId}, ${c.userId}, 'S', 's@example.invalid', ${c.termsId}, 'Aceito.', ${sha("Aceito.")}, ${`idem-${randomUUID()}`})`, /hash/);
    const acceptanceId = await accept(tx, c);
    await rejects(tx, "23505", (sp) => accept(sp, c)); // second acceptance of the same proposal
    await rejects(tx, "UL001", (sp) => sp`update proposal_acceptances set signer_name = 'Outro' where id = ${acceptanceId}`);
    await rejects(tx, "UL001", (sp) => sp`delete from proposal_acceptances where id = ${acceptanceId}`);
    await rejects(tx, "UL001", (sp) => sp`truncate proposal_acceptances cascade`);
  });
});

test("contracts: one per acceptance, organization must be the accepting one, never deleted; versions and items append-only", async () => {
  await inRollback(async (tx) => {
    const c = await draftChain(tx);
    await send(tx, c);
    const acceptanceId = await accept(tx, c);
    const otherOrg = await organization(tx, c.userId);
    await rejects(tx, "23514", (sp) => sp`insert into contracts (number, organization_id, source_acceptance_id, currency, total_minor, effective_at) values (${number("C")}, ${otherOrg}, ${acceptanceId}, 'AOA', 1, now())`, /accepting organization/);
    const k = await contract(tx, c, acceptanceId);
    await rejects(tx, "23505", (sp) => sp`insert into contracts (number, organization_id, source_acceptance_id, currency, total_minor, effective_at) values (${number("C")}, ${c.orgId}, ${acceptanceId}, 'AOA', 1, now())`);
    await tx`update contracts set current_version_id = ${k.versionId} where id = ${k.contractId}`;
    await tx`update contracts set status = 'active' where id = ${k.contractId}`; // status changes belong to (future) services
    await rejects(tx, "23514", (sp) => sp`update contracts set status = 'paused' where id = ${k.contractId}`);
    await rejects(tx, "UL001", (sp) => sp`update contracts set organization_id = ${otherOrg} where id = ${k.contractId}`);
    await rejects(tx, "UL001", (sp) => sp`delete from contracts where id = ${k.contractId}`);
    await rejects(tx, "UL001", (sp) => sp`update contract_versions set snapshot = '{"x":1}'::jsonb where id = ${k.versionId}`);
    await rejects(tx, "UL001", (sp) => sp`delete from contract_versions where id = ${k.versionId}`);
    await rejects(tx, "UL001", (sp) => sp`update contract_items set unit_price_minor = 1, line_total_minor = 1 where id = ${k.itemId}`);
    await rejects(tx, "UL001", (sp) => sp`delete from contract_items where id = ${k.itemId}`);
  });
});

test("deleting an organization never erases commercial history (FK RESTRICT)", async () => {
  await inRollback(async (tx) => {
    const withProposal = await draftChain(tx);
    await rejects(tx, "23503", (sp) => sp`delete from organizations where id = ${withProposal.orgId}`);
    const c = await draftChain(tx);
    await tx`update proposals set organization_id = null where id = ${c.proposalId}`;
    await send(tx, c);
    const acceptanceId = await accept(tx, c);
    await contract(tx, c, acceptanceId);
    await rejects(tx, "23503", (sp) => sp`delete from organizations where id = ${c.orgId}`);
    await rejects(tx, "23503", (sp) => sp`delete from users where id = ${c.userId}`);
  });
});

test("entitlement grants: one per contract item, one ACTIVE per (organization, application), born planned, final once expired/revoked", async () => {
  await inRollback(async (tx) => {
    const c = await draftChain(tx);
    await send(tx, c);
    const acceptanceId = await accept(tx, c);
    const k = await contract(tx, c, acceptanceId);
    const insertGrant = (sp: TransactionSql, itemId: string, status = "planned") =>
      sp`insert into entitlement_grants (contract_id, contract_item_id, organization_id, application_id, plan_id, status) values (${k.contractId}, ${itemId}, ${c.orgId}, ${c.appId}, ${c.planId}, ${status}) returning id`;
    await rejects(tx, "23514", (sp) => insertGrant(sp, k.itemId, "active"), /planned/);
    const [grant] = await insertGrant(tx, k.itemId);
    await rejects(tx, "23505", (sp) => insertGrant(sp, k.itemId));
    const [sub] = await tx`insert into subscriptions (organization_id, plan_id) values (${c.orgId}, ${c.planId}) returning id`;
    await tx`update entitlement_grants set status = 'active', activated_at = now(), activated_by = ${c.userId}, subscription_id = ${sub!.id} where id = ${grant!.id}`;
    // a second ACTIVE grant for the same organization/application is impossible
    const [cv2] = await tx`select contract_version_id from contract_items where id = ${k.itemId}`;
    const [item2] = await tx`insert into contract_items (contract_version_id, kind, title, application_id, plan_id, quantity, unit_price_minor, line_total_minor, billing_period) values (${cv2!.contract_version_id}, 'application_plan', 'Outro', ${c.appId}, ${c.planId}, 1, 0, 0, 'one_time') returning id`;
    const [grant2] = await insertGrant(tx, item2!.id);
    await rejects(tx, "23505", (sp) => sp`update entitlement_grants set status = 'active', activated_at = now(), activated_by = ${c.userId}, subscription_id = ${sub!.id} where id = ${grant2!.id}`);
    await rejects(tx, "UL001", (sp) => sp`update entitlement_grants set status = 'planned' where id = ${grant!.id}`);
    await rejects(tx, "UL001", (sp) => sp`update entitlement_grants set organization_id = ${c.orgId}, plan_id = null where id = ${grant!.id}`);
    await tx`update entitlement_grants set status = 'revoked', revoked_at = now(), revoked_by = ${c.userId}, revoke_reason = 'teste' where id = ${grant!.id}`;
    await rejects(tx, "UL001", (sp) => sp`update entitlement_grants set revoke_reason = 'outro' where id = ${grant!.id}`);
    await rejects(tx, "UL001", (sp) => sp`delete from entitlement_grants where id = ${grant!.id}`);
  });
});

test("commercial events are append-only; idempotency key unique; event type and actor shape checked", async () => {
  await inRollback(async (tx) => {
    const u = await user(tx);
    const key = `evt-${randomUUID()}`;
    const [e] = await tx`insert into commercial_events (aggregate_type, aggregate_id, event_type, actor_type, actor_user_id, idempotency_key) values ('proposal', ${randomUUID()}, 'proposal.created', 'platform_admin', ${u}, ${key}) returning id`;
    await rejects(tx, "23505", (sp) => sp`insert into commercial_events (aggregate_type, aggregate_id, event_type, actor_type, actor_user_id, idempotency_key) values ('proposal', ${randomUUID()}, 'proposal.created', 'platform_admin', ${u}, ${key})`);
    await rejects(tx, "23514", (sp) => sp`insert into commercial_events (aggregate_type, aggregate_id, event_type, actor_type) values ('proposal', ${randomUUID()}, 'Proposal Created', 'system')`);
    await rejects(tx, "23514", (sp) => sp`insert into commercial_events (aggregate_type, aggregate_id, event_type, actor_type) values ('invoice', ${randomUUID()}, 'invoice.created', 'system')`);
    await rejects(tx, "23514", (sp) => sp`insert into commercial_events (aggregate_type, aggregate_id, event_type, actor_type) values ('proposal', ${randomUUID()}, 'proposal.sent', 'user')`);
    await tx`insert into commercial_events (aggregate_type, aggregate_id, event_type, actor_type) values ('proposal', ${randomUUID()}, 'proposal.viewed', 'public_link')`;
    await rejects(tx, "UL001", (sp) => sp`update commercial_events set payload = '{"x":1}'::jsonb where id = ${e!.id}`);
    await rejects(tx, "UL001", (sp) => sp`delete from commercial_events where id = ${e!.id}`);
    await rejects(tx, "UL001", (sp) => sp`truncate commercial_events`);
  });
});

test("terms: body hash must match; approved content is immutable (only approved -> retired); approved terms are never deleted", async () => {
  await inRollback(async (tx) => {
    const u = await user(tx);
    await rejects(tx, "23514", (sp) => sp`insert into commercial_terms_templates (key, version, title, body, body_sha256, created_by) values ('t-bad', 1, 'T', 'corpo', ${sha("outro")}, ${u})`, /sha256/);
    await rejects(tx, "23514", (sp) => sp`insert into commercial_terms_templates (key, version, title, body, body_sha256, status, created_by) values ('t-noapprover', 1, 'T', 'corpo', ${sha("corpo")}, 'approved', ${u})`);
    const [draft] = await tx`insert into commercial_terms_templates (key, version, title, body, body_sha256, created_by) values ('t-draft', 1, 'T', 'corpo', ${sha("corpo")}, ${u}) returning id`;
    await tx`update commercial_terms_templates set body = 'corpo 2', body_sha256 = ${sha("corpo 2")} where id = ${draft!.id}`; // drafts are editable
    await rejects(tx, "23505", (sp) => sp`insert into commercial_terms_templates (key, version, title, body, body_sha256, created_by) values ('t-draft', 1, 'T', 'x', ${sha("x")}, ${u})`);
    const termsId = await approvedTerms(tx, u);
    await rejects(tx, "UL001", (sp) => sp`update commercial_terms_templates set title = 'Outro' where id = ${termsId}`);
    await rejects(tx, "UL001", (sp) => sp`update commercial_terms_templates set body = 'novo', body_sha256 = ${sha("novo")} where id = ${termsId}`);
    await rejects(tx, "UL001", (sp) => sp`update commercial_terms_templates set status = 'draft' where id = ${termsId}`);
    await rejects(tx, "UL001", (sp) => sp`delete from commercial_terms_templates where id = ${termsId}`);
    await tx`update commercial_terms_templates set status = 'retired' where id = ${termsId}`;
    await rejects(tx, "UL001", (sp) => sp`update commercial_terms_templates set status = 'approved' where id = ${termsId}`);
    await tx`delete from commercial_terms_templates where id = ${draft!.id}`; // only drafts can be deleted
  });
});
