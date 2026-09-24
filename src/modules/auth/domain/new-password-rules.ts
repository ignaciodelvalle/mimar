// The two rules a NEW password has to pass, in one place, because there are now
// three callers and they must not drift.
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// The rules used to be written out inside `updatePasswordAction` with a literal
// `8` and a literal sentence, which was fine while `/recuperar/actualizar` was
// the only web surface that set a password after a recovery. It is not any more:
// since the code step sets the password itself (`ResetCodeStep.tsx`), a second
// web caller applies the same two rules, and the phone applies them a third time
// (`resetPasswordWithCode`, apps/mobile/src/auth/session-store.ts). Three copies
// of a threshold is how a threshold silently becomes two thresholds.
//
// THE ORDER IS PART OF THE CONTRACT, not a detail of the implementation. Length
// is checked BEFORE the confirmation, because somebody who typed the same short
// password into both boxes should be told the length — telling them "las
// contraseñas no coinciden" when they match perfectly is a lie that costs a
// support call. The phone's docblock makes the same point about the same pair.
//
// THIS MODULE IS PURE ON PURPOSE: it is imported by a CLIENT component, so it
// may never reach for `@/lib/supabase/server`, `headers()`, or anything else
// that would drag the server graph into the browser bundle.

import { MIN_PASSWORD_LENGTH } from "@dim/contract/input";

/**
 * The sentences, exported so tests and callers can assert on the same strings
 * instead of re-typing them (a re-typed sentence is a sentence that drifts).
 */
export const NEW_PASSWORD_MESSAGES = {
  too_short: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
  mismatch: "Las contraseñas no coinciden.",
} as const;

/**
 * The sentence to show, or `null` when the pair is acceptable.
 *
 * Deliberately returns the MESSAGE rather than a code: every caller does the
 * same thing with it (put it next to the password field), and a code would only
 * move the same `switch` into three places.
 */
export function validateNewPassword(password: string, confirmPassword: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return NEW_PASSWORD_MESSAGES.too_short;
  if (password !== confirmPassword) return NEW_PASSWORD_MESSAGES.mismatch;
  return null;
}

export { MIN_PASSWORD_LENGTH };
