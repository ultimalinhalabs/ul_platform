import { env } from "../../config/env.js";
import { sha256Hex } from "./canonicalJson.js";

/**
 * Block 1C — the consent statement recorded with every acceptance
 * (`proposal_acceptances.consent_text` + `consent_sha256`). Defined and
 * versioned HERE, on the server — never taken from the client. The platform
 * does not author legal text: the official statement must be provided and
 * validated by legal counsel. Until an `approved` version is configured, the
 * only available text is explicitly TEST-ONLY and acceptance is REFUSED
 * outside development/test (fail closed). The system records technical
 * evidence of the acceptance; it makes no claim about its legal validity.
 */
export interface AcceptanceConsent {
  key: string;
  version: number;
  status: "test_only" | "approved";
  text: string;
}

export const ACCEPTANCE_CONSENT_TEST_ONLY: AcceptanceConsent = {
  key: "ul-proposal-acceptance-consent",
  version: 0,
  status: "test_only",
  text: "TEST ONLY — NÃO UTILIZAR EM PRODUÇÃO. Texto de consentimento de teste para validação técnica do fluxo de aceitação; não tem qualquer valor jurídico.",
};

/** The official, legally validated statement goes here (status "approved") once it exists. */
const APPROVED_CONSENT = null as AcceptanceConsent | null;

export function currentAcceptanceConsent(environment: { nodeEnv: string; appEnv: string } = { nodeEnv: env.NODE_ENV, appEnv: env.APP_ENV }):
  | { available: true; consent: AcceptanceConsent; sha256: string }
  | { available: false } {
  if (APPROVED_CONSENT) return { available: true, consent: APPROVED_CONSENT, sha256: sha256Hex(APPROVED_CONSENT.text) };
  const nonProduction = (environment.nodeEnv === "test" || environment.nodeEnv === "development") && environment.appEnv !== "production" && environment.appEnv !== "staging";
  if (!nonProduction) return { available: false };
  return { available: true, consent: ACCEPTANCE_CONSENT_TEST_ONLY, sha256: sha256Hex(ACCEPTANCE_CONSENT_TEST_ONLY.text) };
}
