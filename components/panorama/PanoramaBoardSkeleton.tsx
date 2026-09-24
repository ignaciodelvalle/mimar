// Bounded first-paint skeleton for the Panorama board (resilience fix,
// 2026-07-10). The panorama page STREAMS its slow default-layer seed behind a
// <Suspense> boundary so the outer page function returns synchronously: the
// operator chrome + this skeleton flush as the first byte instead of the
// generic route-group "Cargando…" hanging until the ~9s seed budget elapses.
//
// It mirrors the real board's silhouette — a dark map canvas (same tokens as
// SituationalMapDynamic's own loading fallback) plus a right-rail of indicator
// placeholders — so the swap to the live console is visually stable. Purely
// presentational, no client JS.

const KPI_KEYS = ["a", "b", "c", "d"] as const;

export function PanoramaBoardSkeleton() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando el panorama…"
      className="op-fade-in block space-y-4"
    >
      <span className="sr-only">Cargando el panorama…</span>

      {/* Header eyebrow placeholder */}
      <div className="space-y-1.5">
        <div className="h-3 w-56 animate-pulse rounded bg-ln-op-line" />
        <div className="h-3 w-80 max-w-full animate-pulse rounded bg-ln-op-line/70" />
      </div>

      {/* Vista/capas panel placeholder */}
      <div className="h-16 animate-pulse rounded-[var(--radius-lg)] border border-ln-op-line bg-ln-op-card" />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_342px]">
        {/* Map canvas placeholder — dark, matching SituationalMapDynamic. */}
        <div
          className="w-full animate-pulse rounded-[var(--radius-lg)] border border-ln-op-line"
          style={{ height: 560, background: "var(--color-ln-op-page)" }}
          aria-hidden="true"
        />
        {/* Right-rail indicator placeholders */}
        <div className="space-y-3">
          {KPI_KEYS.map((k) => (
            <div
              key={k}
              className="h-20 animate-pulse rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card"
            />
          ))}
        </div>
      </div>
    </output>
  );
}
