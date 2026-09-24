// Shared result and notification types for the organizations application layer.
// Mirrors src/modules/welfare/application/types.ts — same shape, orgs domain.

export type NewNotification = {
  userId: string;
  notificationType: string;
  title: string;
  body: string;
  severity: "info" | "success" | "warning" | "urgent";
  ctaLabel?: string | null;
  ctaUrl?: string | null;
};

/**
 * Standard use-case result.
 * ok=true  → value T + zero-or-more pending notifications (callers flush post-tx).
 * ok=false → Spanish error string, no side-effects.
 */
export type UseCaseResult<T = void> =
  | { ok: true; value: T; notifications: NewNotification[] }
  | { ok: false; error: string };
