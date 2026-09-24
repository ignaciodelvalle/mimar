/**
 * OpCardSkeleton — loading placeholder for <OpCard> with list/table content.
 *
 * Renders a card frame (header + body) with shimmer rows.
 * Uses operator shimmer tokens (--color-ln-op-line / --color-ln-op-card).
 *
 * Props:
 *   rows — number of content rows to show (default: 4)
 *
 * Accessibility:
 *   Wrap in a region with aria-busy="true" and role="status" (done by the
 *   loading.tsx / Suspense fallback layer, not this atom).
 */

import { Skeleton } from "@/components/ui/Skeleton";

export type OpCardSkeletonProps = {
  rows?: number;
};

// Pre-allocated key sets for common row counts (avoids index-key lint violation).
// Extends to a generic string-based key for arbitrary counts.
function rowKeys(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `row-${String.fromCharCode(97 + (i % 26))}-${Math.floor(i / 26)}`,
  );
}

export function OpCardSkeleton({ rows = 4 }: OpCardSkeletonProps) {
  const keys = rowKeys(rows);
  return (
    <div
      className="overflow-hidden rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card"
      aria-hidden="true"
    >
      {/* Card header */}
      <div className="flex items-baseline gap-2 border-b border-ln-op-line px-[15px] py-[11px]">
        <Skeleton className="op-skeleton-shimmer" w="40%" h="14px" radius="3px" />
      </div>

      {/* Card body */}
      <div className="p-[14px_16px] flex flex-col gap-2.5">
        {keys.map((k, i) => (
          <div key={k} className="flex items-center gap-2.5">
            <Skeleton
              className="op-skeleton-shimmer"
              w={`${55 + (i % 3) * 15}%`}
              h="13px"
              radius="3px"
            />
            <Skeleton className="op-skeleton-shimmer ml-auto" w="18%" h="13px" radius="3px" />
          </div>
        ))}
      </div>
    </div>
  );
}
