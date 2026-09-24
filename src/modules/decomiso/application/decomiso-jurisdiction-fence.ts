// The jurisdictional fence for custody_episode cases. (RA-8 finding R3.)
//
// WHY THIS FILE EXISTS
// --------------------
// The decomiso surfaces disagreed with each other about what bounds a govt
// operator. CREATE (`validateExecuteDecomiso`) and DETAIL (`canReadCase`) both
// used `jurisdictionScopeContains` against `session.jurisdictions` — the
// operator's ASSIGNMENTS, granted per-jurisdiction by an admin. LIST
// (/gob/decomisos) and the two mutations (reassign, return-to-owner) used
// something else entirely: `cases.openedByOrganizationId = govtOrg.id`, i.e.
// bare MEMBERSHIP in a sanitary_authority organization.
//
// Those are different facts. Membership is a directory relationship that
// outlives an assignment: an operator whose jurisdiction assignments were
// narrowed to Buenos Aires, but whose membership in a Mendoza authority org was
// never revoked, passed the org check on every Mendoza custody_episode that org
// had opened — and could reassign custody of a seized animal to a different
// shelter, or hand it back to a previous owner, in a province they no longer
// govern. Both writes are irreversible custody decisions over a live animal.
//
// So the org filter is NOT a jurisdiction fence and must never be treated as
// one. It answers "did MY authority open this episode" — a legitimate,
// narrower question about who owns the workflow. This module supplies the
// missing half: does the operator's assigned scope still cover the case's
// jurisdiction, using the SAME subsumption predicate every other govt read
// applies (whole-province assignments subsume their barrios; barrio
// assignments stay exact; a case with no province is in nobody's scope).

import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";

/**
 * The scope-bearing half of a `requireDecomisoPrincipal()` session: the
 * profile role plus the operator's granted jurisdiction assignments.
 */
export type DecomisoActorScope = {
  role: string;
  jurisdictions: ReadonlyArray<{ province: string; locality: string }>;
};

/** The jurisdiction columns every `cases` row carries. */
export type CaseJurisdiction = {
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

/**
 * Is this case inside the actor's assigned jurisdiction?
 *
 * `admin` is universal, matching `canReadCase` and every govt dashboard. Any
 * other role is fenced — including future roles, which is deliberate: a role
 * this function has never heard of gets the fail-closed answer rather than a
 * silent pass.
 */
export function actorCoversCaseJurisdiction(
  actor: DecomisoActorScope,
  caseRow: CaseJurisdiction,
): boolean {
  if (actor.role === "admin") return true;
  return jurisdictionScopeContains(
    actor.jurisdictions,
    caseRow.jurisdictionProvince,
    caseRow.jurisdictionLocality,
  );
}
