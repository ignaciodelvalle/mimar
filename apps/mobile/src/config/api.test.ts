// Which environment each plane points at, and the one combination that lies.
//
// WHY THIS FILE EXISTS. On 2026-08-30 a walkthrough pointed
// `EXPO_PUBLIC_SUPABASE_URL` at a local stack and left `EXPO_PUBLIC_API_BASE_URL`
// on its staging default. The app signed in at STAGING, handed the resulting
// token to LOCAL GoTrue, and got `invalid JWT: unrecognized JWT kid`. Because
// `setSession` calls `_getUser` over the network before it saves anything, the
// device was never touched — and the sign-in screen reported a device-storage
// failure. It was investigated for hours as an unexplained Keystore fault.
//
// THE OBVIOUS FENCE WOULD HAVE BEEN WRONG, which is the part worth keeping. The
// finding that recorded this asked for "a fence asserting the two EXPO_PUBLIC_*
// origins share a host". They deliberately do NOT: `config/api.ts` opens by
// saying the data plane and the auth plane "are not the same host and must not
// be confused for one", and in staging they are `dim-staging.vercel.app` and a
// `*.supabase.co` project. That fence would be red on every correct build this
// app ships. The invariant is one level up — same ENVIRONMENT, not same host —
// and the last two cases below are what keep the weaker rule from creeping back.

import { describe, expect, it, jest } from "@jest/globals";

/**
 * Reload the module under a given environment.
 *
 * The two constants are read at module scope (Babel inlines `process.env.EXPO_*`
 * at bundle time in a real build), so a test that only sets `process.env` after
 * the import measures nothing. `resetModules` + a fresh `require` is what makes
 * each case an independent build.
 */
function loadWith(env: { api?: string; supabase?: string }) {
  jest.resetModules();
  process.env.EXPO_PUBLIC_API_BASE_URL = env.api ?? "";
  process.env.EXPO_PUBLIC_SUPABASE_URL = env.supabase ?? "";
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./api") as typeof import("./api");
}

const STAGING_API = "https://dim-staging.vercel.app";
const STAGING_AUTH = "https://abcdefghijkl.supabase.co";

describe("planesLookCrossed — the combination that produced a wrong diagnosis", () => {
  it("catches the exact configuration that cost the 2026-08-30 afternoon", () => {
    const { planesLookCrossed } = loadWith({
      api: STAGING_API,
      supabase: "http://10.0.2.2:54321",
    });
    expect(planesLookCrossed()).toBe(true);
  });

  it("catches it in the other direction too", () => {
    // Local API against a remote auth plane fails the same way with the roles
    // swapped, and nothing about the check should care which side is which.
    const { planesLookCrossed } = loadWith({
      api: "http://10.0.2.2:3000",
      supabase: STAGING_AUTH,
    });
    expect(planesLookCrossed()).toBe(true);
  });

  it("knows the emulator's host alias, the simulator's, a LAN name, and the LAN IPs", () => {
    // Asserted as pairs rather than a bare boolean per host: Jest's `expect`
    // takes no message argument (that is vitest), so this is how a failure names
    // WHICH host stopped reading as local instead of just saying `false`.
    // The three RFC 1918 spellings are the 2026-09-01 review's finding: a
    // physical device on the developer's wifi says `192.168.x.x`, and the
    // original list missed it — the exact device this check most needs.
    const hosts = [
      "localhost",
      "127.0.0.1",
      "10.0.2.2",
      "10.0.3.2",
      "macbook.local",
      "192.168.1.50",
      "172.16.0.10",
      "10.1.2.3",
    ];
    const seen = hosts.map((host) => {
      const { planesLookCrossed } = loadWith({
        api: STAGING_API,
        supabase: `http://${host}:54321`,
      });
      return { host, crossed: planesLookCrossed() };
    });

    expect(seen).toEqual(hosts.map((host) => ({ host, crossed: true })));
  });
});

describe("planesLookCrossed — every correct build stays quiet", () => {
  it("is FALSE for staging, where the two hosts differ ON PURPOSE", () => {
    // THE CASE THAT KILLS THE "same host" RULE. This is the shipping
    // configuration; a host-equality fence would be red here, every time.
    const { planesLookCrossed } = loadWith({ api: STAGING_API, supabase: STAGING_AUTH });
    expect(planesLookCrossed()).toBe(false);
  });

  it("is FALSE when both planes are local, on different ports", () => {
    const { planesLookCrossed } = loadWith({
      api: "http://10.0.2.2:3000",
      supabase: "http://10.0.2.2:54321",
    });
    expect(planesLookCrossed()).toBe(false);
  });

  it("is FALSE when the auth plane is absent — that is a different message", () => {
    // An unconfigured build already says so through `authPlaneConfigured()`.
    // Answering "crossed" here would put a second explanation on a screen that
    // already carries the right one.
    const { planesLookCrossed, authPlaneConfigured } = loadWith({ api: STAGING_API });
    expect(authPlaneConfigured()).toBe(false);
    expect(planesLookCrossed()).toBe(false);
  });

  it("is FALSE for an origin it cannot parse, rather than guessing", () => {
    const { planesLookCrossed } = loadWith({ api: STAGING_API, supabase: "not-a-url" });
    expect(planesLookCrossed()).toBe(false);
  });

  it("is FALSE when one machine wears two spellings — LAN IP and emulator alias", () => {
    // The review's false-POSITIVE case: an emulator reaching the API by the
    // host's LAN IP while auth uses the 10.0.2.2 alias is ONE machine, not two
    // environments. Before the RFC 1918 ranges landed, this read as crossed.
    const { planesLookCrossed } = loadWith({
      api: "http://192.168.1.50:3000",
      supabase: "http://10.0.2.2:54321",
    });
    expect(planesLookCrossed()).toBe(false);
  });

  it("does not read 172.32.x — outside RFC 1918 — as the developer's machine", () => {
    // The 172 block is /12, not /8: only 172.16 through 172.31 are private. A
    // public 172.32 address reading as "local" would cross against staging
    // here and put the config message on a screen whose real cause is remote.
    const { planesLookCrossed } = loadWith({
      api: "http://172.32.0.1:3000",
      supabase: STAGING_AUTH,
    });
    expect(planesLookCrossed()).toBe(false);
  });
});
