// ============================================================================
// LEGAL BASELINE DATASET — ar-v1 — ⚠️ CONTENT PENDING PO/LEGAL SIGN-OFF ⚠️
// ============================================================================
//
// Row CONTENT (citations, authorities, effective dates, tiers) is a
// LEGAL-RESEARCH deliverable, not a coding artifact. Nothing in this file may
// be invented by an implementer: every row must trace to a sourced statute or
// ordinance reviewed by the PO/legal reviewer.
//
// This scaffold ships with ONLY the rows whose citations the
// jurisdiction-compliance spec/design themselves already state as established
// (the national rabies law + the CABA ordinance the product has cited since
// the original hardcoded footnote). They are still marked
// `reviewStatus: "pending_legal_review"` — inclusion here is NOT approval.
//
// The seed (scripts/seed-legal-baseline.ts) REFUSES to apply this dataset
// until:
//   1. its manifest (data/legal-baseline/ar-v1.manifest.json) matches the
//      dataset checksum,
//   2. the run carries `--approved-checksum <sha256>` matching that manifest,
//   3. a sign-off record (`--signoff-file`) approves that exact hash — written
//      only AFTER the PO records the engram decision
//      `sdd/jurisdiction-compliance/baseline-signoff`.
// Any edit to a row changes the checksum and re-closes the gate.
//
// TODO (legal research, BEFORE this dataset is considered complete):
//   - rabies_vaccination: enforcing authority + official source URL +
//     effective dates for Ley 22.953 and Ord. CABA 41.831; provincial
//     ordinances beyond CABA.
//   - sterilization: the provincial mandates (e.g. the Santa Fe mandate the
//     spec references) — NO citation is established in the spec, so NO row
//     ships until one is sourced.
//   - microchip_required: per-jurisdiction tier rows (which jurisdictions
//     actually mandate a microchip) — none established yet, so none ship.
//     NOTE: the DEFAULT tier flip (mandatory → not_regulated) is RG2,
//     ratification-gated, and NOT part of this dataset.
// ============================================================================

import type { LegalBaselineDataset } from "./schema";

export const AR_V1: LegalBaselineDataset = {
  version: "ar-v1",
  rows: [
    {
      // National rabies vaccination mandate. Citation stated by the spec
      // (obligation-rules scenario + design ADR-4): Ley 22.953 is the national
      // rabies law the product has cited since the original footnote.
      ruleKey: "rabies_vaccination",
      jurisdiction: { country: "AR", province: null, locality: null },
      requirementLevel: "mandatory",
      legalBasis: "Ley 22.953",
      authority: null, // TODO legal research: enforcing authority
      sourceUrl: null, // TODO legal research: official publication URL
      effectiveFrom: null, // TODO legal research: entry-into-force date
      rulePayload: {},
      reviewStatus: "pending_legal_review",
    },
    {
      // CABA override: adds the local ordinance on top of the national law, so
      // CABA pets see both citations and every other jurisdiction sees only
      // the national one (design ADR-4). frequency_months=12 is stated by the
      // spec's CABA resolution scenario.
      ruleKey: "rabies_vaccination",
      jurisdiction: { country: "AR", province: "CABA", locality: null },
      requirementLevel: "mandatory",
      legalBasis: "Ley 22.953 · Ord. CABA 41.831",
      authority: null, // TODO legal research: enforcing authority
      sourceUrl: null, // TODO legal research: official publication URL
      effectiveFrom: null, // TODO legal research: entry-into-force date
      rulePayload: { frequency_months: 12 },
      reviewStatus: "pending_legal_review",
    },
  ],
};
