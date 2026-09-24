/**
 * loading.tsx — first-paint skeleton for /perdidas (public lost-pet board).
 *
 * The page is force-dynamic and DB-bound (listing + three KPI counts in a
 * Promise.all), so without this boundary the navigation left the main area
 * blank until the query resolved. Footprint mirrors page.tsx: hero heading,
 * the three-tile KPI strip, and the responsive card grid.
 */

import { Skeleton } from "@/components/ui/Skeleton";

const KPI_KEYS = ["a", "b", "c"] as const;
const CARD_KEYS = ["a", "b", "c", "d", "e", "f"] as const;

export default function PerdidasLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in block bg-[var(--color-ln-paper)]"
    >
      <span className="sr-only">Cargando…</span>

      <div className="mx-auto max-w-6xl px-6 py-10 space-y-8">
        {/* Hero heading placeholder */}
        <div className="space-y-2.5 max-w-[720px]">
          <Skeleton w="320px" h="44px" radius="6px" />
          <Skeleton w="90%" h="18px" radius="3px" />
        </div>

        {/* KPI strip — three tiles */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {KPI_KEYS.map((k) => (
            <div
              key={k}
              className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-4 py-3 flex flex-col gap-2"
            >
              <Skeleton w="70%" h="11px" radius="3px" />
              <Skeleton w="48px" h="30px" radius="4px" />
            </div>
          ))}
        </div>

        {/* Card grid — matches the sm:2 / lg:3 listing grid */}
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {CARD_KEYS.map((k) => (
            <li
              key={k}
              className="rounded-xl border border-[var(--color-ln-line)] overflow-hidden bg-[var(--color-ln-card)]"
            >
              <Skeleton w="100%" h="220px" radius="0px" />
              <div className="p-4 flex flex-col gap-2">
                <Skeleton w="55%" h="18px" radius="3px" />
                <Skeleton w="40%" h="12px" radius="3px" />
                <Skeleton w="100%" h="44px" radius="6px" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </output>
  );
}
