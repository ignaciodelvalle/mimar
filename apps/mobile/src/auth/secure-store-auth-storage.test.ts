// The chunked SecureStore adapter, driven through a fake keystore.
//
// WHY THIS FILE IS WORTH MORE THAN MOST
// ---------------------------------------------------------------------------
// Every bug this adapter can have presents as the SAME user-visible symptom —
// "the app logs me out sometimes" — and none of them can be reproduced on
// demand. A value one byte over the Android limit, a chunk that went missing, a
// write interrupted by the OS: all three end with a cold start on the sign-in
// screen and no error anywhere. That is a class of defect a test suite has to
// catch, because a QA pass will not.
//
// The fake below is deliberately dumb — a Map — and the ONE thing it enforces is
// the limit the real provider enforces: a value over 2048 bytes is refused. That
// is the whole reason chunking exists, so a fake that accepted anything would
// let the adapter pass while doing nothing.

import { describe, expect, it } from "@jest/globals";

import {
  CHUNK_SIZE,
  type SecureStorePort,
  createSecureStoreAuthStorage,
  isLegacyHeader,
  parseHeader,
  readChunkPayload,
  sliceEnd,
  splitIntoChunks,
} from "./secure-store-auth-storage";

/** The Android Keystore provider's hard per-value limit. */
const ANDROID_LIMIT_BYTES = 2048;

function utf8Length(value: string): number {
  // TextEncoder is present in Hermes and in Node; measuring rather than
  // assuming is the point of the fake.
  return new TextEncoder().encode(value).length;
}

type FakeStore = SecureStorePort & {
  map: Map<string, string>;
  reads: string[];
  writes: string[];
};

function fakeSecureStore(options: { failOn?: (key: string) => boolean } = {}): FakeStore {
  const map = new Map<string, string>();
  const reads: string[] = [];
  const writes: string[] = [];
  return {
    map,
    reads,
    writes,
    async getItemAsync(key) {
      reads.push(key);
      if (options.failOn?.(key)) throw new Error(`keystore unavailable for ${key}`);
      return map.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      writes.push(key);
      if (utf8Length(value) > ANDROID_LIMIT_BYTES) {
        throw new Error(
          `SecureStore: value for ${key} is ${utf8Length(value)} bytes, over the ${ANDROID_LIMIT_BYTES}-byte limit`,
        );
      }
      map.set(key, value);
    },
    async deleteItemAsync(key) {
      map.delete(key);
    },
  };
}

/** A session-shaped value of roughly `bytes` bytes. */
function sessionOfSize(bytes: number): string {
  const filler = "a".repeat(Math.max(0, bytes - 64));
  return JSON.stringify({ access_token: filler, refresh_token: "r".repeat(48) });
}

const KEY = "mimar.auth.session";

/** The stored key of chunk `index` — the layout the adapter uses internally. */
function chunkKeyFor(index: number): string {
  return `${KEY}.c${index}`;
}

describe("splitIntoChunks", () => {
  it("keeps every chunk inside the Android byte limit for ASCII", () => {
    for (const chunk of splitIntoChunks(sessionOfSize(8_000))) {
      expect(utf8Length(chunk)).toBeLessThanOrEqual(ANDROID_LIMIT_BYTES);
    }
  });

  it("keeps every chunk inside the limit for three-byte characters", () => {
    // The bound in the header is 3 UTF-8 bytes per BMP code unit. This is that
    // arithmetic, measured: 512 units of a 3-byte character is 1536 bytes.
    const dense = "漢".repeat(CHUNK_SIZE * 4);
    for (const chunk of splitIntoChunks(dense)) {
      expect(utf8Length(chunk)).toBeLessThanOrEqual(ANDROID_LIMIT_BYTES);
    }
  });

  it("never splits a surrogate pair", () => {
    // An emoji is two UTF-16 code units. Slicing between them would leave each
    // chunk holding an unpaired surrogate — not valid UTF-8, and something a
    // native keychain is entitled to reject or mangle.
    const emoji = "🐕".repeat(CHUNK_SIZE);
    for (const chunk of splitIntoChunks(emoji)) {
      expect(chunk.length % 2).toBe(0);
      expect(chunk).toBe(chunk.normalize());
      expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
    }
    expect(splitIntoChunks(emoji).join("")).toBe(emoji);
  });

  it("nudges the boundary back exactly one unit when it lands mid-pair", () => {
    const value = `${"a".repeat(CHUNK_SIZE - 1)}🐕tail`;
    expect(sliceEnd(value, 0, CHUNK_SIZE)).toBe(CHUNK_SIZE - 1);
  });
});

describe("round trip", () => {
  it("stores and returns a value larger than the 2048-byte limit", async () => {
    // THE CASE THE WHOLE FILE EXISTS FOR. A Supabase session with app_metadata
    // routinely crosses 2 KB, and the real provider REFUSES the write — silently
    // enough that the symptom is a mystery sign-out days later.
    const store = fakeSecureStore();
    const storage = createSecureStoreAuthStorage(store);
    const value = sessionOfSize(6_000);

    await storage.setItem(KEY, value);
    expect(await storage.getItem(KEY)).toBe(value);
    // It really was chunked, not squeezed through in one write.
    expect(store.map.has(`${KEY}.c0`)).toBe(true);
    expect(store.map.has(`${KEY}.c1`)).toBe(true);
  });

  it("round-trips a small value too, through the same code path", async () => {
    const store = fakeSecureStore();
    const storage = createSecureStoreAuthStorage(store);
    await storage.setItem(KEY, "tiny");
    expect(await storage.getItem(KEY)).toBe("tiny");
  });

  it("round-trips an empty string as an empty string, not as null", async () => {
    // `null` means "no session". A value that is genuinely empty must not become
    // one, or the library would read a stored empty session as no session and
    // never notice it failed to write.
    const store = fakeSecureStore();
    const storage = createSecureStoreAuthStorage(store);
    await storage.setItem(KEY, "");
    expect(await storage.getItem(KEY)).toBe("");
  });

  it("round-trips non-ASCII content intact", async () => {
    const store = fakeSecureStore();
    const storage = createSecureStoreAuthStorage(store);
    const value = JSON.stringify({ name: "Ñandú 🐕 acentuación", pad: "ó".repeat(3_000) });
    await storage.setItem(KEY, value);
    expect(await storage.getItem(KEY)).toBe(value);
  });

  it("writes the header LAST so an interrupted write cannot promise missing chunks", async () => {
    const store = fakeSecureStore();
    const storage = createSecureStoreAuthStorage(store);
    await storage.setItem(KEY, sessionOfSize(4_000));
    expect(store.writes[store.writes.length - 1]).toBe(KEY);
  });
});

describe("corruption is a signed-out user, never a crash", () => {
  it("treats a MISSING chunk as no session", async () => {
    const store = fakeSecureStore();
    const storage = createSecureStoreAuthStorage(store);
    await storage.setItem(KEY, sessionOfSize(6_000));

    store.map.delete(`${KEY}.c1`);

    // Not a throw, not a truncated string handed to JSON.parse: null.
    expect(await storage.getItem(KEY)).toBeNull();
  });

  it("cleans up after itself when it finds a hole", async () => {
    const store = fakeSecureStore();
    const storage = createSecureStoreAuthStorage(store);
    await storage.setItem(KEY, sessionOfSize(6_000));
    store.map.delete(`${KEY}.c1`);

    await storage.getItem(KEY);

    // The next cold start must not pay the same scan, and half a credential
    // must not linger in the Keystore.
    expect([...store.map.keys()].filter((k) => k.startsWith(KEY))).toEqual([]);
  });

  // ==========================================================================
  // THE INTERRUPTED WRITE, ACTUALLY INTERLEAVED (2026-08-25)
  // ==========================================================================
  // This test used to FABRICATE the signature: it took a real header and edited
  // the declared length to 999999. That proves the length comparison runs, and
  // it proves nothing about the case the adapter is for — because the write this
  // adapter performs most often is a token ROTATION, where the new session has
  // the same claims and the same fixed-length signature and therefore the same
  // LENGTH. A splice of two same-length values passes a length check.
  //
  // So this one interleaves two real writes: value A is stored, then a write of
  // value B (identical length, different content) is interrupted after its first
  // chunk. The store is then left exactly as the OS would have left it — chunk 0
  // from B, chunks 1..n from A, header still A's — and the adapter must answer
  // "no session".
  it("treats a REAL interrupted write between two same-length values as no session", async () => {
    const store = fakeSecureStore();
    const storage = createSecureStoreAuthStorage(store);

    const valueA = sessionOfSize(6_000);
    const valueB = valueA.replaceAll("a", "b");
    // The premise: if these differed in length the old check would have caught
    // it, and this test would not be about anything.
    expect(valueB.length).toBe(valueA.length);
    expect(valueB).not.toBe(valueA);

    await storage.setItem(KEY, valueA);
    const headerA = store.map.get(KEY) ?? "";

    // The interruption: B's chunk 0 lands, then the process dies. B's header is
    // never written, so A's is still there.
    const writer = createSecureStoreAuthStorage({
      getItemAsync: store.getItemAsync,
      deleteItemAsync: store.deleteItemAsync,
      setItemAsync: async (key, value) => {
        if (key !== chunkKeyFor(0)) throw new Error("process died mid-write");
        await store.setItemAsync(key, value);
      },
    });
    await expect(writer.setItem(KEY, valueB)).rejects.toThrow(/died mid-write/);

    // Precondition of the whole test: the store really is spliced, and the
    // header really is still A's.
    expect(store.map.get(KEY)).toBe(headerA);
    expect(store.map.get(chunkKeyFor(0))).not.toBe(undefined);

    // The chunks all EXIST and the total length is unchanged — the only thing
    // that separates this from a healthy read is the per-write nonce.
    expect(await storage.getItem(KEY)).toBeNull();
  });

  it("does not accept a chunk left behind by a previous write", async () => {
    const store = fakeSecureStore();
    let nonce = "aaaaaaaa";
    const storage = createSecureStoreAuthStorage(store, () => nonce);

    await storage.setItem(KEY, sessionOfSize(6_000));
    const staleChunk = store.map.get(chunkKeyFor(1));

    nonce = "bbbbbbbb";
    await storage.setItem(KEY, sessionOfSize(6_000));

    // One chunk reverts to the earlier write. Same length, same position.
    store.map.set(chunkKeyFor(1), staleChunk ?? "");

    expect(await storage.getItem(KEY)).toBeNull();
  });

  it("still catches a truncation that somehow kept the nonce", async () => {
    // The length check is kept as a second, cheap guard. Proving it still runs
    // matters because the nonce made it look redundant.
    const store = fakeSecureStore();
    const storage = createSecureStoreAuthStorage(store, () => "nnnnnnnn");
    await storage.setItem(KEY, sessionOfSize(6_000));

    const chunk0 = store.map.get(chunkKeyFor(0)) ?? "";
    store.map.set(chunkKeyFor(0), chunk0.slice(0, chunk0.length - 10));

    expect(await storage.getItem(KEY)).toBeNull();
  });

  // A v1 value cannot be read safely — its chunks carry no nonce, so reading it
  // would mean keeping the detector this change replaced.
  it("wipes a v1 value rather than reading it, and answers no session", async () => {
    const store = fakeSecureStore();
    store.map.set(KEY, "dim.chunked.v1:2:1200");
    store.map.set(chunkKeyFor(0), "half-a-session");
    store.map.set(chunkKeyFor(1), "the-other-half");
    const storage = createSecureStoreAuthStorage(store);

    expect(await storage.getItem(KEY)).toBeNull();
    expect([...store.map.keys()].filter((k) => k.startsWith(KEY))).toEqual([]);
  });

  it("returns null instead of throwing when the keystore itself fails", async () => {
    // A device with no passcode, a corrupted entry after an OS upgrade. The user
    // gets the sign-in screen; they do not get an app that will not start.
    const store = fakeSecureStore({ failOn: (key) => key === KEY });
    const storage = createSecureStoreAuthStorage(store);
    await expect(storage.getItem(KEY)).resolves.toBeNull();
  });

  it("hands back a plain value written by something that is not this adapter", async () => {
    const store = fakeSecureStore();
    store.map.set(KEY, "a-value-with-no-header");
    const storage = createSecureStoreAuthStorage(store);
    expect(await storage.getItem(KEY)).toBe("a-value-with-no-header");
  });
});

describe("removal leaves nothing behind", () => {
  it("deletes the header and every chunk", async () => {
    const store = fakeSecureStore();
    const storage = createSecureStoreAuthStorage(store);
    await storage.setItem(KEY, sessionOfSize(6_000));

    await storage.removeItem(KEY);

    expect([...store.map.keys()].filter((k) => k.startsWith(KEY))).toEqual([]);
  });

  it("deletes orphans left by a previously LONGER value", async () => {
    // The cost the seam named when it chose chunking. Paid here, and asserted:
    // an orphan chunk is unreachable through the new header but is still a
    // credential's bytes sitting in the Keystore.
    const store = fakeSecureStore();
    const storage = createSecureStoreAuthStorage(store);
    await storage.setItem(KEY, sessionOfSize(8_000));
    const longChunkCount = [...store.map.keys()].filter((k) => k.startsWith(`${KEY}.c`)).length;
    expect(longChunkCount).toBeGreaterThan(2);

    await storage.setItem(KEY, "short");

    const remaining = [...store.map.keys()].filter((k) => k.startsWith(`${KEY}.c`));
    expect(remaining).toEqual([`${KEY}.c0`]);
    expect(await storage.getItem(KEY)).toBe("short");
  });

  it("still clears everything when the header is unreadable", async () => {
    // Signing out is exactly when the stored state is most likely to be broken.
    const store = fakeSecureStore();
    const storage = createSecureStoreAuthStorage(store);
    await storage.setItem(KEY, sessionOfSize(6_000));
    store.map.set(KEY, "garbage");

    await storage.removeItem(KEY);

    expect([...store.map.keys()].filter((k) => k.startsWith(KEY))).toEqual([]);
  });
});

describe("parseHeader", () => {
  it("accepts our header and reads the count, the length and the nonce", () => {
    expect(parseHeader("dim.chunked.v2:3:1200:abcd1234")).toEqual({
      chunkCount: 3,
      charLength: 1200,
      nonce: "abcd1234",
    });
  });

  it("rejects anything that is not one, so a plain value is returned verbatim", () => {
    for (const raw of [
      "",
      "{}",
      "dim.chunked.v2:",
      "dim.chunked.v2:x:1:n",
      "dim.chunked.v2:1:2",
      // No nonce, and no empty one either: a header without a write identifier
      // is a header this layout cannot verify.
      "dim.chunked.v2:1:2:",
      "dim.chunked.v2:1:2:n:extra",
      // v1 is NOT parsed. It is recognised separately and wiped.
      "dim.chunked.v1:3:1200",
    ]) {
      expect(parseHeader(raw)).toBeNull();
    }
  });

  it("recognises the v1 header separately, so it is wiped and not handed back", () => {
    expect(isLegacyHeader("dim.chunked.v1:3:1200")).toBe(true);
    expect(isLegacyHeader("dim.chunked.v2:3:1200:n")).toBe(false);
    expect(isLegacyHeader("a-value-with-no-header")).toBe(false);
  });
});

describe("readChunkPayload", () => {
  it("returns the payload only when the nonce matches", () => {
    expect(readChunkPayload("abcd1234:hello", "abcd1234")).toBe("hello");
    expect(readChunkPayload("abcd1234:hello", "zzzz9999")).toBeNull();
  });

  it("does not mistake a payload that happens to contain a colon", () => {
    expect(readChunkPayload('abcd1234:{"a":"b"}', "abcd1234")).toBe('{"a":"b"}');
  });
});
