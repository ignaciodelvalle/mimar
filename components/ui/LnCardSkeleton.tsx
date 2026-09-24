/**
 * LnCardSkeleton — loading placeholder for owner-surface cards (LnCard).
 *
 * Matches the LnCard frame (rounded-[var(--radius-sm)] border ln-line bg-ln-card shadow)
 * with a header row and shimmer body lines.
 *
 * Uses owner/public shimmer tokens (--color-ln-line / --color-ln-card).
 *
 * Accessibility:
 *   Wrap in a region with aria-busy="true" and role="status" (done by the
 *   loading.tsx / Suspense fallback layer, not this atom).
 */

import { Skeleton } from "@/components/ui/Skeleton";

export function LnCardSkeleton() {
  return (
    <div
      className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] shadow-[0_1px_0_rgba(0,0,0,.02)]"
      aria-hidden="true"
    >
      {/* Card header */}
      <div className="flex items-center gap-2 border-b border-[var(--color-ln-line-2)] px-4 py-3">
        <Skeleton w="45%" h="15px" radius="3px" />
      </div>

      {/* Card body */}
      <div className="px-4 py-3.5 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Skeleton w="40px" h="40px" radius="50%" />
          <div className="flex-1 flex flex-col gap-1.5">
            <Skeleton w="60%" h="13px" radius="3px" />
            <Skeleton w="40%" h="11px" radius="3px" />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Skeleton w="80%" h="13px" radius="3px" />
          <Skeleton w="55%" h="13px" radius="3px" />
        </div>
      </div>
    </div>
  );
}
