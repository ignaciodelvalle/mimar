// /admin/inteligencia — Inteligencia operativa territorial (Task #44).
//
// Three aggregate/territorial intelligence surfaces, all derived from existing
// parity-guaranteed metric fetchers (one-truth-per-KPI):
//
//   1. Índice territorial compuesto — per-province composite of the three
//      programme coverages vs their targets (lib/analytics/territorial-index.ts).
//   2. Política → resultado — rule changes (audit_log) correlated with the
//      movement of a mapped aggregate metric in the same jurisdiction
//      (lib/analytics/policy-outcome.ts).
//   3. Calidad de datos por provincia — completeness/reconciliation score,
//      including ghost-record counts (lib/analytics/territorial-data-quality.ts).
//
// RED LINE (Ley 25.326 / habeas data): every number on this page is an
// aggregate over a TERRITORY or a RECORD-level reconciliation count. There is
// no individual-level scoring of citizens anywhere in this pipeline, and none
// may be added. k=5 suppression is applied or inherited on all three surfaces.
//
// STREAMING (platform-budget T3.2): the default export is SYNCHRONOUS — the
// shell flushes before any DB call. The three panels stream independently,
// each behind its own <Suspense> with its OWN loadWithTimeout budget (see
// ./inteligencia-panels.tsx for why the old single 10 s race over four
// fetchers made "Reintentar" hang).

import { Suspense } from "react";

import { OpFilterBar } from "@/components/ui/dashboard";
import { DashboardFreshnessFooter } from "@/components/ui/dashboard/DashboardFreshnessFooter";
import { OpCardSkeleton } from "@/components/ui/dashboard/OpCardSkeleton";
import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";
import { OpKpiSkeleton } from "@/components/ui/dashboard/OpKpiSkeleton";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { loadWithTimeout } from "@/lib/analytics/analytics-load";
import { DEFAULT_DASHBOARD_PRESET } from "@/lib/analytics/analytics-period";
import { fetchPolicyOutcomes } from "@/lib/analytics/policy-outcome";
import { fetchProvinceDataQuality } from "@/lib/analytics/territorial-data-quality";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { buildProjectionContext, fetchCrossJurisdictionOutliers } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";

import {
  INTEL_INDEX_TIMEOUT_MS,
  INTEL_POLICY_TIMEOUT_MS,
  INTEL_QUALITY_TIMEOUT_MS,
  IntelIndexKpis,
  IntelIndexPanel,
  IntelPolicyKpi,
  IntelPolicyPanel,
  IntelQualityKpi,
  IntelQualityPanel,
} from "./inteligencia-panels";

export const dynamic = "force-dynamic";

export default function AdminInteligenciaPage({
  searchParams,
}: {
  searchParams?: Promise<{ period?: string; from?: string; to?: string; ordenar?: string }>;
}) {
  // Sync export — skeleton config mirrors loading.tsx.
  return (
    <Suspense fallback={<OpDashboardSkeleton kpis={4} cards={[6]} />}>
      <InteligenciaBody searchParams={searchParams} />
    </Suspense>
  );
}

async function InteligenciaBody({
  searchParams,
}: {
  searchParams?: Promise<{ period?: string; from?: string; to?: string; ordenar?: string }>;
}) {
  await requireAdminOrRedirect();

  const sp = searchParams ? await searchParams : {};
  const { resolveAnalyticsPeriod } = await import("@/lib/metrics/period");
  const period = sp.period || sp.from ? resolveAnalyticsPeriod(sp) : windows.trailing12m();

  const ctx = buildProjectionContext({ role: "admin" }, [], period);

  // Three INDEPENDENT budgeted loads (T3.2). Kicked off together here, but
  // each races its OWN deadline and degrades alone — the shared promises are
  // consumed by the panel AND its KPI tile group (one query, two consumers).
  //
  // This used to be a Promise.all with getCensusPopulationsCached(). The census
  // half fed the impact column's canine population estimate, which was the wrong
  // denominator for two of the three metrics it multiplied (metric-honesty
  // audit, PO 2026-09-16). Nothing on this screen reads the census any more.
  const indexLoad = loadWithTimeout(fetchCrossJurisdictionOutliers(ctx), INTEL_INDEX_TIMEOUT_MS);
  const policyLoad = loadWithTimeout(fetchPolicyOutcomes(), INTEL_POLICY_TIMEOUT_MS);
  const qualityLoad = loadWithTimeout(fetchProvinceDataQuality(ctx), INTEL_QUALITY_TIMEOUT_MS);

  return (
    <div className="space-y-6">
      <ScreenHeader
        className="space-y-2"
        eyebrow="Admin · Inteligencia territorial"
        title="Inteligencia operativa"
        subtitle={
          <p className="text-md text-ln-op-mute">
            Índice compuesto por jurisdicción, correlación regla→métrica y calidad de datos. Señales
            agregadas por territorio — sin puntuación de personas.
          </p>
        }
      />

      {/* Unified filter bar — period only (F-migration 2026-07-21, off the
          bare <PeriodPicker>), same bar chrome as every other operator
          dashboard. No domain axes: every number here is already a
          territorial aggregate, not a filterable per-row list. */}
      <OpFilterBar period={{ defaultPreset: DEFAULT_DASHBOARD_PRESET }} />

      {/* KPI row — each tile group degrades with its source panel. */}
      <section
        aria-label="Indicadores de inteligencia territorial"
        className="grid grid-cols-2 md:grid-cols-4 gap-3"
      >
        <Suspense
          fallback={
            <>
              <OpKpiSkeleton />
              <OpKpiSkeleton />
            </>
          }
        >
          <IntelIndexKpis load={indexLoad} />
        </Suspense>
        <Suspense fallback={<OpKpiSkeleton />}>
          <IntelPolicyKpi load={policyLoad} />
        </Suspense>
        <Suspense fallback={<OpKpiSkeleton />}>
          <IntelQualityKpi load={qualityLoad} />
        </Suspense>
      </section>

      {/* 1. Índice territorial compuesto */}
      <Suspense fallback={<OpCardSkeleton rows={8} />}>
        <IntelIndexPanel load={indexLoad} sp={sp} />
      </Suspense>

      {/* 2. Política → resultado */}
      <Suspense fallback={<OpCardSkeleton rows={6} />}>
        <IntelPolicyPanel load={policyLoad} sp={sp} />
      </Suspense>

      {/* 3. Calidad de datos por provincia */}
      <Suspense fallback={<OpCardSkeleton rows={6} />}>
        <IntelQualityPanel load={qualityLoad} sp={sp} />
      </Suspense>

      <p className="text-xs text-ln-op-mute">
        Todas las señales de esta página son agregados territoriales o marcas de conciliación a
        nivel registro. No existe puntuación algorítmica de personas (Ley 25.326).
      </p>

      {/* Own boundary: the freshness query must never gate the panels above. */}
      <Suspense fallback={null}>
        <DashboardFreshnessFooter ctx={ctx} />
      </Suspense>
    </div>
  );
}
