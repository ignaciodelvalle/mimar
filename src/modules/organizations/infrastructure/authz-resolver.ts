// AuthzResolver — Supabase session + Drizzle DB queries for capability checks.
//
// This is the I/O layer for authorization. Pure baseline logic (resolveGrantedCaps,
// isValidCapability, CAPABILITY_CATALOG, baselines) lives in domain/capabilities.ts.
//
// Resolution order for requireCapability (preserve EXACTLY per spec):
//   1. Liveness (requireLiveUser, lib/infra/live-user.ts), in ITS precedence:
//        MAINTENANCE    → the platform-wide kill-switch; an env read, before
//                         any client or query, because the database may be
//                         the thing under repair.
//        NO_SESSION     → "Sesión expirada."
//        ACCOUNT_ERASED → "Tu cuenta fue eliminada." (Ley 25.326 art. 16)
//        DEACTIVATED    → refused for a WRITE (the default), tolerated for a
//                         READ (`access: "read"`). See RequireCapabilityOptions.
//   2. getActiveMemberships(userId) → ordered by joinedAt ASC
//   3. orgId provided: find matching membership; omitted: take memberships[length-1]
//   4. No matching/active membership → "No pertenecés a ninguna organización activa."
//   5. getGrantedCapabilities(membership) → delegates domain resolveGrantedCaps + DB
//   6. granted lacks capability → "No tenés permiso para esta acción. Pedile el alta a un administrador."
//   7. Success → { user, membership, organization, granted, error: null }
//
// WHY STEP 1 IS requireLiveUser AND NOT A BARE getUser (RN re-run HIGH, 2026-08-22)
// ---------------------------------------------------------------------------
// Until this change both capability guards resolved the caller with
// `auth.getUser()` plus the erasure check, and NOTHING else — while ~17 org
// entry points (cross-org transfers ×5, foster ×2, member management ×5,
// surveillance, rehome) are gated by these two functions alone. So a
// maintenance window never stopped an org from transferring custody or
// accepting a rehome, and a DEACTIVATED institutional account kept mutating
// through every one of them. lib/infra/live-user.ts already answers all four
// liveness questions in one place and in one order; a guard that re-derives
// three of them is a guard that drifts. The refusal shape stays this module's
// own (RequireCapabilityFailure) — no redirects here, the use-cases return.
//
// ATENDER IS IN THAT LIST NOW — IT WAS NOT, AND SAYING SO IS THIS FILE'S HISTORY.
// ---------------------------------------------------------------------------
// Until 2026-08-25 `app/org/[orgToken]/atender/atender-access.ts` did NOT call
// any guard in this file: `resolveAtenderContext` resolved the caller with a
// bare `supabase.auth.getUser()` and then imported `getGrantedCapabilities`
// from here DIRECTLY — step 5 of the order above with steps 1-4 skipped. The
// seven clinical actions behind it got the capability check and none of the
// liveness checks: no maintenance kill-switch, no deactivation refusal, and no
// 8-hour shift, on the one surface that is literally a shared municipal desk.
//
// It now enters through `resolveLiveOrgActor` (below), which is the SAME
// liveness + shift + membership + grants sequence `requireCapabilityForOrgToken`
// runs, exposed as a result so a surface can word the two ORG refusals in its
// own voice. Atender's copy is unchanged for every refusal it could already
// produce; what it gained is the three it could not (maintenance, deactivation,
// shift).
//
// AND THE STRUCTURAL HALF, which is the part a comment cannot hold: nothing
// ASSERTED that an institutional/operator resolver reaches the shift, which is
// why this hole was invisible for as long as it was. `scripts/check-operator-
// shift-reach.ts` is that assertion. `getGrantedCapabilities` stays exported —
// it is a capability READER consulted by ~25 org surfaces that all authorize
// through `requireOrgAccessByToken` first, and guarding it would buy a GoTrue
// round-trip on every org page to re-answer a question already answered. What
// was missing was never a keyword on the export; it was a fence.

import { and, eq, isNull } from "drizzle-orm";

import {
  type Organization,
  type OrganizationCapability,
  type OrganizationMembership,
  db,
  organizationCapabilityGrants,
  organizationMemberships,
  organizations,
} from "@/db";
import { type LiveUserFailureReason, requireLiveUser } from "@/lib/infra/live-user";
import { OPERATOR_SHIFT_EXPIRED_MESSAGE, isOperatorShiftExpired } from "@/lib/infra/operator-shift";
import { resolveGrantedCaps } from "@/src/modules/organizations/domain/capabilities";

// ---------------------------------------------------------------------------
// Public types exported from this module
// ---------------------------------------------------------------------------

export type ActiveMembership = {
  membership: OrganizationMembership;
  organization: Organization;
};

export type RequireCapabilitySuccess = {
  user: { id: string };
  membership: OrganizationMembership;
  organization: Organization;
  granted: Set<OrganizationCapability>;
  error: null;
};

export type RequireCapabilityFailure = {
  user: { id: string } | null;
  membership: null;
  organization: null;
  granted: null;
  error: string;
};

export type RequireCapabilityResult = RequireCapabilitySuccess | RequireCapabilityFailure;

export type RequireCapabilityOptions = {
  /**
   * What the caller is about to do with the capability. Defaults to "write".
   *
   * The policy is lib/infra/auth-guards.ts:60-70: a DEACTIVATED institutional
   * account keeps its READS (so it can see why, and log out) and loses its
   * WRITES. These guards gate writes by construction — every org server action
   * and every org mutation authorizes through them — so the default refuses.
   * The seven org pages and three export/template handlers that gate a READ
   * on a capability pass `access: "read"` and tolerate the refusal exactly as
   * requireUserOrRedirect does. MAINTENANCE, NO_SESSION and ACCOUNT_ERASED
   * refuse either way.
   */
  access?: "read" | "write";
};

/** The refusal shape this module speaks, from a message and an optional actor. */
function capabilityFailure(userId: string | null, error: string): RequireCapabilityFailure {
  return {
    user: userId ? { id: userId } : null,
    membership: null,
    organization: null,
    granted: null,
    error,
  };
}

/**
 * Step 1 of both guards: the caller must be LIVE, in requireLiveUser's own
 * precedence, and the refusal comes back in this module's result shape.
 *
 * Returns the user id on success so the membership resolution never re-reads
 * the session. DEACTIVATED is the one refusal a READ may tolerate; the guard
 * fails CLOSED if that branch ever arrives without a user rather than
 * asserting the shape with a cast (same stance as auth-guards.ts).
 *
 * THE 8-HOUR SHIFT IS RE-APPLIED HERE, AND IT IS NOT A DUPLICATE (B9)
 * ---------------------------------------------------------------------------
 * `requireLiveUser` already refuses a shift-expired INSTITUTIONAL profile. It
 * cannot refuse the principal this module is for. An org staffer — a vet in a
 * clinic, a coordinator in a refugio — commonly holds `role: "vet"` /
 * `accountType: "personal"`; their operator-ness lives in
 * `organization_memberships`, a table `requireLiveUser` never reads. So the
 * institutional predicate does not fire for them, and without this check the
 * single largest group of org-console operators would have kept a citizen-length
 * session on exactly the shared front-desk machine B9 is about.
 *
 * Applied to READS as well as writes, unlike DEACTIVATED. The two refusals are
 * not the same kind of thing: a deactivated account keeps its reads so it can
 * see WHY it was switched off and log out, and no amount of re-authenticating
 * would change its state. A shift is over for everyone and is fixed by signing
 * in again — leaving org reads open would leave the console populated on the
 * shared desk, which is the whole exposure.
 *
 * It runs AFTER the liveness refusals and only for callers those allowed
 * through, so a maintenance window or an erased account still answers first.
 */
async function resolveLiveActor(
  options: RequireCapabilityOptions | undefined,
): Promise<LiveActorResult> {
  const live = await requireLiveUser();

  if (!live.ok) {
    const tolerated = live.reason === "DEACTIVATED" && options?.access === "read";
    if (tolerated && live.user) return { ok: true, userId: live.user.id };
    return {
      ok: false,
      reason: live.reason,
      userId: live.user?.id ?? null,
      error: live.error,
    };
  }

  if (
    isOperatorShiftExpired({ sessionStartedAt: live.sessionStartedAt, context: "org-capability" })
  ) {
    return {
      ok: false,
      reason: "SHIFT_EXPIRED",
      userId: live.user.id,
      error: OPERATOR_SHIFT_EXPIRED_MESSAGE,
    };
  }

  return { ok: true, userId: live.user.id };
}

/**
 * The liveness+shift step's own result shape.
 *
 * It carries the REASON and not only the copy, because two surfaces word the
 * same refusal differently and neither is wrong: this module answers a server
 * action with a string, and a PAGE has to redirect a shift-expired operator to
 * /turno-vencido — a decision `error` cannot carry. `reason` is
 * requireLiveUser's own vocabulary verbatim (SHIFT_EXPIRED included), so the
 * org-staff shift refusal above and the institutional one inside requireLiveUser
 * are indistinguishable to a caller, which is the honest answer: they are the
 * same policy reached by two predicates.
 */
type LiveActorResult =
  | { ok: true; userId: string }
  | {
      ok: false;
      reason: LiveUserFailureReason;
      userId: string | null;
      error: string;
    };

// ---------------------------------------------------------------------------
// getActiveMemberships
//
// Returns all active memberships (leftAt IS NULL) for a user joined with their
// organization. Ordered by joinedAt ASC so that memberships[length-1] is the
// most-recently-joined (matches v1 "first/last membership wins" default).
// ---------------------------------------------------------------------------

export async function getActiveMemberships(userId: string): Promise<ActiveMembership[]> {
  const rows = await db
    .select({ membership: organizationMemberships, organization: organizations })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(and(eq(organizationMemberships.userId, userId), isNull(organizationMemberships.leftAt)))
    .orderBy(organizationMemberships.joinedAt);
  return rows;
}

// ---------------------------------------------------------------------------
// getGrantedCapabilities
//
// Capabilities currently granted on a membership:
//   - role=admin: implicit grant of ALL capabilities (universal).
//   - role=vet_individual: VET_INDIVIDUAL_IMPLICIT_CAPS + explicit approved grants.
//   - role=coordinator: COORDINATOR_IMPLICIT_CAPS + explicit approved grants.
//   - other roles: only status='approved' grant rows (isValidCapability filtered).
//
// Delegates baseline resolution to domain/capabilities.resolveGrantedCaps (pure).
// DB layer: reads approved organization_capability_grants rows.
//
// IT IS A READER, NOT A GUARD, and the distinction is the one atender got wrong
// for months. It answers "what may this MEMBERSHIP do" from a membership row
// already in hand. It never asks who is calling, whether they still may act, or
// whether their shift is over — it cannot, because it is handed no session. Its
// ~25 callers are org pages and layouts that authorized through
// requireOrgAccessByToken first; the one caller that did not was the bypass.
// `scripts/check-operator-shift-reach.ts` is what makes that structural rather
// than remembered.
// ---------------------------------------------------------------------------

export async function getGrantedCapabilities(
  membership: Pick<OrganizationMembership, "id" | "role">,
): Promise<Set<OrganizationCapability>> {
  // Admin shortcut: no DB read needed (domain handles it)
  if (membership.role === "admin") {
    return resolveGrantedCaps("admin", []);
  }

  // Read approved grants from DB
  const rows = await db
    .select({ capability: organizationCapabilityGrants.capability })
    .from(organizationCapabilityGrants)
    .where(
      and(
        eq(organizationCapabilityGrants.membershipId, membership.id),
        eq(organizationCapabilityGrants.status, "approved"),
      ),
    );

  const approvedCapStrings = rows.map((r) => r.capability);

  // Delegate baseline + validation to pure domain function
  return resolveGrantedCaps(membership.role, approvedCapStrings);
}

// ---------------------------------------------------------------------------
// requireCapability
//
// Server-action helper. Returns the active membership + organization for the
// authenticated user that holds `capability`. Mirrors requireOwnedPet in
// app/actions/events.ts. When organizationId is provided, only that org is
// considered; otherwise the most-recently-joined active membership is used
// (matches the v1 "last membership wins" UI default — memberships[length-1]
// because getActiveMemberships orders by joinedAt ASC).
// ---------------------------------------------------------------------------

export async function requireCapability(
  capability: OrganizationCapability,
  organizationId?: string,
  options?: RequireCapabilityOptions,
): Promise<RequireCapabilityResult> {
  // Right-to-erasure lockout (Ley 25.326 art. 16, Wave E2) lives inside
  // requireLiveUser now, together with the kill-switch and deactivation: the
  // JWT stays valid after erase_subject_data() soft-deletes the profile, so a
  // session alone never authorizes an org mutation. One request-memoized
  // profile read is the price of the boundary, unchanged.
  const live = await resolveLiveActor(options);
  if (!live.ok) return capabilityFailure(live.userId, live.error);

  return resolveCapabilityForUser(live.userId, capability, organizationId);
}

/** Steps 2-7: membership + grant resolution for an already-LIVE user. */
async function resolveCapabilityForUser(
  userId: string,
  capability: OrganizationCapability,
  organizationId?: string,
): Promise<RequireCapabilityResult> {
  const memberships = await getActiveMemberships(userId);
  const active = organizationId
    ? memberships.find((m) => m.organization.id === organizationId)
    : memberships[memberships.length - 1];

  if (!active) {
    return {
      user: { id: userId },
      membership: null,
      organization: null,
      granted: null,
      error: "No pertenecés a ninguna organización activa.",
    };
  }

  const granted = await getGrantedCapabilities(active.membership);
  if (!granted.has(capability)) {
    return {
      user: { id: userId },
      membership: null,
      organization: null,
      granted: null,
      error: "No tenés permiso para esta acción. Pedile el alta a un administrador.",
    };
  }

  return {
    user: { id: userId },
    membership: active.membership,
    organization: active.organization,
    granted,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// requireCapabilityForOrgToken
//
// Confused-deputy guard for org-scoped server actions reached through an
// /org/{orgToken}/… URL. Resolves the acting organization from the URL
// publicToken FIRST, then pins the capability check to THAT org.id — never the
// session-default (most-recently-joined) membership that bare requireCapability
// falls back to. A member of several orgs acting under /org/{A} is authorized
// against org A, not whichever org they happened to join last.
//
// Returns the same RequireCapabilityResult shape as requireCapability. When the
// token matches no organization the standard "no access" failure is returned —
// indistinguishable from "not a member", so org existence is never leaked.
//
// LIVENESS RUNS FIRST, before the org lookup (2026-08-22). The lookup is a DB
// read, and the maintenance kill-switch has to work when the database is what
// is being maintained. It also closes a small oracle the old order had: an
// ANONYMOUS caller used to get "No tenés acceso" for an unknown token and
// "Sesión expirada." for a real one — two different answers to "does this org
// exist?" for someone with no session at all. Now every non-live caller gets
// the same liveness refusal whatever the token says.
// ---------------------------------------------------------------------------

export async function requireCapabilityForOrgToken(
  capability: OrganizationCapability,
  orgToken: string,
  options?: RequireCapabilityOptions,
): Promise<RequireCapabilityResult> {
  const actor = await resolveLiveOrgActor(orgToken, options);

  if (!actor.ok) {
    // The two ORG refusals keep the wording they have always had here, and they
    // stay DIFFERENT on purpose: "no such org" and "not a member of this one"
    // are the same information to an anonymous caller (liveness answered first,
    // above), and to a signed-in member they are two different problems.
    if (actor.reason === "NO_ORGANIZATION") {
      return capabilityFailure(actor.userId, "No tenés acceso a esta organización.");
    }
    if (actor.reason === "NO_MEMBERSHIP") {
      return capabilityFailure(actor.userId, "No pertenecés a ninguna organización activa.");
    }
    return capabilityFailure(actor.userId, actor.error ?? "Sesión expirada.");
  }

  if (!actor.granted.has(capability)) {
    return capabilityFailure(
      actor.userId,
      "No tenés permiso para esta acción. Pedile el alta a un administrador.",
    );
  }

  return {
    user: { id: actor.userId },
    membership: actor.membership,
    organization: actor.organization,
    granted: actor.granted,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// resolveLiveOrgActor — the guarded door for a surface that words its own
// refusals
// ---------------------------------------------------------------------------
//
// SAME SEQUENCE as requireCapabilityForOrgToken, stopping one step earlier: it
// resolves the LIVE actor (maintenance → session → erasure → deactivation →
// 8-hour shift), pins the organization to the URL token, finds THAT
// membership, and reads its granted capabilities — but it does not decide which
// capability was needed, and it does not choose the words for the two ORG
// refusals.
//
// WHY IT EXISTS, rather than atender calling requireCapabilityForOrgToken.
// Atender's screen says "No pertenecés a esta organización." for a caller who is
// not a member, and names the exact permission it wants
// ("Registrar eventos clínicos (event.write)") when the membership lacks it.
// Those two strings are better than this module's generic ones on that surface,
// and routing atender through requireCapabilityForOrgToken would have replaced
// them — trading a real UX regression for the security fix instead of taking
// both. The refusals that MATTER for the fix (the liveness five) come back
// worded by requireLiveUser and identical everywhere.
//
// The alternative — leaving atender to call `getGrantedCapabilities` directly
// and adding its own liveness — is what the codebase already had, and it is the
// shape that produced the bypass: two guards, one of which forgot a check.

/** Why resolveLiveOrgActor refused. The liveness five are requireLiveUser's. */
export type LiveOrgActorFailureReason = LiveUserFailureReason | "NO_ORGANIZATION" | "NO_MEMBERSHIP";

export type LiveOrgActorResult =
  | {
      ok: true;
      userId: string;
      membership: OrganizationMembership;
      organization: Organization;
      granted: Set<OrganizationCapability>;
    }
  | {
      ok: false;
      reason: LiveOrgActorFailureReason;
      userId: string | null;
      /**
       * Ready-to-render es-AR copy for the LIVENESS refusals, straight from
       * requireLiveUser. Null for NO_ORGANIZATION / NO_MEMBERSHIP, whose wording
       * belongs to the surface — null rather than a default so a caller that
       * forgets to word them fails to compile instead of shipping this module's
       * voice onto a screen that reads nothing like it.
       */
      error: string | null;
    };

export async function resolveLiveOrgActor(
  orgToken: string,
  options?: RequireCapabilityOptions,
): Promise<LiveOrgActorResult> {
  // LIVENESS FIRST, before the org lookup — the same order and for the same
  // reason requireCapabilityForOrgToken adopted in 2026-08-22: the lookup is a
  // DB read and the maintenance kill-switch has to work when the database is
  // what is being maintained, and an anonymous caller must not learn from the
  // refusal whether the org in the URL exists.
  const live = await resolveLiveActor(options);
  if (!live.ok) {
    return { ok: false, reason: live.reason, userId: live.userId, error: live.error };
  }

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.publicToken, orgToken))
    .limit(1);

  if (!org) {
    return { ok: false, reason: "NO_ORGANIZATION", userId: live.userId, error: null };
  }

  const memberships = await getActiveMemberships(live.userId);
  const active = memberships.find((m) => m.organization.id === org.id);
  if (!active) {
    return { ok: false, reason: "NO_MEMBERSHIP", userId: live.userId, error: null };
  }

  return {
    ok: true,
    userId: live.userId,
    membership: active.membership,
    organization: active.organization,
    granted: await getGrantedCapabilities(active.membership),
  };
}
