/**
 * loading.tsx — skeleton for /gob/perdidas (lost pets dashboard).
 */

import { OpCardSkeleton } from "@/components/ui/dashboard/OpCardSkeleton";
import { OpKpiSkeleton } from "@/components/ui/dashboard/OpKpiSkeleton";

const KPI_KEYS = ["a", "b", "c"] as const;

export default function GobPerdidasLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in mx-auto max-w-5xl px-8 py-7 pb-12 block"
    >
      <span className="sr-only">Cargando…</span>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 mb-6">
        {KPI_KEYS.map((k) => (
          <OpKpiSkeleton key={k} />
        ))}
      </div>

      <OpCardSkeleton rows={6} />
    </output>
  );
}
