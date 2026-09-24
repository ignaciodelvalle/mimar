/**
 * loading.tsx — full-segment navigation skeleton for /mis-mascotas (list).
 *
 * Heavy fetch: owned pets + compliance projection + pending
 * applications/transfers counts (Promise.all in page.tsx). Shell renders
 * immediately outside this boundary; this covers the registry rows so the
 * navigation from /inicio doesn't leave the main area blank (nav-QOL audit
 * 2026-07-04, finding N4).
 *
 * Footprint mirrors LnRegRow's 72px variant used on this page.
 */

import { Skeleton } from "@/components/ui/Skeleton";

const ROW_KEYS = ["a", "b", "c", "d"] as const;

export default function MisMascotasLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in mx-auto max-w-4xl px-8 py-7 pb-12 block"
    >
      <span className="sr-only">Cargando…</span>

      {/* Header placeholder */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton w="220px" h="30px" radius="4px" />
          <Skeleton w="180px" h="14px" radius="3px" />
        </div>
        <Skeleton w="150px" h="38px" radius="3px" />
      </div>

      {/* Registry rows placeholder — 72px rows to match LnRegRow */}
      <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)]">
        {ROW_KEYS.map((k) => (
          <div
            key={k}
            className="grid items-center gap-4 border-b border-[var(--color-ln-line-2)] px-5 py-3.5 last:border-b-0"
            style={{ gridTemplateColumns: "72px 1fr auto" }}
          >
            <Skeleton w="72px" h="72px" radius="50%" />
            <div className="flex flex-col gap-2">
              <Skeleton w="45%" h="16px" radius="3px" />
              <Skeleton w="30%" h="12px" radius="3px" />
            </div>
            <Skeleton w="60px" h="12px" radius="3px" />
          </div>
        ))}
      </div>
    </output>
  );
}
