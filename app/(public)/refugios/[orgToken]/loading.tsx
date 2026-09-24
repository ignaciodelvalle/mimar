/**
 * loading.tsx — skeleton for /refugios/[orgToken] (public org profile).
 */

import { LnCardSkeleton } from "@/components/ui/LnCardSkeleton";
import { Skeleton } from "@/components/ui/Skeleton";

export default function RefugioLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in mx-auto max-w-3xl px-6 py-7 pb-12 block"
    >
      <span className="sr-only">Cargando…</span>

      {/* Org hero placeholder */}
      <div className="flex items-start gap-5 mb-7">
        <Skeleton w="80px" h="80px" radius="12px" />
        <div className="flex-1 flex flex-col gap-2.5 pt-1">
          <Skeleton w="60%" h="22px" radius="4px" />
          <Skeleton w="40%" h="13px" radius="3px" />
          <Skeleton w="30%" h="12px" radius="3px" />
        </div>
      </div>

      {/* Info panels */}
      <div className="flex flex-col gap-5">
        <LnCardSkeleton />
        <LnCardSkeleton />
      </div>
    </output>
  );
}
