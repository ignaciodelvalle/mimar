// ---------------------------------------------------------------------------
// Credential claim tiering (ADR-7, jurisdiction-compliance spec CT1/CT2).
//
// The public credential MUST NOT imply state registration in a province with
// no registry rule backing that claim. The jurisdiction's registry mandate is
// expressed through the `microchip_required` business rule (the
// identification/registration rule): when a row RESOLVES for the pet's
// jurisdiction and the obligation applies (the OR5 gate — an explicit
// `mandatory` tier, or a pre-tier row whose payload requires the chip), the
// credential keeps its full, unqualified "Identidad registrada" language.
//
// When NO row resolves anywhere in the cascade — or the resolved tier says
// the jurisdiction does not regulate — the heading scopes the claim to miMAR
// ("Identidad registrada en miMAR"): the same qualified claim the landing
// chrome already makes for every /p page ("the only claim this chrome can
// honestly make", AppShell variant=landing). Registration IN miMAR is true
// for every credential; registration with THE registry needs a rule to back
// it.
//
// The resolver's DEFAULT payload ({required: true}) deliberately does NOT
// back the full claim: it is a product stopgap — not a law of the pet's
// province — hence the matchedRow requirement. (RG2, the flip of that default
// to {required: false}, is PARKED: ratified by the PO but reverted in
// 88689beb until an ar-v2 baseline carries microchip rows; restore with
// `git cherry-pick 96277c05`. Either way the default cannot back this claim.)
//
// THE RULE IS NOT THE ANIMAL (T6 review M4). A resolved mandatory rule proves
// an obligation EXISTS in the jurisdiction; it says NOTHING about whether THIS
// pet is in any registry. Keyed on the rule alone, a CABA pet with no
// identifier on record rendered the unqualified "Identidad registrada" directly
// above "Microchip: No", while a fully chipped pet in a jurisdiction with no
// rule got the qualified "en miMAR" — the claim was exactly inverted. The full
// claim now needs BOTH: a registry-backing rule AND an identifier actually on
// record for this animal.
//
// Pure module: the caller resolves the rule and reads the pet's canonical
// identifiers (RSC), this only maps them to language.
// ---------------------------------------------------------------------------

import type { RequirementLevel } from "@/db/schema";
import { microchipObligationApplies } from "@/lib/domain/business-rules-defaults";

/** Full claim — preserved verbatim for mandatory + registry-backed (CT2). */
export const IDENTITY_HEADING_REGISTRY_BACKED = "Identidad registrada";
/** Neutral claim — scoped to miMAR, no state-registration implication (CT1). */
export const IDENTITY_HEADING_NEUTRAL = "Identidad registrada en miMAR";

export type CredentialRegistryClaim = {
  /**
   * True only when a registry rule row resolved, the obligation applies, AND
   * the pet has an identifier on record. All three — see the M4 note above.
   */
  registryBacked: boolean;
  /** es-AR heading for the credential's identity section. */
  identityHeading: string;
};

/**
 * The pet's own identification state.
 *
 * REQUIRED, not optional (M4): making it a parameter every call site must
 * supply is the fence. An optional argument would have let the public page keep
 * claiming state registration for an unidentified animal by simply not passing
 * it — which is precisely the defect this closes.
 */
export type CredentialIdentification = {
  /** A canonical active microchip identifier is on record. */
  hasMicrochip: boolean;
  /** A canonical active tattoo identifier is on record. */
  hasTattoo: boolean;
};

export function deriveCredentialRegistryClaim(
  rule: {
    requirementLevel?: RequirementLevel | null;
    payload: { required?: boolean };
    matchedRow: unknown | null;
  } | null,
  identification: CredentialIdentification,
): CredentialRegistryClaim {
  const ruleBacksRegistry =
    rule != null && rule.matchedRow != null && microchipObligationApplies(rule);
  // "Identidad registrada" is a claim about the ANIMAL's identity, so any
  // canonical identifier on record satisfies the second half — the microchip
  // rule is only how the jurisdiction's registry mandate is EXPRESSED (ADR-7),
  // not the only identifier the credential shows.
  const identified = identification.hasMicrochip || identification.hasTattoo;
  const registryBacked = ruleBacksRegistry && identified;
  return {
    registryBacked,
    identityHeading: registryBacked ? IDENTITY_HEADING_REGISTRY_BACKED : IDENTITY_HEADING_NEUTRAL,
  };
}
