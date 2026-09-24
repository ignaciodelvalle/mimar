// /admin/sistema — system health dashboard (streamed shell, platform-budget T3.1).
//
// STREAMING MOVE (same load-bearing shape as app/admin/panorama/page.tsx): the
// default export is SYNCHRONOUS and returns <Suspense> immediately, so the
// route shell flushes before ANY DB call — on hard reload AND on client nav.
// The async shell inside awaits only the auth guard, then kicks off the four
// critical KPI fetchers with individual withDbBudget budgets and streams every
// section behind its own nested <Suspense>. One slow query degrades alone
// (honest "sin datos por demora" state) instead of holding the page >34 s as
// observed on staging. Budget wrapper: withDbBudget via
// _components/sistema-sections.tsx (budgetedOrDegraded).

import { Suspense } from "react";

import Link from "next/link";

import { DashboardFreshnessFooter } from "@/components/ui/dashboard/DashboardFreshnessFooter";
import { OpCardSkeleton } from "@/components/ui/dashboard/OpCardSkeleton";
import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";
import { OpKpiSkeleton } from "@/components/ui/dashboard/OpKpiSkeleton";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import {
  fetchDecisionsMetrics,
  fetchQueueHealth,
  fetchUserMetrics,
} from "@/lib/analytics/admin-metrics";
import { fetchEnoSla } from "@/lib/analytics/surveillance-metrics";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";

import {
  SISTEMA_KPI_BUDGET_MS,
  SistemaChannelsCard,
  SistemaCronsBanner,
  SistemaCronsCard,
  SistemaDriftCard,
  SistemaGovtActivity,
  SistemaKpiStrip,
  SistemaStatCards,
  budgetedOrDegraded,
} from "./_components/sistema-sections";

export const dynamic = "force-dynamic";

export default function AdminSistemaPage() {
  // Sync export — the shell (and the loading.tsx-equivalent skeleton below)
  // paints before any DB round trip. The skeleton config mirrors loading.tsx.
  return (
    <Suspense fallback={<OpDashboardSkeleton filterBar={false} cards={[6, 4]} />}>
      <AdminSistemaShell />
    </Suspense>
  );
}

async function AdminSistemaShell() {
  await requireAdminOrRedirect();

  // Admin context: global scope (no jurisdiction restriction), trailing 12m window.
  // Used for DashboardFreshnessFooter (lastIngestAt) — admin sees all pet_events.
  const adminCtx = buildProjectionContext({ role: "admin" }, [], windows.trailing12m());

  // Kick off the four critical KPI fetchers NOW (before any section renders),
  // each under its OWN budget so one slow query degrades alone. The promises
  // are shared by the KPI strip and the stat cards below — one query each,
  // two consumers. budgetedOrDegraded never rejects.
  const users = budgetedOrDegraded(
    fetchUserMetrics(),
    SISTEMA_KPI_BUDGET_MS,
    "admin/sistema users",
  );
  const queue = budgetedOrDegraded(
    fetchQueueHealth(),
    SISTEMA_KPI_BUDGET_MS,
    "admin/sistema queue",
  );
  const decisions = budgetedOrDegraded(
    fetchDecisionsMetrics(),
    SISTEMA_KPI_BUDGET_MS,
    "admin/sistema decisions",
  );
  const enoSla = budgetedOrDegraded(
    fetchEnoSla(adminCtx),
    SISTEMA_KPI_BUDGET_MS,
    "admin/sistema eno-sla",
  );

  return (
    <div className="space-y-8">
      <ScreenHeader
        eyebrow="Admin · Sistema"
        title="Salud del sistema"
        subtitle={
          <>
            <p className="text-md text-ln-op-ink-2">Métricas operativas en vivo. Solo admin.</p>
            {/* D6 — cross-link a la profundidad analítica nacional (mapa, ranking,
                métricas agregadas). El admin no tiene charts propios todavía; el
                Centro de Situación es la superficie integradora pendiente. */}
            <div className="flex flex-wrap gap-4 pt-1">
              {/* F9 (2026-08-01): Analítica is a vista of the Programa hub. */}
              <Link
                href="/gob/programa?vista=analitica"
                className="text-sm font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline"
              >
                Ver analítica nacional {"→"}
              </Link>
              {/* Paquete H — executive summary cross-link */}
              <Link
                href="/admin/programa"
                className="text-sm font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline"
              >
                Resumen ejecutivo {"→"}
              </Link>
            </div>
          </>
        }
      />

      {/* Crons-down banner (operator-trust T3) — now fed by the CHEAP
          fetchFailedCronNames query (own Suspense) instead of riding the full
          fetchCronRuns result. No fallback UI: a pending/degraded banner
          renders nothing; the Crons card below owns the honest state. */}
      <Suspense fallback={null}>
        <SistemaCronsBanner />
      </Suspense>

      {/* Top KPIs — shared operational strip (C26). Paquete H ENO SLA (A7)
          measures the notification pipeline health. */}
      <section aria-label="Estado del sistema">
        <Suspense
          fallback={
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <OpKpiSkeleton />
              <OpKpiSkeleton />
              <OpKpiSkeleton />
              <OpKpiSkeleton />
            </div>
          }
        >
          <SistemaKpiStrip users={users} queue={queue} decisions={decisions} enoSla={enoSla} />
        </Suspense>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Suspense
          fallback={
            <>
              <OpCardSkeleton rows={3} />
              <OpCardSkeleton rows={3} />
              <OpCardSkeleton rows={3} />
            </>
          }
        >
          <SistemaStatCards users={users} queue={queue} decisions={decisions} />
        </Suspense>
        <Suspense fallback={<OpCardSkeleton rows={8} />}>
          <SistemaCronsCard />
        </Suspense>
        <Suspense fallback={<OpCardSkeleton rows={4} />}>
          <SistemaDriftCard />
        </Suspense>
        {/* Env-presence only — no DB call, so no Suspense boundary and no
            degraded branch to own. */}
        <SistemaChannelsCard />
      </section>

      <section className="space-y-3">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          Actividad por gobierno
        </p>
        <Suspense fallback={<OpCardSkeleton rows={6} />}>
          <SistemaGovtActivity />
        </Suspense>
      </section>

      {/* Own boundary: the footer's freshness query must never gate the
          sections above (it resolves late under contention, page stays usable). */}
      <Suspense fallback={null}>
        <DashboardFreshnessFooter ctx={adminCtx} />
      </Suspense>
    </div>
  );
}
