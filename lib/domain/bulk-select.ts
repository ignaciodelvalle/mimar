// Pure helpers for the operator bulk-select state machine (Wave 2 Item 10.2).
//
// Kept side-effect-free and DOM-free so the selection logic is unit-testable
// without a browser. The OpBulkBar component and the queue list components hold
// the React state; these functions compute the next state.

import { pluralizeEs } from "@/lib/utils/format";

/** Toggle a single id in/out of the selection set, returning a new Set. */
export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * "Select page" toggle. If every selectable id on the page is already selected,
 * clears the selection; otherwise selects all selectable ids on the page.
 */
export function toggleSelectPage(
  selected: ReadonlySet<string>,
  pageSelectableIds: readonly string[],
): Set<string> {
  if (isPageFullySelected(selected, pageSelectableIds)) return new Set();
  return new Set(pageSelectableIds);
}

/** True when the page has ≥1 selectable id and all of them are selected. */
export function isPageFullySelected(
  selected: ReadonlySet<string>,
  pageSelectableIds: readonly string[],
): boolean {
  return pageSelectableIds.length > 0 && pageSelectableIds.every((id) => selected.has(id));
}

/**
 * Whether a destructive bulk action may proceed. A reason of at least
 * `minLength` trimmed chars is required. Default min is 5 (matches
 * bulkRejectRequestsAction); the revoke flow passes 30 (bulkRevokeAction).
 */
export function isReasonValid(reason: string, minLength = 5): boolean {
  return reason.trim().length >= minLength;
}

/** Human-readable "N seleccionados" summary (es-AR pluralization). */
export function selectionSummary(count: number): string {
  return `${count} ${pluralizeEs(count, "seleccionado")}`;
}
