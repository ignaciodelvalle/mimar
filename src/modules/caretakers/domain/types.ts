// Plain DTOs and value-shapes for the caretakers domain layer.
//
// ZERO external imports. This file must not pull in Drizzle, Next.js or @/db —
// the biome fence bans `next/*` and `server-only` under application/**, and the
// dependency-direction linter bans importing another module. The shapes that
// look like they belong to `pets` (NewNotification, UseCaseResult) are MIRRORED
// here on purpose; see application/types.ts and the module README.

// ---------------------------------------------------------------------------
// Grant lifecycle
// ---------------------------------------------------------------------------

/**
 * The workflow states of a `pet_caretaker_grants` row.
 *
 * `pending` is workflow state, not a fact about the animal — there is no
 * `caretaker_proposed` event. Only `accepted` has a spine representation
 * (`caretaker_designated`), and only `ended` emits `caretaker_ended`.
 */
export const GRANT_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "cancelled",
  "expired",
  "ended",
] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];

/**
 * Why an ACCEPTED grant stopped being active. Rides the `caretaker_ended`
 * payload as `outcome` — deliberately NOT `reason`, because erase_subject_data
 * sentinel-redacts the key `reason` across every event type (see
 * lib/events/caretaker-event-schemas.ts).
 */
export const GRANT_END_OUTCOMES = [
  "returned",
  "expired",
  "revoked_by_owner",
  "withdrawn_by_caretaker",
  // Added 2026-08-21. The other four describe a decision somebody made ABOUT the
  // arrangement; this one is the arrangement being overtaken by a change of
  // hands it was not party to — adoption finalize, decomiso. It exists because
  // those paths had to end a live grant and none of the four was true: the
  // caretaker did not return the animal, nothing expired, the titular did not
  // revoke, and the caretaker did not withdraw. Reaching for the nearest one
  // would have written a false sentence into an append-only spine and, per the
  // note in caretaker-event-schemas.ts, into the copy the caretaker reads.
  "ownership_transferred",
] as const;
export type GrantEndOutcome = (typeof GRANT_END_OUTCOMES)[number];

/**
 * Maximum length of a caretaker arrangement, in days. PO decision, settled.
 *
 * Enforced in the DOMAIN ONLY (design decision E3): a
 * `CHECK ((ends_at - starts_at) <= interval '180 days')` would be a
 * forward-only, immutable commitment to a product number in a migration that
 * can never be edited. `pet_caretaker_grants` keeps only `ends_at > starts_at`.
 * That makes this constant the single fence — hence the test that pins it.
 */
export const MAX_GRANT_DURATION_DAYS = 180;

/** How long an unanswered invitation stays open before the cron expires it. */
export const GRANT_INVITATION_EXPIRY_DAYS = 7;

/** How many days before `ends_at` both parties get the "renew or let it end" nudge. */
export const GRANT_REMINDER_LEAD_DAYS = 3;

// ---------------------------------------------------------------------------
// Shared domain result
// ---------------------------------------------------------------------------

/**
 * A rejection carries BOTH a machine-readable `reason` and the es-AR `error`
 * the user reads. The reason is what tests assert on (copy changes should not
 * break a rule test); the error is what the action returns.
 */
export type DomainRejection<R extends string> = { ok: false; reason: R; error: string };

export type DomainResult<R extends string> = { ok: true } | DomainRejection<R>;
