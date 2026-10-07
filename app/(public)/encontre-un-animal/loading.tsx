/**
 * loading.tsx — first-paint skeleton for /encontre-un-animal. Footprint
 * mirrors page.tsx: the header block, the locality field, then the three
 * numbered steps.
 */

import { Skeleton } from "@/components/ui/Skeleton";

const STEP_KEYS = ["chip", "perdidas", "receptoras"] as const;

export default function EncontreUnAnimalLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in block min-h-screen bg-[var(--color-ln-paper)]"
    >
      <span className="sr-only">Cargando…</span>
      <div className="mx-auto max-w-2xl space-y-6 px-4 py-10 sm:px-6">
        <div className="space-y-2.5">
          <Skeleton w="300px" h="36px" radius="4px" />
          <Skeleton w="90%" h="16px" radius="3px" />
          <Skeleton w="70%" h="14px" radius="3px" />
        </div>
        <Skeleton w="100%" h="44px" radius="6px" />
        {STEP_KEYS.map((k) => (
          <div
            key={k}
            className="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-4"
          >
            <Skeleton w="220px" h="20px" radius="4px" />
            <Skeleton w="95%" h="14px" radius="3px" />
            <Skeleton w="60%" h="14px" radius="3px" />
          </div>
        ))}
      </div>
    </output>
  );
}
