// The offline display cache for a credential. DISPLAY ONLY (PO decision,
// 2026-08-25).
//
// WHAT IT IS FOR
// ---------------------------------------------------------------------------
// A phone in a basement, a rural clinic with no signal, a border check with a
// dead data plan. The owner opens their pet's credential and today gets "no
// pudimos conectarnos" and nothing else — while the last successful read is
// sitting in memory that was thrown away when the screen unmounted. Keeping it
// costs one write per successful read and turns a dead end into a usable, dated
// answer.
//
// WHY AsyncStorage AND NOT SecureStore
// ---------------------------------------------------------------------------
// Because of WHOSE data this is and what it already is. A credential is the
// PUBLIC face of a pet: the same JSON is served to any stranger who scans the QR
// on the animal's tag, with no authentication at all. Storing the owner's own
// copy of a public document on the owner's own device is not a new disclosure —
// the disclosure already happened, by design, and is the product's central
// promise (invariant #1: the pet IS the credential).
//
// The things that genuinely must not touch a plain file are the CREDENTIALS —
// the refresh token and the access token — and those live in the Keystore via
// `auth/secure-store-auth-storage.ts`. Putting the credential JSON there too
// would mean chunking a multi-kilobyte document through a 2048-byte-per-value
// API for no gain in confidentiality.
//
// One thing does follow from "the device may be shared", and it is not
// optional: `forgetAllCachedCredentials()` runs on every sign-out. The next
// person to sign in on this phone must not find the previous owner's animals in
// a cache.
//
// WHAT IT IS NOT
// ---------------------------------------------------------------------------
// It is not a source of truth and it is never rendered silently. A cached
// credential is ALWAYS shown with its age and with the fact that it came from
// the cache — `describeFreshness` computes the age from the SERVER'S `issuedAt`
// and `staleAfter`, not from the device clock at write time, so a device with a
// wrong clock reports honestly. Rendering a stale credential without the banner
// would let someone present a "vigente" rabies status that expired last month,
// which is the one failure this whole per-section design exists to prevent.

import { PUBLIC_CREDENTIAL_PAYLOAD_VERSION, type PublicCredentialV1 } from "@dim/contract/api";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * The key prefix, versioned.
 *
 * The version is in the KEY, not only in the value, so a payload-version bump
 * strands the old entries instead of making every read parse-and-discard them.
 * `forgetAllCachedCredentials` still sweeps by the common prefix.
 */
const KEY_PREFIX = "mimar.credential.";
const KEY_VERSION_PREFIX = `${KEY_PREFIX}v${PUBLIC_CREDENTIAL_PAYLOAD_VERSION}.`;

function cacheKey(publicToken: string): string {
  return `${KEY_VERSION_PREFIX}${publicToken}`;
}

/**
 * Store a credential that was just read successfully.
 *
 * Failures are swallowed. A cache write that throws — storage full, a
 * provisioning profile problem — must never turn a SUCCESSFUL read into an
 * error on screen: the user has their credential; the only thing lost is the
 * offline copy, which they will not miss until they are offline, at which point
 * the honest "no pudimos conectarnos" is what they get anyway.
 */
export async function writeCachedCredential(
  publicToken: string,
  payload: PublicCredentialV1,
): Promise<void> {
  try {
    await AsyncStorage.setItem(cacheKey(publicToken), JSON.stringify(payload));
  } catch {
    // See above.
  }
}

/**
 * The last good credential for a token, or null.
 *
 * The payload version is re-checked on READ even though it is in the key,
 * because a value can also be corrupt or truncated. A cached payload that does
 * not declare exactly the version this build understands is discarded rather
 * than rendered: the fallback path must not be the one place a client guesses at
 * a shape it does not know.
 */
export async function readCachedCredential(
  publicToken: string,
): Promise<PublicCredentialV1 | null> {
  try {
    const raw = await AsyncStorage.getItem(cacheKey(publicToken));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as PublicCredentialV1;
    if (parsed?.payloadVersion !== PUBLIC_CREDENTIAL_PAYLOAD_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Drop every cached credential. Called on sign-out — see the header.
 *
 * Sweeps the UNVERSIONED prefix so entries written by an older payload version
 * go too. A sign-out that left them behind would be the shared-device hole with
 * an extra step.
 */
export async function forgetAllCachedCredentials(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = keys.filter((key) => key.startsWith(KEY_PREFIX));
    if (ours.length > 0) await AsyncStorage.multiRemove(ours);
  } catch {
    // Best effort. There is nothing useful to tell a user who is signing out.
  }
}
