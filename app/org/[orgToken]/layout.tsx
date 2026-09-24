// Org portal layout — validates active membership for the requested orgToken.
// Returns notFound() if the org does not exist or the user has no active
// membership, so callers cannot distinguish "org exists but you're not a
// member" from "no such org" (decision D4 — no information leakage).
//
// Every page under /org/[orgToken]/* can assume the membership is valid.
// The orgToken (organizations.publicToken) is the URL-stable identifier used
// throughout this portal instead of inferring an "active org" from session.

import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import { BRANDING } from "@/lib/ui/branding";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { logoutAction } from "@/app/actions/auth";
import { AppShell } from "@/components/layout/AppShell";
import { AppShellDrawer } from "@/components/layout/AppShellDrawer";
import { buildOrgNav } from "@/components/layout/nav-presets";
import { DemoModeBanner } from "@/components/ui/DemoModeBanner";
import type { NavSection } from "@/components/ui/dashboard";
import { OpMaintenanceScreen, OpOfflineBanner, OpOmnibox } from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { OpRail } from "@/components/ui/dashboard/OpRail";
import { OpScopeChip } from "@/components/ui/dashboard/OpScopeChip";
import { OrgBreadcrumbs } from "@/components/ui/dashboard/OrgBreadcrumbs";
import type { OrganizationCapability } from "@/db";
import { applicableOrgQueues } from "@/lib/analytics/org-dashboard";
import { shouldShowDemoBanner } from "@/lib/domain/demo-mode";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { isPlatformInMaintenance } from "@/lib/infra/live-user";
import {
  getOrgQueueCountsCached,
  getProfileCached,
  orgQueueCacheKey,
} from "@/lib/infra/request-cache";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";

import { loadOrgShellAccess } from "./_lib/org-shell-access";

// One topbar class for both frames (the normal portal and the degraded one a
// missed membership deadline renders), so the two cannot drift apart.
const ORG_TOPBAR_CLASS =
  "sticky top-0 z-[var(--z-header)] flex flex-shrink-0 items-center gap-3 border-b border-ln-op-line bg-ln-op-card px-6 py-[11px]";

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
    default: `Organización — ${BRANDING.appName}`,
    template: `%s · Organización — ${BRANDING.appName}`,
  },
};

export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgToken: string }>;
}) {
  // Maintenance kill-switch short-circuits BEFORE any auth/data fetch — no
  // rail/topbar data exists yet, so the screen renders full-page, unwrapped.
  if (isPlatformInMaintenance()) {
    return <OpMaintenanceScreen />;
  }

  const { orgToken } = await params;

  // BOUNDED (T1-L18). The membership check, the profile and the capabilities
  // used to be awaited bare right here, in front of the badge block below whose
  // own comment explains why that hangs the whole portal. One deadline now
  // covers all three — see ./_lib/org-shell-access.ts for how each degrades.
  //
  // Membership validation still returns notFound() on failure — never leaks
  // org existence — because loadWithTimeout re-throws Next's control flow.
  // getProfileCached is warmed by requireOrgAccessByToken → requireUserOrRedirect,
  // so the profile read is a memoized hit within the same render pass.
  //
  // Capability-gated items (Ingresos, Check-ins, Permisos) only render for
  // members holding the matching capability. The pages re-check defensively;
  // the nav filter is UX, not the security boundary — so a query failure here
  // must never take down the whole org shell. Next.js does not wrap a
  // segment's own layout.tsx in its sibling error.tsx boundary, so an
  // unguarded throw would bypass app/org/[orgToken]/error.tsx and fall through
  // to the fullscreen root boundary (error-path audit 2026-07-04, finding E4).
  // Default to no granted capabilities: nav items simply stay hidden, and the
  // page-level defensive re-check still protects the actual security boundary.
  const shell = await loadOrgShellAccess(orgToken, {
    requireAccess: requireOrgAccessByToken,
    getProfile: getProfileCached,
    getGranted: (session) =>
      getGrantedCapabilities(session.membership).catch((err) => {
        console.error("[OrgLayout] getGrantedCapabilities failed", err);
        return new Set<OrganizationCapability>();
      }),
  });

  // Right-side topbar actions: personal cross-portal links + a reliable sign-out.
  // ContextSwitcher is not added here: owner/vet with no additional org memberships
  // returns an empty switcher.
  //
  // Two distinct affordances (portal-logout consistency, PO QA §4): the old
  // "← Salir" pointed at /mis-mascotas — an ambiguous label whose back-arrow
  // read as "sign out" but actually only switched to the personal app, leaving
  // the org portal with NO real logout. Now:
  //   - "Ir a mi app" → the personal owner surface (/mis-mascotas), labelled for
  //     what it does (navigate, not sign out).
  //   - "Cerrar sesión" → logoutAction, matching /gob and /admin so every
  //     operator portal owns a reliable, consistently-placed sign-out.
  const topbarActions = (
    <div className="flex items-center gap-3">
      <Link href="/cuenta" className="text-xs text-ln-op-mute no-underline hover:text-ln-op-ink">
        Mi cuenta
      </Link>
      <Link
        href="/mis-mascotas"
        className="text-xs text-ln-op-mute no-underline hover:text-ln-op-ink"
      >
        Ir a mi app
      </Link>
      <form action={logoutAction}>
        <button
          type="submit"
          className="cursor-pointer border-0 bg-transparent p-0 text-xs text-ln-op-mute hover:text-ln-op-ink"
        >
          Cerrar sesión →
        </button>
      </form>
    </div>
  );

  const banner = (
    <>
      <DemoModeBanner enabled={shouldShowDemoBanner(process.env.NEXT_PUBLIC_DEMO_MODE)} />
      <OpOfflineBanner />
    </>
  );

  if (!shell.ok) {
    // The membership check did not finish: this layout has NOT authorised the
    // children, so it must not render them. It keeps the shell's frame — the
    // sign-out above all — and says the portal could not load, with a retry
    // into the org home (a layout does not know the child's path).
    return (
      <AppShell
        variant="operator"
        banner={banner}
        rail={
          <OpRail
            sections={[]}
            variant="org"
            brandSubtitle="Organización"
            user={{ name: "", role: "ORG" }}
          />
        }
        topbar={
          <header className={ORG_TOPBAR_CLASS}>
            <div className="flex-1" />
            {topbarActions}
          </header>
        }
      >
        <AnalyticsLoadFallback
          reason={shell.reason}
          correlationId={shell.id}
          retryHref={analyticsRetryHref(`/org/${orgToken}`)}
        />
      </AppShell>
    );
  }

  const {
    session: { organization, membership },
    displayName,
    granted,
  } = shell.value;
  const orgNavSections = buildOrgNav(orgToken, {
    granted,
    orgType: organization.orgType,
    // Role gates the two role-based nav items (Maltrato welfare inbox,
    // Configuración admin-only) so the sidebar matches each page's own guard.
    role: membership.role,
  });

  // Nav pending-count badges (task #18): reuse the org pending-queue engine —
  // the SAME applicability + counts as the panel "Pendientes" surface — and
  // overlay each actionable nav item with its live count. ONE batched fetch
  // covers every badge. Only badgeable queues (those that map to a nav item)
  // participate; informational queues (tránsitos activos) carry no badge.
  //
  // The full `applicableOrgQueues` list (not just the navPath subset) is
  // fetched here — same key set the page below asks for — so `getOrgQueueCountsCached`
  // (request-memoized by (orgId, sorted key list)) hits ONE shared batch for
  // the whole render pass instead of layout + page each issuing it (adversarial
  // review 2026-07-10, MED 11). Badges are filtered from the shared result.
  //
  // Resilient like the admin outbox/alertas badges: a badge-count failure must
  // never take down the org shell (badges are UX, not a security gate), and
  // Next does not wrap a segment's own layout.tsx in its sibling error.tsx —
  // an unguarded throw here would bypass app/org/[orgToken]/error.tsx and fall
  // through to the fullscreen root boundary. `fetchOrgQueueCounts` itself never
  // rejects on an individual counter failure (it degrades that key to `null`),
  // so ONE bad query silently drops ONE badge instead of blanking every badge
  // (MED 10) — the outer `.catch` below is only a last-resort backstop for a
  // truly unexpected throw.
  const orgQueues = applicableOrgQueues(organization.orgType, granted, membership.role);
  const badgeQueues = orgQueues.filter((q) => q.navPath !== undefined);
  const queueCounts =
    orgQueues.length > 0
      ? // BOUNDED (2026-08-09). fetchOrgQueueCounts fans out up to eight
        // counters, and this runs in the LAYOUT of every /org/* route. The
        // .catch below guards a REJECTION; a degraded pooler does not reject,
        // it hangs — the identical bug fixed in app/admin/layout.tsx one commit
        // earlier, whose reasoning this file's own comment block already
        // states. Carrying the sentence over without the deadline is exactly
        // how it recurred.
        await loadWithTimeout(
          getOrgQueueCountsCached(
            organization.id,
            orgQueueCacheKey(orgQueues.map((q) => q.key)),
          ).catch((err) => {
            console.error("[OrgLayout] getOrgQueueCountsCached failed", err);
            return null;
          }),
          3_000,
        ).then((r) => (r.ok ? r.value : null))
      : null;

  const badgeByHref = new Map<string, number>();
  if (queueCounts) {
    for (const q of badgeQueues) {
      const n = queueCounts[q.key];
      if (q.navPath && n !== null && n > 0) {
        badgeByHref.set(`/org/${orgToken}/${q.navPath}`, n);
      }
    }
  }

  const navSections: NavSection[] =
    badgeByHref.size > 0
      ? orgNavSections.map((section) => ({
          ...section,
          items: section.items.map((item) => {
            const badge = badgeByHref.get(item.href);
            return badge ? { ...item, badge } : item;
          }),
        }))
      : orgNavSections;

  // Omnibox: show only for members with pet read access.
  const canSearchPets = granted.has("pet.read_held") || membership.role === "admin";

  return (
    <AppShell
      variant="operator"
      banner={banner}
      rail={
        <OpRail
          sections={navSections}
          variant="org"
          brandSubtitle="Organización"
          user={{ name: displayName, role: "ORG" }}
        />
      }
      topbar={
        <header className={ORG_TOPBAR_CLASS}>
          {/* Mobile hamburger — AppShellDrawer mirrors the desktop rail. */}
          <AppShellDrawer sections={navSections} variant="org" brandSubtitle="Organización" />
          {/* Left: org breadcrumbs (client component, uses usePathname) */}
          <OrgBreadcrumbs orgToken={orgToken} />
          {/* Scope chip */}
          <OpScopeChip code="ORG" label={organization.displayName} variant="org" />
          {/* Spacer */}
          <div className="flex-1" />
          {/* Right: omnibox (capability-gated) + actions */}
          <div className="flex items-center gap-2">
            {canSearchPets && <OpOmnibox orgToken={orgToken} />}
            {topbarActions}
          </div>
        </header>
      }
    >
      {children}
    </AppShell>
  );
}
