/**
 * loading.tsx — skeleton for /gob/analytics (analytics dashboard).
 */

import { OpCardSkeleton } from "@/components/ui/dashboard/OpCardSkeleton";
import { OpKpiSkeleton } from "@/components/ui/dashboard/OpKpiSkeleton";

const KPI_KEYS = ["a", "b", "c", "d"] as const;

export default function AnalyticsLoading() {
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

      <div className="grid gap-6 md:grid-cols-2">
        <OpCardSkeleton rows={6} />
        <OpCardSkeleton rows={5} />
      </div>
    </output>
  );
}
