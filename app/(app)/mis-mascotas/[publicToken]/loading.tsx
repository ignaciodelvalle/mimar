/**
 * loading.tsx — full-segment navigation skeleton for /mis-mascotas/[publicToken].
 *
 * Heavy fetch: pet profile + events + achievements + reminders.
 * Shell renders immediately outside this boundary.
 */

import { DegradedFallback } from "@/components/ui/DegradedFallback";
import { LnCardSkeleton } from "@/components/ui/LnCardSkeleton";
import { Skeleton } from "@/components/ui/Skeleton";

export default function PetProfileLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in mx-auto max-w-3xl px-6 py-7 pb-12 block"
    >
      <span className="sr-only">Cargando…</span>

      {/* degraded-states: escalates to waiting text / degraded card if this
          boundary stalls (pure CSS — see components/ui/DegradedFallback.tsx). */}
      <DegradedFallback>
        {/* Hero placeholder */}
        <div className="flex items-start gap-5 mb-6">
          <Skeleton w="96px" h="96px" radius="50%" />
          <div className="flex-1 flex flex-col gap-2.5 pt-1.5">
            <Skeleton w="55%" h="26px" radius="4px" />
            <Skeleton w="40%" h="14px" radius="3px" />
            <Skeleton w="30%" h="12px" radius="3px" />
          </div>
        </div>

        {/* Cards */}
        <div className="flex flex-col gap-5">
          <LnCardSkeleton />
          <LnCardSkeleton />
        </div>
      </DegradedFallback>
    </output>
  );
}
