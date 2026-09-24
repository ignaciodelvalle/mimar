/**
 * loading.tsx — shared segment skeleton for every event-capture form under
 * /mis-mascotas/[publicToken]/eventos/nuevo/* (vacuna, peso, microchip,
 * embarazo, …: 17+ form routes).
 *
 * Decision (nav-QOL audit 2026-07-04, finding N4, priority #4): Next.js
 * wraps a segment's page.tsx AND every nested child segment below it in the
 * SAME <Suspense> boundary created by that segment's loading.tsx — even
 * without an explicit layout.tsx at this level. A single file here covers
 * all form sub-routes; 17 near-identical loading.tsx files would be pure
 * duplication with no additional coverage.
 */

import { Skeleton } from "@/components/ui/Skeleton";

const FIELD_KEYS = ["a", "b", "c", "d"] as const;

export default function EventCaptureFormLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in mx-auto max-w-xl px-6 py-7 pb-12 block"
    >
      <span className="sr-only">Cargando…</span>

      {/* Form title placeholder */}
      <div className="mb-6 flex flex-col gap-2">
        <Skeleton w="55%" h="26px" radius="4px" />
        <Skeleton w="70%" h="13px" radius="3px" />
      </div>

      {/* Field placeholders */}
      <div className="flex flex-col gap-[18px]">
        {FIELD_KEYS.map((k) => (
          <div key={k} className="flex flex-col gap-2">
            <Skeleton w="35%" h="12px" radius="3px" />
            <Skeleton w="100%" h="40px" radius="3px" />
          </div>
        ))}
      </div>

      {/* Submit button placeholder */}
      <Skeleton w="140px" h="40px" radius="3px" className="mt-7" />
    </output>
  );
}
