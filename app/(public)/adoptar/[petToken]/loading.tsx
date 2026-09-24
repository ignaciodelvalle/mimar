/**
 * loading.tsx — skeleton for /adoptar/[petToken] (public pet adoption detail).
 */

import { LnCardSkeleton } from "@/components/ui/LnCardSkeleton";
import { Skeleton } from "@/components/ui/Skeleton";

export default function AdoptarPetLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in mx-auto max-w-3xl px-6 py-7 pb-12 block"
    >
      <span className="sr-only">Cargando…</span>

      {/* Hero */}
      <div className="flex flex-col items-center gap-3.5 mb-7">
        <Skeleton w="140px" h="140px" radius="12px" />
        <Skeleton w="50%" h="24px" radius="4px" />
        <Skeleton w="35%" h="14px" radius="3px" />
      </div>

      <div className="flex flex-col gap-5">
        <LnCardSkeleton />
        <LnCardSkeleton />
      </div>
    </output>
  );
}
