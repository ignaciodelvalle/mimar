// Group a libreta's past records by the visit that wrote them
// (vet-visit-record, 2026-09-29).
//
// Pure, and shared by every renderer of a pet's record — the owner/org
// LibretaFace and the walk-in history in Atender — so "one atención reads as
// one block" is decided once.
//
// THE RULE. Records carry `visitId` when a vet wrote them inside a visit
// (stamped at insert; never backfilled). The timeline stays in its order —
// newest first — and a visit's records are gathered into ONE block placed where
// the visit's newest record would have been. Records without a visit render
// one by one, exactly as before visits existed. Nothing is dropped or
// reordered within a visit.

import { VISIT_MODALITY_LABELS, labelOf } from "@/lib/domain/visit-labels";
import { formatDateShort } from "@/lib/utils/format";

/** What a renderer needs to title a visit block. */
export type LibretaVisitInfo = {
  modality: string;
  openedAt: Date | string;
};

export type LibretaEntry<R> =
  | { kind: "event"; row: R }
  | { kind: "visit"; visitId: string; header: string; rows: R[] };

type Groupable = { id: string; occurredAt: Date | string; visitId?: string | null };

/**
 * "Atención · 20 de sept de 2026 · En la clínica". The date is the visit's
 * opening when known, else its newest record's; the modality is omitted when
 * the visit is unknown to the caller (a record whose visit it did not load).
 */
export function visitHeader(
  info: LibretaVisitInfo | undefined,
  fallbackDate: Date | string,
): string {
  const date = formatDateShort(info?.openedAt ?? fallbackDate);
  const modality = info ? labelOf(VISIT_MODALITY_LABELS, info.modality) : null;
  return ["Atención", date, modality].filter(Boolean).join(" · ");
}

export function groupPastByVisit<R extends Groupable>(
  rows: readonly R[],
  visits: Readonly<Record<string, LibretaVisitInfo>> = {},
): LibretaEntry<R>[] {
  const byVisit = new Map<string, R[]>();
  for (const row of rows) {
    if (!row.visitId) continue;
    const list = byVisit.get(row.visitId);
    if (list) list.push(row);
    else byVisit.set(row.visitId, [row]);
  }

  const entries: LibretaEntry<R>[] = [];
  const placed = new Set<string>();
  for (const row of rows) {
    if (!row.visitId) {
      entries.push({ kind: "event", row });
      continue;
    }
    if (placed.has(row.visitId)) continue;
    placed.add(row.visitId);
    const visitRows = byVisit.get(row.visitId) ?? [row];
    entries.push({
      kind: "visit",
      visitId: row.visitId,
      header: visitHeader(visits[row.visitId], row.occurredAt),
      rows: visitRows,
    });
  }
  return entries;
}
