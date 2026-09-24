"use client";

// PanoramaKpiFooter — the metrics column's recalculation cue + freshness chip
// + "Actualizar" button (extracted from PanoramaKpiStrip, panorama-vista-
// redesign Phase 3). Purely presentational; the parent owns the refresh fetch.

import { AR_TIME_ZONE, formatCount } from "@/lib/utils/format";
import type { PanoramaKpis } from "@/src/modules/panorama/application/get-panorama-kpis";
import { panoramaFreshnessCaption } from "@/src/modules/panorama/domain/cube-freshness";

type Props = {
  kpis: PanoramaKpis;
  /** map-QOL selective refresh — refetches KPIs + active layers, no reload. */
  onRefresh?: () => void;
  /** True while a selective refresh is in flight (disables the button). */
  refreshing?: boolean;
  /**
   * perf plan 1.3: the streamed KPI promise hasn't resolved yet. While pending
   * the caption shows the loading copy (`kpis.recalculatedFor`) WITHOUT the
   * dashboard-parity suffix or the "Actualizar" affordance — there is nothing
   * to refresh until the first payload lands.
   */
  pending?: boolean;
  /**
   * Cursor I2, reshaped by the cube-ON decision (K4/S3 2026-07-24) — the
   * aggregate cube's build timestamp when the view is served from the
   * precomputed cube. Non-null → "Datos precalculados al …" (age declared);
   * null/undefined (live-served, or no/never-refreshed meta) → "Datos en vivo".
   * One honest freshness/liveness line, always rendered.
   */
  cubeBuiltAt?: Date | string | null;
  /**
   * Labels of active layers whose live fetch hit the per-layer row cap (the
   * same list the map-table CSV discloses, K4). Decorates the LIVE caption so
   * a truncated live view is never presented as complete.
   */
  truncatedLayers?: string[];
};

export function PanoramaKpiFooter({
  kpis,
  onRefresh,
  refreshing = false,
  pending = false,
  cubeBuiltAt = null,
  truncatedLayers = [],
}: Props) {
  const freshnessCaption = panoramaFreshnessCaption(cubeBuiltAt, truncatedLayers);
  return (
    <div className="space-y-1.5">
      {/* metric-honesty demotion 2026-07-09: the coverage denominator ("N
          mascotas en cobertura") is a footer caption, NOT a headline tile — it
          is the denominator the rate KPIs are computed against, not a decision
          KPI. Shown once under the strip so it never competes with the decision
          KPIs or repeats across presets. */}
      {kpis.coverageDenominator && (
        <p className="text-sm text-ln-op-ink-2">
          <a href={kpis.coverageDenominator.href} className="hover:underline">
            <span className="font-semibold tabular-nums">
              {formatCount(kpis.coverageDenominator.totalPets)}
            </span>{" "}
            mascotas en cobertura
          </a>
          <span className="text-ln-op-mute"> · denominador de las tasas (activas o perdidas)</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ln-op-mute">
        <p className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full bg-ln-op-azul"
          />
          {kpis.recalculatedFor}
          {!pending && " Consistente con las superficies de detalle."}
        </p>
        {kpis.dataAsOf && (
          <span
            suppressHydrationWarning
            className="rounded-full border border-ln-op-line bg-ln-op-card px-2 py-0.5"
          >
            Datos al{" "}
            {new Date(kpis.dataAsOf).toLocaleString("es-AR", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
              timeZone: AR_TIME_ZONE,
            })}
          </span>
        )}
        {onRefresh && !pending && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="rounded-full border border-ln-op-line bg-ln-op-card px-2 py-0.5 text-ln-op-ink-2 hover:border-ln-op-azul/40 disabled:cursor-wait disabled:opacity-60"
          >
            {refreshing ? "Actualizando…" : "Actualizar"}
          </button>
        )}
      </div>
      {/* Cube-ON K4/S3 — the honest freshness/liveness line, ALWAYS rendered:
          "Datos precalculados al …" when the view is cube-served (never claim
          live for a daily snapshot), "Datos en vivo" when live — plus the
          capped-layer disclosure when a live layer hit the row cap. Unobtrusive:
          mute text, below the KPI row. */}
      <p suppressHydrationWarning className="text-xs text-ln-op-mute">
        {freshnessCaption}
      </p>
    </div>
  );
}
