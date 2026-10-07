import { pgSequence } from "drizzle-orm/pg-core";

/**
 * Block 1A — human-facing document numbers (UL-P-YYYY-NNNNNN for proposals,
 * UL-C-YYYY-NNNNNN for contracts), formatted by the commercial services.
 * Sequences may leave gaps (a rolled-back transaction consumes a value) —
 * acceptable for proposals and contracts; fiscal documents (invoices) must
 * NOT use these (their numbering belongs to certified invoicing, later).
 */
export const commercialProposalNumberSeq = pgSequence("commercial_proposal_number_seq", { startWith: 1, increment: 1 });
export const commercialContractNumberSeq = pgSequence("commercial_contract_number_seq", { startWith: 1, increment: 1 });
