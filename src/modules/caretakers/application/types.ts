// Shared result and notification types for the caretakers application layer.
//
// MIRRORED, NOT IMPORTED. `NewNotification` and `UseCaseResult` have the same
// shape in adoption, foster, transfers, welfare, surveillance, organizations,
// events and decomiso — eight local copies, on purpose. Importing one module's
// copy would create a cross-module edge (scripts/check-dependency-direction.ts)
// for a DTO neither module owns, and the edge would point the wrong way: this
// module must never depend on `pets`. The convention is stated in the
// ALLOWED_EDGES comment itself — "mirror the shape, don't import the module".

export type NewNotification = {
  userId: string;
  notificationType: string;
  title: string;
  body: string;
  // The REAL notification_severity pg enum is info|success|warning|urgent.
  // The sibling copies in foster/transfers say `"error"` instead of `"urgent"`
  // — a value the enum would reject at insert time. Copied shapes drift; this
  // one is typed against the schema rather than against its siblings.
  severity: "info" | "success" | "warning" | "urgent";
  /**
   * REQUIRED idempotency key — this module writes through
   * `createNotificationsBulk` (lib/infra/notification-service.ts), whose insert
   * is ON CONFLICT (dedupe_key) DO NOTHING. Unlike the sibling copies in
   * adoption/foster/transfers, which still flush with a raw insert into the
   * `notifications` table, this field is NOT optional here: a use-case that
   * forgets it does not compile.
   *
   * Shape used across this module: `caretaker:<event>:<grantId>:<recipientId>`.
   * The grant id is what the notification is ABOUT (a re-invitation is a new
   * grant row, so it gets a new key); the recipient id is what keeps the two
   * copies of a two-party notice from collapsing into one.
   */
  dedupeKey: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  relatedPetId?: string | null;
  relatedCaseId?: string | null;
  category?: string | null;
};

export type UseCaseResult<T = void> =
  | { ok: true; value: T; notifications: NewNotification[] }
  | { ok: false; error: string };
