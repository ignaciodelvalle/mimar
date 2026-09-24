// Shared result and notification types for the events application layer.
// Mirrors src/modules/surveillance/application/types.ts — same shape, events domain.

export type NewNotification = {
  userId: string;
  notificationType: string;
  title: string;
  body: string;
  severity: "info" | "success" | "warning" | "urgent";
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  relatedPetId?: string | null;
  relatedCaseId?: string | null;
  relatedEventId?: string | null;
  category?: string | null;
};

/**
 * Standard use-case result.
 * ok=true  → value T + zero-or-more pending notifications (callers flush post-tx).
 * ok=false → Spanish error string, no side-effects.
 */
export type UseCaseResult<T = void> =
  | { ok: true; value: T; notifications: NewNotification[] }
  | { ok: false; error: string };

/**
 * What an owner-path event writer returns when the append succeeded.
 *
 * SIX WHEN THIS WAS WRITTEN, TEN NOW: WU-L brought microchip, esterilización,
 * visita veterinaria and información clínica onto it, for the same reason and
 * with the same four-line change. The count is deliberately no longer in this
 * sentence — a number here would need editing every time a writer crossed, and
 * the property is not "there are N of them" but "a writer reachable from
 * `/api/v1` reports its replays".
 *
 * `wasDuplicate` REPORTS THE REPLAY instead of swallowing it. Every one of these
 * writers routes through `insertEventIdempotent` and every one already knew the
 * answer — `wasNoop` decides whether the reminders, the projection and the
 * attachment run — and then threw it away at the boundary, which was fine while
 * the only caller was a web form that branches on `ok` alone.
 *
 * `/api/v1` is not that caller. A phone whose first attempt timed out AFTER the
 * server committed re-sends with the same `Idempotency-Key`, and "the event now
 * exists" and "you just created it" are different facts: a client that cannot
 * tell them apart re-fires whatever it does on success. Same argument, same
 * shape, as `AmendEventResult.wasDuplicate`.
 */
export type RecordedEvent = {
  eventId: string;
  /** True when the idempotency key resolved to an event that already existed. */
  wasDuplicate: boolean;
};

/**
 * Shared dependency bag injected into every use-case.
 * Callers (actions.ts) build and pass this; use-cases never import db directly.
 */
export type Deps = {
  repo: import("../infrastructure/events-repository").EventsRepository;
};
