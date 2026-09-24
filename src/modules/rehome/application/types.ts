// Shared result and notification types for the rehome application layer.
//
// MIRRORED, NOT IMPORTED — the same convention caretakers documents: these
// DTOs have the same shape in adoption, foster, transfers and the rest, each
// module keeps its own copy so no cross-module edge exists for a type nobody
// owns (scripts/check-dependency-direction.ts). `dedupeKey` is REQUIRED
// because this module flushes through `createNotificationsBulk`.

export type NewNotification = {
  userId: string;
  notificationType: string;
  title: string;
  body: string;
  severity: "info" | "success" | "warning" | "urgent";
  /**
   * Shape used across this module: `rehome:<event>:<caseId>:<recipientId>`.
   * The case id is what the notification is ABOUT (a new request is a new
   * case row, so it gets a new key); the recipient id keeps an org's several
   * admins from collapsing into one row.
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
