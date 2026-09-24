// How a page of notifications is ORDERED and GROUPED for display — the one copy.
//
// WHY THIS IS IN THE CONTRACT PACKAGE AND NOT IN A PAGE
// ---------------------------------------------------------------------------
// The rule was born in `app/(app)/notificaciones/notification-ordering.ts`,
// which is exactly the right place for it while there is one renderer. There
// are now two: the web inbox and the native one. Two renderers with two copies
// of a sort is a promise ("the phone shows what the browser shows") that nothing
// checks — and this is the kind of drift that is invisible in review, because
// both copies read correctly on their own and only disagree on the fourth row of
// a real inbox.
//
// So the rule moves HERE, where `@dim/contract`'s whole job is that two programs
// cannot answer the same question differently, and the web module becomes a
// four-line adapter over it. Nothing about the web's behaviour changes: its own
// unit test (`notification-ordering.test.ts`) was not touched by the move, and it
// still passes over the delegating adapter — which is the evidence that the rule
// arrived intact rather than being retyped.
//
// GENERIC OVER THE ROW, AND WHY IT HAS TO BE
// ---------------------------------------------------------------------------
// The two callers hold different objects. The web has a Drizzle row whose
// `createdAt` is a `Date` and whose fields are snake-cased columns mapped by the
// ORM; the phone has a JSON payload whose `createdAt` is an ISO string. Neither
// can be turned into the other without one of them building a fake of the other's
// shape, so these functions take the row AS IT IS plus a `facts` function that
// projects the five values the rule actually reads.
//
// That projection is the ONLY thing each side owns, it is five field reads long,
// and `__tests__/notification-ordering-parity.test.ts` runs both projections over
// the same logical notifications and asserts the two orders are identical. The
// rule is shared by construction; the two projections are shared by test.
//
// ZERO RUNTIME DEPENDENCIES, like every other module in this package.

/**
 * The four severities `notifications.severity` can hold (`notification_severity`
 * enum, db/schema.ts).
 *
 * The functions below accept a plain `string` rather than this union, and that is
 * deliberate: `severity` reaches them from a database column and from a JSON
 * payload, and a value neither program recognises must be ORDERED rather than
 * crash a list. See `severityRank`.
 */
export const NOTIFICATION_SEVERITIES = ["urgent", "warning", "success", "info"] as const;

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/**
 * The five values the display rule reads out of one notification.
 *
 * `createdAtMs` is EPOCH MILLISECONDS and not a `Date` or an ISO string, because
 * the two callers hold different ones and the comparison is arithmetic either
 * way. A caller converting from a string must hand over a finite number — see
 * the note on `sortForDisplay` for what an unparseable date does to a sort.
 */
export type NotificationOrderingFacts = {
  severity: string;
  createdAtMs: number;
  /** The row's stable identifier. The last tiebreak, compared as a string. */
  id: string;
  /** The subject animal, or `null` for a notification about no one animal. */
  relatedPetId: string | null;
  /** Free text (`notifications.notification_type` has no CHECK) — see db/schema.ts. */
  notificationType: string;
};

/** Projects one caller's row onto the five values the rule reads. */
export type NotificationFacts<Row> = (row: Row) => NotificationOrderingFacts;

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

/** Inbox priority: urgent surfaces first, info last. Lower number = higher up. */
const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  urgent: 0,
  warning: 1,
  success: 2,
  info: 3,
};

/**
 * Where a severity sits in the inbox. Lower is higher up.
 *
 * A SEVERITY THIS FILE DOES NOT KNOW RANKS AS `info`, and the fallback is load
 * bearing rather than defensive dressing: the input is a database enum on one
 * side and a JSON string on the other, and the day a fifth severity is added the
 * correct behaviour for a client that predates it is to show the row at the
 * bottom of the list — not to sort it to the top, and not to throw inside a
 * comparator, which produces an exception with no row in it to name.
 */
export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity as NotificationSeverity] ?? SEVERITY_RANK.info;
}

// ---------------------------------------------------------------------------
// Display order
// ---------------------------------------------------------------------------

/**
 * Order a page of rows for display: highest severity first, then most recent,
 * then id descending as a stable tiebreak (which mirrors the web's SQL keyset
 * order's secondary sort, so two rows written in the same millisecond do not
 * swap places between one render and the next).
 *
 * RETURNS A NEW ARRAY. The web caller's input is the chronologically ordered
 * page its keyset cursor is derived from — reordering it in place would corrupt
 * "Ver más antiguos" — and the native caller holds a payload it re-reads on
 * refresh. Neither may be mutated, and the copy is what guarantees it.
 *
 * AN UNPARSEABLE `createdAtMs` (NaN) MAKES THE TIMESTAMP COMPARISON INERT rather
 * than random: `NaN !== 0` is true, so the comparator would return NaN and the
 * sort's behaviour would be engine-defined. Callers must not pass one — the
 * native adapter substitutes 0 for an unparseable ISO string, which sorts that
 * row to the bottom of its severity band, which is the honest place for a row
 * whose date nobody can read.
 */
export function sortForDisplay<Row>(rows: readonly Row[], facts: NotificationFacts<Row>): Row[] {
  return [...rows].sort((a, b) => {
    const left = facts(a);
    const right = facts(b);
    const rankDelta = severityRank(left.severity) - severityRank(right.severity);
    if (rankDelta !== 0) return rankDelta;
    const tsDelta = right.createdAtMs - left.createdAtMs;
    if (tsDelta !== 0) return tsDelta;
    return right.id.localeCompare(left.id);
  });
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/** How many rows of one (pet, type) it takes before the list collapses them. */
export const NOTIFICATION_GROUP_MIN = 3;

export type NotificationGroup<Row> =
  | { kind: "single"; row: Row }
  | { kind: "group"; leader: Row; rest: Row[] };

function bucketKey(facts: NotificationOrderingFacts): string {
  return `${facts.relatedPetId ?? "_"}|${facts.notificationType}`;
}

/**
 * Collapse runs of the same (relatedPetId, notificationType) into one group once
 * there are at least `NOTIFICATION_GROUP_MIN` of them.
 *
 * ADJACENCY-INDEPENDENT: rows are bucketed by key wherever they appear, so a
 * prior severity sort does not fragment a group. The group leader is the first
 * instance in the INCOMING order — i.e. the highest-priority one when the input
 * came through `sortForDisplay`, which is how the collapsed card ends up being
 * the one worth reading.
 */
export function groupForDisplay<Row>(
  rows: readonly Row[],
  facts: NotificationFacts<Row>,
): NotificationGroup<Row>[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = bucketKey(facts(row));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const result: NotificationGroup<Row>[] = [];
  const seenBuckets = new Map<string, Row[]>();
  for (const row of rows) {
    const key = bucketKey(facts(row));
    const total = counts.get(key) ?? 0;
    if (total < NOTIFICATION_GROUP_MIN) {
      result.push({ kind: "single", row });
      continue;
    }
    const existing = seenBuckets.get(key);
    if (existing) {
      existing.push(row);
      continue;
    }
    const rest: Row[] = [];
    seenBuckets.set(key, rest);
    result.push({ kind: "group", leader: row, rest });
  }
  return result;
}
