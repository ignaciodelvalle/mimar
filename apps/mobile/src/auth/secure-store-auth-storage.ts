// SecureStore-backed auth storage — the M2 seam, now implemented.
//
// `@supabase/supabase-js` accepts a custom `auth.storage` adapter: a three-method
// key/value store. On the web it defaults to `localStorage`; React Native has no
// such global, so the client must be handed one explicitly or it silently keeps
// the session in memory and signs the user out on every cold start. The PO's
// decision (2026-08-25) is bearer auth against `/api/v1`, so this adapter holds
// the refresh token — and a refresh token belongs in the Keychain / Keystore,
// not in AsyncStorage, which is a plain file any backup or rooted device reads.
//
// ---------------------------------------------------------------------------
// THE 2048-BYTE LIMIT, AND WHICH WAY OUT WAS TAKEN
// ---------------------------------------------------------------------------
// `expo-secure-store` has a hard per-value size limit of 2048 bytes on Android
// (the Keystore-backed provider). A Supabase session is an access JWT + a
// refresh token + the serialized user object, and once that user object carries
// app_metadata it routinely crosses 2 KB. The failure is not a clean throw at
// the boundary — the write fails, the session never persists, and the symptom is
// "users get logged out sometimes", which reads as a server problem.
//
// The seam wrote down two ways out. THIS FILE TAKES (a), CHUNKING, and the
// reason is that (b) is not actually the cheap option it looks like:
//
//   (b) SPLIT BY SENSITIVITY — refresh token in SecureStore, the rest of the
//       session in AsyncStorage — puts the ACCESS TOKEN on disk in the clear.
//       That token is a bearer for `/api/v1` for up to an hour: with it, an
//       attacker holding a device backup reads the owner's pets, registers pets
//       in their name and revokes their sessions. "It expires in an hour" is an
//       argument about the SIZE of the window, not about whether there is one,
//       and the window is attacker-chosen (they steal the backup when they can).
//       Splitting also does not remove the size problem, it relocates it: the
//       day the session object needs to be authoritative in the Keystore, the
//       chunking has to be written anyway.
//
//   (a) CHUNKING keeps everything in the Keystore. The cost the seam named is
//       real — `removeItem` has to find and delete every chunk, including
//       orphans left by an interrupted write — and it is paid explicitly below.
//
// ---------------------------------------------------------------------------
// THE LAYOUT
// ---------------------------------------------------------------------------
// For a logical key `K`:
//
//   K        → a HEADER: `dim.chunked.v2:<chunkCount>:<charLength>:<nonce>`
//   K.c0…    → the chunks, in order, each prefixed `<nonce>:`.
//
// Two properties of that header earn their keep:
//
//   · A value at `K` that does NOT parse as a header is returned VERBATIM. That
//     makes the adapter compatible with anything that wrote a plain value at the
//     same key before it existed, and it means the day a value happens to be
//     small this file still has exactly one code path.
//   · The NONCE is the corruption detector. Writes are not transactional — there
//     is no way to make several SecureStore calls atomic — so an interrupted
//     write can leave a header from the old value in front of chunks from the
//     new one. Every chunk carries the nonce of the write that produced it, and
//     reading rejects any chunk whose nonce is not the header's.
//
// ---------------------------------------------------------------------------
// THE LENGTH CHECK CAME FIRST AND MISSED THE NORMAL CASE (fixed 2026-08-25)
// ---------------------------------------------------------------------------
// v1 detected an interrupted write by reassembling the chunks and comparing the
// total against a `charLength` in the header. That catches a splice only when
// the two values happen to differ in LENGTH — and the write this adapter
// performs most often is a token ROTATION, where the new session has the same
// claims, the same fixed-length signature and therefore, routinely, exactly the
// same length. So the case the check was written for was the case it could not
// see: chunk 0 new, chunks 1..n old, total length unchanged, check passes,
// supabase is handed a spliced session.
//
// The outcome was soft — the halves belong to different JWTs, so the server
// refuses the token and the user is signed out — but the header's promise ("a
// clean no-session") was false, and a splice that reaches supabase is a
// signature-mismatch error nobody can explain rather than a sign-in screen.
//
// A per-write nonce turns the header-written-LAST design into a real detector:
// old chunks carry the old nonce, so ANY splice is visible regardless of length.
// `charLength` is kept as a second, cheap check — it costs nothing and catches a
// truncation that somehow preserved the nonce.
//
// A v1 header is not read. It is treated as unreadable, cleaned up, and answered
// as "no session": one re-login on upgrade, against carrying a legacy path whose
// whole purpose is to be less safe than the current one.
//
// CHUNK SIZE is in UTF-16 CODE UNITS, not bytes, and 512 is chosen so the byte
// bound holds without measuring: a BMP code unit is at most 3 UTF-8 bytes, and a
// surrogate pair is 2 units for 4 bytes (2 bytes/unit), so 512 units is at most
// 1536 bytes — inside 2048 with room for the provider's own overhead. The nonce
// prefix adds NONCE_LENGTH + 1 ASCII units (1 byte each) per chunk, so the bound
// becomes 1536 + 9 = 1545 bytes and the argument is unchanged. Slicing on a
// code-unit boundary would split a surrogate pair, so the boundary is nudged
// back one unit when it lands in the middle of one (`sliceEnd` below).
//
// ---------------------------------------------------------------------------
// IT FAILS SOFT, AND ONLY ON READS
// ---------------------------------------------------------------------------
// A keychain read that throws — a device with no passcode, a corrupted entry
// after an OS upgrade, a value written by an older layout — behaves like "no
// session" and sends the user to the sign-in screen. It must never behave like
// an app that will not start. Writes are the opposite: a failed write is
// reported, because swallowing it produces exactly the "logged out sometimes"
// mystery this file exists to prevent.

import * as SecureStore from "expo-secure-store";

/**
 * The storage contract `@supabase/supabase-js` expects at `auth.storage`.
 *
 * Still declared locally rather than imported from the library: the shape is
 * three methods and pinning it here keeps this module readable on its own. It
 * is structurally checked against the real one at the call site in
 * `supabase-client.ts`, which is where a drift would actually matter.
 */
export type AuthStorageAdapter = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

/** The primitive operations this module needs. Injected so Jest can drive it. */
export type SecureStorePort = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

/** See the header: 512 UTF-16 units is at most 1536 UTF-8 bytes. */
export const CHUNK_SIZE = 512;

const HEADER_PREFIX = "dim.chunked.v2:";

/** The layout this one replaces. Recognised only so it can be cleaned up. */
const LEGACY_HEADER_PREFIX = "dim.chunked.v1:";

/**
 * How many characters of nonce each chunk carries.
 *
 * It is a WRITE IDENTIFIER, not a secret: its only job is to differ between two
 * writes so a splice of one into the other is visible. Eight characters out of
 * base-36 is ~41 bits, which makes an accidental collision between consecutive
 * writes not a thing that happens; guessing it buys an attacker nothing, since
 * anyone who can write to this device's Keystore can write the header too.
 */
const NONCE_LENGTH = 8;

/** ASCII, so it costs 1 byte per unit against the 2048-byte per-value limit. */
function defaultNonce(): string {
  return Math.random().toString(36).slice(2).padEnd(NONCE_LENGTH, "0").slice(0, NONCE_LENGTH);
}

/**
 * How far past the declared chunk count `removeItem` looks for orphans.
 *
 * An interrupted write can leave chunks beyond the header's count. Scanning
 * forever is not an option (each probe is a Keystore round trip), and stopping
 * at the first miss is not enough either, because a partial write can leave a
 * hole. Sixteen is well past any session this app will ever hold and bounds the
 * cost of a sign-out at a few dozen milliseconds.
 */
const ORPHAN_SCAN_AHEAD = 16;

function chunkKey(key: string, index: number): string {
  // SecureStore keys are limited to [A-Za-z0-9._-]; `.` is inside that set and
  // supabase's own key (`sb-<ref>-auth-token`) already uses `-`.
  return `${key}.c${index}`;
}

function buildHeader(chunkCount: number, charLength: number, nonce: string): string {
  return `${HEADER_PREFIX}${chunkCount}:${charLength}:${nonce}`;
}

export type ParsedHeader = { chunkCount: number; charLength: number; nonce: string };

/**
 * Reads our header, or `null` for anything that is not one.
 *
 * `null` is not an error: it is how a plain value written by something else is
 * recognised, and the caller returns it verbatim. A LEGACY (v1) header is not
 * one of those — see `isLegacyHeader`, which the caller checks first so a v1
 * value is wiped rather than handed back as if it were a session.
 */
export function parseHeader(raw: string): ParsedHeader | null {
  if (!raw.startsWith(HEADER_PREFIX)) return null;
  const [countText, lengthText, nonce, ...rest] = raw.slice(HEADER_PREFIX.length).split(":");
  if (rest.length > 0) return null;
  const chunkCount = Number(countText);
  const charLength = Number(lengthText);
  if (!Number.isInteger(chunkCount) || chunkCount < 0) return null;
  if (!Number.isInteger(charLength) || charLength < 0) return null;
  if (typeof nonce !== "string" || nonce.length === 0) return null;
  return { chunkCount, charLength, nonce };
}

/**
 * A header from the previous layout, which had no per-write nonce.
 *
 * It is deliberately NOT parsed. v1's chunks carry no nonce, so reading them
 * would mean keeping the detector this file just replaced — the one that could
 * not see a same-length splice. The value is wiped and answered as "no session":
 * one re-login on upgrade, which for an app with no released build is free and
 * which is the right trade even when it is not.
 */
export function isLegacyHeader(raw: string): boolean {
  return raw.startsWith(LEGACY_HEADER_PREFIX);
}

/** `<nonce>:<payload>` — the stored form of one chunk. */
function buildChunk(nonce: string, payload: string): string {
  return `${nonce}:${payload}`;
}

/**
 * The payload of a chunk that belongs to `nonce`, or null if it does not.
 *
 * Null is the whole detector: a chunk left behind by an earlier write carries
 * that write's nonce, so a splice is visible no matter what the lengths are.
 */
export function readChunkPayload(stored: string, nonce: string): string | null {
  const prefix = `${nonce}:`;
  return stored.startsWith(prefix) ? stored.slice(prefix.length) : null;
}

/**
 * Where a slice may end without splitting a surrogate pair.
 *
 * A high surrogate (U+D800–U+DBFF) at the last position of a slice means its low
 * half would land in the next chunk. Reassembly would still produce the right
 * string — the two halves are adjacent again — but each chunk on its own would
 * be an unpaired surrogate, which is not valid UTF-8 and is exactly the kind of
 * value a native keychain is entitled to reject or mangle. One unit back costs
 * nothing and removes the question.
 */
export function sliceEnd(value: string, start: number, size: number): number {
  const end = Math.min(value.length, start + size);
  if (end <= start || end >= value.length) return end;
  const last = value.charCodeAt(end - 1);
  const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return isHighSurrogate ? end - 1 : end;
}

/** Splits a value into storable chunks. Exported for the round-trip test. */
export function splitIntoChunks(value: string, size: number = CHUNK_SIZE): string[] {
  if (value.length === 0) return [""];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const end = sliceEnd(value, cursor, size);
    chunks.push(value.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

const defaultPort: SecureStorePort = {
  getItemAsync: (key) =>
    SecureStore.getItemAsync(key, {
      // iOS only. The refresh token must NOT ride an iCloud backup onto a new
      // device: a credential that survives device migration without the user
      // re-authenticating is a credential nobody revoked. The cost is that a
      // restored phone asks for a sign-in, which is the correct answer.
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  setItemAsync: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
};

/**
 * Builds the adapter.
 *
 * `port` exists for tests. Production passes nothing and gets `expo-secure-store`
 * with the iOS accessibility class pinned above.
 */
export function createSecureStoreAuthStorage(
  port: SecureStorePort = defaultPort,
  makeNonce: () => string = defaultNonce,
): AuthStorageAdapter {
  async function readChunks(key: string, header: ParsedHeader): Promise<string | null> {
    const parts: string[] = [];
    for (let i = 0; i < header.chunkCount; i++) {
      const stored = await port.getItemAsync(chunkKey(key, i));
      // A MISSING CHUNK IS NOT RECOVERABLE and must not be treated as an empty
      // one. Concatenating around the hole would hand supabase a truncated JSON
      // string; at best it throws, at worst it parses into a session with a
      // mangled token that fails at the server as an auth error nobody can
      // explain. "Signed out" is the only honest reading of a hole.
      if (stored === null) return null;
      // THE DETECTOR. A chunk from an earlier write carries that write's nonce,
      // so a splice is caught whatever the lengths are — which is what the
      // length check alone could not do on the write this adapter performs most
      // often (a same-length token rotation). See the header.
      const part = readChunkPayload(stored, header.nonce);
      if (part === null) return null;
      parts.push(part);
    }
    const value = parts.join("");
    // Kept as a second, cheap check: it catches a truncation that somehow
    // preserved the nonce, and it costs one comparison.
    return value.length === header.charLength ? value : null;
  }

  async function deleteChunks(key: string, upTo: number): Promise<void> {
    for (let i = 0; i < upTo + ORPHAN_SCAN_AHEAD; i++) {
      await port.deleteItemAsync(chunkKey(key, i));
    }
  }

  return {
    async getItem(key) {
      try {
        const raw = await port.getItemAsync(key);
        if (raw === null) return null;

        // A v1 value: wiped, not read. See isLegacyHeader.
        if (isLegacyHeader(raw)) {
          await deleteChunks(key, 0).catch(() => undefined);
          await port.deleteItemAsync(key).catch(() => undefined);
          return null;
        }

        const header = parseHeader(raw);
        // Not our layout: a plain value someone else wrote. Hand it back.
        if (header === null) return raw;

        const value = await readChunks(key, header);
        if (value === null) {
          // Corrupt or half-written. Clean up so the next cold start does not
          // pay the same scan, then report "no session".
          await deleteChunks(key, header.chunkCount).catch(() => undefined);
          await port.deleteItemAsync(key).catch(() => undefined);
          return null;
        }
        return value;
      } catch {
        // FAIL SOFT. A keychain that will not answer is a signed-out user, never
        // an app that will not start. Deliberately no rethrow and no logging of
        // the value — whatever is in there is a credential.
        return null;
      }
    },

    async setItem(key, value) {
      const chunks = splitIntoChunks(value);
      const nonce = makeNonce();

      // Chunks first, header LAST. If the process dies mid-write the header
      // still describes the OLD value while the chunks are new — and since each
      // chunk carries the nonce of the write that produced it, `readChunks`
      // turns that into a clean "no session" rather than a half-parsed one.
      // Writing the header first would leave a window where it promises chunks
      // that do not exist yet.
      for (let i = 0; i < chunks.length; i++) {
        await port.setItemAsync(chunkKey(key, i), buildChunk(nonce, chunks[i] ?? ""));
      }
      await port.setItemAsync(key, buildHeader(chunks.length, value.length, nonce));

      // Orphans from a previously LONGER value. They are unreachable through the
      // new header, but they are still a credential's bytes sitting in the
      // Keystore, so they go.
      for (let i = chunks.length; i < chunks.length + ORPHAN_SCAN_AHEAD; i++) {
        await port.deleteItemAsync(chunkKey(key, i));
      }
    },

    async removeItem(key) {
      // Read the header to know how many chunks there were; if it is unreadable,
      // fall back to scanning from zero. Sign-out must not depend on the stored
      // state being coherent — the corrupted case is precisely when a user is
      // most likely to be trying to sign out.
      let declared = 0;
      try {
        const raw = await port.getItemAsync(key);
        declared = raw === null ? 0 : (parseHeader(raw)?.chunkCount ?? 0);
      } catch {
        declared = 0;
      }
      await port.deleteItemAsync(key);
      await deleteChunks(key, declared);
    },
  };
}
