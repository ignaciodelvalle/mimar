// Collapse consecutive runs of identical (action + actor) audit rows into a
// single group so a bulk backfill — e.g. ~150 "Mutación forzada de evento de
// mascota (override)" rows written by one actor in a tight window — does not
// bury real events (PII searches, business-rule changes, decomisos).
//
// The audit list is fetched ordered by performedAt DESC, id DESC, so the rows
// of a single bulk operation are already contiguous; one linear pass groups
// them. Runs shorter than `minRun` render as individual rows (two approvals by
// the same operator are signal, not noise). Pure function — no DB, no React.

export const COLLAPSE_MIN_RUN = 3;

export type GroupableAuditRow = {
  id: string;
  action: string;
  actorUserId: string | null;
  performedAt: Date;
};

export type AuditRowGroup<T extends GroupableAuditRow> =
  | { kind: "single"; row: T }
  | {
      kind: "run";
      /** Stable key for React — anchored on the first row's id. */
      key: string;
      action: string;
      actorUserId: string | null;
      count: number;
      rows: T[];
      /** Newest row's timestamp (list is DESC, so rows[0]). */
      latestAt: Date;
      /** Oldest row's timestamp (rows[count - 1]). */
      earliestAt: Date;
    };

/**
 * Groups a DESC-ordered audit list, collapsing every maximal run of rows that
 * share the same `action` and `actorUserId` into one `run` group when the run
 * length reaches `minRun`. Shorter runs are emitted as `single` groups so no
 * row is ever hidden — only the flood is folded.
 */
export function groupConsecutiveAuditRows<T extends GroupableAuditRow>(
  rows: readonly T[],
  minRun: number = COLLAPSE_MIN_RUN,
): AuditRowGroup<T>[] {
  const groups: AuditRowGroup<T>[] = [];
  let i = 0;
  while (i < rows.length) {
    let j = i + 1;
    while (
      j < rows.length &&
      rows[j].action === rows[i].action &&
      rows[j].actorUserId === rows[i].actorUserId
    ) {
      j += 1;
    }
    const run = rows.slice(i, j);
    if (run.length >= minRun) {
      groups.push({
        kind: "run",
        key: `${rows[i].action}:${rows[i].actorUserId ?? "null"}:${rows[i].id}`,
        action: rows[i].action,
        actorUserId: rows[i].actorUserId,
        count: run.length,
        rows: run,
        latestAt: run[0].performedAt,
        earliestAt: run[run.length - 1].performedAt,
      });
    } else {
      for (const r of run) groups.push({ kind: "single", row: r });
    }
    i = j;
  }
  return groups;
}
