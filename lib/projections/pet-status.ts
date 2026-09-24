// Projection: derive `pets.status` and `pets.deceasedAt` from the event log.
//
// Rules (latest wins by occurredAt, then recordedAt, then id):
//   1. Any death_recorded event → status='deceased', deceasedAt=event.occurredAt.
//      Once deceased, the pet stays deceased (no resurrection event today).
//   2. Otherwise latest status_changed event → status=payload.to_status.
//   3. Otherwise status='active' (the implicit default for newly registered
//      pets; pet_registered does NOT emit a status_changed because the
//      pets row already starts as 'active').
//
// Pure function. Caller orders events; we only care that the input is sorted
// so the "latest" rule is deterministic.

import type { ProjectionEvent } from "./types";

export type PetStatusProjection = {
  status: "active" | "lost" | "deceased";
  deceasedAt: Date | null;
};

export function replayPetStatus(events: ProjectionEvent[]): PetStatusProjection {
  // death_recorded is terminal: scan for ANY, use the earliest one (multiple
  // would be a bug — see Known gaps in AGENTS.md re: concurrency races).
  const deathEvent = events.find((e) => e.eventType === "death_recorded");
  if (deathEvent) {
    return {
      status: "deceased",
      deceasedAt: toDate(deathEvent.occurredAt),
    };
  }

  // Latest status_changed wins. Events are pre-sorted; iterate from the end.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.eventType !== "status_changed") continue;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const toStatus = payload.to_status;
    if (toStatus === "lost" || toStatus === "active") {
      return { status: toStatus, deceasedAt: null };
    }
  }

  return { status: "active", deceasedAt: null };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
