/**
 * Block 1C — the legal identity of the platform's contracting party (Última
 * Linha), as it enters every contract. Source of truth: two official
 * documents provided by the owner — the "Pacto de Sociedade Unipessoal por
 * Quotas" and the "Comprovativo de Registo de Contribuinte (NIF)". Only the
 * data those documents confirm is here; nothing is inferred or invented
 * (no phone, legal email, bank details, VAT status, …). The manager's
 * identity-card number is deliberately NOT included: it is personal data
 * the contract photograph does not need.
 *
 * Versioned: a contract copies the WHOLE object into its version snapshot
 * (`parties.provider`), so a later change of these data (new version below)
 * never alters an existing contract. A database-backed, versioned store
 * would need a migration — documented gap; a typed code constant is the MVP.
 */
export interface PlatformLegalIdentity {
  schema: "ul.legal-identity/1";
  version: number;
  effectiveFrom: string;
  sources: string[];
  legalName: string;
  legalForm: string;
  nif: string;
  registeredAddress: string;
  representative: { name: string; role: string };
  representationRule: string;
}

export const PLATFORM_LEGAL_IDENTITY_V1: PlatformLegalIdentity = {
  schema: "ul.legal-identity/1",
  version: 1,
  effectiveFrom: "2026-10-06",
  sources: ["Pacto de Sociedade Unipessoal por Quotas", "Comprovativo de Registo de Contribuinte (NIF)"],
  legalName: "AIRTON ALEXANDRE - PRESTAÇÃO DE SERVIÇOS, (SU), LDA.",
  legalForm: "Sociedade por quotas unipessoal",
  nif: "5002819481",
  registeredAddress: "Província de Luanda, Município de Maianga, Bairro Cassenda, Rua 3, casa n.º 13",
  representative: { name: "AIRTON JORGE GOUVEIA ALEXANDRE", role: "Gerente" },
  representationRule: "A sociedade obriga-se com a intervenção do gerente único.",
};

/** The identity new contracts are created with. Changing the data = add a new version and point this to it. */
export function currentPlatformLegalIdentity(): PlatformLegalIdentity {
  return structuredClone(PLATFORM_LEGAL_IDENTITY_V1);
}
