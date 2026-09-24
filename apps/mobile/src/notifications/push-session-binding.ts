// THE ONE FILE THAT KNOWS BOTH THE SESSION AND THE PUSH REGISTRATION.
//
// WHY A SUBSCRIPTION AND NOT A CALL IN `signIn()`. There are FOUR ways this app
// arrives at `phase: "signed-in"` — `signIn`, `signUp` via `completeIdentity`,
// `resetPasswordWithCode`, and `bootstrapSession` restoring a session that was
// already on the phone. The last one is the common case by a wide margin: most
// launches are a restore, not a sign-in. A hook placed in `signIn` would
// register on the rarest path and miss the ordinary one, and four hooks would
// be four places to forget the fifth. The state transition is the fact; this
// watches the fact.
//
// THE SIGN-OUT SIDE IS NOT HERE, and the asymmetry is the point. By the time a
// subscriber sees `phase: "signed-out"` the tokens are already gone, and a
// revoke needs them — so that call lives at the top of `clearSession()` in the
// session store, before the teardown. This file only ever registers.
//
// NOTHING HERE IS SHOWN TO ANYBODY. There is no screen for push in this unit:
// no toggle, no "activá las notificaciones" callout, no error banner. An
// outcome of `denied` or `failed` changes nothing a person can see, which is
// why none of them is surfaced — inventing a sentence for a surface that does
// not exist would be inventing the surface.

import { getSessionState, sessionPort, subscribeToSession } from "../auth/session-store";
import { registerThisDeviceForPush } from "./push-registration";

/**
 * Whose registration is already in flight or done, for the session this process
 * is currently holding. `null` when nobody is signed in.
 *
 * IT IS AN ID AND NOT A BOOLEAN because of the shared phone. One device, two
 * people: when the second signs in, the row's owner has to flip, and a boolean
 * that only remembered "already registered" would leave the first person's id
 * on a device they handed over. Comparing the id makes the change of person the
 * trigger, which is exactly what it is.
 */
let registeredFor: string | null = null;

/**
 * Register whenever somebody is signed in, and forget when nobody is.
 *
 * Returns the unsubscribe function, which is for tests: the app subscribes once
 * at start and never stops.
 */
export function startPushRegistration(): () => void {
  const react = (): void => {
    const state = getSessionState();

    if (state.phase !== "signed-in") {
      // Includes `starting` and `session-unverified`, neither of which is a
      // sign-out — but neither is a state to register from either, and the next
      // transition into `signed-in` will do it.
      registeredFor = null;
      return;
    }

    if (registeredFor === state.user.id) return;
    // SET BEFORE THE AWAIT, not after. The store notifies its listeners
    // synchronously and more than once per sign-in; setting this afterwards
    // would let a second notification start a second registration while the
    // first is still reading a token.
    registeredFor = state.user.id;

    void registerThisDeviceForPush(sessionPort).then((outcome) => {
      // A failure must not stick: if it did, this install would never try again
      // until the app was restarted. Clearing the marker lets the next
      // transition retry — and since every step of the registration is itself
      // idempotent, a retry costs nothing it should not cost. `denied` is NOT
      // cleared: the person decided, and the port's contract forbids re-asking.
      if (outcome.outcome === "failed") registeredFor = null;
    });
  };

  const unsubscribe = subscribeToSession(react);
  // ONCE, IMMEDIATELY. `bootstrapSession()` may already have resolved by the
  // time this runs — it is started from the same module scope — and a listener
  // that only ever hears about FUTURE changes would miss the restore that
  // happened one tick ago and never register on an ordinary launch.
  react();
  return unsubscribe;
}

/** Forgets who is registered. For tests, which share one module registry. */
export function resetPushRegistrationBinding(): void {
  registeredFor = null;
}
