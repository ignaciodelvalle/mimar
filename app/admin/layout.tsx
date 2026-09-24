import { logoutAction } from "@/app/actions/auth";
import { Icon } from "@/components/Icon";
import { AppShell } from "@/components/layout/AppShell";
import { AppShellDrawer } from "@/components/layout/AppShellDrawer";
import { ContextSwitcher } from "@/components/layout/ContextSwitcher";
import { ADMIN_NAV_SECTIONS } from "@/components/layout/nav-presets";
import { DemoModeBanner } from "@/components/ui/DemoModeBanner";
import type { NavSection } from "@/components/ui/dashboard";
import { OpMaintenanceScreen } from "@/components/ui/dashboard/OpMaintenanceScreen";
import { OpOfflineBanner } from "@/components/ui/dashboard/OpOfflineBanner";
import { OpOmnibox } from "@/components/ui/dashboard/OpOmnibox";
import { OpRail } from "@/components/ui/dashboard/OpRail";
import { OpScopeChip } from "@/components/ui/dashboard/OpScopeChip";
import { OperatorBreadcrumbs } from "@/components/ui/dashboard/OperatorBreadcrumbs";
import { loadWithTimeout } from "@/lib/analytics/analytics-load";
import { shouldShowDemoBanner } from "@/lib/domain/demo-mode";
import { roleLabel } from "@/lib/domain/role-labels";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { isPlatformInMaintenance } from "@/lib/infra/live-user";
import { countOutboxBreaches } from "@/lib/infra/outbox-queries";
import { getProfileCached } from "@/lib/infra/request-cache";
import { countOpenAlertFirings } from "@/lib/metrics/alert-firing-inbox";
import { BRANDING } from "@/lib/ui/branding";
import type { ShellSession } from "@/lib/ui/shell-nav";
import type { Metadata } from "next";

// Gate the /admin/* segment. Admin-only — govt and everyone else gets sent
// to / (root). Uses the strict requireAdminOrRedirect guard which also rejects
// deactivated admins (Fase 5 invariant).

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
    default: `Admin — ${BRANDING.appName}`,
    template: `%s · Admin — ${BRANDING.appName}`,
  },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Maintenance kill-switch short-circuits BEFORE any auth/data fetch — no
  // rail/topbar data exists yet, so the screen renders full-page, unwrapped.
  if (isPlatformInMaintenance()) {
    return <OpMaintenanceScreen />;
  }

  const { profile } = await requireAdminOrRedirect();

  // Global breach count (pending rows past their SLA deadline). Shared with the
  // outbox banner via countOutboxBreaches() so the badge and the banner can
  // never disagree (C2). Uses the outbox_sla_due_idx(sla_due_at, status) index.
  // Open-alerts count (WS-K): firings not yet resuelta/descartada → /admin/alertas badge.
  //
  // These are OPTIONAL nav badges, not gate queries — error.tsx does not catch
  // a throw from this layout (Next.js does not wrap a segment's own layout.tsx
  // in its sibling error.tsx boundary), so a transient failure here would
  // bypass app/admin/error.tsx entirely and fall through to the fullscreen
  // root boundary (error-path audit 2026-07-04, finding E4). Default to 0 and
  // log instead of letting the whole admin shell go down over a badge count.
  // …and the `.catch`es below guard a REJECTION, which is not the failure that
  // took staging down. A degraded pooler does not reject — it HANGS, and this
  // await is in the layout of every /admin/* route, so a hung badge count hangs
  // the entire portal with (as the note above establishes) no error boundary to
  // land in. The deadline is what closes that second mode; 4s because these are
  // nav badges and nothing on the page waits on them for meaning.
  const badges = await loadWithTimeout(
    Promise.all([
      countOutboxBreaches().catch((err) => {
        console.error("[AdminLayout] countOutboxBreaches failed", err);
        return 0;
      }),
      countOpenAlertFirings().catch((err) => {
        console.error("[AdminLayout] countOpenAlertFirings failed", err);
        return 0;
      }),
    ]),
    4_000,
  );
  // Same 0-on-failure convention the catches above already chose, now covering
  // the timeout too.
  const [breachCount, openAlertCount] = badges.ok ? badges.value : [0, 0];

  // getProfileCached is already warmed by requireAdminOrRedirect above —
  // this call is a memoized hit, not a second DB round-trip.
  const profileRow = await getProfileCached(profile.id);
  const displayName = profileRow?.displayName ?? "";

  // Inject runtime badges into the nav sections: the outbox breach count on
  // /admin/outbox and the open-alerts count on /admin/alertas (WS-K). A single
  // map pass covers both so we never clone the sections twice.
  const needsBadges = breachCount > 0 || openAlertCount > 0;
  const sections: NavSection[] = needsBadges
    ? ADMIN_NAV_SECTIONS.map((section) => ({
        ...section,
        items: section.items.map((item) => {
          if (item.href === "/admin/outbox" && breachCount > 0) {
            return { ...item, badge: breachCount };
          }
          if (item.href === "/admin/alertas" && openAlertCount > 0) {
            return { ...item, badge: openAlertCount };
          }
          return item;
        }),
      }))
    : ADMIN_NAV_SECTIONS;

  // Build the session shape for the context switcher.
  // Admin always holds govtAssignments (they can access /gob).
  const switcherSession: ShellSession = {
    role: profile.role,
    displayName,
    govtAssignments: true,
  };

  const topbarActions = (
    <div className="flex items-center gap-3">
      {/* Account text label — hidden <md (mobile-polish 2026-07: it bled off
          the 390px viewport). The universal scope stays disclosed via the
          scope chip (>=md) and each page's ViewScopeCaption. */}
      <span className="hidden text-xs text-ln-op-mute md:inline">
        <span className="font-semibold text-ln-op-ink-2">{roleLabel(profile.role)}</span>
        <span className="mx-1">·</span>
        Universal
      </span>
      {/* ContextSwitcher (D6): replaces the ad-hoc "Ir a Gobierno →" link. */}
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

  // Demo banner flag (A1): shouldShowDemoBanner now lives in the server-safe
  // lib/demo-mode module, so the server layout can call it directly without
  // pulling in the "use client" banner module (which crashed /admin before).
  const demoMode = shouldShowDemoBanner(process.env.NEXT_PUBLIC_DEMO_MODE);

  return (
    <AppShell
      variant="operator"
      banner={
        <>
          <DemoModeBanner enabled={demoMode} />
          <OpOfflineBanner />
        </>
      }
      rail={
        <OpRail
          sections={sections}
          variant="gob"
          brandSubtitle="Administración"
          user={{
            name: displayName,
            role: roleLabel(profile.role).toUpperCase(),
          }}
        />
      }
      topbar={
        <header
          data-testid="admin-topbar"
          className="sticky top-0 z-[var(--z-header)] flex flex-shrink-0 flex-nowrap items-center gap-3 border-b border-ln-op-line bg-ln-op-card px-4 py-[11px] md:px-6"
        >
          {/* Mobile hamburger — AppShellDrawer mirrors the desktop rail. */}
          <AppShellDrawer sections={sections} variant="gob" brandSubtitle="Administración" />
          {/* Left group: breadcrumbs + scope chip. Grows to fill (pushing the
                omnibox + actions right) and is the ONLY shrinkable region, so the
                breadcrumb truncates rather than wrapping the topbar (D1). */}
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {/* Breadcrumbs — derived from route (UX 1.2); truncates when tight.
                Hidden <md (mobile-polish 2026-07): the drawer + page H1 orient
                the operator on a phone; the crumb trail is desktop chrome. */}
            <div className="hidden min-w-0 flex-shrink md:block">
              <OperatorBreadcrumbs portal="admin" />
            </div>
            {/* Scope chip — neutral/outline so it never out-weighs the page H1 (D1). */}
            <OpScopeChip code="SUPERADMIN" label="Universal" variant="neutral" />
          </div>
          {/* Global search omnibox (Item 10) — operator jump-to-record + PII log.
              Admin searches with universal scope, so the empty state must not
              say "en tu jurisdicción" (Cowork B3). */}
          <div className="flex-shrink-0">
            <OpOmnibox universalScope />
          </div>
          {/* Right: switcher + logout */}
          <div className="flex flex-shrink-0 items-center gap-2">{topbarActions}</div>
        </header>
      }
    >
      {children}
    </AppShell>
  );
}
