// Capability scope helper for revocation actions.
//
// Mirrors lib/approval-scope.ts canDecideRequest — pure function,
// no DB queries, operates entirely on data passed by the caller.
// Used server-side in each revocation writer and (imported) client-side
// to hide buttons when the actor cannot act.
//
// Spec §REQ-5, design §2e.

import {
  isWholeProvinceAssignment,
  jurisdictionScopeContains,
} from "@/lib/domain/jurisdiction-canonical";

import type { AdminOrGovtJurisdiction } from "@/lib/infra/auth-guards";

export type { AdminOrGovtJurisdiction };

export type RevocationType = "vet_role" | "org_verification" | "govt_locality";

// Discriminated union per revocation type. Each variant carries the jurisdiction
// fields needed to evaluate scope — loaded by the caller from the DB before
// calling canRevoke.
export type RevocationTarget =
  | {
      type: "vet_role";
      // Province that issued the vet's professional license.
      // A free-text "Provincia" string from the role_upgrade_vet payload.
      matriculaJurisdiccion: string;
      // Operational address declared by the vet (optional — may not be set).
      operationalProvince?: string | null;
      operationalLocality?: string | null;
    }
  | {
      type: "org_verification";
      province: string;
      locality: string;
    }
  | {
      type: "govt_locality";
      province: string;
      locality: string;
    };

// Authoritative capability check for revocation actions.
//
// - admin: always returns true (universal scope).
// - govt: must hold at least one active jurisdiction assignment that covers
//   the target's scope. The rule varies by revocation type:
//   * org_verification: the target's (province, locality) must be COVERED by an
//     assignment — exact for a barrio-scoped mandate, and province-wide for a
//     whole-province one (see the subsumption note below).
//   * govt_locality: containment is NOT enough — the actor's coverage must be
//     STRICTLY WIDER than the target's (see the rank note below, D3).
//   * vet_role: OR between matricula_jurisdiccion (province-only) and
//     operational (province, locality). This is intentionally liberal —
//     a govt can revoke a vet if EITHER the vet's license province OR
//     their operational locality falls within the govt's scope.
//     Spec §7.7 — vet scope = matricula jurisdiction OR operational locality.
//
// WHOLE-PROVINCE SUBSUMPTION (2026-08-17, found by the hardened
// check-jurisdiction-subsumption fence). Both comparisons used to be plain
// exact-pair equality, which silently excluded the WHOLE-PROVINCE operator:
// their assignment row's locality is the `""` sentinel (or the CABA whole-city
// entry), never a barrio name, so a provincial official could not revoke an org
// verification, a locality assignment, or a vet inside their own province.
// `jurisdictionScopeContains` is the canonical predicate — it widens ONLY for a
// whole-province assignment and keeps a barrio-scoped mandate exact, so this
// grants nothing beyond the mandate the actor already holds.
//
// Does NOT cover the self-revocation footgun for govt_locality — that lives
// in the writer because canRevoke does not receive the actor's user_id.
export function canRevoke(
  profile: { id: string; role: "admin" | "govt" },
  target: RevocationTarget,
  jurisdictions: readonly AdminOrGovtJurisdiction[],
): boolean {
  if (profile.role === "admin") return true;

  if (target.type === "vet_role") {
    // Govt can revoke if the vet's matricula province OR operational locality
    // falls within one of the govt's active assignment (province, locality) pairs.
    return (
      // Province-only match on matricula_jurisdiccion.
      jurisdictions.some((j) => j.province === target.matriculaJurisdiccion) ||
      // Operational address, covered rather than exactly equal.
      jurisdictionScopeContains(
        jurisdictions,
        target.operationalProvince,
        target.operationalLocality,
      )
    );
  }

  if (target.type === "org_verification") {
    return jurisdictionScopeContains(jurisdictions, target.province, target.locality);
  }

  if (target.type === "govt_locality") {
    return govtCoverageStrictlyContains(jurisdictions, target);
  }

  return false;
}

// RANK RULE for revoking another official's assignment (D3, PO 2026-08-23).
//
// This branch used plain containment, and containment is REFLEXIVE: an official
// assigned to Buenos Aires / La Plata contains the scope of another official
// assigned to Buenos Aires / La Plata, so the two could strip each other's
// mandate. The catalog documented peer discipline as intentional back in
// 2026-05-17 ("Admin u otro govt en scope revoca una localidad de un govt"); a
// national deployment raises the cost of an internal dispute enough that the PO
// re-decided it.
//
// The chosen rule is RANK, deliberately NOT admin-only: a province must still be
// able to revoke inside its own territory without escalating to us. So the actor
// needs coverage STRICTLY WIDER than the target's:
//
//   province over locality   → allowed  (whole-BA operator revokes BA / La Plata)
//   nation   over province   → allowed  — and "nation" has no assignment row in
//                              this model; universal scope IS the admin branch
//                              above, which returns true before we get here.
//   locality over same locality → refused (peers)
//   province over same province → refused (provincial peers)
//   locality reaching UP at its own province → refused
//
// Self-revocation is refused twice over: the writer checks
// `assignment.userId === actorUserId` BEFORE calling canRevoke
// (revoke-govt-locality.ts, spec §REQ-3) and remains the primary guard; the rank
// rule cannot open a second door behind it because an actor's own row is never
// strictly wider than itself.
//
// Both tiers are decided by `isWholeProvinceAssignment` — the SAME canonical
// predicate the subsumption fix uses — so there is no second, drifting notion of
// "the whole province" in this file. Containment itself still goes through
// `jurisdictionScopeContains`; the only thing added is the strictness.
function govtCoverageStrictlyContains(
  jurisdictions: readonly AdminOrGovtJurisdiction[],
  target: { province: string; locality: string },
): boolean {
  // A whole-province mandate is the widest tier a govt assignment can express.
  // Nothing a govt holds outranks it — only admin does, upstream.
  if (isWholeProvinceAssignment(target)) return false;

  // The target is locality-scoped, so the only strictly-wider govt coverage is
  // a whole-province assignment that contains it.
  return jurisdictions.some(
    (j) =>
      isWholeProvinceAssignment(j) &&
      jurisdictionScopeContains([j], target.province, target.locality),
  );
}
