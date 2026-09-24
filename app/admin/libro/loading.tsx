// loading.tsx — segment skeleton for /admin/libro (Wave 2 Item 8 pattern).
//
// Shown while the server page streams. The shell renders outside this boundary.

import { OpCardSkeleton } from "@/components/ui/dashboard/OpCardSkeleton";

export default function LibroLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando libro de eventos…"
      className="op-fade-in mx-auto block max-w-5xl px-8 py-7 pb-12"
    >
      <span className="sr-only">Cargando libro de eventos…</span>

      {/* Header placeholder */}
      <div className="mb-6 space-y-2">
        <div className="h-[14px] w-[160px] animate-pulse rounded bg-ln-op-stripe" />
        <div className="h-[24px] w-[260px] animate-pulse rounded bg-ln-op-stripe" />
      </div>

      {/* Table placeholder */}
      <OpCardSkeleton rows={8} />
    </output>
  );
}
