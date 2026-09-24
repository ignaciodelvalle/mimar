/**
 * loading.tsx — skeleton for /gob/vigilancia (surveillance metrics dashboard).
 *
 * Heavy server-side aggregation (outbreak signals, ENO compliance, AMR density).
 * The map choropleth and KPI tiles are the costliest renders.
 */

import { OpCardSkeleton } from "@/components/ui/dashboard/OpCardSkeleton";
import { OpKpiSkeleton } from "@/components/ui/dashboard/OpKpiSkeleton";

const KPI_KEYS = ["a", "b", "c", "d", "e", "f"] as const;

export default function VigilanciaLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in mx-auto max-w-5xl px-8 py-7 pb-12 block"
    >
      <span className="sr-only">Cargando…</span>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 mb-6">
        {KPI_KEYS.map((k) => (
          <OpKpiSkeleton key={k} />
        ))}
      </div>

      {/* Map placeholder */}
      <div
        className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card op-skeleton-shimmer h-[360px] mb-6"
        aria-hidden="true"
      />

      <div className="grid gap-6 md:grid-cols-2">
        <OpCardSkeleton rows={5} />
        <OpCardSkeleton rows={4} />
      </div>
    </output>
  );
}
