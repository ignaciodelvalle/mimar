/**
 * loading.tsx — full-segment navigation skeleton for /gob (govt operator).
 *
 * Shown by Next.js during segment-level navigation while the page's async
 * component is streaming. The shell (AppShell variant="operator") renders
 * immediately outside this boundary.
 *
 * PO visual-validation batch B (2026-07-23): mirrors the revised briefing
 * shape —
 *   1. Alertas priorizadas — 2 card-shaped placeholders (max 5, but the
 *      skeleton only needs to suggest "a short ranked list", not the cap).
 *   2. Brechas vs meta — 10 KPI-tile placeholders (the 8 original tiles +
 *      the 2 mortalidad/disposición tiles folded in as ordinary OpKpi tiles,
 *      no longer their own oddly-shaped card) + 1 chart-card placeholder for
 *      the "mordeduras por período" trend (a genuine chart never mixes into
 *      the KPI-tile grid).
 *   3. Cola operativa — 5 individual KPI-tile placeholders, "de a 1" (was one
 *      condensed row card; each queue now carries its own tile, including
 *      "Habilitación de organizaciones" which gained a metric).
 *   4. Actividad reciente (collapsed) — one card placeholder. "Mi trabajo
 *      asignado" is conditional (hidden at 0) and, like before, has no
 *      placeholder of its own.
 */

import { DegradedFallback } from "@/components/ui/DegradedFallback";
import { OpCardSkeleton } from "@/components/ui/dashboard/OpCardSkeleton";
import { OpKpiSkeleton } from "@/components/ui/dashboard/OpKpiSkeleton";

const ALERT_KEYS = ["a", "b"] as const;
const BRECHAS_KPI_KEYS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] as const;
const QUEUE_KPI_KEYS = ["a", "b", "c", "d", "e"] as const;

export default function GobLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in mx-auto max-w-5xl px-8 py-7 pb-12 block"
    >
      <span className="sr-only">Cargando…</span>

      {/* degraded-states: escalates to waiting text / degraded card if this
          boundary stalls (pure CSS — see components/ui/DegradedFallback.tsx). */}
      <DegradedFallback>
        {/* Block 1 — Alertas priorizadas placeholder */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 mb-6">
          {ALERT_KEYS.map((k) => (
            <OpCardSkeleton key={`alert-${k}`} rows={2} />
          ))}
        </div>

        {/* Block 2 — Brechas vs meta: KPI grid (10 tiles, incl. mortalidad/
          disposición) + its own chart-card sub-row (mordeduras por período). */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 mb-4">
          {BRECHAS_KPI_KEYS.map((k) => (
            <OpKpiSkeleton key={`kpi-${k}`} />
          ))}
        </div>
        <div className="mb-6">
          <OpCardSkeleton rows={3} />
        </div>

        {/* Block 3 — Cola operativa, "de a 1": one KPI-tile placeholder per
          queue card. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 mb-6">
          {QUEUE_KPI_KEYS.map((k) => (
            <OpKpiSkeleton key={`queue-${k}`} />
          ))}
        </div>

        {/* Block 4 — Actividad reciente (collapsed) placeholder */}
        <OpCardSkeleton rows={3} />
      </DegradedFallback>
    </output>
  );
}
