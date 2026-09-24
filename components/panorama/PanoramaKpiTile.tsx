"use client";

// PanoramaKpiTile — one headline KPI tile (extracted from PanoramaKpiStrip,
// panorama-vista-redesign Phase 3). Renders an OpKpi card + a neutral delta
// line underneath. Reused by PanoramaMetricsColumn (per-vista curated set).
//
// The delta stays a neutral text line — NEVER a valence color. Several
// panorama KPIs are bad-when-up (zoonosis, mordeduras); a green "Sube" would
// misread a worsening trend as an improvement (code review 2026-07-03).
//
// v+1 rail: `bar` (target-progress meter) and `sparkline` (inline trend) are
// straight pass-throughs to OpKpi — both already existed on OpKpi, only
// `kpi.sparkline` is new (get-panorama-kpis.ts). No new visual language.

import { DeltaGlyph } from "@/components/panorama/DeltaGlyph";
import { OpKpi } from "@/components/ui/dashboard/OpKpi";
import type { PanoramaKpi } from "@/src/modules/panorama/application/get-panorama-kpis";

type Props = {
  kpi: PanoramaKpi;
};

export function PanoramaKpiTile({ kpi }: Props) {
  // Per-tile degradation (2026-07): this tile's PRIMARY fetcher rejected while its
  // siblings succeeded. Render a self-contained "no disponible" card — same OpKpi
  // footprint (min-h-[112px]) and label, dashed border to signal the degraded
  // state, NO numbers (parity: an unavailable tile never shows a stale figure).
  // The operator still sees WHICH metric failed via the label.
  if (kpi.unavailable) {
    return (
      <div
        aria-label={`${kpi.label}: no disponible`}
        className="flex min-h-[112px] flex-col rounded-[var(--radius-md)] border border-dashed border-ln-op-line bg-ln-op-card p-[14px_16px]"
      >
        <span className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          {kpi.label}
        </span>
        <span className="font-ln-serif text-2xl font-semibold leading-none tracking-[-0.02em] text-ln-op-mute">
          —
        </span>
        <p className="mt-auto pt-1.5 text-xs text-ln-op-mute">No disponible en este momento.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <OpKpi
        label={kpi.label}
        value={kpi.value}
        tone={kpi.tone}
        bar={kpi.bar}
        sub={kpi.sub}
        href={kpi.href}
        info={kpi.info}
        sparkline={kpi.sparkline}
      />
      {kpi.delta && (
        <p className="flex items-center gap-1 text-xs tabular-nums text-ln-op-mute">
          <DeltaGlyph direction={kpi.delta.direction} />
          <span>{kpi.delta.label}</span>
        </p>
      )}
    </div>
  );
}
