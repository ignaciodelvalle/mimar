// Use-case types for createTattooForUser (strangler migration 34/61).

export type EventFormState = {
  error: string | null;
  /**
   * N3 post-action destination. The action must NOT redirect() — the App
   * Router drops a server action's own redirect in production: the write
   * commits and the screen never moves (lib/ui/full-page-action-nav.ts).
   */
  redirectTo?: string | null;
};

// THE FIVE PLACES ARE NAMED ONCE, IN THE CONTRACT, since the app grew a
// `tattoo` kind (2026-09-10). They lived here as a TS union and next door as a
// runtime array, which is two lists that had to agree by hand — and a native
// picker could not have named either. Re-exported under the same name so the
// web's call sites (`app/actions/tattoo.ts`, the form) read unchanged.
import type { TattooLocation } from "@dim/contract/input";

export type { TattooLocation };

export type TattooInput = {
  code: string;
  location: TattooLocation | null;
  description: string | null;
  recordedAt: Date | null;
  recordedBy: string | null;
  uploadedAttachment: { path: string; mimeType: string; size: number };
  // Idempotency guard (projection-writes audit §6): stable UUID per form
  // session. When present, a re-submit is a no-op (no second event + ident).
  clientIdempotencyKey?: string | null;
};

// wasNoop=true → duplicate submit deduped by clientIdempotencyKey; the caller
// should clean up any attachment uploaded for the redundant submission.
export type CreateTattooResult =
  | { ok: true; eventId: string; wasNoop?: boolean }
  | { error: string };
