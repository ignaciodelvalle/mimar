/**
 * loading.tsx — full-segment navigation skeleton for /cuenta.
 *
 * Heavy fetch: profile row + admin auth email lookup + pet count
 * (Promise.all in page.tsx). Shell renders immediately outside this
 * boundary; this covers the identity card + grouped settings rows so the
 * navigation from /inicio doesn't leave the main area blank (nav-QOL audit
 * 2026-07-04, finding N4).
 */

import { Skeleton } from "@/components/ui/Skeleton";

const SECTION_KEYS = ["a", "b", "c"] as const;

export default function CuentaLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in mx-auto max-w-4xl px-8 py-7 pb-12 block"
    >
      <span className="sr-only">Cargando…</span>

      {/* Header placeholder */}
      <div className="mb-7 flex flex-col gap-2">
        <Skeleton w="180px" h="30px" radius="4px" />
        <Skeleton w="240px" h="14px" radius="3px" />
      </div>

      {/* Identity card placeholder */}
      <div className="mb-7 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-4 py-4">
        <div className="flex items-center gap-4">
          <Skeleton w="64px" h="64px" radius="50%" />
          <div className="flex-1 flex flex-col gap-2">
            <Skeleton w="40%" h="16px" radius="3px" />
            <Skeleton w="55%" h="13px" radius="3px" />
          </div>
        </div>
      </div>

      {/* Grouped settings rows placeholder */}
      {SECTION_KEYS.map((k) => (
        <div key={k} className="mb-6">
          <Skeleton w="140px" h="13px" radius="3px" className="mb-3" />
          <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
            <div className="flex items-center justify-between gap-4 border-b border-[var(--color-ln-line-2)] px-[18px] py-3.5 last:border-b-0">
              <Skeleton w="55%" h="14px" radius="3px" />
              <Skeleton w="16px" h="16px" radius="3px" />
            </div>
            <div className="flex items-center justify-between gap-4 px-[18px] py-3.5">
              <Skeleton w="40%" h="14px" radius="3px" />
              <Skeleton w="16px" h="16px" radius="3px" />
            </div>
          </div>
        </div>
      ))}
    </output>
  );
}
