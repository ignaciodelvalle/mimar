/**
 * loading.tsx — skeleton for /casos/[publicCode] (public case detail).
 */

import { LnCardSkeleton } from "@/components/ui/LnCardSkeleton";
import { Skeleton } from "@/components/ui/Skeleton";

export default function CasoLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in mx-auto max-w-3xl px-6 py-7 pb-12 block"
    >
      <span className="sr-only">Cargando…</span>

      {/* Case header placeholder */}
      <div className="flex flex-col gap-2.5 mb-6">
        <div className="flex items-center gap-2.5">
          <Skeleton w="90px" h="22px" radius="4px" />
          <Skeleton w="70px" h="22px" radius="9999px" />
        </div>
        <Skeleton w="65%" h="20px" radius="4px" />
      </div>

      <div className="flex flex-col gap-5">
        <LnCardSkeleton />
        <LnCardSkeleton />
      </div>
    </output>
  );
}
