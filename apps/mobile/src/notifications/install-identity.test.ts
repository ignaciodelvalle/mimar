// The install identity — one uuid, minted once, and what happens when the
// keychain refuses.
//
// WHY THIS FILE MATTERS MORE THAN ITS SIZE SUGGESTS. `push_targets` conflicts on
// `device_id` (migration 0222) precisely so that a rotating token cannot orphan
// a row. That design is only as good as this module's promise to hand back the
// SAME id every time — and its refusal to hand back one it could not persist. An
// id that is minted fresh on every launch would leave one live, undeliverable
// row per app start, with nothing to attribute any of them to.
//
// MUTATIONS THAT MUST GO RED HERE (applied while writing, then reverted):
//   · returning `minted` instead of `null` when `setItemAsync` throws — the
//     "does not hand back an id it could not persist" test.
//   · returning `null` instead of falling through when `getItemAsync` throws —
//     the "a read failure is not fatal" test.
//   · minting on every call instead of returning the stored value — the
//     "same id on the second call" test.

import { describe, expect, it, jest } from "@jest/globals";

import {
  INSTALL_DEVICE_ID_KEY,
  type InstallIdentityPort,
  getOrCreateInstallDeviceId,
} from "./install-identity";

/** An in-memory keychain whose two failure modes can be switched on. */
function fakeStore(options: { readThrows?: boolean; writeThrows?: boolean } = {}) {
  const values = new Map<string, string>();
  const writes: Array<{ key: string; value: string }> = [];
  const port: InstallIdentityPort = {
    getItemAsync: async (key) => {
      if (options.readThrows) throw new Error("keychain unavailable");
      return values.get(key) ?? null;
    },
    setItemAsync: async (key, value) => {
      if (options.writeThrows) throw new Error("keychain read-only");
      values.set(key, value);
      writes.push({ key, value });
    },
  };
  return { port, values, writes };
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("getOrCreateInstallDeviceId", () => {
  it("mints a uuid v4 on the first call and stores it under the versioned key", async () => {
    const { port, writes } = fakeStore();

    const id = await getOrCreateInstallDeviceId(port);

    expect(id).toMatch(UUID_V4);
    expect(writes).toHaveLength(1);
    // The key is pinned as a literal: a rename would orphan every phone's id
    // and silently re-register every install as a new device.
    // `?.` because the index is unchecked under this tsconfig — the assertion
    // still bites: an absent write makes these `undefined` and the comparison
    // fails, which is the same red as a wrong key.
    expect(writes[0]?.key).toBe("dim.push.deviceId.v1");
    expect(INSTALL_DEVICE_ID_KEY).toBe("dim.push.deviceId.v1");
    expect(writes[0]?.value).toBe(id);
  });

  it("returns the SAME id on the second call, and writes nothing more", async () => {
    const { port, writes } = fakeStore();

    const first = await getOrCreateInstallDeviceId(port);
    const second = await getOrCreateInstallDeviceId(port);

    // This is the whole contract. A different answer here means one live,
    // undeliverable row per app start.
    expect(second).toBe(first);
    expect(writes).toHaveLength(1);
  });

  it("returns a value already on the phone without minting a new one", async () => {
    const { port, values, writes } = fakeStore();
    values.set(INSTALL_DEVICE_ID_KEY, "0f2b1f3c-4d5e-4a6b-8c7d-9e0f1a2b3c4d");

    const id = await getOrCreateInstallDeviceId(port);

    expect(id).toBe("0f2b1f3c-4d5e-4a6b-8c7d-9e0f1a2b3c4d");
    expect(writes).toHaveLength(0);
  });

  it("does NOT hand back an id it could not persist", async () => {
    const { port } = fakeStore({ writeThrows: true });

    const id = await getOrCreateInstallDeviceId(port);

    // `null`, not the minted value. Returning it would register a row this
    // install can never claim again: every launch would mint a different id and
    // leave the previous row live.
    expect(id).toBeNull();
  });

  it("treats a READ failure as recoverable — it mints and stores instead of giving up", async () => {
    const values = new Map<string, string>();
    const writes: Array<{ key: string; value: string }> = [];
    let firstRead = true;
    const port: InstallIdentityPort = {
      getItemAsync: async (key) => {
        if (firstRead) {
          firstRead = false;
          throw new Error("keychain locked");
        }
        return values.get(key) ?? null;
      },
      setItemAsync: async (key, value) => {
        values.set(key, value);
        writes.push({ key, value });
      },
    };

    const id = await getOrCreateInstallDeviceId(port);

    // A read failure alone must not end this install's ability to register.
    // Falling through to the write is the difference between one bad launch and
    // a phone that never registers again.
    expect(id).toMatch(UUID_V4);
    expect(writes).toHaveLength(1);
  });

  it("returns null when the keychain refuses BOTH operations", async () => {
    const { port } = fakeStore({ readThrows: true, writeThrows: true });
    expect(await getOrCreateInstallDeviceId(port)).toBeNull();
  });

  it("never throws, whatever the store does", async () => {
    const hostile: InstallIdentityPort = {
      getItemAsync: async () => {
        throw "not even an Error";
      },
      setItemAsync: async () => {
        throw "still not an Error";
      },
    };
    // A phone whose keychain misbehaves must still be able to sign in. It
    // simply will not register for push that session.
    await expect(getOrCreateInstallDeviceId(hostile)).resolves.toBeNull();
  });

  it("uses the injected port and never the real keychain in a test", async () => {
    const { port } = fakeStore();
    const spy = jest.spyOn(port, "setItemAsync");
    await getOrCreateInstallDeviceId(port);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
