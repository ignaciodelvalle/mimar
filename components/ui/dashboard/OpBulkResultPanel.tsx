// OpBulkResultPanel — shared post-bulk-action partial-success/failure panel.
//
// Extracted from THREE near-identical inline `ResultPanel` implementations
// (Track B4, dim-interno:docs/reviews/results/2026-07-21-nivel-siguiente-plan.md):
// components/BulkApprovalQueueList.tsx, components/AdoptionQueueList.tsx,
// app/org/[orgToken]/mascotas/OrgMascotasBulkList.tsx. Same shape each time —
// "{succeeded} OK · {failed} fallaron" + per-item failure reasons + a
// bulkActionId footer — but each with a slightly different surface, id-
// truncation, and (in the org-mascotas case) a computed success noun instead
// of the literal "OK". This primitive converges the three onto ONE surface
// (org-mascotas's `bg-ln-op-card` variant, the most complete of the three)
// and takes the noun/truncation differences as caller-supplied props instead
// of re-deriving them.
//
// Accessibility upgrade over all three originals (none had this): the panel
// is a post-action result ANNOUNCEMENT, not a destructive alert, so it uses
// role="status"/aria-live="polite" rather than role="alert". Implemented via
// <output>, whose implicit ARIA role is already "status" — an explicit
// role="status" attribute would be redundant (biome lint/a11y/noRedundantRoles)
// — matching the pattern in components/ui/DemoModeBanner.tsx and
// components/ui/OfflineBanner.tsx / components/ui/dashboard/OpOfflineBanner.tsx.

import type { BulkResult } from "@/app/actions/bulk-actions";

export type OpBulkResultPanelProps = {
  result: BulkResult;
  onDismiss: () => void;
  /** What to call a succeeded item in the summary line. Already pluralized/
   * singularized by the caller (e.g. "vacunada" / "vacunadas"). Defaults to "OK". */
  successLabel?: string;
  /** Show only the first N chars of each failed item's id, followed by "…".
   * Omit to render the id in full. */
  truncateFailedIdsTo?: number;
  className?: string;
};

export function OpBulkResultPanel({
  result,
  onDismiss,
  successLabel = "OK",
  truncateFailedIdsTo,
  className,
}: OpBulkResultPanelProps) {
  return (
    <output
      aria-live="polite"
      className={[
        "block rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-3 space-y-2 text-md",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-baseline justify-between">
        <p className="font-medium text-ln-op-ink">
          {result.succeeded.length} {successLabel} · {result.failed.length} fallaron
        </p>
        <button
          type="button"
          onClick={onDismiss}
          className="text-sm text-ln-op-mute hover:text-ln-op-ink"
        >
          Cerrar
        </button>
      </div>
      {result.failed.length > 0 && (
        <ul className="text-sm text-ln-op-danger space-y-0.5">
          {result.failed.map((f) => (
            <li key={f.id}>
              <span className="font-ln-mono">
                {truncateFailedIdsTo ? `${f.id.slice(0, truncateFailedIdsTo)}…` : f.id}
              </span>{" "}
              — {f.reason}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-ln-op-mute font-ln-mono">bulk: {result.bulkActionId}</p>
    </output>
  );
}
