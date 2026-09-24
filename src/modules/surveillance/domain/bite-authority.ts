// Who may open a rabies observation on somebody else's animal.
//
// WHY THIS EXISTS (H1, top-10 review 2026-08-22)
// ---------------------------------------------------------------------------
// `reportBiteFromOrgAction` was gated by ONE fact: the caller holds the
// `bite.report` capability in some organization. Creating an organization asks
// for a DNI that nothing verifies and makes the creator its admin, so that one
// fact was reachable by any self-registered citizen in about a minute. With it,
// and the DIM token off a collar, they could declare that a stranger's dog bit
// somebody: red banner on the public credential, alert to the pet's sanitary
// authorities, rehome and adoption blocked — and since 2026-08-17 the owner
// cannot lift it, only a professional or the State can.
//
// Two skeptics walked the chain independently and neither found a guard the
// original author had merely overlooked: there was none. The sibling channel
// (welfare derivation to an org) already demands `organization.verified`; the
// bite report was the only consequential org write with neither a verification
// gate nor a relationship gate.
//
// THE RULE IS A CONJUNCTION OF TWO FACTS, AND THE SECOND IS A DISJUNCTION
//
//   verified  AND  (attended/held this animal  OR  works where the bite happened)
//
// `verified` alone is not enough: a verified shelter in Ushuaia would still be
// able to open an observation on a pet in Salta it has never seen. A
// relationship alone is not enough either: an unverified "organization" would
// still be able to report the animal it claims to be holding.
//
// The second half MUST be a disjunction, because a real flow dies otherwise: a
// verified shelter reporting a bite by an animal it does NOT hold — someone
// else's dog bit a volunteer at its door — has no attendance and no custody row
// for that pet. Its standing comes from the INCIDENT being inside the zone it
// works in. That is what `organization_coverage` already models, so this reads
// it through lib/domain/org-coverage.ts rather than inventing a second
// coverage predicate next to the one rehome and foster share.
//
// The zone compared is the INCIDENT's, not the pet's home. A bite is the
// incident authority's problem (the same LEGAL-ROUTING rule the case and the
// authority fan-out already follow in report-bite-from-org.ts). Comparing the
// pet's home instead would authorize a stranger org for every animal registered
// in the one locality it covers, wherever in the country they were bitten.
//
// WHAT EACH ARM ACTUALLY PROVES (fresh-context review 2026-08-22, U3)
// ---------------------------------------------------------------------------
// The Ushuaia/Salta sentence above was FALSE as originally written, and it is
// worth saying why rather than quietly deleting it. `organization_coverage` is
// written by `addCoverageZoneAction`, which lets any admin or coordinator add
// ANY province (locality null = province-wide); `add-coverage-zone.ts` checks
// only that the province exists and that the locality belongs to it. Ushuaia
// only had to add Salta to its own coverage list first. The coverage arm was
// therefore a SELF-ASSERTED claim, not a relationship, and the conjunction read
// `verified AND (self-asserted claim)`.
//
// The coverage arm is now ANCHORED: the incident province must also equal the
// org's `organizations.jurisdiction_province`. That column is set once at
// creation and is excluded from every update path BY TYPE — `updateOrgProfile`
// takes a `Pick<>` that does not contain it, `UpdateOrganizationFields` cannot
// express it, and no admin write path touches it. It is the jurisdiction a
// government saw when it verified the org, and the org cannot move it
// afterwards. Coverage rows still narrow authority WITHIN that province (a
// locality row keeps meaning one locality); they can no longer manufacture it
// in another one. An org with a NULL jurisdiction has no anchor, so the
// coverage arm denies rather than falling back to trusting the list.
//
// The RELATION arm is deliberately NOT tightened, and it is weaker than it
// looks: `hasPetRelation` is satisfied by any pet_event this org authored, and
// a member can author one through /org/{token}/atender/{petToken}, which
// `resolveAtenderContext` gates on active membership alone. So the honest
// statement is "attended this animal, on this org's own say-so — but only for
// an animal whose DIM token it physically had". Closing that means gating
// `atender` itself, which is a different subject with its own real flows (the
// clinic that treated the dog last year is exactly the reporter this gate must
// keep). It is not fixed here; it is no longer overclaimed here either. The
// compensating controls that DO exist: the pet's active owner is notified
// in-transaction (`bite_reported_by_org_owner`, report-bite-from-org.ts) and
// the report is written to the audit log.
//
// Pure — no DB, no framework. The facts arrive as data.

import { type CoverageArea, type PetZone, orgCoversZone } from "@/lib/domain/org-coverage";

export type OrgBiteAuthorityInput = {
  /** `organizations.verified` for the REPORTING org. */
  orgVerified: boolean;
  /**
   * Has this org ever attended or held this animal? Any live-or-past ownership
   * row (custody, foster, shelter custody) or any pet_event this org authored.
   * Historical on purpose: the clinic that treated the dog last year is exactly
   * the reporter this gate must keep.
   */
  hasPetRelation: boolean;
  /**
   * `organizations.jurisdiction_province` for the REPORTING org — the province
   * a government saw when it verified it, immutable afterwards (see header).
   * Null when the org never declared one: no anchor, so no coverage authority.
   */
  orgJurisdictionProvince: string | null;
  /** The org's `organization_coverage` rows. Empty = covers nothing. */
  coverageAreas: readonly CoverageArea[];
  /** Where the bite happened (province/locality), NOT where the pet lives. */
  incidentZone: PetZone;
};

export type OrgBiteAuthorityResult = { ok: true } | { ok: false; error: string };

export function assertOrgMayReportBite(input: OrgBiteAuthorityInput): OrgBiteAuthorityResult {
  if (!input.orgVerified) {
    // Same voice as the sibling refusals (welfare/actions.ts:565, 1194): the
    // subject is the caller's OWN organization, and the sentence says what to
    // do about it rather than only that the door is shut.
    return {
      ok: false,
      error:
        "Tu organización todavía no está verificada por miMAR. Solo una organización verificada puede iniciar una observación antirrábica.",
    };
  }

  if (input.hasPetRelation) return { ok: true };

  // The coverage arm, anchored. Both must hold: the incident is in the province
  // the org was VERIFIED in (which it cannot edit), and it falls inside a
  // coverage row it declared (which only ever narrows, never widens).
  const anchored =
    input.orgJurisdictionProvince !== null &&
    input.incidentZone.province === input.orgJurisdictionProvince;
  if (anchored && orgCoversZone(input.coverageAreas, input.incidentZone)) return { ok: true };

  return {
    ok: false,
    error:
      "Tu organización no atendió a esta mascota ni tiene cobertura en la jurisdicción del incidente. Reportá la mordedura a la autoridad sanitaria de esa zona.",
  };
}
