import { and, eq } from "drizzle-orm";
import { env } from "../../config/env.js";
import { db } from "../../db/index.js";
import { memberships, roles, users } from "../../db/schema/index.js";
import type { PaymentInstructionsText } from "../email/templates.js";

/** Helpers shared by the commercial emails (migrations 0026–0028). */

type Executor = Pick<typeof db, "select">;

/** The organization's active OWNERs — the people a contract concerns (contracts are OWNER-only in the client). */
export async function ownerEmails(executor: Executor, organizationId: string): Promise<string[]> {
  const rows = await executor
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.status, "active"), eq(roles.key, "OWNER")));
  return [...new Set(rows.map((r) => r.email).filter((e): e is string => !!e).map((e) => e.toLowerCase()))];
}

const trim = (url: string) => url.replace(/\/+$/, "");
export const clientContractUrl = (organizationId: string, contractId: string) => `${trim(env.UL_CLIENT_URL)}/app/o/${organizationId}/contracts/${contractId}`;
export const consoleContractUrl = (contractId: string) => `${trim(env.UL_CONSOLE_URL)}/contracts/${contractId}`;

/** Owner decision 2026-10-16 — IBAN transfer or Multicaixa Express; a method whose data is not configured is not offered. */
export function paymentMethodsConfigured(): PaymentInstructionsText {
  return {
    ...(env.PAYMENT_IBAN ? { bankTransfer: { bankName: env.PAYMENT_BANK_NAME, accountHolder: env.PAYMENT_ACCOUNT_HOLDER, iban: env.PAYMENT_IBAN } } : {}),
    ...(env.PAYMENT_MCX_EXPRESS_NUMBER ? { multicaixaExpress: { number: env.PAYMENT_MCX_EXPRESS_NUMBER } } : {}),
  };
}

export const renewalReference = (contractNumber: string, sequence: number) => `${contractNumber}-R${sequence}`;
