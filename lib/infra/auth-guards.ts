// Server-component auth guards that fail by redirecting, never by rendering
// a blank page. Replaces the `if (!user) return null` defensive pattern that
// produced silent blank screens when a session expired between layout and
// page render — see audit reported 2026-05-17.
//
// Use these helpers in any server component / page / layout that needs an
// authenticated user. The return type is non-nullable: if you got here, the
// guard passed.

import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import type { Organization, OrganizationMembership } from "@/db";
import type { ActorProfile } from "@/lib/domain/institutional-scope";
import type { GobReadRole } from "@/lib/domain/jurisdiction-canonical";
import { requireLiveUser } from "@/lib/infra/live-user";
import {
  getJurisdictionsCached,
  getOrgMembershipCached,
  getProfileCached,
} from "@/lib/infra/request-cache";
import type { createClient } from "@/lib/supabase/server";
import { FIRST_ACCESS_PATH } from "@/src/modules/auth/domain/first-access";
import { MFA_CHALLENGE_PATH, MFA_ENROL_PATH } from "@/src/modules/auth/domain/mfa-policy";

export type AuthenticatedSession = {
  supabase: Awaited<ReturnType<typeof createClient>>;
  // Runtime value is the full Supabase User; the type stays narrow on purpose.
  // email is exposed for display fallbacks (nav avatar) only — never for authz.
  user: { id: string; email?: string };
};

// Require an authenticated session. Redirects to /login if absent.
//
// Right-to-erasure lockout (Ley 25.326 art. 16, Wave D2): a valid Supabase
// session is necessary but NOT sufficient. erase_subject_data() soft-deletes the
// profile (deleted_at) and hashes every PII column, but does not by itself
// invalidate an already-issued session token. Without this check a self-erased
// account keeps full access to every guarded surface until the token naturally
// expires. We resolve the profile (request-cached — every layout/guard downstream
// reuses the same round-trip) and bounce erased accounts to /login, which renders
// the "cuenta eliminada" notice + a logout surface instead of looping back in.
// `returnTo` (optional): a same-origin path preserved across the login round-trip
// (login validates it via safeReturnTo before honoring it). App Router layouts do
// not receive the pathname, so the (app) layout — the primary caller — cannot
// cheaply pass it and stays on the bare /login bounce; the page-level fixes carry
// returnTo themselves. This param lets callers that DO know their path (or the
// pets.ts shim) preserve it instead of string-matching the error message. The
// erased-account branch intentionally drops returnTo: an erased account can never
// reach the target again, so it lands on plain /login (the "cuenta eliminada"
// notice) rather than a returnTo that would loop.
//
// SHAPE (T1.2): this is now a thin wrapper over requireLiveUser() — the one
// result-shaped liveness guard (lib/infra/live-user.ts) — not a parallel
// implementation. The result guard decides; this function only translates a
// refusal into the redirect a page/layout needs.
//
// It handles four of the five refusals and DELIBERATELY tolerates the fifth:
//   MAINTENANCE    → /mantenimiento. New (B52): the kill-switch used to live in
//                    four layouts, which gate a RENDER, so a Server Action that
//                    calls this guard committed its write during a maintenance
//                    window and only then met the maintenance screen.
//   NO_SESSION     → /iniciar-sesion (+ returnTo). Unchanged.
//   ACCOUNT_ERASED → /iniciar-sesion, returnTo dropped. Unchanged.
//   SHIFT_EXPIRED  → /turno-vencido (B9). NOT straight to /iniciar-sesion, and
//                    the difference is the whole reason that route exists: the
//                    session is still valid at GoTrue, so the login page would
//                    redirect the operator back into the portal by role and the
//                    portal would refuse them again — the 2026-07-04 redirect
//                    loop, rebuilt. /turno-vencido signs them out first. No
//                    returnTo: after an 8-hour shift the half-finished URL is
//                    not where anyone wants to be returned, and carrying it
//                    through a global sign-out invites the same loop back.
//   DEACTIVATED    → PASSES. A deactivated account must keep a surface it can
//                    read the explanation on and log out from; bouncing it off
//                    everything is how the 2026-07-04 ERR_TOO_MANY_REDIRECTS
//                    incident happened. The operator portals still reject it in
//                    loadActiveInstitutionalProfile, and every WRITE boundary
//                    refuses it via requireLiveUser directly. Reads stay open
//                    so the user can see why; writes stop.
//
//                    THIS TOLERANCE IS NOW LOAD-BEARING FOR A SECOND
//                    POPULATION. requireLiveUser used to raise DEACTIVATED only
//                    for INSTITUTIONAL accounts; it now raises it for a PERSONAL
//                    account that self-deactivated from /cuenta as well. For
//                    that person the tolerated read is not a courtesy — it is
//                    the entire product: the citizen shell renders a standing
//                    banner and /cuenta renders the card that switches the
//                    account back on. Adding a redirect for DEACTIVATED here
//                    would not merely risk the old loop, it would strand them
//                    outside the only control that can undo their own decision.
//
//                    The institutional half of that promise is WEAKER than this
//                    comment has always implied, and saying so is cheaper than
//                    letting the next reader assume it: /cuenta lives under the
//                    citizen layout, which redirects an `admin` role to /admin
//                    and a `govt` role to /gob, and those portals bounce a
//                    deactivated account to `/`. So a deactivated operator does
//                    keep a readable surface (the public landing) but NOT
//                    /cuenta. Their refusal copy says "contactá al equipo de
//                    miMAR" rather than naming a screen they cannot reach.
export async function requireUserOrRedirect(returnTo?: string): Promise<AuthenticatedSession> {
  const live = await requireLiveUser();

  if (!live.ok) {
    if (live.reason === "MAINTENANCE") redirect("/mantenimiento");
    // First access (pilot T1-P3): requireLiveUser refuses a session that still
    // owes its password as NO_SESSION + passwordSetupPending. Checked BEFORE the
    // plain NO_SESSION bounce, which would send the person to a login they have
    // no password for.
    if (live.passwordSetupPending) redirect(FIRST_ACCESS_PATH);
    // Second factor (T2-S6): an institutional session that signed in but has
    // not passed TOTP (or has no factor yet) goes to the step it owes, with the
    // attempted path preserved. Before the NO_SESSION bounce for the same reason
    // as first access: the login page would send them straight back here.
    if (live.mfaPending) redirect(await mfaStepPath(live.mfaPending, returnTo));
    if (live.reason === "NO_SESSION") {
      redirect(
        returnTo ? `/iniciar-sesion?returnTo=${encodeURIComponent(returnTo)}` : "/iniciar-sesion",
      );
    }
    if (live.reason === "ACCOUNT_ERASED") redirect("/iniciar-sesion");
    if (live.reason === "SHIFT_EXPIRED") redirect("/turno-vencido");
    // Only DEACTIVATED reaches here, and it always carries both a client and a
    // user. The guard fails CLOSED rather than asserting that with a cast: if
    // the shape is ever not what this branch assumes, bounce to login.
    if (!live.supabase || !live.user) redirect("/iniciar-sesion");
    return { supabase: live.supabase, user: live.user };
  }

  return { supabase: live.supabase, user: live.user };
}

// Where an institutional session that owes its second factor goes (T2-S6),
// carrying the attempted path — the caller's, or the full URL middleware
// stamped — so the operator lands back on it after the six digits.
async function mfaStepPath(pending: "enrol" | "challenge", returnTo?: string): Promise<string> {
  const base = pending === "enrol" ? MFA_ENROL_PATH : MFA_CHALLENGE_PATH;
  const target = returnTo ?? (await currentReturnTo());
  return target ? `${base}?returnTo=${encodeURIComponent(target)}` : base;
}

export type OrgAccessSession = AuthenticatedSession & {
  organization: Organization;
  membership: OrganizationMembership;
};

// Require a logged-in user with an active membership in the org identified by
// `orgToken` (organizations.publicToken). Returns notFound() — not a redirect —
// if the org does not exist or the user has no active membership, so callers
// can't distinguish "org exists but you're not a member" from "no such org"
// (no information leakage per decision D4).
//
// Replaces the old requireActiveOrgOrRedirect() which inferred the "active org"
// from session state. The explicit orgToken in the URL segment is now the only
// source of truth.
export async function requireOrgAccessByToken(orgToken: string): Promise<OrgAccessSession> {
  const { supabase, user } = await requireUserOrRedirect();

  const row = await getOrgMembershipCached(orgToken, user.id);

  if (!row) notFound();

  return { supabase, user, organization: row.organization, membership: row.membership };
}

export type AdminOrGovtJurisdiction = {
  province: string;
  locality: string;
};

export type AdminOrGovtSession = AuthenticatedSession & {
  profile: { id: string; role: "admin" | "govt" };
  // Empty for admin (universal scope). Populated for govt with every
  // active (non-revoked) govt_assignments tuple.
  jurisdictions: AdminOrGovtJurisdiction[];
};

// Gate the /gob/* segment (also used for the admin+govt server actions in
// app/actions/admin-proposals.ts). Redirects unauthenticated to /login and
// authenticated non-authorities to /acceso-denegado?portal=gob (an explained
// no-access screen with a link home — A4; previously a silent bounce to
// /mis-mascotas). The returned `jurisdictions` is the govt's active scope —
// empty for admin, who has universal scope.
//
// Rejects deactivated institutional accounts (deactivated_at IS NOT NULL) by
// redirecting to / — mirrors requireAdminOrRedirect. Without this check a
// deactivated govt/admin would retain read+write access to every /gob/* surface
// (PII search, role-change proposals, decomisos) because those server actions
// gate on this same guard.
// Shared loader for every institutional guard. Loads the profile and enforces
// the three invariants that an admin/govt surface always requires:
//   1. role ∈ `allow`   (else redirect to `roleRejectRedirect`)
//   2. accountType === 'institutional'   (else redirect to /)
//   3. deactivatedAt === null            (else redirect to /)
//
// Centralizing (2) and (3) here makes it structurally impossible for a guard to
// forget either check — the divergence that caused AC1 (requireAdminOrGovt-
// OrRedirect lacked the deactivation gate that requireAdminOrRedirect had).
// The account-type and deactivation rejects always land on / regardless of the
// guard; only the wrong-role destination is caller-specific.
// Bug fix (qa-triage-2026-07-23, finding #13): the operator portal guards
// below used to call requireUserOrRedirect() with no `returnTo`, so a
// session-expiry bounce mid-triage always landed on bare /login — the
// attempted deep link (e.g. /gob/denuncias?etapa=triage&queue=mine) was lost,
// forcing the operator to re-navigate from scratch after logging back in.
// middleware.ts stamps `x-full-path` (pathname + search) on every request —
// this reads it back so the /gob and /admin guards can restore the FULL
// attempted URL post-login. Falls back to null (bare /login, unchanged
// behavior) if the header is somehow absent — never throws.
async function currentReturnTo(): Promise<string | undefined> {
  try {
    return (await headers()).get("x-full-path") ?? undefined;
  } catch {
    return undefined;
  }
}

async function loadActiveInstitutionalProfile(
  userId: string,
  opts: { allow: ReadonlyArray<GobReadRole>; roleRejectRedirect: string },
): Promise<NonNullable<Awaited<ReturnType<typeof getProfileCached>>>> {
  const profile = await getProfileCached(userId);
  if (!profile || !opts.allow.includes(profile.role as GobReadRole)) {
    redirect(opts.roleRejectRedirect);
  }
  if (profile.accountType !== "institutional") redirect("/");
  if (profile.deactivatedAt !== null) redirect("/");
  return profile;
}

// THE WRITE-AUTHORITY GATE for /gob. Admits admin | govt ONLY. Every mutating
// server action and route handler on the government slice gates on this guard
// (or on a guard that delegates to it — requireDecomisoPrincipal,
// requireDenunciaModerationPrincipal), which is exactly why the read-only
// `national` role is NOT admitted here: refusing it at this one function is
// what keeps every writer closed to it without touching the writers.
//
// Read pages under app/gob use requireGobReadAccessOrRedirect below instead.
export async function requireAdminOrGovtOrRedirect(): Promise<AdminOrGovtSession> {
  const session = await requireUserOrRedirect(await currentReturnTo());
  const profile = await loadActiveInstitutionalProfile(session.user.id, {
    allow: ["admin", "govt"],
    // A4: a personal-role account is bounced to the explained access-denied
    // landing (not silently to /mis-mascotas) so it learns WHY it was moved.
    roleRejectRedirect: "/acceso-denegado?portal=gob",
  });

  const jurisdictions: AdminOrGovtJurisdiction[] =
    profile.role === "govt" ? await getJurisdictionsCached(profile.id) : [];

  return {
    ...session,
    profile: { id: profile.id, role: profile.role as "admin" | "govt" },
    jurisdictions,
  };
}

// ============================================================================
// /gob READ gate — admin | govt | national (national role, migration 0214)
// ============================================================================
//
// The same three invariants as requireAdminOrGovtOrRedirect (role ∈ allow,
// institutional account type, not deactivated — all centralized in
// loadActiveInstitutionalProfile), with ONE more role admitted: `national`, the
// read-only institutional role with country-wide READ scope. It holds no
// govt_assignments (jurisdictions is [] — universal, exactly like admin; the
// scope helpers decide universality through hasNationalReadScope(role), never
// through the emptiness of this list).
//
// WHY A SIBLING AND NOT A WIDER requireAdminOrGovtOrRedirect. The strict guard
// fronts eleven app/actions files and several src/modules action files — the
// government slice's WRITERS. Widening it would have admitted a national to
// every one of them; converting each writer to a new strict guard would have
// meant that ONE missed writer is a privilege escalation. A sibling inverts the
// failure mode: a read page that was not converted BOUNCES a national (an
// annoyance, visible, fixable), it never lets one write. And this guard is
// deliberately absent from scripts/check-authz-guards.ts's AUTH_GUARDS, so a
// "use server" export that ever switched to it would be flagged as unguarded —
// the fence enforces that writers cannot adopt the read gate.
//
// Same rejects, same destinations as the strict guard: unauthenticated → /login
// (returnTo preserved); wrong role → /acceso-denegado?portal=gob; personal or
// deactivated institutional → /.

export type GobReadSession = AuthenticatedSession & {
  profile: { id: string; role: GobReadRole };
  // Empty for admin AND national (universal read scope). Populated for govt
  // with every active (non-revoked) govt_assignments tuple.
  jurisdictions: AdminOrGovtJurisdiction[];
};

export async function requireGobReadAccessOrRedirect(): Promise<GobReadSession> {
  const session = await requireUserOrRedirect(await currentReturnTo());
  const profile = await loadActiveInstitutionalProfile(session.user.id, {
    allow: ["admin", "govt", "national"],
    roleRejectRedirect: "/acceso-denegado?portal=gob",
  });

  const jurisdictions: AdminOrGovtJurisdiction[] =
    profile.role === "govt" ? await getJurisdictionsCached(profile.id) : [];

  return {
    ...session,
    profile: { id: profile.id, role: profile.role as GobReadRole },
    jurisdictions,
  };
}

// ============================================================================
// Fase 5: Admin-only guard (institutional accounts)
// ============================================================================
//
// Stricter than requireAdminOrGovtOrRedirect — only active institutional admins
// pass. Rejects:
//   - unauthenticated users (→ /login via requireUserOrRedirect)
//   - personal accounts (owner / vet)
//   - govt role
//   - deactivated admins (deactivated_at IS NOT NULL)
//
// Used by every Fase 5 page and action that is admin-only.
// Redirect target: /  (govts navigating to /admin/govts etc. land on root)

export type AdminSession = AuthenticatedSession & {
  profile: ActorProfile;
};

export async function requireAdminOrRedirect(): Promise<AdminSession> {
  const session = await requireUserOrRedirect(await currentReturnTo());

  const profile = await loadActiveInstitutionalProfile(session.user.id, {
    allow: ["admin"],
    roleRejectRedirect: "/",
  });

  return {
    ...session,
    profile: {
      id: profile.id,
      role: profile.role as ActorProfile["role"],
      accountType: profile.accountType as ActorProfile["accountType"],
      deactivatedAt: profile.deactivatedAt,
    },
  };
}

// ============================================================================
// Decomiso (Ley 14.346) guard — welfare.decomiso.execute capability
// ============================================================================
//
// Spec: 2026-05-19-decomiso-welfare-authority-design.md §4.4 + DC1.
//
// Capability string: 'welfare.decomiso.execute'
// Granted automatically to:
//   - role='govt'  (all govt accounts, any active jurisdiction)
//   - role='admin' (universal scope)
// NOT granted to: owner, vet, org members without a govt/admin profile role.
//
// Auth model: this is a PROFILE-LEVEL role check (not an org-capability grant).
// The decomiso is an act of the State (Ley 14.346); an org-capability grant
// would allow a refugio to issue one, which is legally wrong (DC1: "refugio que
// decomisa por su cuenta = robo de animal"). We mirror the EXACT same pattern
// as requireAdminOrGovtOrRedirect (role + govt_assignments). A separate
// org-capability ('welfare.decomiso.execute' in ORGANIZATION_CAPABILITIES)
// is NOT created for this reason.
//
// Usage in server actions:
//   const session = await requireDecomisoPrincipal();
//   // session.profile.role is 'admin' | 'govt'
//   // session.jurisdictions is [] for admin, non-empty tuples for govt
//   // Jurisdiction-scope enforcement is the caller's responsibility:
//   //   admin → universal scope (no jurisdiction check needed)
//   //   govt  → animal's jurisdiction must appear in session.jurisdictions
export type DecomisoPrincipalSession = AdminOrGovtSession;

export async function requireDecomisoPrincipal(): Promise<DecomisoPrincipalSession> {
  // Reuses requireAdminOrGovtOrRedirect verbatim — same role set, same
  // jurisdictions query. Named separately so call sites are self-documenting
  // ("this action requires decomiso authority") rather than generic.
  return requireAdminOrGovtOrRedirect();
}

// ============================================================================
// Denuncia moderation guard — 'denuncia.moderate' capability
// ============================================================================
//
// Spec: dim-interno:docs/design/handoffs/2026-07-07-govt-jurisdiction-moderation-sdd.md.
//
// Capability string: 'denuncia.moderate'
// Granted automatically to:
//   - role='admin' (universal scope — the national moderation queue)
//   - role='govt'  (SCOPED to the account's active jurisdiction assignments)
// NOT granted to: owner, vet, org members without a govt/admin profile role.
//
// Auth model: a PROFILE-LEVEL role check (not an org-capability grant), mirroring
// requireDecomisoPrincipal. Moderating the anonymous denuncia funnel of a
// territory is an act of the jurisdiction authority (or the platform operator),
// not something an org membership can confer.
//
// Jurisdiction-scope enforcement is the CALLER'S responsibility and MUST NOT be
// skipped for govt (Wave A/F hardening — do not regress):
//   admin → universal scope (jurisdictions is []; no per-row check needed)
//   govt  → the report's (jurisdictionProvince, jurisdictionLocality) MUST appear
//           in session.jurisdictions. A flagged report with no jurisdiction is
//           never in a govt's scope, so it stays admin-only.
export type DenunciaModerationPrincipalSession = AdminOrGovtSession;

export async function requireDenunciaModerationPrincipal(): Promise<DenunciaModerationPrincipalSession> {
  // Reuses requireAdminOrGovtOrRedirect verbatim — same role set, same
  // jurisdictions query. Named separately so call sites are self-documenting
  // ("this action requires denuncia moderation authority") rather than generic.
  return requireAdminOrGovtOrRedirect();
}
