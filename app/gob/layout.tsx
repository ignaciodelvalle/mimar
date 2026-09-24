import { logoutAction } from "@/app/actions/auth";
import { Icon } from "@/components/Icon";
import { AppShell } from "@/components/layout/AppShell";
import { AppShellDrawer } from "@/components/layout/AppShellDrawer";
import { ContextSwitcher } from "@/components/layout/ContextSwitcher";
import { GovtJurisdictionsChip } from "@/components/layout/GovtJurisdictionsChip";
import { GOB_NAV_SECTIONS } from "@/components/layout/nav-presets";
import { DemoModeBanner } from "@/components/ui/DemoModeBanner";
import { OpMaintenanceScreen } from "@/components/ui/dashboard/OpMaintenanceScreen";
import { OpOfflineBanner } from "@/components/ui/dashboard/OpOfflineBanner";
import { OpOmnibox } from "@/components/ui/dashboard/OpOmnibox";
import { OpRail } from "@/components/ui/dashboard/OpRail";
import { OpScopeChip } from "@/components/ui/dashboard/OpScopeChip";
import { OperatorBreadcrumbs } from "@/components/ui/dashboard/OperatorBreadcrumbs";
import { shouldShowDemoBanner } from "@/lib/domain/demo-mode";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { roleLabel } from "@/lib/domain/role-labels";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { isPlatformInMaintenance } from "@/lib/infra/live-user";
import { getProfileCached } from "@/lib/infra/request-cache";
import { BRANDING } from "@/lib/ui/branding";
import { describeMandate } from "@/lib/ui/scope-chrome";
import type { ShellSession } from "@/lib/ui/shell-nav";
import type { Metadata } from "next";

// Gate the /gob/* segment. admin, govt and national can access this surface.
// Admin and national have universal READ scope; govt is scoped to their
// assigned localities; national additionally writes nothing (every mutating
// action gates on requireAdminOrGovtOrRedirect, which refuses it).
// requireGobReadAccessOrRedirect rejects deactivated accounts (deactivated_at IS
// NOT NULL) by redirecting to /, so a deactivated operator cannot reach any
// /gob surface or invoke its server actions.

// A funcionario works with three portals open at once, and all four of them
// returned the ROOT title verbatim — "miMAR — Mi Mascota Argentina" — so the
// browser tabs were indistinguishable (QA 2026-08-07). The public routes were
// already fine; only the authenticated portals inherited.
//
// `template` rather than a flat string: a page that sets its own title gets
// "Denuncias · Gobierno — miMAR", and one that sets none falls back to
// `default`. The portal name is the part that has to survive truncation in a
// narrow tab, so it goes before the brand.
export const metadata: Metadata = {
  title: {
    default: `Gobierno — ${BRANDING.appName}`,
    template: `%s · Gobierno — ${BRANDING.appName}`,
  },
};

export default async function GobiernoLayout({ children }: { children: React.ReactNode }) {
  // Maintenance kill-switch short-circuits BEFORE any auth/data fetch — no
  // rail/topbar data exists yet, so the screen renders full-page, unwrapped.
  if (isPlatformInMaintenance()) {
    return <OpMaintenanceScreen />;
  }

  const { profile, jurisdictions } = await requireGobReadAccessOrRedirect();

  // C3 (ONE VIEWSCOPE, plan-maestro-integridad §C3): this layout is SHARED
  // across every /gob/* page and renders once per navigation — it has no
  // access to a page's own searchParams/filter, so it can only ever describe
  // the operator's MANDATE (their session assignments), never the page's
  // resolved VIEW. describeMandate() is the one allowlisted computation site
  // (lint:view-scope fences a raw `jurisdictions.length` read here) — it fixes
  // the verified S3 symptom (a shared badge claiming a raw enumerable count as
  // if it were the current, possibly-filtered view). A page whose OWN filter
  // narrows below this mandate discloses that separately (ViewScopeCaption).
  const scopeCode = hasNationalReadScope(profile.role)
    ? "Nacional"
    : describeMandate(jurisdictions);

  // The gob portal shows the GOB rail — to everyone who is in it, admins
  // included.
  //
  // This used to swap in the ADMIN rail + brand for an admin viewer
  // (red-team-admin-2 P2.1, a891f111): back then an admin reached this segment
  // through /admin/moderacion's REDIRECT, so they landed on "miMAR GOBIERNO"
  // without having asked, and it read as "I left my portal / a permissions
  // bug". Right fix for that entry path.
  //
  // That entry path no longer exists. The F1 fusion (2026-07-22) turned
  // Moderación into a stage of the Denuncias hub, /admin/moderacion is its own
  // page again, and nothing under app/admin — nav preset, link or omnibox
  // result — points into /gob any more. The only remaining way in is the
  // switcher's explicit "Ir a Gobierno" (lib/ui/shell-nav.ts).
  //
  // So the override had inverted: the product opened a door and then refused
  // to let you through it. An admin who chose Gobierno got the Admin rail —
  // 19 links back to /admin — so the sections never changed and every click
  // bounced them home (PO report 2026-08-08). PO decision: honour the hop.
  //
  // "You are an admin here" is still said, twice, by chrome that was already
  // role-aware and stays that way: the scope chip reads SUPERADMIN / Nacional,
  // and the switcher offers "Volver a Admin" from anywhere under /gob.
  const navSections = GOB_NAV_SECTIONS;
  const brandSubtitle = "Gobierno";

  // getProfileCached is already warmed by requireAdminOrGovtOrRedirect above —
  // this call is a memoized hit, not a second DB round-trip.
  const profileRow = await getProfileCached(profile.id);
  const displayName = profileRow?.displayName ?? "";

  // Build the session shape for the context switcher.
  // admin visiting /gob always has govtAssignments (that is the prerequisite).
  const switcherSession: ShellSession = {
    role: profile.role,
    displayName,
    // An admin can always hop between /gob and /admin — govtAssignments=true.
    // A govt user gets only the "volver a ciudadano" escape.
    govtAssignments: profile.role === "admin",
  };

  const topbarActions = (
    <div className="flex items-center gap-3">
      {/* Account text label — hidden <md (mobile-polish 2026-07: it bled off
          the 390px viewport). The mandate stays disclosed via the scope chip
          (>=md) and each page's ViewScopeCaption. */}
      <span className="hidden text-xs text-ln-op-mute md:inline">
        <span className="font-semibold text-ln-op-ink-2">{roleLabel(profile.role)}</span>
        <span className="mx-1">·</span>
        {scopeCode}
      </span>
      {/* ContextSwitcher (D6): replaces the ad-hoc "Ir a Admin →" link. */}
      <ContextSwitcher session={switcherSession} />
      {/* Logout — institutional roles are bounced out of /mis-mascotas and
          /cuenta by the (app) layout, so the portal must own its sign-out.
          <md it collapses to an icon (same budget fix as the account label);
          the aria-label keeps the accessible name in both forms. */}
      <form action={logoutAction}>
        <button
          type="submit"
          aria-label="Cerrar sesión"
          className="inline-flex cursor-pointer items-center justify-center border-0 bg-transparent p-2 text-xs text-ln-op-mute hover:text-ln-op-ink md:p-0"
        >
          <Icon name="logout" size={16} decorative className="md:hidden" />
          <span className="hidden md:inline">Cerrar sesión →</span>
        </button>
      </form>
    </div>
  );

  return (
    <AppShell
      variant="operator"
      banner={
        <>
          <DemoModeBanner enabled={shouldShowDemoBanner(process.env.NEXT_PUBLIC_DEMO_MODE)} />
          <OpOfflineBanner />
        </>
      }
      rail={
        <OpRail
          sections={navSections}
          variant="gob"
          brandSubtitle={brandSubtitle}
          user={{
            name: displayName,
            role: roleLabel(profile.role).toUpperCase(),
          }}
        />
      }
      topbar={
        <header className="sticky top-0 z-[var(--z-header)] flex flex-shrink-0 flex-nowrap items-center gap-3 border-b border-ln-op-line bg-ln-op-card px-4 py-[11px] md:px-6">
          {/* Mobile hamburger — AppShellDrawer mirrors the desktop rail. */}
          <AppShellDrawer sections={navSections} variant="gob" brandSubtitle={brandSubtitle} />
          {/* Left group: breadcrumbs + scope chip. Grows to fill and is the
              ONLY shrinkable region (same D1 discipline as the admin topbar),
              so the breadcrumb truncates instead of pushing chrome off-screen. */}
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {/* Breadcrumbs — derived from route (UX 1.2). Hidden <md
                (mobile-polish 2026-07): the drawer + page H1 orient the
                operator on a phone; the crumb trail is desktop chrome. */}
            <div className="hidden min-w-0 flex-shrink md:block">
              <OperatorBreadcrumbs portal="gob" />
            </div>
            {/* Scope chip. A multi-locality govt gets the expandable variant so
                the operator can see WHICH jurisdictions they cover (Cowork M5),
                not just the count. Admin (universal) and single-locality govt
                already read their full scope in the label (>=md; <md the chip
                collapses to its portal code — see OpScopeChip). */}
            {!hasNationalReadScope(profile.role) && jurisdictions.length > 1 ? (
              <GovtJurisdictionsChip label={scopeCode} jurisdictions={jurisdictions} />
            ) : (
              <OpScopeChip
                code={
                  profile.role === "admin"
                    ? "SUPERADMIN"
                    : profile.role === "national"
                      ? "NACIONAL"
                      : "GOB"
                }
                label={scopeCode}
                variant={profile.role === "admin" ? "superadmin" : "default"}
              />
            )}
          </div>
          {/* Global search omnibox (Item 10) — operator jump-to-record + PII log.
              An admin visiting /gob searches universally; a govt is scoped to its
              jurisdictions (Cowork B3). <md it rests as an icon trigger that
              expands to a full-width row over the topbar (see OpOmnibox).
              NOT rendered for the read-only national role: the omnibox is a
              PII person/pet lookup backed by a server action that gates on the
              write-authority guard (admin | govt), so for a national it could
              only ever answer with a bounce. The aggregate dashboards are the
              national surface; record-level PII search is not. */}
          {profile.role !== "national" && <OpOmnibox universalScope={profile.role === "admin"} />}
          {/* Right: switcher + logout */}
          <div className="flex flex-shrink-0 items-center gap-2">{topbarActions}</div>
        </header>
      }
    >
      {children}
    </AppShell>
  );
}
