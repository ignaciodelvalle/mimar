/**
 * loading.tsx — first-paint skeleton for /refugios (public shelter index).
 *
 * The page is force-dynamic and DB-bound (verified shelters + rescue networks,
 * grouped by province), so without this boundary the main area stayed blank
 * until the query resolved. Footprint mirrors page.tsx: header block plus two
 * province sections, each a titled band over a two-column card grid.
 */

import { Skeleton } from "@/components/ui/Skeleton";

const SECTION_KEYS = ["a", "b"] as const;
const CARD_KEYS = ["a", "b", "c", "d"] as const;

export default function RefugiosLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in block min-h-screen bg-[var(--color-ln-paper)]"
    >
      <span className="sr-only">Cargando…</span>

      <div className="max-w-4xl mx-auto px-6 py-10 space-y-8">
        {/* Header placeholder */}
        <div className="space-y-2.5">
          <Skeleton w="360px" h="32px" radius="4px" />
          <Skeleton w="80%" h="16px" radius="3px" />
          <Skeleton w="180px" h="14px" radius="3px" />
        </div>

        {/* Province sections */}
        <div className="space-y-10">
          {SECTION_KEYS.map((s) => (
            <section key={s} className="space-y-3">
              <div className="border-b border-[var(--color-ln-line)] pb-1">
                <Skeleton w="120px" h="12px" radius="3px" />
              </div>
              <ul className="grid gap-2 sm:grid-cols-2">
                {CARD_KEYS.map((c) => (
                  <li key={c}>
                    <div className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-4 py-3">
                      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
                        <Skeleton w="70%" h="13px" radius="3px" />
                        <Skeleton w="45%" h="11px" radius="3px" />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </output>
  );
}
