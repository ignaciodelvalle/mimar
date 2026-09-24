// loading.tsx — segment skeleton for /admin/alertas (Paquete K).
//
// Shown while the server page streams. The admin shell renders outside this
// boundary.

import { OpCardSkeleton } from "@/components/ui/dashboard/OpCardSkeleton";

export default function AlertasLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando bandeja de alertas…"
      className="op-fade-in block space-y-6"
    >
      <span className="sr-only">Cargando bandeja de alertas…</span>

      {/* Header placeholder */}
      <div className="space-y-2">
        <div className="h-[14px] w-[160px] animate-pulse rounded bg-ln-op-stripe" />
        <div className="h-[24px] w-[260px] animate-pulse rounded bg-ln-op-stripe" />
      </div>

      {/* Filters + table placeholders */}
      <OpCardSkeleton rows={2} />
      <OpCardSkeleton rows={8} />
    </output>
  );
}
