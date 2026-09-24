// AuthorChip — citizen-safe "who recorded this" chip: role + verified mark,
// NEVER a personal name (privacy convention — an operator's PII is never
// exposed to the citizen viewing their own pet's timeline). Extracted from
// app/(app)/mis-mascotas/[publicToken]/eventos/[eventId]/page.tsx (C5,
// 2026-07-21 facades harvest) so EventTimeline.tsx can reuse the exact same
// component instead of a third duplicate of AUTHOR_ROLE_LABELS (the admin
// ledger, app/admin/libro/view.ts, already carries an independent copy for
// its own operator-facing styling/tokens).

import { Icon } from "@/components/Icon";
import { AUTHOR_ROLE_LABELS, authorRoleLabel } from "@/lib/events/author-role-labels";

// The TABLE moved to lib/events/author-role-labels.ts (2026-08-25) so the native
// event-detail endpoint can compose the same label without importing a React
// component. Re-exported here because every existing importer names it from this
// file, and the chip is still where a reader looks for it.
export { AUTHOR_ROLE_LABELS };

export function AuthorChip({ role, verified }: { role: string; verified: boolean }) {
  const label = authorRoleLabel(role);
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-2 py-0.5 font-ln-mono text-xs text-[var(--color-ln-ink-2)]">
      {label}
      {verified && (
        <span
          className="inline-flex h-[13px] w-[13px] items-center justify-center rounded-full bg-[var(--color-ln-ok)] text-white"
          title="Verificado"
          aria-label="verificado"
        >
          <Icon name="check" size={9} decorative />
        </span>
      )}
    </span>
  );
}
