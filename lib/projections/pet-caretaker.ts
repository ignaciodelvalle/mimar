// Projection: derive a pet's temporary-caretaker arrangements from the spine.
//
// Pure function. Caller supplies the events; this only decides what they mean.
//
// WHY IT PRODUCES INTERVALS AND NOT COLUMNS. Every other projection here folds
// events down onto `pets.*` columns and is compared by rederivePetCache. A
// caretaker arrangement is not a column: it is a SET OF ROWS WITH A LIFECYCLE
// (`ownerships` where role='caretaker'), so its cache-vs-spine comparison needs
// a different shape and a different harness — lib/infra/rederive-pet-ownerships.ts,
// a SIBLING to rederivePetCache rather than an extension of it. Forcing this
// into `Record<column, {stored, derived}>` would distort a working abstraction
// and both of its consumers.
//
// SCOPED TO `caretaker` ON PURPOSE. Replaying `owner` / `foster` /
// `shelter_custody` intervals would mean modelling custody_transferred,
// adoption_finalized, decomiso, free-claim and chip-match — a much larger
// change that this one must not absorb silently. The general gap (no ownership
// role has drift detection today) is logged as a finding for the integrity
// plan, not fixed here.

import type { ProjectionEvent } from "./types";

export type CaretakerInterval = {
  grantId: string;
  caretakerUserId: string;
  startedAt: Date;
  /** null while the arrangement is still open. */
  endedAt: Date | null;
  /** `caretaker_ended.outcome`, or null while open. */
  outcome: string | null;
};

export function replayPetCaretakers(events: ProjectionEvent[]): CaretakerInterval[] {
  const byGrant = new Map<string, CaretakerInterval>();
  // Endings can be replayed before their designation, so they are collected
  // first and applied afterwards instead of being dropped on arrival.
  const endings = new Map<string, { endedAt: Date; outcome: string }>();

  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const grantId = readString(payload.grant_id);
    if (!grantId) continue;

    if (event.eventType === "caretaker_designated") {
      applyDesignation(byGrant, grantId, payload, event);
    } else if (event.eventType === "caretaker_ended") {
      applyEnding(endings, grantId, payload, event);
    }
  }

  for (const [grantId, ending] of endings) {
    const interval = byGrant.get(grantId);
    // An ending with no designation is a hole in the spine, not an interval.
    // Inventing a zero-length arrangement would have the drift harness report a
    // phantom row instead of the missing event.
    if (!interval) continue;
    interval.endedAt = ending.endedAt;
    interval.outcome = ending.outcome;
  }

  // Stable order: the caller compares this against a set of rows, so the order
  // is part of the contract rather than an accident of the input.
  return [...byGrant.values()].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.grantId.localeCompare(b.grantId),
  );
}

function applyDesignation(
  byGrant: Map<string, CaretakerInterval>,
  grantId: string,
  payload: Record<string, unknown>,
  event: ProjectionEvent,
): void {
  const caretakerUserId = readString(payload.caretaker_user_id);
  // Required by the Zod schema, so a row missing it cannot come from the app.
  // Skipped rather than thrown on: this runs over historical rows in a sweep,
  // and one bad row must not void the sweep.
  if (!caretakerUserId) return;
  // First designation per grant wins. A duplicate would be a spine defect;
  // taking the first keeps the interval's start honest.
  if (byGrant.has(grantId)) return;
  byGrant.set(grantId, {
    grantId,
    caretakerUserId,
    startedAt: toDate(event.occurredAt),
    endedAt: null,
    outcome: null,
  });
}

function applyEnding(
  endings: Map<string, { endedAt: Date; outcome: string }>,
  grantId: string,
  payload: Record<string, unknown>,
  event: ProjectionEvent,
): void {
  const outcome = readString(payload.outcome);
  if (!outcome) return;
  const endedAt = toDate(event.occurredAt);
  const existing = endings.get(grantId);
  // EARLIEST ending wins. The spine is append-only, so a correction is a second
  // event rather than an edit — and the moment access actually stopped is the
  // first one. A later duplicate cannot move it back.
  if (!existing || endedAt.getTime() < existing.endedAt.getTime()) {
    endings.set(grantId, { endedAt, outcome });
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
