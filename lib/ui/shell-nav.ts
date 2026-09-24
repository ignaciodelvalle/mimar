// shell-nav — the single auth-aware navigation decision for the unified
// AppShell (Item 7, spec §3 / D3 / D4 / D6 / D13).
//
// This is a PURE module: no React, no DB, no `headers()`, no async. It takes a
// plain description of the current request (who is logged in + the pathname +
// the role's nav source) and returns which shell variant to render, which nav
// to show, the guaranteed return target, and the context-switcher entitlements.
//
// Why it exists: today the public `(public)` layout hard-replaces the role nav
// with PUBLIC_NAV, so a logged-in owner who lands on `/adoptar` is *stranded* —
// the only way back is a truncated name chip that reads like "account", not
// "back to my pets". `resolveShellNav` fixes that: the nav is chosen by auth
// state, NOT by route-group. A public surface never replaces the role nav.
//
// Phase D note (strangler complete): the legacy chromes (LnOwnerNav / AppHeader /
// OpShell) are deleted in Phase D. All surfaces now render via AppShell. This
// resolver is the single decision core consumed by every layout.

import type { NavItem } from "@/components/layout/HeaderNav";
import { ADMIN_NAV, GOB_NAV, OWNER_NAV, PUBLIC_NAV } from "@/components/layout/nav-presets";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type ShellVariant = "citizen" | "operator" | "landing";

/** A role recognised by the shell. Mirrors `profiles.role`. */
export type ShellRole = "owner" | "vet" | "govt" | "admin" | "national";

/**
 * Minimal session shape the resolver needs. The caller (a server layout) is
 * responsible for fetching this; the resolver stays pure and synchronous.
 */
export type ShellSession = {
  role: ShellRole;
  displayName: string;
  /**
   * Pre-built FLAT org nav for the active `/org/[orgToken]` context, when the
   * user is operating inside one. Supplied by the org layout via
   * `buildOrgNavFlat` (the sectioned `buildOrgNav` is for the rail renderer).
   */
  orgNav?: NavItem[];
  /**
   * True when the user holds at least one `govt_assignments` entitlement, i.e.
   * an admin who may also operate the `/gob` surface. Feeds the switcher (D6).
   */
  govtAssignments?: boolean;
  /**
   * Org tokens the user is a member of (for the citizen→org switcher). Only the
   * presence/identity is needed here; capability checks stay in the layout.
   */
  orgMemberships?: { token: string; name: string }[];
};

export type ShellNavInput = {
  /** Null when anonymous. */
  session: ShellSession | null;
  /** The current pathname (e.g. from `usePathname()` or the request URL). */
  pathname: string;
};

/** A single destination offered by the context switcher (D6). */
export type SwitcherTarget = {
  key: "citizen" | "gob" | "admin" | "org";
  label: string;
  href: string;
};

export type ShellNavResult = {
  /** Which shell chrome to render. */
  variant: ShellVariant;
  /** The flat nav to show. Empty for `landing`. */
  nav: NavItem[];
  /** Whether a guaranteed role-return affordance must be shown (D4). */
  showReturn: boolean;
  /** Where the return affordance points, when `showReturn` is true. */
  returnHref?: string;
  /** Context-switcher destinations — only entitled ones, never empty-rendered (D6). */
  switcher: SwitcherTarget[];
};

// ---------------------------------------------------------------------------
// Route classification
// ---------------------------------------------------------------------------

/** Operator route-group prefixes — these force the `operator` variant. */
const OPERATOR_PREFIXES = ["/gob", "/admin", "/org/"] as const;

/**
 * Token-landing surfaces (D13): credential / share / invite pages that must
 * render the minimal trust chrome, NOT the public browse chrome. This decision
 * is auth-independent — a logged-in owner scanning a QR still sees `landing`.
 *
 * Matched as `/p/<token>` (+ sub-actions), `/libreta/compartir/<token>`, and
 * `/r/invite/<token>`. Note the owner libreta surface is exactly `/libreta`
 * (browse), which must NOT match — only `/libreta/compartir/...` is a landing.
 */
export function isTokenLandingPath(pathname: string): boolean {
  if (pathname === "/p" || pathname.startsWith("/p/")) return true;
  if (pathname.startsWith("/libreta/compartir/")) return true;
  if (pathname === "/r/invite" || pathname.startsWith("/r/invite/")) return true;
  return false;
}

function isOperatorPath(pathname: string): boolean {
  return OPERATOR_PREFIXES.some((p) => pathname.startsWith(p));
}

/** The home surface for a given role (D5: the role's "Inicio"). */
function roleHome(role: ShellRole): string {
  switch (role) {
    case "owner":
    case "vet":
      return "/inicio";
    case "govt":
    case "national":
      return "/gob";
    case "admin":
      return "/admin";
  }
}

/**
 * The citizen nav for a personal role. owner + vet both navigate the citizen
 * world via OWNER_NAV (their personal pets surface). Institutional roles never
 * reach the citizen branch, so a single source is correct here; the parameter
 * is kept so a future vet-specific nav can diverge without a signature change.
 */
function citizenNavFor(_role: ShellRole): NavItem[] {
  return OWNER_NAV;
}

// ---------------------------------------------------------------------------
// Context switcher (D6)
// ---------------------------------------------------------------------------

/**
 * Build the entitlement-filtered context-switcher destinations (D6). Exported
 * so the `ContextSwitcher` component reuses the exact same entitlement logic
 * without re-deriving it. Returns `[]` for a single-context user — the caller
 * renders nothing in that case.
 *
 * Surface-aware: the admin ⇄ gob pair depends on where the operator currently
 * is, not on role alone. `pathname` is the current request path.
 *
 * Institutional roles (govt/admin) get NO "volver a ciudadano" target: they are
 * service accounts with no owner identity and cannot own pets (DB-enforced), so
 * `/mis-mascotas` only bounces them back. The citizen escape is for personal
 * roles (owner/vet) operating inside an org context — handled by the role-return
 * affordance in `resolveShellNav`, not here.
 */
export function buildSwitcher(session: ShellSession | null, pathname: string): SwitcherTarget[] {
  if (!session) return [];

  const targets: SwitcherTarget[] = [];
  const { role, govtAssignments, orgMemberships } = session;

  // admin ⇄ gob, surface-aware (the bug this fixes: there was no way back to
  // /admin from /gob, because the switcher was built from role alone).
  if (role === "admin") {
    const onGob = pathname === "/gob" || pathname.startsWith("/gob/");
    if (onGob) {
      // From /gob, an admin (universal scope) must always be able to return to
      // the admin panel — independent of govtAssignments.
      targets.push({ key: "admin", label: "Volver a Admin", href: "/admin" });
    } else if (govtAssignments) {
      // From /admin (or any non-gob surface), offer the hop to /gob when the
      // admin also holds govt assignments.
      targets.push({ key: "gob", label: "Ir a Gobierno", href: "/gob" });
    }
  }

  // owner/vet who belongs to one or more orgs may hop into the org operator
  // surface. Only entitled orgs are listed.
  if ((role === "owner" || role === "vet") && orgMemberships?.length) {
    for (const m of orgMemberships) {
      targets.push({
        key: "org",
        label: m.name,
        href: `/org/${m.token}`,
      });
    }
  }

  return targets;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export function resolveShellNav(input: ShellNavInput): ShellNavResult {
  const { session, pathname } = input;
  const switcher = buildSwitcher(session, pathname);

  // D13 — token-landing wins over everything, regardless of auth state.
  if (isTokenLandingPath(pathname)) {
    return {
      variant: "landing",
      nav: [],
      // A logged-in user still gets a discreet "back to my app"; an anon user
      // gets no return (there is nowhere to return to).
      showReturn: Boolean(session),
      returnHref: session ? roleHome(session.role) : undefined,
      switcher,
    };
  }

  // Anonymous — citizen browse chrome with the public nav.
  if (!session) {
    return {
      variant: "citizen",
      nav: PUBLIC_NAV,
      showReturn: false,
      switcher,
    };
  }

  const { role } = session;
  const onOperatorPath = isOperatorPath(pathname);

  // Institutional roles (govt/admin) live in the operator variant. They keep it
  // even when they wander onto a public browse surface — they don't "fall" to
  // citizen-public; instead they get an explicit return (D3, §3 last bullet).
  if (role === "govt" || role === "admin") {
    const nav = role === "admin" ? ADMIN_NAV : GOB_NAV;
    if (onOperatorPath) {
      return { variant: "operator", nav, showReturn: false, switcher };
    }
    // Operator stranded on a public surface → keep operator chrome, offer a
    // return to THEIR app.
    //
    // `roleHome(role)`, not "/mis-mascotas". This used to point at the citizen
    // world and call it "their personal escape hatch" — but an institutional
    // role has no citizen world to escape to: app/(app)/layout.tsx redirects
    // govt to /gob and admin to /admin before /mis-mascotas ever renders. So
    // the link advertised a destination the product refuses to serve, and a
    // funcionario clicking it on /adoptar landed back on /gob after a pointless
    // redirect (measured 2026-08-08). The href now says where you will actually
    // end up, and the hop is gone.
    //
    // The label "Volver a mi app" needs no change — for these roles their app
    // IS the portal. Line ~204 already resolved this correctly through the same
    // helper; this branch was the one that hardcoded.
    return {
      variant: "operator",
      nav,
      showReturn: true,
      returnHref: roleHome(role),
      switcher,
    };
  }

  // Personal roles operating inside an org context use the operator rail with
  // the supplied org nav (D1: operator variant absorbs the org chrome).
  if (onOperatorPath && pathname.startsWith("/org/") && session.orgNav) {
    return {
      variant: "operator",
      nav: session.orgNav,
      showReturn: true,
      returnHref: "/mis-mascotas",
      switcher,
    };
  }

  // Personal role on any non-operator surface — including public browse pages.
  // THE STRANDED-USER FIX (D3/D4) still holds for the NAV: it's kept, never
  // replaced by PUBLIC_NAV, regardless of how far off-home the user wanders.
  //
  // The separate "Volver a mi app" RETURN affordance used to also render
  // here whenever `offHome` (D4's original guarantee). Wave-3 P6 (PO
  // decision #645 point 5) removed it for THIS branch only: `citizenNavFor`
  // (OWNER_NAV) always renders and carries "Mis mascotas" → /mis-mascotas,
  // the owner surface index — a guaranteed 1-click way back into the owner
  // app that made the chip a near-duplicate on every citizen page. (PO ronda
  // 4 later removed OWNER_NAV's "Inicio" item entirely; `roleHome(role)`
  // stays "/inicio" — a courtesy redirect into the most-urgent credential —
  // for the OTHER `showReturn` call sites that still use it.) Those call
  // sites above are untouched and stay true: token-landing (D13) renders NO
  // nav at all, and the operator branches (govt/admin stranded on a public
  // surface, or a personal role inside an org context) use ADMIN_NAV/GOB_NAV/
  // org nav, none of which link back to /mis-mascotas — for those, the
  // return affordance is still the only way back.
  return {
    variant: "citizen",
    nav: citizenNavFor(role),
    showReturn: false,
    switcher,
  };
}
