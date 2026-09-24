/**
 * loading.tsx — skeleton for /adoptar (public pet adoption listing).
 *
 * High visibility public surface — must render shell instantly with
 * skeleton content while the listing fetches.
 */

import { LnCardSkeleton } from "@/components/ui/LnCardSkeleton";
import { Skeleton } from "@/components/ui/Skeleton";

const FILTER_KEYS = ["a", "b", "c", "d"] as const;
const PET_KEYS = ["p1", "p2", "p3", "p4", "p5", "p6"] as const;

export default function AdoptarLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in mx-auto max-w-5xl px-6 py-7 pb-12 block"
    >
      <span className="sr-only">Cargando…</span>

      {/* Filters bar placeholder */}
      <div className="flex gap-2.5 mb-6 flex-wrap">
        {FILTER_KEYS.map((k) => (
          <Skeleton key={k} w="80px" h="32px" radius="9999px" />
        ))}
      </div>

      {/* Pet grid placeholder */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-3">
        {PET_KEYS.map((k) => (
          <LnCardSkeleton key={k} />
        ))}
      </div>
    </output>
  );
}
