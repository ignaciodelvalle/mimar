/**
 * OpKpiSkeleton — loading placeholder for <OpKpi>.
 *
 * Same footprint as OpKpi (min-h-[112px], rounded-[var(--radius-md)] border, p-[14px_16px])
 * to guarantee zero CLS when the real tile hydrates.
 *
 * Uses operator shimmer tokens (--color-ln-op-line / --color-ln-op-card).
 *
 * Accessibility:
 *   Wrap one or more of these in a region with aria-busy="true" and
 *   role="status" (handled by the loading.tsx / Suspense fallback layer).
 */

import { Skeleton } from "@/components/ui/Skeleton";

export function OpKpiSkeleton() {
  return (
    <div
      className="flex flex-col rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-[14px_16px] min-h-[112px]"
      aria-hidden="true"
    >
      {/* Label row */}
      <Skeleton className="op-skeleton-shimmer" w="55%" h="10px" radius="3px" />
      {/* Value */}
      <Skeleton className="op-skeleton-shimmer mt-2.5" w="45%" h="30px" radius="4px" />
      {/* Sub / delta placeholder */}
      <Skeleton className="op-skeleton-shimmer mt-auto" w="70%" h="10px" radius="3px" />
    </div>
  );
}
