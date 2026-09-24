/**
 * loading.tsx — skeleton for /gob/maltrato (welfare report queue).
 */

import { OpCardSkeleton } from "@/components/ui/dashboard/OpCardSkeleton";

export default function GobMaltratoLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in mx-auto max-w-5xl px-8 py-7 pb-12 block"
    >
      <span className="sr-only">Cargando…</span>
      <OpCardSkeleton rows={7} />
    </output>
  );
}
