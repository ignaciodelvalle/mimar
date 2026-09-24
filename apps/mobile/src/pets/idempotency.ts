// The `Idempotency-Key` for `POST /api/v1/pets`, and the rule about when it may
// change.
//
// WHY THIS IS NOT ONE LINE AT THE CALL SITE
// ---------------------------------------------------------------------------
// The header is required — a missing OR malformed one is a 400
// `idempotency_key_required`, not a best effort — so generating it is trivial.
// The part that is not trivial is WHEN a new one is generated, and getting that
// wrong is invisible until it isn't:
//
//   · A NEW key per HTTP attempt turns every retry into a second pet. The retry
//     that matters here is the one after a timeout, which is exactly the case
//     where the first request may well have succeeded and the phone never heard
//     the answer. That is the failure this header exists to prevent, and a
//     freshly generated key opts out of it while looking correct.
//   · The SAME key forever turns the second, deliberate registration of a real
//     second animal into a replay: the server answers 201 with `wasDuplicate:
//     true` and the pet the user just described is never created.
//
// So the key is scoped to an ATTEMPT SESSION: one key from the moment the user
// confirms until that registration is finished (created, or abandoned). Every
// retry inside that window — a timeout, a 503, a "Registrar igual" after a 409 —
// reuses it. `restart()` is the ONLY way to get a new one, and the wizard calls
// it when it starts a new registration, never on a retry.
//
// THE 409 CASE IS THE SUBTLE ONE and it is why `duplicateOverride` does not get
// its own key: re-sending with `duplicateOverride: true` is the SAME
// registration, answered differently. A new key there would mean that a user who
// taps "Registrar igual" on a flaky connection can end up with two pets — the
// precise outcome the duplicate dialog exists to let them avoid.
//
// THE COST OF THAT CHOICE, WHICH THIS HEADER USED TO LEAVE OUT
// ---------------------------------------------------------------------------
// Attempt-scoped means the key survives an EDIT. If a send fails, the user goes
// back, changes the name from "Firu" to "Firulais" and submits again, that
// second request carries the same key — and if the FIRST one actually committed
// (the timeout case: the server created the pet, the phone never heard the
// answer), the server replays it and hands back pet #1, named "Firu". The user
// sees a pet they did not quite describe.
//
// That is inherent to attempt-scoped idempotency and it is ACCEPTED, because the
// alternative is worse in a way that cannot be undone from the app: a new key on
// edit-and-resubmit means the same flaky connection produces TWO animals in the
// national registry, and the event spine is append-only. A wrong name is a field
// the owner edits in ten seconds; a duplicate pet is a support case. The
// asymmetry is the whole argument.

import { isValidIdempotencyKey } from "@dim/contract/api";
import * as Crypto from "expo-crypto";

/**
 * A UUID v4, validated against the contract's own pattern before it is used.
 *
 * The validation is not paranoia about `randomUUID` — it is about the fact that
 * the server's acceptance test is `IDEMPOTENCY_KEY_PATTERN`, exported by
 * `@dim/contract/api` for exactly this. Checking here turns a platform that one
 * day returns something else into a clear local failure instead of a 400 the
 * user reads as "la app envió un pedido mal formado".
 */
export function newIdempotencyKey(): string {
  const candidate = Crypto.randomUUID();
  if (isValidIdempotencyKey(candidate)) return candidate;
  throw new Error(
    [
      `expo-crypto returned a value that is not a UUID (${candidate.length} chars).`,
      "POST /api/v1/pets validates the header against IDEMPOTENCY_KEY_PATTERN and would refuse it.",
    ].join(" "),
  );
}

export type AttemptSession = {
  /** The key for this attempt. Stable across every retry. */
  key(): string;
  /** Begin a NEW registration. The only way to get a different key. */
  restart(): void;
};

/**
 * One registration attempt's key, memoised.
 *
 * `generate` is injected so the reuse policy above can be tested without a
 * native module: `expo-crypto` cannot run under Jest, and the thing worth
 * testing is not the UUID, it is that the same one comes back four times.
 */
export function createAttemptSession(generate: () => string = newIdempotencyKey): AttemptSession {
  let current: string | null = null;
  return {
    key() {
      if (current === null) current = generate();
      return current;
    },
    restart() {
      current = null;
    },
  };
}
