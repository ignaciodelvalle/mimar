// Shared result and notification types for the foster application layer.
// Mirrors the adoption module's UseCaseResult / NewNotification shapes.

export type NewNotification = {
  userId: string;
  notificationType: string;
  title: string;
  body: string;
  // The `notification_severity` pg enum is info | success | warning | urgent.
  // This mirror said "error" (which the column REJECTS) and omitted "urgent"
  // (which it accepts) — a type that permits an impossible value and forbids a
  // legal one. Dormant: nothing here emits either today. Corrected 2026-08-19
  // alongside widening CreateNotificationInput, so the mirrors and the column
  // finally agree.
  severity: "info" | "success" | "warning" | "urgent";
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  relatedPetId?: string | null;
  relatedCaseId?: string | null;
};

export type UseCaseResult<T = void> =
  | { ok: true; value: T; notifications: NewNotification[] }
  | { ok: false; error: string };
