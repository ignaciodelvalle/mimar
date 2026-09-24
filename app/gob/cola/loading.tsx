/**
 * loading.tsx — skeleton for /gob/cola (govt approval queue).
 * Heavy fetch: paginated pending approval_requests with jurisdiction scoping.
 */

import { DegradedFallback } from "@/components/ui/DegradedFallback";
import { OpCardSkeleton } from "@/components/ui/dashboard/OpCardSkeleton";

export default function GobColaLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in mx-auto max-w-5xl px-8 py-7 pb-12 block"
    >
      <span className="sr-only">Cargando…</span>
      {/* degraded-states: escalates to waiting text / degraded card if this
          boundary stalls (pure CSS — see components/ui/DegradedFallback.tsx). */}
      <DegradedFallback>
        <OpCardSkeleton rows={8} />
      </DegradedFallback>
    </output>
  );
}
