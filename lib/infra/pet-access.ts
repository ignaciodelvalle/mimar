// Centralized pet-access authorization. The pet is the spine of DIM's data
// model; users and organizations orbit, each holding ownership rows in
// different roles over time. This helper resolves "can the current user act
// on this pet?" via two paths:
//
//   - owner path: user has an active ownership row (any role) keyed on their
//     user_id. Covers personal owners, co-owners, fosters, caretakers, and
//     citizens holding strays — anyone whose user_id is the direct holder.
//   - org path:   user has an active membership in an organization that holds
//     an active ownership row on this pet (custody, foster, or owner). Covers
//     refugio coordinators, sanctuary admins, and any future org-side actor.
//
// The discriminator (`accessPath`) is returned so callers can branch on
// authorship: events written through the owner path attribute to
// authorRole='owner', events through the org path attribute to 'shelter' with
// authorOrganizationId set. The `eventAuthorship` field bakes that decision in
// so server actions can spread it directly into petEvents.values().
//
// Drizzle bypasses RLS by design, so this helper is the security boundary for
// every pet-scoped server action and page that previously gated on
// `ownerships.ownerUserId = user.id`. Adding a new entry point to a pet should
// either use this helper or have a written justification.

import {
  type Organization,
  type OrganizationMembership,
  type OwnershipRole,
  type Pet,
  db,
  organizationMemberships,
  organizations,
  ownerships,
  pets,
  profiles,
} from "@/db";
import { findOpenCaseForPetAndKind } from "@/lib/infra/case-helpers";
import {
  type LiveUserFailure,
  type LiveUserFailureReason,
  requireLiveUser,
} from "@/lib/infra/live-user";
import type { createClient } from "@/lib/supabase/server";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";

export type PetAccessPath = "owner" | "org";

// VET-role trust keystone (#43): the three provenance tiers below are bound to
// the SIGNER's validated matrícula, resolved here at the signing boundary:
//   - authorRole "vet"     + authorVerified=true  → verified_professional
//       (the acting user HELD a validated matrícula at sign time). This is the
//       only org-path tier that satisfies the compliance "verificado" gate.
//   - authorRole "shelter" + authorVerified=false → org_registered
//       (event.write by an org member WITHOUT a validated matrícula). A valid
//       institutional record, but NOT professional-verified.
//   - authorRole "owner"   + authorVerified=false → owner_declared (owner path).
// See lib/events/event-confidence.ts (computeConfidence) for how these columns
// project onto the ConfidenceTier, and lib/projections/pet-compliance.ts for the
// "al día" gate that only professional/institutional tiers clear.
export type PetEventAuthorship = {
  authorRole: "owner" | "shelter" | "vet";
  authorOrganizationId: string | null;
  authorVerified: boolean;
};

/**
 * How an OWNER-path write signs its event.
 *
 * Exported (WU-J) because the bearer door needs the same three fields the
 * cookie door stamps: `resolvePetHolderAccess` returns an `eventAuthorship` for
 * the ORG path only — an organization's signature depends on whether the acting
 * member holds a validated matrícula — while the person path has exactly one
 * answer, which is this. Re-declaring it at a call site is how a native write
 * ends up signed `authorVerified: true` by accident.
 */
export const OWNER_AUTHORSHIP: PetEventAuthorship = {
  authorRole: "owner",
  authorOrganizationId: null,
  authorVerified: false,
};

export type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type PetAccessSuccess = {
  ok: true;
  supabase: SupabaseServerClient;
  user: { id: string };
  pet: Pet;
  accessPath: PetAccessPath;
  organization: Organization | null;
  // Membership is populated only on org-path access (the row that authorized
  // the access). Null on owner-path. Capability-gated wrappers like
  // requireAlivePetAccess consult it to check fine-grained permissions.
  membership: OrganizationMembership | null;
  // The role of the ownership row that authorized a PERSON-path access, so a
  // caller can tell "this pet is one of mine" apart from "I may write anything
  // on it" (custodia-temporal). NULL on the org path — deliberately, and never
  // as a placeholder: org access is capability-gated separately, and conflating
  // an org member's authority with a person's ownership role is how you end up
  // applying the wrong gate. See requireTitularAccess below.
  holderRole: OwnershipRole | null;
  eventAuthorship: PetEventAuthorship;
  error: null;
};

// Structural discriminator for a denied access (external audit 2026-07). A page
// must be able to tell "you have no session" apart from "you have a session but
// no permission" WITHOUT string-matching the human `error` message:
//   - "no-session"            → the caller has no valid Supabase session. A page
//       should redirect to /login (with returnTo), not render a misleading 404.
//   - "not-found-or-forbidden" → the session resolved, but the pet doesn't exist
//       for this caller, they lack access, the pet is deceased, or they lack the
//       write capability. Pages fail closed to notFound() (no information leak);
//       an erased account (valid JWT, no rights) is deliberately in this bucket
//       so it 404s like any other permission denial rather than looping /login.
//   - "not-titular"           → the caller DOES hold this pet, as a caretaker,
//       and the action is titular-only. Distinct from the bucket above on
//       purpose: pretending the pet does not exist to someone who is legitimately
//       caring for it is a lie the UI cannot recover from. This one gets an
//       explanatory refusal, not a 404.
//   - "not-live"              → the caller's SESSION is fine and their rights on
//       this pet were never consulted: the PLATFORM is not accepting writes
//       (maintenance window) or the ACCOUNT is deactivated. Added with B52.
//       `liveReason` carries which. Deliberately its own bucket: neither of
//       these is "no such pet" (a 404 would be a lie) nor "log in again" (the
//       session is valid), and both are TEMPORARY in a way the other reasons
//       are not. The two pre-existing strings are untouched so the six pages
//       that branch on `reason === "no-session"` / `"not-titular"` keep working.
export type PetAccessFailureReason =
  | "no-session"
  | "not-found-or-forbidden"
  | "not-titular"
  | "not-live";

export type PetAccessFailure = {
  ok: false;
  // Null only on a MAINTENANCE refusal: the kill-switch answers before any
  // client is built, precisely so it still works when the DATABASE is what is
  // being maintained.
  supabase: SupabaseServerClient | null;
  user: { id: string } | null;
  pet: null;
  accessPath: null;
  organization: null;
  membership: null;
  // Defaulted to OWNER_AUTHORSHIP so callers can destructure without checks.
  // The error branch returns early before any event insert reads this field;
  // it is functionally dead in the failure case but keeps types simple.
  eventAuthorship: PetEventAuthorship;
  reason: PetAccessFailureReason;
  // Populated only when `reason === "not-live"`, so a caller can tell a
  // maintenance window apart from a deactivated account without string-matching
  // the human message.
  liveReason?: LiveUserFailureReason;
  error: string;
};

export type PetAccessResult = PetAccessSuccess | PetAccessFailure;

// Maps a liveness refusal onto this module's failure shape. The structural
// reason of the two PRE-EXISTING refusals is preserved byte-for-byte — six
// pages branch on `access.reason === "no-session"` and would silently fall
// through to notFound() if it moved — while the two NEW ones (maintenance,
// deactivation) get their own `not-live` bucket.
//
// SHIFT_EXPIRED (B9) joins `not-live` and needs no branch of its own here. Every
// page that reaches this helper sits under a layout whose guard is
// requireUserOrRedirect, which redirects a shift-expired operator to
// /turno-vencido before the page renders — so in practice this module never sees
// it. Landing in `not-live` rather than in the 404 bucket is nonetheless the
// right default if that order ever changes: it renders the honest message
// instead of pretending the animal does not exist.
function failureFromLiveness(live: LiveUserFailure): PetAccessFailure {
  const reason: PetAccessFailureReason =
    live.reason === "NO_SESSION"
      ? "no-session"
      : live.reason === "ACCOUNT_ERASED"
        ? // An erased account is deliberately in the 404 bucket: it has a valid
          // JWT and no rights, so it must fail like any other permission denial
          // rather than loop back to /login. Unchanged from Wave E2.
          "not-found-or-forbidden"
        : "not-live";
  return {
    ok: false,
    supabase: live.supabase,
    user: live.user,
    pet: null,
    accessPath: null,
    organization: null,
    membership: null,
    eventAuthorship: OWNER_AUTHORSHIP,
    reason,
    ...(reason === "not-live" ? { liveReason: live.reason } : {}),
    error: live.error,
  };
}

export async function requirePetAccess(publicToken: string): Promise<PetAccessResult> {
  // ONE liveness guard (T1.2). This used to be a hand-rolled `auth.getUser()`
  // plus an inline `profile?.deletedAt != null` check — correct, but it was the
  // second of two copies and it knew nothing about maintenance or deactivation.
  //
  // Right-to-erasure lockout (Ley 25.326 art. 16, Wave D2/E2) still applies here
  // and still matters HERE specifically: a valid Supabase session is necessary
  // but NOT sufficient to mutate a pet. erase_subject_data() soft-deletes the
  // profile and hashes PII but does not invalidate an already-issued JWT, and
  // Drizzle bypasses RLS — every pet-scoped SERVER ACTION resolves the user
  // through this function, not through the page guard. getProfileCached is
  // request-memoized, so a render pass reuses one round-trip and a server-action
  // call pays one indexed read: the price of the security boundary.
  const live = await requireLiveUser();
  if (!live.ok) return failureFromLiveness(live);
  const { supabase, user } = live;

  const held = await resolvePetHolderAccess(publicToken, user.id);
  if (held.kind === "owner") {
    return {
      ok: true,
      supabase,
      user: { id: user.id },
      pet: held.pet,
      accessPath: "owner",
      organization: null,
      membership: null,
      holderRole: held.holderRole,
      eventAuthorship: OWNER_AUTHORSHIP,
      error: null,
    };
  }
  if (held.kind === "org") {
    return {
      ok: true,
      supabase,
      user: { id: user.id },
      pet: held.pet,
      accessPath: "org",
      organization: held.organization,
      membership: held.membership,
      holderRole: null,
      eventAuthorship: held.eventAuthorship,
      error: null,
    };
  }

  return {
    ok: false,
    supabase,
    user: { id: user.id },
    pet: null,
    accessPath: null,
    organization: null,
    membership: null,
    eventAuthorship: OWNER_AUTHORSHIP,
    reason: "not-found-or-forbidden",
    error: "Mascota no encontrada o sin permisos.",
  };
}

/**
 * WHO MAY READ OR ACT ON A PET, given a user id that is already known to be
 * live. The authorization RULE, with no session handling of its own.
 *
 * Extracted from `requirePetAccess` so a second door can enforce the SAME rule
 * BY CONSTRUCTION rather than by resemblance. `requirePetAccess` is the
 * cookie-session door every page and server action uses; `GET /api/v1/pets/
 * {publicToken}` is the bearer-token door the native app uses. They resolve
 * liveness differently — cookies versus an `Authorization` header — and they
 * must not resolve ACCESS differently. Two copies of this query is exactly how
 * a native client would quietly end up with a wider or narrower reach than the
 * web, and nobody would notice until it mattered.
 *
 * The caller is responsible for having established that `userId` belongs to a
 * live, non-erased account. This function does not check that and must not be
 * called with an unvalidated id.
 *
 * ===========================================================================
 * AN ERASED PET RESOLVES NOTHING — both paths filter `pets.deleted_at`
 * (closed 2026-08-28, the same day the gap was measured open).
 * ===========================================================================
 * `erase_subject_data` SOFT-DELETES the pet and leaves the `ownerships` row
 * standing — `purgeOwnedPetAttachments` in erase-subject-data.ts depends on
 * exactly that and says so: "ownerships rows survive the RPC (only pets are
 * soft-deleted)". So after an account erasure the animal still has a live
 * ownership row, and without the `isNull(pets.deletedAt)` term in each
 * predicate below this function kept answering a holder kind for it (Ley
 * 25.326 art. 16). `requireAlivePetAccess` covered none of that: it refuses
 * `status === 'deceased'`, a different column and a different fact.
 *
 * An erased pet now answers `{ kind: "none" }`, which every caller maps to
 * "not-found-or-forbidden" → 404 — under PO-4 an erased pet and a pet that
 * never existed are the same answer.
 *
 * DELIBERATELY NO OPT-IN PARAMETER. A read-only classification of every call
 * site (2026-08-28) found none that must still resolve a soft-deleted pet.
 * The populations that looked like they might do not route through this
 * resolver at all: government aggregates read `pets` directly and
 * deliberately unfiltered (migration 0205 PART C1; the census stays out of
 * the soft-delete fence's scope by assertion), `getFormerOwnerReadAccess`
 * below is its own sibling resolver, and decomiso custody is mutually
 * exclusive by SQL — erasure soft-deletes only pets whose subject holds a
 * live 'owner' row, while executeDecomiso ends every individual row when
 * opening the episode. If a future admin-recovery surface needs to see an
 * erased pet, it gets its own named resolver, the way
 * `getFormerOwnerReadAccess` is a sibling rather than a flag: an unused
 * escape hatch on a security boundary is an invitation.
 *
 * Call-site counts live in `bash scripts/derive-pet-access-callers.sh` —
 * re-derive, never transcribe.
 *
 * THE FENCE IS RUNTIME, AT THIS CHOKE POINT.
 * `__tests__/public-soft-delete-resolution.test.ts` runs the real erasure RPC
 * against a real DB and asserts both paths answer `{ kind: "none" }` — for a
 * surviving org sponsorship and for a surviving live person row.
 * `__tests__/pet-access.test.ts` cannot see this predicate: its mocked
 * `.where()` discards the argument.
 */
export type PetHolderAccess =
  | { kind: "owner"; pet: Pet; holderRole: OwnershipRole }
  | {
      kind: "org";
      pet: Pet;
      organization: Organization;
      membership: OrganizationMembership;
      eventAuthorship: PetEventAuthorship;
    }
  | { kind: "none" };

export async function resolvePetHolderAccess(
  publicToken: string,
  userId: string,
): Promise<PetHolderAccess> {
  // Path 1: direct ownership by user_id. We still don't filter by
  // ownership.role — owner / co_owner / foster / caretaker all qualify for
  // ACCESS. What changed with custodia-temporal is that the role is now
  // RETURNED, so a titular-only writer can refuse a caretaker without this
  // helper narrowing anybody's access. The shelter_custody role is impossible
  // on this path (it requires owner_organization_id).
  //
  // The ORDER BY is not cosmetic. This query was `.limit(1)` with no ordering:
  // harmless while the result was role-agnostic, a coin flip the moment `role`
  // became load-bearing. A user who is BOTH owner and caretaker of one pet
  // (perfectly reachable — a titular can be designated caretaker of their own
  // co-owned animal) would otherwise resolve to a non-deterministic role and
  // get denied at random. Same bug class, same remedy, as the ROUTE-1 ranking
  // in encontre/action.ts: rank explicitly, most-privileged row first.
  const [ownerRow] = await db
    .select({ pet: pets, role: ownerships.role })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(pets.publicToken, publicToken),
        // Erased pets resolve nothing (art. 16) — see the docblock above.
        isNull(pets.deletedAt),
        eq(ownerships.ownerUserId, userId),
        isNull(ownerships.endedAt),
      ),
    )
    .orderBy(
      sql`case ${ownerships.role} when 'owner' then 0 when 'co_owner' then 1 when 'foster' then 2 when 'caretaker' then 3 else 4 end`,
    )
    .limit(1);
  if (ownerRow) {
    return { kind: "owner", pet: ownerRow.pet, holderRole: ownerRow.role };
  }

  // Path 2: org-mediated. User is an active member of an organization that
  // has an active ownership row on this pet. Any ownership role qualifies —
  // shelter_custody (rehome track), foster (foster_in_transit case, rare),
  // or owner (sanctuary / org-as-permanent-owner).
  //
  // "CUSTODIA" MEANS TWO THINGS HERE (rehome-by-titular, design R4). A
  // `shelter_custody` row can be a rehome SPONSORSHIP: the animal keeps living
  // with its family and the org only publishes and vets. This path still
  // grants the org's members full pet access to an animal in a private home —
  // the privacy face of the overload the PO accepted. Every org screen says
  // the animal is not in the org's possession (REQ-11); this comment is the
  // rest of the mitigation. See src/modules/rehome/README.md.
  const [orgRow] = await db
    .select({
      pet: pets,
      organization: organizations,
      membership: organizationMemberships,
      // VET keystone (#43): resolve whether the acting user HELD a validated
      // matrícula at sign time — same join, no extra round-trip.
      signerMatriculaVerified: profiles.matriculaVerified,
    })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .innerJoin(organizations, eq(organizations.id, ownerships.ownerOrganizationId))
    .innerJoin(
      organizationMemberships,
      and(
        eq(organizationMemberships.organizationId, organizations.id),
        eq(organizationMemberships.userId, userId),
        isNull(organizationMemberships.leftAt),
      ),
    )
    .innerJoin(profiles, eq(profiles.id, organizationMemberships.userId))
    .where(
      and(
        eq(pets.publicToken, publicToken),
        // Erased pets resolve nothing (art. 16) — the org path is the one
        // population that still reaches this resolver for an erased animal:
        // rehome (R4) keeps the org's sponsorship row live alongside the
        // family's owner row, and the erasure RPC ends neither.
        isNull(pets.deletedAt),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  if (orgRow) {
    // VET-role trust keystone (#43): bind the provenance tier to the SIGNER's
    // validated matrícula, NOT to the organization's verified status. A member
    // who holds a validated matrícula signs as verified_professional; anyone
    // else (clinic admin, volunteer) signs as org_registered — a valid record
    // that does NOT satisfy the compliance "verificado" gate. This is what
    // closes the "verificado por profesional" theater (#45).
    const eventAuthorship: PetEventAuthorship = orgRow.signerMatriculaVerified
      ? { authorRole: "vet", authorOrganizationId: orgRow.organization.id, authorVerified: true }
      : {
          authorRole: "shelter",
          authorOrganizationId: orgRow.organization.id,
          authorVerified: false,
        };
    return {
      kind: "org",
      pet: orgRow.pet,
      organization: orgRow.organization,
      membership: orgRow.membership,
      eventAuthorship,
    };
  }

  return { kind: "none" };
}

// Same as requirePetAccess but additionally blocks writes when the pet is
// marked deceased AND, for org-mediated access, requires the `event.write`
// capability. Owner-path always allowed (your pet, your events). Admin
// org-members implicitly hold every capability so they always pass.
export async function requireAlivePetAccess(publicToken: string): Promise<PetAccessResult> {
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return access;
  if (access.pet.status === "deceased") {
    return {
      ok: false,
      supabase: access.supabase,
      user: access.user,
      pet: null,
      accessPath: null,
      organization: null,
      membership: null,
      eventAuthorship: OWNER_AUTHORSHIP,
      reason: "not-found-or-forbidden",
      error: "Esta mascota está registrada como fallecida y no acepta nuevos eventos.",
    };
  }
  if (access.accessPath === "org" && access.membership) {
    const granted = await getGrantedCapabilities(access.membership);
    if (!granted.has("event.write")) {
      return {
        ok: false,
        supabase: access.supabase,
        user: access.user,
        pet: null,
        accessPath: null,
        organization: null,
        membership: null,
        eventAuthorship: OWNER_AUTHORSHIP,
        reason: "not-found-or-forbidden",
        error:
          "Necesitás el permiso 'Registrar eventos clínicos' (event.write). Pediselo a un administrador.",
      };
    }
  }
  return access;
}

// Titular-only gate (custodia-temporal). Composes with requirePetAccess — it
// does NOT replace it — and denies exactly one thing: a person-path holder whose
// ownership role is `caretaker`.
//
// It is a role DENY, not an allow-list, and that asymmetry is the point:
//   - `co_owner` passes. A co-owner is owner-equivalent; making them ask
//     permission would be a new product decision smuggled in as a security fix.
//   - `foster` passes. Today's behaviour, byte for byte.
//   - the ORG path passes. holderRole is null there and org access is
//     capability-gated separately; a deny here would be the wrong gate applied
//     at the wrong layer.
// Consequence worth stating plainly: with no caretaker row in the database this
// function is behaviourally identical to requirePetAccess. That is what makes
// swapping the ~5 titular-only call sites safe to land BEFORE the caretakers
// module exists.
//
// It lives HERE, next to requirePetAccess, and not in src/modules/caretakers.
// Putting it in the module would force app/actions/** and every future writer to
// import the caretakers module — inverting the dependency direction the whole
// module fence exists to protect. The fence is scripts/check-titular-gate.ts;
// this is the guard it looks for.

/**
 * The titular rule as a PREDICATE, for callers that report it instead of
 * enforcing it.
 *
 * `requireTitularAccess` is a cookie-session guard: it opens a Supabase client,
 * resolves the pet and answers a redirect-shaped refusal. A bearer endpoint that
 * has ALREADY resolved the holder cannot call it, and what it usually needs is
 * not a refusal at all but a boolean to put in a `capabilities` block, so a
 * client is never offered a control the write would refuse.
 *
 * Those callers were each writing `!(path === "owner" && role === "caretaker")`
 * out again, which is a rule maintained in N places by hand. This is the same
 * expression, exported once — and the guard below CALLS IT, so the predicate and
 * the gate cannot drift into disagreeing about who a titular is.
 *
 * A DENY and not an allow-list, for the reason the block above gives: an
 * allow-list silently narrows the roles the web admits the first time somebody
 * adds a role to the system.
 */
export function isTitularHolder(
  accessPath: PetAccessPath | null,
  holderRole: OwnershipRole | string | null,
): boolean {
  return !(accessPath === "owner" && holderRole === "caretaker");
}

export async function requireTitularAccess(publicToken: string): Promise<PetAccessResult> {
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return access;
  if (!isTitularHolder(access.accessPath, access.holderRole)) {
    return {
      ok: false,
      supabase: access.supabase,
      user: access.user,
      pet: null,
      accessPath: null,
      organization: null,
      membership: null,
      eventAuthorship: OWNER_AUTHORSHIP,
      reason: "not-titular",
      error: "Sos cuidador/a de esta mascota. Esta acción es solo del titular.",
    };
  }
  return access;
}

// ---------------------------------------------------------------------------
// Shared former-owner derivation.
//
// "Immediate former owner" — no new table, no migration:
//   Ownership rows for a pet form a chronological chain. Exactly one write
//   path ends an INDIVIDUAL's (ownerUserId-based) ownership row and opens a
//   custody_episode in the same breath: executeDecomiso (ends every active
//   ownership row for the pet, any role, in one UPDATE, then opens the
//   episode). Every subsequent step in the SAME custody chain — org-to-org
//   handoff (acceptDecomisoHandoffInTx), reassignment, reject — only ever
//   touches ownerOrganizationId-scoped shelter_custody rows; none of them
//   re-ends an individual's row, and a handoff that opens a NEW episode for
//   the receiver always closes the previous one first (findOpenCaseForPet-
//   AndKind returns at most one open custody_episode per pet — see the
//   double-seizure guard in validateExecuteDecomiso). So the MOST RECENTLY
//   ENDED ownership row with a non-null ownerUserId is unambiguously the
//   immediate former owner for whichever custody_episode is open right now,
//   no matter how many org-to-org handoffs happened along the way. No role
//   filter needed (owner / co_owner / foster / caretaker all qualify,
//   matching Path 1 of requirePetAccess which is equally role-agnostic).
//
// SINGLE derivation shared by two call sites that each need a different
// shape of the answer (docs-sync 2026-07-18 — the two used to be parallel,
// hand-copied implementations that could silently drift):
//   - getFormerOwnerReadAccess (below) — answers "does THIS caller qualify
//     for a read grant on this pet".
//   - findImmediateFormerOwnerOwnership's other caller,
//     src/modules/decomiso/application/return-custody-to-owner.ts — needs the
//     ROW itself (id + owner) with no caller to compare against, in order to
//     reactivate it.
export type ImmediateFormerOwnerOwnership = {
  id: string;
  ownerUserId: string;
};

type OwnershipExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function findImmediateFormerOwnerOwnership(
  petId: string,
  executor: OwnershipExecutor = db,
): Promise<ImmediateFormerOwnerOwnership | null> {
  const [row] = await executor
    .select({ id: ownerships.id, ownerUserId: ownerships.ownerUserId })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, petId),
        isNotNull(ownerships.ownerUserId),
        isNotNull(ownerships.endedAt),
      ),
    )
    .orderBy(desc(ownerships.endedAt))
    .limit(1);
  if (!row?.ownerUserId) return null;
  return { id: row.id, ownerUserId: row.ownerUserId };
}

// ---------------------------------------------------------------------------
// Former-owner READ-ONLY access during an open custody episode (PO decision
// 2026-07-18): "El ex-dueño conserva LECTURA durante el proceso [de custodia
// oficial / decomiso]. Si lo pierde [definitivamente], también los permisos.
// Si se lo devuelve, nunca se le fue."
//
// Deliberately a SIBLING resolver, not a third branch of requirePetAccess:
//   - requirePetAccess / requireAlivePetAccess remain the WRITE boundary.
//     Every event-writing server action gates on one of those two, and
//     NEITHER of them calls into this function — so a former owner who lost
//     ownership keeps failing "not-found-or-forbidden" on every write path,
//     with ZERO changes to those call sites. The read grant below can never
//     leak write capability by construction (no capability check to forget).
//   - Only the pet profile page (the one read surface a former owner should
//     see) calls this, AFTER requirePetAccess has already failed for them.
//
// Severing on permanent loss and continuity on return both fall out of the
// findImmediateFormerOwnerOwnership derivation for free, no extra
// bookkeeping needed:
//   - adoption_finalized / death_recorded close the custody_episode (cascade
//     or direct close) with no new custody_episode opened → findOpenCaseFor-
//     PetAndKind returns null → this resolver returns { ok: false } → read
//     access is gone, matching "si lo pierde, también los permisos."
//   - IF a return-to-owner path re-opens (or reactivates) the ex-owner's
//     'owner' ownership row and closes the episode, Path 1 of
//     requirePetAccess grants FULL access again automatically — this
//     resolver is never even reached at that point. (This is exactly what
//     src/modules/decomiso/application/return-custody-to-owner.ts's
//     returnCustodyToOwnerInTx now does.)
export type FormerOwnerReadAccess =
  | {
      ok: true;
      pet: Pet;
      accessPath: "former-owner-during-custody";
      readOnly: true;
      custodyCase: { id: string; publicCode: string };
    }
  | { ok: false };

export async function getFormerOwnerReadAccess(
  publicToken: string,
  userId: string,
): Promise<FormerOwnerReadAccess> {
  // An erased pet grants no read either (art. 16). Unreachable for a
  // soft-deleted pet today — soft-delete requires a live 'owner' row, and this
  // grant requires an open custody episode, which requires that row ended —
  // but a sibling of the holder resolver must not be the one bare `pets` read
  // left in this file.
  const [petRow] = await db
    .select()
    .from(pets)
    .where(and(eq(pets.publicToken, publicToken), isNull(pets.deletedAt)))
    .limit(1);
  if (!petRow) return { ok: false };

  // Must be a CURRENTLY OPEN custody_episode for this pet — the derivation
  // below is only meaningful while the custody process is still running.
  const custodyCase = await findOpenCaseForPetAndKind(petRow.id, "custody_episode");
  if (!custodyCase) return { ok: false };

  // The pet's overall most-recently-ended individual ownership row (any
  // user) — the SAME shared derivation returnCustodyToOwnerInTx uses to
  // reactivate it. The caller only qualifies as the IMMEDIATE former owner
  // if it's THEIRS — otherwise they're a stale prior owner from an earlier,
  // unrelated tenure (e.g. the pet was legitimately transferred away long
  // before this custody episode ever opened), and a different user is the
  // true immediate former owner tied to the CURRENT episode.
  const formerOwner = await findImmediateFormerOwnerOwnership(petRow.id);
  if (!formerOwner || formerOwner.ownerUserId !== userId) {
    return { ok: false };
  }

  return {
    ok: true,
    pet: petRow,
    accessPath: "former-owner-during-custody",
    readOnly: true,
    custodyCase: { id: custodyCase.id, publicCode: custodyCase.publicCode },
  };
}
