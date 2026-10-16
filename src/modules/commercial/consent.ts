import { env } from "../../config/env.js";
import { sha256Hex } from "./canonicalJson.js";

/**
 * Block 1C — the consent statement recorded with every acceptance
 * (`proposal_acceptances.consent_text` + `consent_sha256`). Defined and
 * versioned HERE, on the server — never taken from the client. The platform
 * does not author legal text: the official statement must be provided and
 * validated by legal counsel. Approved statements are bound to a terms family
 * (below); for any other terms the only available text is explicitly TEST-ONLY
 * and acceptance is REFUSED outside development/test (fail closed). The system records technical
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

/**
 * Owner-approved statement (2026-10-15) for the Na Pista standard subscription terms (Annex A of the pilot
 * specification). It names those terms, so it applies ONLY to proposals whose terms template belongs to that family
 * (key `np-tos-…`, e.g. `np-tos-001`); any other terms keep the fail-closed rule below until their own statement is
 * approved. Changing the text means a new version (the hash is recorded with every acceptance).
 */
export const NA_PISTA_SUBSCRIPTION_CONSENT_V1: AcceptanceConsent = {
  key: "ul-na-pista-subscription-consent",
  version: 1,
  status: "approved",
  text: "Declaro que tenho poderes para representar a organização indicada, que li e aceito os Termos Padrão de Subscrição — Na Pista (versão indicada) e o resumo contratual apresentado, e que compreendo que o acesso só é ativado após a confirmação do pagamento.",
};

const APPROVED_CONSENTS: { termsKeyPrefix: string; consent: AcceptanceConsent }[] = [{ termsKeyPrefix: "np-tos-", consent: NA_PISTA_SUBSCRIPTION_CONSENT_V1 }];

/** The statement for a proposal whose terms template has `termsKey`: the approved one of its family, else test-only outside production. */
export function currentAcceptanceConsent(
  termsKey: string | null | undefined,
  environment: { nodeEnv: string; appEnv: string } = { nodeEnv: env.NODE_ENV, appEnv: env.APP_ENV },
): { available: true; consent: AcceptanceConsent; sha256: string } | { available: false } {
  const approved = termsKey ? APPROVED_CONSENTS.find((c) => termsKey.startsWith(c.termsKeyPrefix)) : undefined;
  if (approved) return { available: true, consent: approved.consent, sha256: sha256Hex(approved.consent.text) };
  const nonProduction = (environment.nodeEnv === "test" || environment.nodeEnv === "development") && environment.appEnv !== "production" && environment.appEnv !== "staging";
  if (!nonProduction) return { available: false };
  return { available: true, consent: ACCEPTANCE_CONSENT_TEST_ONLY, sha256: sha256Hex(ACCEPTANCE_CONSENT_TEST_ONLY.text) };
}
