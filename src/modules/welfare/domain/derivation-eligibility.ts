// Pure rule: which organization types may RECEIVE a derived welfare report and
// act on it (take / note / return). Zero external imports — pure domain logic.
//
// A welfare report is derived by the government to an external organization for
// field follow-up. Two coupled gates read this single set so they can never
// drift apart:
//   1. deriveWelfareToOrgAction   — restricts the derivation TARGET;
//   2. requireOrgInterventionAccess — mirrors it so the intervention surface
//      (take / note / return on a derived report) matches the target set.
//
// Eligible org types:
//   - shelter / rescue_network — custody orgs that run field rehoming follow-up;
//   - sanitary_authority       — a regulator is the natural fiscalización
//     recipient of a welfare derivation (#48, PO-approved). Its members reach
//     the same recibidos inbox + intervention actions, which are gated by
//     membership role, not org_type (see app/org/[orgToken]/maltrato/recibidos).
//
// clinic / other are NOT eligible — they neither run custody rehoming nor hold a
// fiscalización mandate.

export const WELFARE_DERIVATION_ORG_TYPES = [
  "shelter",
  "rescue_network",
  "sanitary_authority",
] as const;

export type WelfareDerivationOrgType = (typeof WELFARE_DERIVATION_ORG_TYPES)[number];

const WELFARE_DERIVATION_ORG_TYPE_SET: ReadonlySet<string> = new Set(WELFARE_DERIVATION_ORG_TYPES);

/**
 * Returns true iff an organization of `orgType` may receive a derived welfare
 * report and act on it. Used by both the derivation-target gate and the
 * intervention-access mirror so the two never diverge.
 */
export function canReceiveDerivedWelfare(orgType: string): boolean {
  return WELFARE_DERIVATION_ORG_TYPE_SET.has(orgType);
}
