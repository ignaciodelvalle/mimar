// THE RECOVERY MARKER — binding a recovered pick to who and what asked for it
// (T3-R4, 2026-09-22, security review).
//
// WHAT THIS FILE PROVES, exhaustively, because a mismatch on any ONE field is
// its own security boundary and each one needs its own red: `imagePickMarkerMatches`
// refuses a marker naming a different screen, pet, session user, or one that
// is simply too old — and delivers only when every field agrees.
// `pickImageSafely`/`recoverPendingPickSafely` are then proven against a fake,
// native-free store: the write happens before the pick resolves, the read is
// always cleared (claim-once at this layer, independent of the native side),
// and the native call is always made even when the marker cannot match — see
// each test's own note for why.
//
// MUTATIONS THAT MUST GO RED HERE (applied while writing, then reverted):
//   · dropping any one of the four `!==` checks in `imagePickMarkerMatches`.
//   · `age >= 0 && age <= MAX` → `age <= MAX` alone (accepts a future marker).
//   · `pickImageSafely` calling `store.write` AFTER `activePort.pickImage()`
//     instead of before.
//   · `recoverPendingPickSafely` returning the native result without checking
//     `imagePickMarkerMatches` — the "deliver to whoever asks first" bug this
//     file exists to close.
//   · dropping `store.clear()` — a matching marker would then deliver twice.

import { afterEach, describe, expect, it, jest } from "@jest/globals";

import {
  IMAGE_PICK_MARKER_MAX_AGE_MS,
  type ImagePickMarker,
  type ImagePickMarkerStore,
  type ImagePickScreen,
  type ImagePickerPort,
  imagePickMarkerMatches,
  pickImageSafely,
  recoverPendingPickSafely,
  resetImagePickerPort,
  setImagePickerPort,
} from "./image-picker-port";

const IDENTITY = {
  screen: "tattoo" as ImagePickScreen,
  publicToken: "DIM-PAMP-0001",
  sessionUserId: "11111111-1111-4111-8111-111111111111",
};

function marker(overrides: Partial<ImagePickMarker> = {}, now = Date.now()): ImagePickMarker {
  return { ...IDENTITY, launchedAt: now, ...overrides };
}

describe("imagePickMarkerMatches", () => {
  const NOW = 1_800_000_000_000;

  it("matches when every field agrees and the marker is fresh", () => {
    expect(imagePickMarkerMatches(marker({}, NOW), IDENTITY, NOW)).toBe(true);
  });

  it("matches right up to the edge of the age window", () => {
    const launchedAt = NOW - IMAGE_PICK_MARKER_MAX_AGE_MS;
    expect(imagePickMarkerMatches(marker({}, launchedAt), IDENTITY, NOW)).toBe(true);
  });

  it("refuses a DIFFERENT screen", () => {
    const wrong = marker({ screen: "pet-photo" }, NOW);
    expect(imagePickMarkerMatches(wrong, IDENTITY, NOW)).toBe(false);
  });

  it("refuses a DIFFERENT pet", () => {
    const wrong = marker({ publicToken: "DIM-OTRO-0002" }, NOW);
    expect(imagePickMarkerMatches(wrong, IDENTITY, NOW)).toBe(false);
  });

  it("refuses a DIFFERENT signed-in person — the cross-session leak this exists to close", () => {
    const wrong = marker({ sessionUserId: "22222222-2222-4222-8222-222222222222" }, NOW);
    expect(imagePickMarkerMatches(wrong, IDENTITY, NOW)).toBe(false);
  });

  it("refuses a marker past the age window", () => {
    const stale = marker({}, NOW - IMAGE_PICK_MARKER_MAX_AGE_MS - 1);
    expect(imagePickMarkerMatches(stale, IDENTITY, NOW)).toBe(false);
  });

  it("refuses a marker that looks like it is from the future — never guessed at", () => {
    const fromTheFuture = marker({}, NOW + 1);
    expect(imagePickMarkerMatches(fromTheFuture, IDENTITY, NOW)).toBe(false);
  });
});

describe("pickImageSafely — writes the marker BEFORE the pick resolves", () => {
  afterEach(() => {
    resetImagePickerPort();
  });

  function fakeStore(): ImagePickMarkerStore & { written: ImagePickMarker[] } {
    const written: ImagePickMarker[] = [];
    let current: ImagePickMarker | null = null;
    return {
      written,
      read: async () => current,
      write: async (m) => {
        written.push(m);
        current = m;
      },
      clear: async () => {
        current = null;
      },
    };
  }

  it("persists screen, pet and session before the native call settles", async () => {
    const order: string[] = [];
    const store = fakeStore();
    const originalWrite = store.write;
    store.write = async (m) => {
      order.push("write");
      await originalWrite(m);
    };
    setImagePickerPort({
      name: "fake",
      available: true,
      pickImage: async () => {
        order.push("launch");
        return { outcome: "cancelled" };
      },
      recoverPendingPick: async () => null,
    });

    const now = 1_800_000_000_000;
    await pickImageSafely(IDENTITY, store, () => now);

    expect(order).toEqual(["write", "launch"]);
    expect(store.written).toEqual([{ ...IDENTITY, launchedAt: now }]);
  });

  it("skips the marker entirely when there is no session to bind it to", async () => {
    const store = fakeStore();
    setImagePickerPort({
      name: "fake",
      available: true,
      pickImage: async () => ({ outcome: "cancelled" }),
      recoverPendingPick: async () => null,
    });

    const result = await pickImageSafely(null, store);

    // The pick still runs — refusing to open a live picker over a missing
    // session would be a worse answer than an unbound recovery some day.
    expect(result).toEqual({ outcome: "cancelled" });
    expect(store.written).toEqual([]);
  });

  it("a marker write that throws does not stop the pick", async () => {
    setImagePickerPort({
      name: "fake",
      available: true,
      pickImage: async () => ({ outcome: "cancelled" }),
      recoverPendingPick: async () => null,
    });
    const throwingStore: ImagePickMarkerStore = {
      read: async () => null,
      write: async () => {
        throw new Error("disk full");
      },
      clear: async () => undefined,
    };

    await expect(pickImageSafely(IDENTITY, throwingStore)).resolves.toEqual({
      outcome: "cancelled",
    });
  });
});

describe("recoverPendingPickSafely — bound delivery, T3-R4", () => {
  afterEach(() => {
    resetImagePickerPort();
  });

  function fakeStore(initial: ImagePickMarker | null): ImagePickMarkerStore {
    let current = initial;
    return {
      read: async () => current,
      write: async (m) => {
        current = m;
      },
      clear: async () => {
        current = null;
      },
    };
  }

  const RECOVERED = {
    outcome: "picked" as const,
    bytes: new Uint8Array([1, 2, 3]),
    contentType: "image/jpeg",
    previewUri: null,
  };

  it("delivers the native answer when the marker matches", async () => {
    setImagePickerPort({
      name: "fake",
      available: true,
      pickImage: async () => ({ outcome: "cancelled" }),
      recoverPendingPick: async () => RECOVERED,
    });
    const now = 1_800_000_000_000;

    const result = await recoverPendingPickSafely(IDENTITY, fakeStore(marker({}, now)), () => now);

    expect(result).toEqual(RECOVERED);
  });

  it.each<[string, Partial<ImagePickMarker>]>([
    ["a different pet", { publicToken: "DIM-OTRO-0002" }],
    ["a different signed-in person", { sessionUserId: "99999999-9999-4999-8999-999999999999" }],
    ["a different screen", { screen: "pet-photo" }],
  ])("discards the recovered pick for %s", async (_label, override) => {
    setImagePickerPort({
      name: "fake",
      available: true,
      pickImage: async () => ({ outcome: "cancelled" }),
      recoverPendingPick: async () => RECOVERED,
    });
    const now = 1_800_000_000_000;

    const result = await recoverPendingPickSafely(
      IDENTITY,
      fakeStore(marker(override, now)),
      () => now,
    );

    expect(result).toBeNull();
  });

  it("discards a STALE marker, past the binding window", async () => {
    setImagePickerPort({
      name: "fake",
      available: true,
      pickImage: async () => ({ outcome: "cancelled" }),
      recoverPendingPick: async () => RECOVERED,
    });
    const now = 1_800_000_000_000;

    const result = await recoverPendingPickSafely(
      IDENTITY,
      fakeStore(marker({}, now - IMAGE_PICK_MARKER_MAX_AGE_MS - 1)),
      () => now,
    );

    expect(result).toBeNull();
  });

  it("returns null and never touches the marker when there is nothing pending — no marker means no false positive", async () => {
    setImagePickerPort({
      name: "fake",
      available: true,
      pickImage: async () => ({ outcome: "cancelled" }),
      recoverPendingPick: async () => null,
    });

    const result = await recoverPendingPickSafely(IDENTITY, fakeStore(null));
    expect(result).toBeNull();
  });

  it("CLAIMS ONCE: clears the marker even when the pending pick never matched it", async () => {
    const port: ImagePickerPort = {
      name: "fake",
      available: true,
      pickImage: async () => ({ outcome: "cancelled" }),
      recoverPendingPick: async () => RECOVERED,
    };
    setImagePickerPort(port);
    const store = fakeStore(marker({ publicToken: "DIM-OTRO-0002" }));

    const first = await recoverPendingPickSafely(IDENTITY, store);
    expect(first).toBeNull();

    // The marker is gone now — a second recovery attempt in the same process
    // (a different screen mounting later) must not read the same stale entry.
    expect(await store.read()).toBeNull();
  });

  it("always drains the native side, even for a mismatched marker — never leaks to a later screen", async () => {
    const recoverPendingPick = jest.fn(async () => RECOVERED);
    setImagePickerPort({
      name: "fake",
      available: true,
      pickImage: async () => ({ outcome: "cancelled" }),
      recoverPendingPick,
    });

    await recoverPendingPickSafely(IDENTITY, fakeStore(marker({ publicToken: "DIM-OTRO-0002" })));

    expect(recoverPendingPick).toHaveBeenCalledTimes(1);
  });
});
