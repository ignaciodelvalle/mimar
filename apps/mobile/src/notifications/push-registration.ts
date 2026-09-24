// TELLING THE SERVER WHERE TO DELIVER — and telling it to stop.
//
// Two acts, one install identity, and nothing here throws. This is the mobile
// half of `app/api/v1/me/push-targets/route.ts`: the phone says "entregá acá"
// when somebody signs in, and "pará" when they sign out.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE KNOWS NOTHING ABOUT THE SESSION STORE
// ---------------------------------------------------------------------------
// It takes a `SessionPort` and is told when to run. That is not ceremony: the
// session store has to call `revokeThisDeviceForPush` on its way out (see
// `clearSession`), and if this module imported the store back the two would be
// a cycle — the kind that resolves to `undefined` at import time under Jest's
// module registry and works fine in the app, which is the worst place for a
// difference to live. `push-session-binding.ts` is the file that knows both,
// and it is imported by exactly one place.
//
// ---------------------------------------------------------------------------
// NOTHING HERE THROWS, AND NOTHING HERE BLOCKS ANYTHING
// ---------------------------------------------------------------------------
// Registration is a side effect of signing in, not a step of it. A person whose
// phone cannot obtain a push token must still get all the way into the app, and
// a person signing out must get all the way out even if the revoke request never
// lands. Every failure is a returned value, never a rejection.

import Constants from "expo-constants";
import { Platform } from "react-native";

import { PUSH_APP_VERSION_MAX_LENGTH, type PushPlatform } from "@dim/contract/input";

import { type SessionPort, apiRequest } from "../api/client";
import {
  getExpoPushTokenSafely,
  getPushPort,
  requestPushPermissionSafely,
} from "../native/push-port";
import { getOrCreateInstallDeviceId } from "./install-identity";

/** The endpoint, as one string rather than three copies of it. */
export const PUSH_TARGETS_PATH = "/api/v1/me/push-targets";

/**
 * What one registration attempt produced.
 *
 * `denied` AND `unavailable` ARE KEPT APART even though neither ends with a row
 * in the table, because they mean opposite things to whatever asks next:
 * `denied` is a decision and must never be re-prompted; `unavailable` is this
 * build or this device, and the same person on a different build would be asked
 * normally.
 */
export type PushRegistrationOutcome =
  | { outcome: "registered" }
  /** The person declined the OS prompt, now or earlier. Do not ask again. */
  | { outcome: "denied" }
  /** No push in this build, on this platform, or on this device. */
  | { outcome: "unavailable" }
  | { outcome: "failed"; detail: string };

/**
 * This app's version, as triage metadata for the row.
 *
 * TRUNCATED RATHER THAN REFUSED. The contract caps `app_version` at
 * `PUSH_APP_VERSION_MAX_LENGTH` because it is free text a client fills; a
 * version string is never close to that, so anything longer is a value nobody
 * meant. Sending the first 64 characters keeps the registration — which is the
 * point of the request — and loses only the tail of a field the header itself
 * calls "triage metadata and nothing else". Refusing the whole write over it
 * would be the tail wagging the dog.
 */
function appVersion(): string | undefined {
  const raw: unknown = Constants.expoConfig?.version;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  return raw.slice(0, PUSH_APP_VERSION_MAX_LENGTH);
}

/**
 * The platform, as the column's CHECK constraint spells it.
 *
 * `null` FOR ANYTHING ELSE. `Platform.OS` also answers `"web"`, `"windows"` and
 * `"macos"`; migration 0222's CHECK admits only `ios` and `android`, so sending
 * one of the others would be a 500-shaped rejection from a constraint rather
 * than a decision this app made. This app ships to two stores — but the union
 * says four, and a type that says four while the code assumes two is how the
 * fifth one gets added and nobody notices.
 */
export function currentPushPlatform(): PushPlatform | null {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return null;
}

/**
 * Ask for permission if needed, read the token, and register this install.
 *
 * IDEMPOTENT AND SAFE TO CALL ON EVERY SIGN-IN. The endpoint upserts on
 * `device_id`, so a second call with a rotated token updates one row rather than
 * adding one, and a call for a DIFFERENT person flips that row's owner — which
 * is the shared-phone case, handled by design rather than by accident.
 *
 * THE ORDER IS DELIBERATE and each step refuses before the next costs anything:
 * the build check is free, the install id is a keychain read, the permission is
 * a dialog, and the token is a network round trip to Expo. Nothing asks a person
 * for permission that this build could not honour anyway.
 */
export async function registerThisDeviceForPush(
  session: SessionPort,
): Promise<PushRegistrationOutcome> {
  // THE BUILD ON PLAY TODAY LANDS HERE AND STOPS. It was cut without
  // `expo-notifications`, so `moduleMissingPush` is its port and asking it
  // anything would spend a permission prompt on a build that cannot receive.
  if (!getPushPort().available) return { outcome: "unavailable" };

  const platform = currentPushPlatform();
  if (platform === null) return { outcome: "unavailable" };

  const deviceId = await getOrCreateInstallDeviceId();
  if (deviceId === null) {
    // The keychain refused both a read and a write. Registering under an id
    // that was not persisted would leave one live, undeliverable row per app
    // start — see `install-identity.ts`.
    return { outcome: "failed", detail: "no install id" };
  }

  const permission = await requestPushPermissionSafely();
  if (permission.outcome === "denied") return { outcome: "denied" };
  if (permission.outcome === "unavailable") return { outcome: "unavailable" };
  if (permission.outcome === "failed") {
    return { outcome: "failed", detail: `permission: ${permission.detail}` };
  }

  const token = await getExpoPushTokenSafely();
  if (token.outcome === "denied") return { outcome: "denied" };
  if (token.outcome === "unavailable") return { outcome: "unavailable" };
  if (token.outcome === "failed") {
    return { outcome: "failed", detail: `token: ${token.detail}` };
  }

  const result = await apiRequest<{ registered: true }>(
    {
      path: PUSH_TARGETS_PATH,
      method: "POST",
      body: {
        command: "register",
        deviceId,
        expoPushToken: token.expoPushToken,
        platform,
        appVersion: appVersion(),
      },
    },
    session,
  );

  if (result.outcome !== "ok") {
    // The API's own failure vocabulary, not a sentence. Nothing shows this to
    // anybody — see `push-session-binding.ts` for why there is no UI here.
    return { outcome: "failed", detail: `api: ${result.outcome}` };
  }
  return { outcome: "registered" };
}

/**
 * What one revocation attempt produced.
 *
 * IT USED TO BE `void`, AND THAT WAS THE DEFECT. The call is best-effort by
 * design — nobody is blocked from leaving because a row would not update — but
 * "best-effort" was implemented as "unobservable", so a revoke that never landed
 * looked exactly like one that did, from every angle: no return value, no
 * screen, no event. The row stayed live and the phone kept ringing, and the only
 * way to find out was to hold the phone.
 *
 * `skipped` is not a failure and must not be reported: it is the build with no
 * push module, or an install that never minted an id, neither of which ever had
 * a row to revoke.
 */
export type PushRevocationOutcome =
  /** The server acknowledged. `revoked: false` — nothing to revoke — is still this. */
  | { outcome: "acknowledged" }
  /** There was never anything to revoke here. Not a failure. */
  | { outcome: "skipped"; reason: "no-push-in-build" | "no-install-id" }
  /** The request did not land. The row may still be live. */
  | { outcome: "failed"; detail: string };

/**
 * Tell the server to stop delivering to this install.
 *
 * CALLED FROM `clearSession()` IN THE SESSION STORE, which is the funnel every
 * way of ending a session passes through, and called BEFORE the tokens are
 * dropped — a revoke needs the very credentials the sign-out is about to
 * destroy. `signOutEverywhere` is the one caller that cannot rely on that,
 * because it kills the session over the network FIRST; it calls this itself,
 * earlier, and tells `clearSession` not to repeat it.
 *
 * STILL BEST-EFFORT — it resolves, never rejects, and no caller is allowed to
 * block a sign-out on it. What changed is that the failure is now a VALUE the
 * caller can report, instead of being swallowed here. The row is soft — revoked,
 * not deleted — so the recovery is the next sign-in on this device, which
 * upserts it live again.
 *
 * IT MINTS NO INSTALL ID. `getOrCreateInstallDeviceId` would create one for a
 * device that never registered, and the request would revoke nothing at the
 * cost of a round trip on every sign-out of every build that has no push. The
 * port check above it is what makes that impossible.
 */
export async function revokeThisDeviceForPush(
  session: SessionPort,
): Promise<PushRevocationOutcome> {
  if (!getPushPort().available) return { outcome: "skipped", reason: "no-push-in-build" };

  const deviceId = await getOrCreateInstallDeviceId();
  if (deviceId === null) return { outcome: "skipped", reason: "no-install-id" };

  const result = await apiRequest<{ revoked: boolean }>(
    {
      path: PUSH_TARGETS_PATH,
      method: "POST",
      body: { command: "revoke", deviceId },
    },
    session,
  );

  // `unreachable` is folded in with the rest on purpose. A subway sign-out is
  // not a defect, and the caller's reporter drops `unreachable` for exactly that
  // reason — but from HERE the two are the same fact: delivery to this device
  // was not stopped. Deciding which of them is worth an event belongs to
  // whoever is reporting, not to the function that made the request.
  if (result.outcome !== "ok") return { outcome: "failed", detail: result.outcome };
  return { outcome: "acknowledged" };
}
