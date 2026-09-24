// Role-based post-login landing page resolution.
//
// pathForRole — pure function, no DB access.
// resolveVetLanding — queries the vet's org memberships and returns the correct
// path. All three call-sites (loginAction, LoginPage, root page) use it so
// the routing logic never diverges.
//
// resolveUserLanding — org-aware landing resolver for OAuth/magic-link callbacks.
// Unlike pathForRole (which requires pre-fetched role + membership flags) this
// function fetches both the role and membership in one pass and returns the best
// default landing URL. Used by app/auth/callback/route.ts.

import { and, eq, inArray, isNull } from "drizzle-orm";

import { db, organizationMemberships, organizations, profiles } from "@/db";

// Rules (priority order):
//  1. admin  → /admin
//  2. govt   → /gob
//  3. vet with active admin/coordinator org membership → /org/[firstOrgToken]
//  4. vet with exactly one other active membership → /org/[thatOrgToken]
//     (single-membership shortcut — mirror of the owner rule: land the vet
//      directly in their one clinic's work surface, not a meta-list)
//  5. vet with 2+ other active memberships → /cuenta/memberships (let them pick)
//  6. vet with no memberships → /cuenta
//  7. owner with active org-admin membership → /org  (index redirects to their org)
//  8. everyone else → /inicio  (owner dashboard; pet list still reachable at /mis-mascotas)

export type RoleOptions = {
  hasOrgAdminMembership?: boolean;
  vetFirstOrgToken?: string | null;
  vetHasAnyMembership?: boolean;
};

// ---------------------------------------------------------------------------
// Deactivated institutional accounts — redirect-loop guard (task #39)
// ---------------------------------------------------------------------------
//
// Every institutional guard (requireAdminOrRedirect, requireAdminOrGovtOr-
// Redirect) bounces a deactivated institutional account to `/`. If any
// role-landing call site (root page, /login page, loginAction, auth callback)
// redirects that same account back into its portal by role, the two redirects
// chase each other forever: /admin → / → /admin → … and the browser dies with
// ERR_TOO_MANY_REDIRECTS — no app surface, no logout, no feedback (observed
// live 2026-07-04 with a deactivated admin@dim.test). Every auto-redirect by
// role MUST consult this predicate first and fall through to a real page
// (landing or login) when it returns true.

export type InstitutionalStatusFields = {
  accountType: string | null;
  deactivatedAt: Date | null;
};

/** True when the profile is an institutional account that has been deactivated. */
export function isDeactivatedInstitutional(
  profile: InstitutionalStatusFields | null | undefined,
): boolean {
  return !!profile && profile.accountType === "institutional" && profile.deactivatedAt !== null;
}

// ---------------------------------------------------------------------------
// Erased accounts — right-to-erasure lockout (Ley 25.326 art. 16, Wave D2)
// ---------------------------------------------------------------------------
//
// erase_subject_data() soft-deletes the profile (deleted_at = now()) and hashes
// every PII column, but the Supabase session is only dropped client-side via
// signOut(). A stale/replayed session cookie — or a user who simply logs back in
// before auth.users is cleaned up — would otherwise regain a full session on an
// account that no longer holds any identity. Every auth entry point MUST treat a
// non-null deleted_at as "no access", identically to how it treats a deactivated
// institutional account: bounce to /login, never into the app (which would loop
// against requireUserOrRedirect).

export type ErasureStatusFields = {
  deletedAt: Date | null;
};

/** True when the profile has been erased at the subject's request (soft-deleted). */
export function isErasedAccount(profile: ErasureStatusFields | null | undefined): boolean {
  return !!profile && profile.deletedAt !== null;
}

export function pathForRole(role: string, options: RoleOptions | boolean): string {
  const opts: RoleOptions =
    typeof options === "boolean" ? { hasOrgAdminMembership: options } : options;

  switch (role) {
    case "admin":
      return "/admin";
    case "govt":
    case "national":
      return "/gob";
    case "vet":
      if (opts.vetFirstOrgToken) return `/org/${opts.vetFirstOrgToken}`;
      if (opts.vetHasAnyMembership) return "/cuenta/memberships";
      return "/cuenta";
    case "owner":
      return opts.hasOrgAdminMembership ? "/org" : "/inicio";
    default:
      return "/inicio";
  }
}

// Resolve the correct landing path for a vet by querying their org memberships.
// Priority: admin/coordinator in an org → /org/[token]; exactly one other
// membership → /org/[thatToken] (single-membership shortcut, mirrors the owner
// rule); 2+ memberships → /cuenta/memberships; no memberships → /cuenta.
export async function resolveVetLanding(userId: string): Promise<string> {
  const [adminRow] = await db
    .select({ publicToken: organizations.publicToken })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        inArray(organizationMemberships.role, ["admin", "coordinator"]),
        isNull(organizationMemberships.leftAt),
      ),
    )
    .limit(1);

  if (adminRow) return `/org/${adminRow.publicToken}`;

  // No admin/coordinator membership → the rows below are all non-admin. Fetch at
  // most 2: knowing "0", "exactly 1", or "2+" is sufficient to decide.
  const memberRows = await db
    .select({ publicToken: organizations.publicToken })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(and(eq(organizationMemberships.userId, userId), isNull(organizationMemberships.leftAt)))
    .limit(2);

  if (memberRows.length === 0) return "/cuenta";
  // Single-membership shortcut — land the vet in their one clinic's work
  // surface directly, exactly as resolveUserLanding does for a single-org owner.
  if (memberRows.length === 1 && memberRows[0].publicToken) {
    return `/org/${memberRows[0].publicToken}`;
  }
  // 2+ memberships → let the vet pick from the list.
  return "/cuenta/memberships";
}

// Resolve the correct default landing path for any user by querying their role
// and active org memberships. Designed for OAuth / magic-link callbacks that have
// no explicit ?next= parameter and must pick the best starting surface.
//
// Priority order:
//  1. admin           → /admin
//  2. govt            → /gob
//  3. vet             → delegate to resolveVetLanding (existing logic)
//  4. owner / default:
//       - exactly 1 active org membership → /org/<publicToken>  (UX 0.5)
//       - 0 or >1 active memberships     → /inicio
//         (multi-org: the "Portales ▾" context-switcher handles selection;
//          a new picker page is explicitly out of scope for this fix)
export async function resolveUserLanding(userId: string): Promise<string> {
  const [profile] = await db
    .select({
      role: profiles.role,
      accountType: profiles.accountType,
      deactivatedAt: profiles.deactivatedAt,
      deletedAt: profiles.deletedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  // Erased (right-to-erasure) → never into a portal. /login renders the notice.
  if (isErasedAccount(profile)) return "/iniciar-sesion";

  // Deactivated institutional → never into a portal (guards bounce it back
  // to `/` and the redirects loop). /login renders the deactivated notice.
  if (isDeactivatedInstitutional(profile)) return "/iniciar-sesion";

  const role = profile?.role ?? "owner";

  // Institutional roles — fast path, no membership lookup needed.
  if (role === "admin") return "/admin";
  if (role === "govt" || role === "national") return "/gob";

  // Vet — delegate to existing resolveVetLanding.
  if (role === "vet") return resolveVetLanding(userId);

  // Owner (and any future personal role) — check active org memberships.
  // Fetch at most 2 rows: knowing "0", "exactly 1", or ">1" is sufficient.
  const memberships = await db
    .select({ publicToken: organizations.publicToken })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(and(eq(organizationMemberships.userId, userId), isNull(organizationMemberships.leftAt)))
    .limit(2);

  if (memberships.length === 1 && memberships[0].publicToken) {
    return `/org/${memberships[0].publicToken}`;
  }

  // Zero orgs (new owner) or more than one (multi-org owner) → personal home.
  return "/inicio";
}

// Validate a post-auth returnTo URL. Only same-origin paths starting with a
// single "/" are allowed — rejects protocol-relative ("//evil.com"),
// backslash tricks, and absolute URLs. Returns null when the input is unsafe,
// so callers can fall back to their role-based default.
//
// CONTROL CHARACTERS ARE REFUSED OUTRIGHT (2026-09-18). The string checks
// alone were not enough: `/%09/evil.com` decodes to "/\t/evil.com", which
// passes a "starts with one slash" test — and the WHATWG URL parser, which is
// what `window.location.assign` and every browser `Location` follow, STRIPS
// tab, LF and CR before parsing, so the browser saw "//evil.com" and left the
// origin. A legitimate in-app path never carries a control character, so any
// of them (C0, DEL, C1) is a refusal rather than something to clean up.
//
// And the verdict is then asked of the parser itself, not re-derived from the
// string: resolved against a placeholder origin, the path must stay on that
// origin and its pathname must start with exactly one "/". Whatever other
// normalisation a parser applies, the answer is the parser's.
const RETURN_TO_PROBE_ORIGIN = "https://return-to.invalid";

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value) return null;
  const decoded = (() => {
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  })();
  if (!decoded) return null;
  if (!decoded.startsWith("/")) return null;
  if (decoded.startsWith("//")) return null;
  if (decoded.includes("\\")) return null;
  if (hasControlCharacter(decoded)) return null;

  let parsed: URL;
  try {
    parsed = new URL(decoded, RETURN_TO_PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (parsed.origin !== RETURN_TO_PROBE_ORIGIN) return null;
  if (!parsed.pathname.startsWith("/") || parsed.pathname.startsWith("//")) return null;
  return decoded;
}
