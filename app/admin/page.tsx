import Link from "next/link";

import { Icon } from "@/components/Icon";
import { AdminKpiStrip } from "@/components/admin/AdminKpiStrip";
import { CronsDownBanner } from "@/components/admin/CronsDownBanner";
import { OutlierProvincesTeaser } from "@/components/admin/OutlierProvincesTeaser";
import { QueueHealthCockpit } from "@/components/admin/QueueHealthCockpit";
import { NovedadesCard } from "@/components/operator/NovedadesCard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { DashboardFreshnessFooter } from "@/components/ui/dashboard/DashboardFreshnessFooter";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import {
  fetchDecisionsMetrics,
  fetchFailedCronNames,
  fetchQueueCockpit,
  fetchUserMetrics,
} from "@/lib/analytics/admin-metrics";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import {
  computeJurisdictionIndex,
  selectLowestScoringJurisdictions,
} from "@/lib/analytics/territorial-index";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import {
  buildProjectionContext,
  decisionsDeltaPct,
  fetchCrossJurisdictionOutliers,
} from "@/lib/metrics";
import { fetchNovedadesGroupedFeed } from "@/lib/metrics/novedades-feed";
import { windows } from "@/lib/metrics/period";
import { decisionsAuditDrillHref } from "@/lib/ui/audit-filters";

export default async function AdminDashboardPage() {
  const { user } = await requireAdminOrRedirect();

  // Admin context: global scope (no jurisdiction restriction), trailing 12m window.
  // Used for DashboardFreshnessFooter (lastIngestAt) — admin sees all pet_events.
  // The Novedades feed reuses it for scope (admin → universal); its window is the
  // per-user watermark, not the ctx period.
  const adminCtx = buildProjectionContext({ role: "admin" }, [], windows.trailing12m());

  // The header renders in BOTH the data and the degraded branch. It depends on
  // none of the aggregates below, and this is the FIRST screen an admin sees
  // after signing in — a bare "no pudimos cargar" with no title and no chrome
  // reads like a broken app rather than one slow strip. (The nav rail survives
  // regardless: it lives in app/admin/layout.tsx, itself bounded.)
  const header = (
    <ScreenHeader
      className="space-y-1"
      eyebrow="miMAR Plataforma · Admin"
      // "Briefing", not "Panel" — the admin twin of the /gob rename (PO
      // decision 2026-08-01). /admin ships its own "Panorama" entry one nav
      // section below, so it had the same two-synonyms problem.
      title="Briefing de administración"
      subtitle={
        <p className="text-md text-ln-op-ink-2">
          Estas colas se comparten con Gobierno, que las trabaja acotadas a su jurisdicción.
        </p>
      }
    />
  );

  // D-2 (Lote D) — the compliance teaser's fan-out, kicked off HERE so it races
  // the operational batch below instead of queueing behind it. It gets its OWN
  // budget and its OWN degraded branch on purpose: the territorial index is a
  // heavier, province-wide scan than any queue count, and a slow one must cost
  // this page a single card, never the queues an admin came here to triage.
  // The budget mirrors /admin/inteligencia's INTEL_INDEX_TIMEOUT_MS for the
  // identical fetch (that constant lives in a component module this server page
  // deliberately does not pull in).
  const outlierLoad = loadWithTimeout(fetchCrossJurisdictionOutliers(adminCtx), 6_000);

  // BOUNDED (outage pass 2026-08-09) — the admin landing page's five
  // aggregates. Unbounded, a degraded pooler made the first screen an operator
  // sees hang with nothing in the logs.
  const load = await loadWithTimeout(
    Promise.all([
      fetchUserMetrics(),
      // Epic D: every operational queue counted (approvals broken out per type)
      // for the cockpit — replaces the old lumped fetchQueueHealth number.
      fetchQueueCockpit(),
      fetchDecisionsMetrics(),
      // Session-start orientation feed (universal scope for admin), grouped by
      // type + locality with a distinct-subject count (Cowork M2).
      fetchNovedadesGroupedFeed(adminCtx, user.id),
      // Crons-down banner (operator-trust T3): any background job whose latest run
      // failed. One DISTINCT ON query — cheap enough for the dashboard hot path.
      fetchFailedCronNames(),
    ]),
  );
  if (!load.ok) {
    return (
      <div className="space-y-6">
        {header}
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref={analyticsRetryHref("/admin")}
        />
      </div>
    );
  }
  const [users, cockpit, decisions, novedades, failedCronNames] = load.value;

  // D-2: fold the outlier rows into the composite index, then take the tail.
  // Both steps are pure (lib/analytics/territorial-index) and produce the SAME
  // rows — same ranks — that /admin/inteligencia's full table renders.
  const outliers = await outlierLoad;
  const outlierIndex = outliers.ok ? computeJurisdictionIndex(outliers.value) : null;
  const outlierTail = outlierIndex ? selectLowestScoringJurisdictions(outlierIndex, 4) : [];

  // deltaV2 for decisions: compare 7d vs the approximated prior 7d window.
  // Shared helper (decisionsDeltaPct) is the single source of truth — same
  // approximation as /admin/sistema, so the two strips can't drift (C28).
  // T4.10: also carries `priorBase` — the small-N guard floor AdminKpiStrip
  // feeds to OpKpi via guardInput so a delta off a tiny prior week (n<5)
  // renders with no colored verdict.
  const total7d = decisions.approved7d + decisions.rejected7d;
  const decisionsDeltaResult = decisionsDeltaPct(decisions);
  const decisionsDelta = decisionsDeltaResult?.pct ?? null;
  const decisionsPriorBase = decisionsDeltaResult?.priorBase ?? null;

  return (
    <div className="space-y-6">
      {/* Page header — "Universal" scope lives in ONE place: the topbar's
          OpScopeChip (app/admin/layout.tsx), visible on every admin screen.
          The eyebrow/subtitle used to repeat it a 2nd and 3rd time (LOW,
          adversarial-admin 2026-07-23) — rephrased so scope is stated once.
          Hoisted above the load so the degraded branch keeps it. */}
      {header}

      {/* Crons-down banner (operator-trust T3) — leads the page when any
          background job's latest run failed, so the operator sees the impact
          before triaging queues. Renders nothing when the fleet is healthy. */}
      <CronsDownBanner failedCronNames={failedCronNames} />

      {/* (1) Queue-health cockpit — every operational queue as a compact tile
          with its live count and a jump-off. Approvals broken out per type.
          Leads the page: it is what an admin comes here to triage. */}
      <QueueHealthCockpit cockpit={cockpit} />

      {/* (2) Compliance teaser (D-2) — the national portal finally asks its own
          landing "¿dónde estamos más lejos de la meta?". Sits right under the
          queues: an admin triages work first, then reads the country. Degrades
          ALONE (its own budget above), so a slow province-wide scan costs this
          card and nothing else. */}
      {outlierIndex === null ? (
        <AnalyticsLoadFallback
          reason={outliers.ok ? "error" : outliers.reason}
          correlationId={outliers.ok ? undefined : outliers.id}
          retryHref={analyticsRetryHref("/admin")}
        />
      ) : (
        <OutlierProvincesTeaser rows={outlierTail} evaluatedTotal={outlierIndex.length} />
      )}

      {/* (3) System metrics — the shared operational KPI strip (C26). The
          pending-queue tile is OMITTED here: the QueueHealthCockpit above already
          owns that number (per type), so showing "Cola pendiente" again just
          duplicated it (PO ronda 4 + Cowork B1). The strip promotes
          "Instituciones activas" in its place. Links to the richer /admin/sistema. */}
      <section aria-label="Métricas del sistema" className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-bold uppercase tracking-[0.12em] text-ln-op-mute">
            Métricas del sistema
          </h2>
          <Link
            href="/admin/sistema"
            className="inline-flex items-center gap-1 text-sm font-semibold text-ln-op-azul no-underline hover:underline"
          >
            Ver Sistema completo
            <Icon name="chevron-right" size="sm" decorative />
          </Link>
        </div>
        <AdminKpiStrip
          omitPendingQueue
          data={{
            totalPersonal: users.totalPersonal,
            totalInstitutionalActive: users.totalInstitutionalActive,
            pendingTotal: cockpit.approvals.pendingTotal,
            oldestPendingDaysAgo: cockpit.approvals.oldestPendingDaysAgo,
            decisionsTotal7d: total7d,
            approved7d: decisions.approved7d,
            rejected7d: decisions.rejected7d,
            decisionsDelta,
            decisionsPriorBase,
            decisionsDrillHref: decisionsAuditDrillHref(),
          }}
        />
      </section>

      {/* (4) Novedades — session-start orientation feed, DEMOTED below the
          cockpit and collapsible so it no longer competes with the queues.
          Starts collapsed on the admin home; "Marcar como visto" is intact. */}
      <NovedadesCard feed={novedades} collapsible defaultCollapsed />

      <DashboardFreshnessFooter ctx={adminCtx} />
    </div>
  );
}
