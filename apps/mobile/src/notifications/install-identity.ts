// THE INSTALL IDENTITY — one uuid, minted once, kept for the life of the install.
//
// WHY THIS EXISTS AT ALL. `push_targets` (migration 0222) conflicts on
// `device_id` rather than on the push token, because Expo tokens ROTATE: a token
// used as the conflict target would insert a second row on every rotation and
// orphan the first with no install identity left to reconcile against. That
// design only works if the app can hand the server the same `device_id` every
// time, across token rotations, sign-outs and app restarts — which is exactly
// what this module is for and all it is for.
//
// WHY SECURE STORE AND NOT ASYNC STORAGE. The value is not a secret and nothing
// here treats it as one. It is kept next to the session because it must survive
// the same events the session survives and die when the app is uninstalled, and
// `expo-secure-store` is already this app's answer to that question — adding a
// second persistence mechanism for one string would be a second thing to reason
// about on restore, on migration, and on clear-data.
//
// THE `WHEN_UNLOCKED_THIS_DEVICE_ONLY` CLASS IS DELIBERATE and matches
// `secure-store-auth-storage.ts`. A device id that rode an iCloud backup onto a
// NEW phone would make two physical devices claim one row, and the second one to
// register would silently take the first one's notifications. This is the one
// property of this file that is about correctness rather than convenience.
//
// NOTHING HERE THROWS FOR A STORAGE FAILURE. A phone whose keychain refuses to
// answer must still be able to sign in and use the app; it simply will not
// register for push that session. The caller reads `null` and stops.

import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

/** The primitive operations this module needs. Injected so Jest can drive it. */
export type InstallIdentityPort = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
};

/**
 * The key. Namespaced like every other key this app writes, and versioned so a
 * future change of shape can coexist with a value already on a phone rather than
 * having to guess what an unversioned string meant.
 */
export const INSTALL_DEVICE_ID_KEY = "dim.push.deviceId.v1";

const defaultPort: InstallIdentityPort = {
  getItemAsync: (key) =>
    SecureStore.getItemAsync(key, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  setItemAsync: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
};

/** A uuid v4, validated the way `newIdempotencyKey` validates its own. */
function mintDeviceId(): string {
  const candidate = Crypto.randomUUID();
  // Not paranoia about `randomUUID`: the server stores this in a `text` column
  // with no format check, so a platform that one day returned something else
  // would be persisted silently and become this install's permanent identity.
  // A local failure is recoverable; a bad identity written once is not.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) {
    return candidate;
  }
  throw new Error(`expo-crypto returned a value that is not a uuid v4 (${candidate.length} chars)`);
}

/**
 * The id for this install: the one already stored, or a new one stored now.
 *
 * IDEMPOTENT BY CONSTRUCTION — call it on every sign-in, on every token
 * rotation, as often as you like. The first call mints; every later one reads.
 *
 * Returns `null` when the keychain could not be read AND could not be written,
 * which is the honest answer to "what is this install's id" when the only place
 * it can live is unavailable. A caller must treat `null` as "do not register
 * this session" rather than minting a throwaway: an id that is not persisted
 * would create a new row on every app start, and the table would grow one dead
 * target per launch with no way to attribute any of them.
 */
export async function getOrCreateInstallDeviceId(
  port: InstallIdentityPort = defaultPort,
): Promise<string | null> {
  try {
    const existing = await port.getItemAsync(INSTALL_DEVICE_ID_KEY);
    if (existing) return existing;
  } catch {
    // A read failure is not fatal on its own — the write below may still work,
    // and if it does the install has an id from here on. Falling through rather
    // than returning is the difference between "one bad launch" and "this phone
    // never registers again".
  }

  let minted: string;
  try {
    minted = mintDeviceId();
  } catch {
    // The platform gave us something that is not a uuid. Refusing is correct:
    // see the note in `mintDeviceId`.
    return null;
  }

  try {
    await port.setItemAsync(INSTALL_DEVICE_ID_KEY, minted);
  } catch {
    // Minted but not persisted. Returning it anyway would register a row this
    // install can never claim again — every launch would mint a different id and
    // leave the previous row live, delivering to a device list that grows
    // forever. `null` is the honest answer.
    return null;
  }

  return minted;
}
