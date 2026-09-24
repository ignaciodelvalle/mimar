// /admin/inteligencia — independently budgeted + streamed panels (T3.2).
//
// The page used to race ONE 10 s loadWithTimeout over a Promise.all of four
// differently-priced fetchers. Under pooler contention the whole page degraded
// together, and "Reintentar" re-fought the SAME four-query contention (a
// loadWithTimeout deadline does not cancel the underlying queries — they keep
// occupying pool slots), which is why retry hung and the observed wall time
// (18 s) exceeded the 10 s budget.
//
// Now each panel is its own async server component behind its own <Suspense>,
// awaiting its own loadWithTimeout envelope: a slow "calidad de datos" query
// degrades that panel alone, the other two render their data, and a retry
// re-runs three INDEPENDENT budgets instead of one all-or-nothing race.
//
// The KPI strip tiles degrade with their source panel (each tile group awaits
// the same shared load promise as its panel — one query, two consumers).

import { LnEmptyState } from "@/components/ui/EmptyState";
import { OpCard, OpCardBody, OpCardHead, OpKpi } from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { type AnalyticsLoad, analyticsRetryHref } from "@/lib/analytics/analytics-load";
import {
  POLICY_OUTCOME_WINDOW_DAYS,
  type PolicyOutcomeRow,
  type fetchPolicyOutcomes,
} from "@/lib/analytics/policy-outcome";
import {
  DATA_QUALITY_K_ANON,
  type ProvinceDataQualityRow,
  type fetchProvinceDataQuality,
} from "@/lib/analytics/territorial-data-quality";
import { computeJurisdictionIndex } from "@/lib/analytics/territorial-index";
import { RULE_TYPE_REGISTRY } from "@/lib/domain/rule-types-registry";
import {
  NO_POPULATION_NOTE,
  TARGETS,
  type fetchCrossJurisdictionOutliers,
  formatImpactUnits,
  totalImpactByJurisdiction,
} from "@/lib/metrics";

import { KPI_CATALOG, type KpiId } from "@/lib/metrics/kpi-catalog";
import { formatDateShort, formatPercent, pluralizeEs } from "@/lib/utils/format";

// ---------------------------------------------------------------------------
// Per-panel budgets (T3.2) — priced to each panel's observed cost, NOT one
// shared deadline. The prime suspect (province data quality) is isolated.
// ---------------------------------------------------------------------------

export const INTEL_INDEX_TIMEOUT_MS = 6_000;
export const INTEL_POLICY_TIMEOUT_MS = 8_000;
export const INTEL_QUALITY_TIMEOUT_MS = 8_000;

export type IntelSearchParams = {
  period?: string;
  from?: string;
  to?: string;
  ordenar?: string;
};

type OutlierRows = Awaited<ReturnType<typeof fetchCrossJurisdictionOutliers>>;
type PolicyRows = Awaited<ReturnType<typeof fetchPolicyOutcomes>>;
type Quality = Awaited<ReturnType<typeof fetchProvinceDataQuality>>;

// Was `[OutlierRows, CensusPopulations]`. The census half existed only to feed
// `estimateDogPopulation` into the impact column, which was the wrong
// denominator for two of the three metrics it multiplied (metric-honesty audit,
// PO 2026-09-16); with the impact now counted over each row's own measured
// denominator, nothing on this screen reads the census at all.
export type IndexLoad = Promise<AnalyticsLoad<OutlierRows>>;
export type PolicyLoad = Promise<AnalyticsLoad<PolicyRows>>;
export type QualityLoad = Promise<AnalyticsLoad<Quality>>;

/** Scoped retry: same page + current period params — the reload re-runs three
 * independent budgets, so a panel that already loaded can succeed again while
 * only the slow one re-fights its own query. */
function retryHref(sp: IntelSearchParams): string {
  return analyticsRetryHref("/admin/inteligencia", sp);
}

// ---------------------------------------------------------------------------
// Small presentational helpers (server-rendered, Op-skin)
// ---------------------------------------------------------------------------

/** Track + fill bar with the numeric value beside it (never color-alone). */
function ScoreBar({ value, max = 100 }: { value: number; max?: number }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-[80px] h-2 rounded bg-ln-op-stripe overflow-hidden">
        <div
          className="h-full rounded bg-ln-op-azul"
          style={{ width: `${pct}%` }}
          aria-hidden="true"
        />
      </div>
      <span className="w-10 shrink-0 text-right text-md tabular-nums text-ln-op-ink">{value}</span>
    </div>
  );
}

/** Signed delta with arrow glyph + sr-only direction (WCAG 1.4.1). */
function DeltaCell({ row }: { row: PolicyOutcomeRow }) {
  if (row.suppressed) {
    return <span className="text-ln-op-mute">&lt;5 (privacidad)</span>;
  }
  // red-team-admin #15: an after-window with almost no elapsed time collapses to
  // a spurious ≈-100% for any before>0. Show "ventana insuficiente" instead of a
  // full-strength colored verdict on a change that just happened.
  if (row.deltaUnstable) {
    return <span className="text-ln-op-mute">ventana insuficiente</span>;
  }
  if (row.deltaPct === null) {
    return <span className="text-ln-op-mute">sin línea de base</span>;
  }
  const up = row.deltaPct >= 0;
  return (
    <span
      className={[
        "font-semibold tabular-nums",
        up ? "text-[var(--color-st-ok)]" : "text-[var(--color-st-err)]",
      ].join(" ")}
    >
      <span aria-hidden="true">{up ? "↑" : "↓"} </span>
      <span className="sr-only">{up ? "Sube:" : "Baja:"} </span>
      {up ? "+" : ""}
      {/* T4.16 (2026-08-01): raw JS number rendered a "." decimal separator
          (e.g. "41.3%") in an es-AR UI — formatPercent already appends "%",
          the sign/arrow handling above is untouched. */}
      {formatPercent(row.deltaPct)}
    </span>
  );
}

function ruleScopeLabel(row: PolicyOutcomeRow): string {
  if (!row.province) return "Nacional";
  return row.locality ? `${row.province} · ${row.locality}` : row.province;
}

const ACTION_LABELS: Record<PolicyOutcomeRow["action"], string> = {
  govt_business_rule_created: "creada",
  govt_business_rule_updated: "modificada",
  govt_business_rule_deleted: "eliminada",
};

/**
 * Lote B4 — key-level diff between two rule payloads (generic v1: raw JSON
 * values per changed key). The payloads have been durable in audit_log since
 * the rule writers landed; this is the first surface that renders them.
 */
export function diffEntries(
  before: unknown,
  after: unknown,
): Array<{ key: string; before: string; after: string }> {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const out: Array<{ key: string; before: string; after: string }> = [];
  for (const key of keys) {
    if (JSON.stringify(b[key]) === JSON.stringify(a[key])) continue;
    out.push({
      key,
      before: key in b ? JSON.stringify(b[key]) : "—",
      after: key in a ? JSON.stringify(a[key]) : "—",
    });
  }
  return out;
}

/** The "Ver cambios" disclosure for one rule-change row (B4). */
function RuleChangeDiff({ row }: { row: PolicyOutcomeRow }) {
  if (row.previousPayload == null && row.newPayload == null) return null;
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-ln-op-mute">Ver cambios</summary>
      <div className="mt-1 space-y-0.5">
        {row.action === "govt_business_rule_created" && (
          <p>
            Configuración inicial: <code>{JSON.stringify(row.newPayload)}</code>
          </p>
        )}
        {row.action === "govt_business_rule_deleted" && (
          <p>
            Última configuración: <code>{JSON.stringify(row.previousPayload)}</code>
          </p>
        )}
        {row.action === "govt_business_rule_updated" && (
          <dl className="space-y-0.5">
            {diffEntries(row.previousPayload, row.newPayload).map((d) => (
              <div key={d.key}>
                <dt className="inline font-semibold">{d.key}:</dt>{" "}
                <dd className="inline">
                  <code>{d.before}</code> → <code>{d.after}</code>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </details>
  );
}

/** Honest degraded KPI tile — an explicit "sin datos" state, never a zero. */
function DegradedKpi({ label, descriptorId }: { label: string; descriptorId: KpiId }) {
  return (
    <OpKpi
      label={label}
      value="—"
      sub="Sin datos por demora — reintentá"
      descriptorId={descriptorId}
    />
  );
}

// ---------------------------------------------------------------------------
// KPI tiles (grid items — the page owns the surrounding <section> grid)
// ---------------------------------------------------------------------------

export async function IntelIndexKpis({ load }: { load: IndexLoad }) {
  const result = await load;
  if (!result.ok) {
    return (
      <>
        <DegradedKpi
          label="Provincias evaluadas"
          descriptorId="territorial_index_provinces_evaluated"
        />
        <DegradedKpi label="Índice promedio" descriptorId="territorial_index_average_score" />
      </>
    );
  }
  const outlierRows = result.value;
  const indexRows = computeJurisdictionIndex(outlierRows);
  const nationalAvg =
    indexRows.length > 0
      ? Math.round(indexRows.reduce((sum, r) => sum + r.score, 0) / indexRows.length)
      : null;
  return (
    <>
      <OpKpi
        label="Provincias evaluadas"
        value={indexRows.length > 0 ? indexRows.length : "—"}
        sub="con población suficiente (k≥5)"
        info={{
          definition:
            "Provincias con al menos 5 mascotas activas — las menores se omiten por privacidad (k-anonimato).",
        }}
        descriptorId="territorial_index_provinces_evaluated"
      />
      <OpKpi
        label="Índice promedio"
        value={nationalAvg ?? "—"}
        sub="promedio simple entre provincias evaluadas"
        info={{
          definition:
            "Promedio del índice territorial compuesto: cumplimiento de metas de cobertura antirrábica, esterilización y chip, con pesos iguales.",
          formula: "score = mean(min(100, tasa/meta×100))",
        }}
        descriptorId="territorial_index_average_score"
      />
    </>
  );
}

export async function IntelPolicyKpi({ load }: { load: PolicyLoad }) {
  const result = await load;
  if (!result.ok) {
    return (
      <DegradedKpi label="Cambios de reglas" descriptorId="policy_outcome_rule_changes_analyzed" />
    );
  }
  const policyRows = result.value;
  return (
    <OpKpi
      label="Cambios de reglas"
      value={policyRows.length > 0 ? policyRows.length : "—"}
      sub={`analizados · ventana ±${POLICY_OUTCOME_WINDOW_DAYS} días`}
      info={{
        definition:
          "Mutaciones recientes de reglas jurisdiccionales (audit log) correlacionadas con la métrica agregada que gobiernan.",
        caveat: "Correlación temporal, no atribución causal.",
      }}
      descriptorId="policy_outcome_rule_changes_analyzed"
    />
  );
}

export async function IntelQualityKpi({ load }: { load: QualityLoad }) {
  const result = await load;
  if (!result.ok) {
    return (
      <DegradedKpi
        label={KPI_CATALOG.ghost_records_count.label}
        descriptorId="ghost_records_count"
      />
    );
  }
  const quality = result.value;
  const totalGhosts = quality.rows.reduce((sum, r) => sum + r.ghosts, 0);
  const totalRecords = quality.rows.reduce((sum, r) => sum + r.total, 0);
  const ghostPct = totalRecords > 0 ? Math.round((totalGhosts / totalRecords) * 1000) / 10 : 0;

  // The KPI totals sum only quality.rows, which fetchProvinceDataQuality has
  // already stripped of k<5-suppressed provinces and null-province records. The
  // quality table below (Calidad de datos) discloses that exclusion; the KPI must
  // say the same thing so the headline count and the table cannot silently
  // disagree (C2 / C3). Build the same exclusion clause the table renders.
  const ghostExclusionNote =
    quality.suppressedProvinces > 0 || quality.unassigned > 0
      ? ` No incluye ${
          quality.suppressedProvinces > 0
            ? `${quality.suppressedProvinces} ${
                quality.suppressedProvinces === 1 ? "provincia oculta" : "provincias ocultas"
              } por k<${DATA_QUALITY_K_ANON}`
            : ""
        }${quality.suppressedProvinces > 0 && quality.unassigned > 0 ? " ni " : ""}${
          quality.unassigned > 0
            ? `${quality.unassigned.toLocaleString("es-AR")} ${pluralizeEs(quality.unassigned, "registro")} sin provincia asignada`
            : ""
        } — cuenta solo el padrón evaluado, igual que la tabla de calidad.`
      : "";

  return (
    <OpKpi
      label={KPI_CATALOG.ghost_records_count.label}
      value={totalGhosts > 0 ? totalGhosts.toLocaleString("es-AR") : "0"}
      // T4.16 (2026-08-01): raw JS decimal ("." separator) in an es-AR UI.
      sub={`${formatPercent(ghostPct)} del padrón evaluado · sin titular ni actividad`}
      tone={ghostPct > 20 ? "danger" : ghostPct > 10 ? "warn" : undefined}
      info={{
        definition:
          "Registros activos sin ningún titular asociado y sin actividad del propietario en 12 meses — candidatos a conciliación de datos.",
        caveat: `Señal a nivel registro (conciliación), nunca puntuación de personas.${ghostExclusionNote}`,
      }}
      descriptorId="ghost_records_count"
    />
  );
}

// ---------------------------------------------------------------------------
// 1. Índice territorial compuesto
// ---------------------------------------------------------------------------

export async function IntelIndexPanel({
  load,
  sp,
}: {
  load: IndexLoad;
  sp: IntelSearchParams;
}) {
  const result = await load;
  if (!result.ok) {
    // A5: AnalyticsLoadFallback has no className prop (shared across a dozen
    // analytics screens) — wrap instead. This panel is its own top-level
    // Suspense (not a grid item), so the extra div is layout-safe.
    return (
      <div className="op-fade-in">
        <AnalyticsLoadFallback
          reason={result.reason}
          correlationId={result.id}
          retryHref={retryHref(sp)}
        />
      </div>
    );
  }
  const outlierRows = result.value;
  const indexRows = computeJurisdictionIndex(outlierRows);

  // PO-interview decision 2, item 1 — same gap x población lens as /gob/programa
  // + /admin/programa, applied to the territorial index's own composite: a
  // second sort so "which province matters most" is answerable here too,
  // without displacing the index's own score-based ranking as the default.
  //
  // `population` is each row's OWN measured denominator (metric-honesty audit,
  // PO 2026-09-16). It used to be `estimateDogPopulation(censusPopulations[...])`
  // for all three metrics, and this screen SUMS the three per province — so the
  // sum added an all-species chip gap and an all-species esterilización gap,
  // both scaled by a canine population, to a genuinely canine antirrábica gap.
  // Three numbers on two different scales in one total.
  const impactTotals = totalImpactByJurisdiction(
    outlierRows.map((row) => ({
      ...row,
      jurisdiction: row.province,
      coverage: row.rate,
      population: row.denominator,
    })),
  );
  const impactByProvince = new Map<string, number | null>(
    impactTotals.map((t) => [t.jurisdiction, t.impact]),
  );
  // Map.get() already returns `undefined` for a province with no gap at all
  // (never registered in impactTotals) — NEVER collapse that into the SAME
  // `null` totalImpactByJurisdiction uses for "gap exists, no population".
  // Those are two different honest states (see the table's legend below).
  const indexRowsWithImpact = indexRows.map((row) => ({
    ...row,
    impact: impactByProvince.get(row.province),
  }));
  const sortByImpact = sp.ordenar === "impacto";
  // Impact-sorted view: known-impact rows desc, then unknown (no population/no
  // gap) rows at the end, alphabetically — same guard posture as
  // lib/metrics/impact-ranking.ts's rankByImpact, applied here to a list that
  // ALREADY carries a score/rank from computeJurisdictionIndex (never
  // recomputed, only re-ordered).
  const displayIndexRows = sortByImpact
    ? [...indexRowsWithImpact].sort((a, b) => {
        if (a.impact === b.impact) return a.province.localeCompare(b.province, "es");
        if (a.impact === undefined || a.impact === null) return 1;
        if (b.impact === undefined || b.impact === null) return -1;
        return b.impact - a.impact;
      })
    : indexRowsWithImpact;

  // Preserves the active period filter across the sort toggle — switching
  // "índice"/"impacto" must never silently reset the period the operator
  // already picked.
  function sortHref(mode: "indice" | "impacto"): string {
    const params = new URLSearchParams();
    if (sp.period) params.set("period", sp.period);
    if (sp.from) params.set("from", sp.from);
    if (sp.to) params.set("to", sp.to);
    if (mode === "impacto") params.set("ordenar", "impacto");
    const qs = params.toString();
    return qs ? `/admin/inteligencia?${qs}` : "/admin/inteligencia";
  }

  const panelIndexId = "intel-panel-indice-titulo";

  return (
    <OpCard aria-labelledby={panelIndexId} className="op-fade-in">
      <OpCardHead
        title={<span id={panelIndexId}>Índice territorial compuesto</span>}
        actions={
          // PO-interview decision 2, item 1 — second sort: the composite
          // score answers "¿cómo cumple esta jurisdicción sus metas?"; the
          // impact sort answers "¿cuál mueve más el gap nacional si mejora?"
          // — two different, both honest, questions over the SAME rows.
          <span className="flex items-center gap-2 text-sm text-ln-op-mute">
            Ordenar por
            <a
              href={sortHref("indice")}
              aria-current={sortByImpact ? undefined : "true"}
              className={
                sortByImpact ? "text-ln-op-azul hover:underline" : "font-semibold text-ln-op-ink"
              }
            >
              índice
            </a>
            ·
            <a
              href={sortHref("impacto")}
              aria-current={sortByImpact ? "true" : undefined}
              className={
                sortByImpact ? "font-semibold text-ln-op-ink" : "text-ln-op-azul hover:underline"
              }
            >
              impacto
            </a>
          </span>
        }
      />
      <OpCardBody>
        {displayIndexRows.length === 0 ? (
          <LnEmptyState
            icon="chart-line"
            title="Sin datos suficientes"
            description="Sin provincias con población suficiente para calcular el índice."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-md text-ln-op-ink border-collapse">
              <caption className="sr-only">
                Ranking de provincias por {sortByImpact ? "impacto" : "índice compuesto"} de
                cumplimiento de metas, de mayor a menor.
              </caption>
              <thead>
                <tr className="border-b border-ln-op-line">
                  <th scope="col" className="text-left py-2 pr-2 font-semibold text-ln-op-mute w-8">
                    #
                  </th>
                  <th scope="col" className="text-left py-2 pr-4 font-semibold text-ln-op-mute">
                    Provincia
                  </th>
                  <th
                    scope="col"
                    className="text-left py-2 pr-4 font-semibold text-ln-op-mute min-w-[140px]"
                  >
                    Índice
                  </th>
                  <th scope="col" className="text-right py-2 pr-4 font-semibold text-ln-op-mute">
                    Antirrábica
                  </th>
                  <th scope="col" className="text-right py-2 pr-4 font-semibold text-ln-op-mute">
                    Esterilización
                  </th>
                  <th scope="col" className="text-right py-2 pr-4 font-semibold text-ln-op-mute">
                    Chip
                  </th>
                  <th scope="col" className="text-right py-2 font-semibold text-ln-op-mute">
                    Impacto
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayIndexRows.map((row, i) => (
                  <tr key={row.province} className="border-b border-ln-op-line last:border-0">
                    <td className="py-2 pr-2 tabular-nums text-ln-op-mute">
                      {sortByImpact ? i + 1 : row.rank}
                    </td>
                    <td className="py-2 pr-4">
                      {row.province}
                      {row.componentsUsed < 3 && (
                        <span
                          className="text-ln-op-mute"
                          title="Índice parcial: componente antirrábica omitida por k-anonimato"
                        >
                          {" "}
                          *
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      <ScoreBar value={row.score} />
                    </td>
                    {/* T4.16 (2026-08-01): raw JS decimals ("." separator) in
                        an es-AR table — formatPercent's 1-decimal default
                        matches the upstream rate rounding. */}
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {row.components.rabies ? formatPercent(row.components.rabies.rate) : "—"}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {row.components.sterilization
                        ? formatPercent(row.components.sterilization.rate)
                        : "—"}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {row.components.microchip
                        ? formatPercent(row.components.microchip.rate)
                        : "—"}
                    </td>
                    <td className="py-2 text-right tabular-nums text-ln-op-mute">
                      {row.impact === undefined
                        ? "—"
                        : row.impact === null
                          ? NO_POPULATION_NOTE
                          : `~${formatImpactUnits(row.impact)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-ln-op-mute">
              Impacto = registros del padrón sin cobertura (brecha × la base con la que se calcula
              cada cobertura: mascotas activas en chip y esterilización, perros activos en
              antirrábica), sumado entre las tres métricas de la provincia. Es un piso medido, no
              una proyección sobre la población estimada del territorio. «{NO_POPULATION_NOTE}» =
              sin base de cálculo para esa provincia; — = provincia sin brecha (cumple las tres
              metas). Índice = promedio con pesos iguales del cumplimiento de metas: antirrábica (
              {TARGETS.RABIES_COVERAGE_PCT}%), esterilización ({TARGETS.STERILIZATION_COVERAGE_PCT}
              %) y chip ({TARGETS.MICROCHIP_PENETRATION_PCT}%). * = índice parcial (2 de 3
              componentes; antirrábica omitida cuando hay menos de 5 perros). Provincias con menos
              de 5 mascotas no se listan (privacidad).
            </p>
          </div>
        )}
      </OpCardBody>
    </OpCard>
  );
}

// ---------------------------------------------------------------------------
// 2. Política → resultado
// ---------------------------------------------------------------------------

export async function IntelPolicyPanel({
  load,
  sp,
}: {
  load: PolicyLoad;
  sp: IntelSearchParams;
}) {
  const result = await load;
  if (!result.ok) {
    // A5: see IntelIndexPanel's identical note above.
    return (
      <div className="op-fade-in">
        <AnalyticsLoadFallback
          reason={result.reason}
          correlationId={result.id}
          retryHref={retryHref(sp)}
        />
      </div>
    );
  }
  const policyRows = result.value;
  const panelPolicyId = "intel-panel-politica-titulo";

  return (
    <OpCard aria-labelledby={panelPolicyId} className="op-fade-in">
      <OpCardHead
        title={<span id={panelPolicyId}>Política → resultado</span>}
        actions={
          <span className="text-xs text-ln-op-mute">
            Ventana fija ±{POLICY_OUTCOME_WINDOW_DAYS}d — no usa el período elegido arriba
          </span>
        }
      />
      <OpCardBody>
        {policyRows.length === 0 ? (
          <LnEmptyState
            icon="disputa"
            title="Sin cambios de reglas"
            description="Sin cambios de reglas registrados en el audit log todavía."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-md text-ln-op-ink border-collapse">
              <caption className="sr-only">
                Cambios recientes de reglas jurisdiccionales y el movimiento de la métrica agregada
                asociada antes y después del cambio.
              </caption>
              <thead>
                <tr className="border-b border-ln-op-line">
                  <th scope="col" className="text-left py-2 pr-4 font-semibold text-ln-op-mute">
                    Fecha
                  </th>
                  <th scope="col" className="text-left py-2 pr-4 font-semibold text-ln-op-mute">
                    Regla
                  </th>
                  <th scope="col" className="text-left py-2 pr-4 font-semibold text-ln-op-mute">
                    Alcance
                  </th>
                  <th scope="col" className="text-left py-2 pr-4 font-semibold text-ln-op-mute">
                    Métrica observada
                  </th>
                  <th scope="col" className="text-right py-2 pr-4 font-semibold text-ln-op-mute">
                    Antes
                  </th>
                  <th scope="col" className="text-right py-2 pr-4 font-semibold text-ln-op-mute">
                    Después
                  </th>
                  <th scope="col" className="text-right py-2 font-semibold text-ln-op-mute">
                    Δ
                  </th>
                </tr>
              </thead>
              <tbody>
                {policyRows.map((row) => (
                  <tr key={row.auditId} className="border-b border-ln-op-line last:border-0">
                    <td className="py-2 pr-4 whitespace-nowrap tabular-nums">
                      {formatDateShort(row.changedAt)}
                    </td>
                    <td className="py-2 pr-4">
                      {RULE_TYPE_REGISTRY[row.ruleType].label}{" "}
                      <span className="text-ln-op-mute">({ACTION_LABELS[row.action]})</span>
                      <RuleChangeDiff row={row} />
                    </td>
                    <td className="py-2 pr-4">{ruleScopeLabel(row)}</td>
                    <td className="py-2 pr-4">
                      {row.metricLabel}
                      {row.partialAfter && (
                        <span className="text-ln-op-mute">
                          {" "}
                          · ventana parcial ({row.afterDaysCovered}{" "}
                          {pluralizeEs(row.afterDaysCovered, "día")})
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {row.suppressed ? "<5" : row.before.toLocaleString("es-AR")}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {row.suppressed ? "<5" : row.after.toLocaleString("es-AR")}
                    </td>
                    <td className="py-2 text-right">
                      <DeltaCell row={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-ln-op-mute">
              Conteo de eventos agregados en la jurisdicción de la regla,{" "}
              {POLICY_OUTCOME_WINDOW_DAYS} días antes y después del cambio. «Ver cambios» muestra
              qué decía la regla antes y después, directo del registro de auditoría. Correlación
              temporal — no implica causalidad. Pares con ambas ventanas &lt;5 se enmascaran
              (privacidad). El selector de período de arriba no afecta esta tabla: la ventana de ±
              {POLICY_OUTCOME_WINDOW_DAYS} días es fija y se ancla a la fecha de cada cambio de
              regla, porque cada regla necesita su propio antes/después.
            </p>
          </div>
        )}
      </OpCardBody>
    </OpCard>
  );
}

// ---------------------------------------------------------------------------
// 3. Calidad de datos por provincia — the prime latency suspect, isolated
// ---------------------------------------------------------------------------

export async function IntelQualityPanel({
  load,
  sp,
}: {
  load: QualityLoad;
  sp: IntelSearchParams;
}) {
  const result = await load;
  if (!result.ok) {
    // A5: see IntelIndexPanel's identical note above.
    return (
      <div className="op-fade-in">
        <AnalyticsLoadFallback
          reason={result.reason}
          correlationId={result.id}
          retryHref={retryHref(sp)}
        />
      </div>
    );
  }
  const quality = result.value;
  const panelQualityId = "intel-panel-calidad-titulo";

  return (
    <OpCard aria-labelledby={panelQualityId} className="op-fade-in">
      <OpCardHead title={<span id={panelQualityId}>Calidad de datos por provincia</span>} />
      <OpCardBody>
        {quality.rows.length === 0 ? (
          <LnEmptyState
            icon="chart-line"
            title="Sin datos suficientes"
            description="Sin provincias con población suficiente para el puntaje de calidad."
          />
        ) : (
          <div className="overflow-x-auto">
            {/* Ola 4 / decision-density audit (2026-07-21): this table had 9
                columns — the densest in the portal. Rank + score + the one
                ready-to-act signal (Fantasma, also the headline KPI above)
                stay visible; the other 5 completeness-diagnostic columns
                (localidad/chip/titular/inactivas/chips reemplazados) move
                behind a disclosure — still fully honest/reachable, just not
                co-equal with the decision-relevant columns by default. */}
            <table className="w-full text-md text-ln-op-ink border-collapse">
              <caption className="sr-only">
                Ranking de provincias por puntaje de calidad de datos, con la señal de registros
                fantasma.
              </caption>
              <thead>
                <tr className="border-b border-ln-op-line">
                  <th scope="col" className="text-left py-2 pr-2 font-semibold text-ln-op-mute w-8">
                    #
                  </th>
                  <th scope="col" className="text-left py-2 pr-4 font-semibold text-ln-op-mute">
                    Provincia
                  </th>
                  <th
                    scope="col"
                    className="text-left py-2 pr-4 font-semibold text-ln-op-mute min-w-[140px]"
                  >
                    Puntaje
                  </th>
                  <th scope="col" className="text-right py-2 pr-4 font-semibold text-ln-op-mute">
                    Registros
                  </th>
                  <th scope="col" className="text-right py-2 font-semibold text-ln-op-mute">
                    Fantasma
                  </th>
                </tr>
              </thead>
              <tbody>
                {quality.rows.map((row: ProvinceDataQualityRow) => (
                  <tr key={row.province} className="border-b border-ln-op-line last:border-0">
                    <td className="py-2 pr-2 tabular-nums text-ln-op-mute">{row.rank}</td>
                    <td className="py-2 pr-4">{row.province}</td>
                    <td className="py-2 pr-4">
                      <ScoreBar value={row.score} />
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {row.total.toLocaleString("es-AR")}
                    </td>
                    <td className="py-2 text-right tabular-nums">{row.ghosts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-ln-op-mute">
              Puntaje = promedio con pesos iguales de cinco señales de completitud (localidad, sexo,
              chip, titularidad, actividad). Fantasma = sin titular y sin actividad en 12 meses
              (conciliación de registros).
              {quality.suppressedProvinces > 0 && (
                <>
                  {" "}
                  {quality.suppressedProvinces}{" "}
                  {quality.suppressedProvinces === 1 ? "provincia oculta" : "provincias ocultas"}{" "}
                  por k&lt;{DATA_QUALITY_K_ANON} (privacidad).
                </>
              )}
              {quality.unassigned > 0 && (
                <>
                  {" "}
                  {quality.unassigned.toLocaleString("es-AR")}{" "}
                  {pluralizeEs(quality.unassigned, "registro")} sin provincia asignada no{" "}
                  {quality.unassigned === 1 ? "aparece" : "aparecen"} en la tabla.
                </>
              )}
            </p>

            <details className="group mt-3">
              <summary className="cursor-pointer select-none text-sm font-semibold text-ln-op-ink-2 hover:text-ln-op-ink">
                Ver desglose completo de completitud (localidad, chip, titular, inactivas, chips
                reemplazados)
              </summary>
              <table className="mt-2 w-full text-md text-ln-op-ink border-collapse">
                <caption className="sr-only">
                  Desglose de completitud por provincia: registros sin localidad, sin chip, sin
                  titular, inactivos y chips reemplazados.
                </caption>
                <thead>
                  <tr className="border-b border-ln-op-line">
                    <th scope="col" className="text-left py-2 pr-4 font-semibold text-ln-op-mute">
                      Provincia
                    </th>
                    <th scope="col" className="text-right py-2 pr-4 font-semibold text-ln-op-mute">
                      Sin localidad
                    </th>
                    <th scope="col" className="text-right py-2 pr-4 font-semibold text-ln-op-mute">
                      Sin chip
                    </th>
                    <th scope="col" className="text-right py-2 pr-4 font-semibold text-ln-op-mute">
                      Sin titular
                    </th>
                    <th scope="col" className="text-right py-2 pr-4 font-semibold text-ln-op-mute">
                      Inactivas
                    </th>
                    <th scope="col" className="text-right py-2 font-semibold text-ln-op-mute">
                      Chips reemplaz.
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {quality.rows.map((row: ProvinceDataQualityRow) => (
                    <tr key={row.province} className="border-b border-ln-op-line last:border-0">
                      <td className="py-2 pr-4">{row.province}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.missingLocality}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.missingChip}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.orphans}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.dormant}</td>
                      <td className="py-2 text-right tabular-nums">{row.replacedChips}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        )}
      </OpCardBody>
    </OpCard>
  );
}
