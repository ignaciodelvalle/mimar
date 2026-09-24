/**
 * OpDashboardSkeleton — shared loading.tsx skeleton for operator (gob/admin/org)
 * list/dashboard segments.
 *
 * Wave 2 (state-coverage audit, 2026-07-21) found only 13/~115 route segments
 * shipping a segment-specific `loading.tsx` — everywhere else inherited the
 * generic portal-root skeleton (wrong shape → a layout-shift flash on hydrate).
 * Rather than hand-roll a bespoke skeleton per screen (as the existing 13 do),
 * this composes the SAME primitives (`OpFilterBar`'s real footprint, plus
 * `OpKpiSkeleton` / `OpCardSkeleton`) behind a small prop surface so a new
 * `loading.tsx` is a 3-line file that roughly matches its destination page.
 *
 * Composition, top to bottom (each optional):
 *   1. filter-bar shimmer strip — matches `OpFilterBar`'s header+rail footprint
 *   2. KPI tile row — `kpis` tiles of `OpKpiSkeleton` (0 = omit)
 *   3. one or more `OpCardSkeleton` blocks — `cards[i]` = row count for card i
 *
 * Accessibility: this component owns the `<output aria-busy aria-label>` +
 * SR-only "Cargando…" wrapper — a loading.tsx using it needs no extra markup
 * (mirrors the existing 13 hand-rolled files' `<output>` contract, enforced by
 * `__tests__/skeleton.test.tsx`).
 *
 * Motion: `op-fade-in` (app/globals.css) so the skeleton ARRIVES instead of
 * replacing the outgoing page on one frame — MOT-2, motion audit 2026-08-04
 * Gap 2. This is the single highest-leverage line of that fix: 100 of the 165
 * `loading.tsx` files get it from here without being touched. Fading the
 * skeleton is free; fading the CONTENT it hands off to is not, and the audit
 * forbids it (§5.7).
 */

import { Skeleton } from "@/components/ui/Skeleton";
import { OpCardSkeleton } from "@/components/ui/dashboard/OpCardSkeleton";
import { OpKpiSkeleton } from "@/components/ui/dashboard/OpKpiSkeleton";

export type OpDashboardSkeletonProps = {
  /** Number of KPI tiles above the list (0 = no KPI row). Default 0. */
  kpis?: number;
  /** Row count for each `OpCardSkeleton` block. Default `[6]` (one card). */
  cards?: number[];
  /** Show the `OpFilterBar`-shaped shimmer strip. Default true. */
  filterBar?: boolean;
  /** Outer container max-width (Tailwind class), matches the real page. Default "max-w-5xl". */
  maxWidth?: string;
  /**
   * Fade the skeleton in (default true — see the Motion note above).
   *
   * Pass `false` on an EMERGENCY FILING FLOW. The motion audit's "do not
   * animate" list (§5.2) covers the bite/maltrato/lost-pet report forms: the
   * person filing is distressed, often one-handed on a phone, and the skeleton
   * IS the "is this thing working?" signal. Delaying it by even 150ms spends
   * the one thing those flows cannot spare. Everywhere else the fade is free.
   */
  fade?: boolean;
};

const KPI_KEYS = ["a", "b", "c", "d", "e", "f"] as const;
const CARD_KEYS = ["a", "b", "c", "d"] as const;

function FilterBarSkeleton() {
  return (
    <div
      className="mb-6 space-y-4 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4"
      aria-hidden="true"
    >
      {/* Header row — "Filtros" eyebrow */}
      <Skeleton className="op-skeleton-shimmer" w="70px" h="12px" radius="3px" />
      {/* Rail — period + a couple of domain-axis selects */}
      <div className="flex flex-wrap items-end gap-4">
        <Skeleton className="op-skeleton-shimmer" w="140px" h="38px" radius="3px" />
        <Skeleton className="op-skeleton-shimmer" w="180px" h="38px" radius="3px" />
        <Skeleton className="op-skeleton-shimmer" w="150px" h="38px" radius="3px" />
      </div>
    </div>
  );
}

export function OpDashboardSkeleton({
  kpis = 0,
  cards = [6],
  filterBar = true,
  maxWidth = "max-w-5xl",
  fade = true,
}: OpDashboardSkeletonProps) {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className={`${fade ? "op-fade-in " : ""}mx-auto ${maxWidth} px-8 py-7 pb-12 block`}
    >
      <span className="sr-only">Cargando…</span>

      {filterBar && <FilterBarSkeleton />}

      {kpis > 0 && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 mb-6">
          {KPI_KEYS.slice(0, kpis).map((k) => (
            <OpKpiSkeleton key={k} />
          ))}
        </div>
      )}

      <div className={cards.length > 1 ? "grid gap-6 md:grid-cols-2" : undefined}>
        {cards.map((rows, i) => (
          <OpCardSkeleton key={CARD_KEYS[i] ?? `card-${i}`} rows={rows} />
        ))}
      </div>
    </output>
  );
}
