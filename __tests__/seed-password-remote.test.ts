// Pins the seed-password policy in scripts/_env-target.ts (R8 + the security
// review of R8/C4b, 2026-09-23): what counts as a local target, which
// SEED_DEMO_PASSWORD values a remote seed refuses, when a seed may reset an
// existing account's password, and what it prints.
//
// The local literal is never spelled here: it comes from e2e/_credentials.ts,
// so this file does not become one more place that publishes it.

import { afterEach, describe, expect, it, vi } from "vitest";

import { LOCAL_LITERAL_PASSWORD } from "@/e2e/_credentials";
import {
  isLocalTarget,
  resolveSeedPassword,
  seedPasswordForDisplay,
  seedPasswordProblem,
  shouldResetSeedPassword,
} from "@/scripts/_env-target";

const LOCAL_API = "http://127.0.0.1:54321";
const LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const REMOTE_API = "https://abcdefghijklmnopqrst.supabase.co";
const REMOTE_DB =
  "postgresql://postgres.abcdefghijklmnopqrst:pw@aws-1-sa-east-1.pooler.supabase.com:6543/postgres";

describe("isLocalTarget", () => {
  it("is local only when BOTH urls are local", () => {
    expect(isLocalTarget(LOCAL_API, LOCAL_DB)).toBe(true);
    expect(isLocalTarget(LOCAL_API, REMOTE_DB)).toBe(false);
    expect(isLocalTarget(REMOTE_API, LOCAL_DB)).toBe(false);
    expect(isLocalTarget(REMOTE_API, REMOTE_DB)).toBe(false);
  });

  it("an empty url is NOT local (the old seeds defaulted an empty DATABASE_URL to local)", () => {
    expect(isLocalTarget(LOCAL_API, "")).toBe(false);
    expect(isLocalTarget("", LOCAL_DB)).toBe(false);
    expect(isLocalTarget("", "")).toBe(false);
  });

  it("does not substring-match: a remote host that merely contains 'localhost' is remote", () => {
    expect(isLocalTarget("https://localhost.example.supabase.co", LOCAL_DB)).toBe(false);
    expect(isLocalTarget(LOCAL_API, "postgresql://localhost@db.example.com:5432/postgres")).toBe(
      false,
    );
  });
});

describe("seedPasswordProblem", () => {
  it("accepts a real value", () => {
    expect(seedPasswordProblem("a-fresh-remote-password")).toBeNull();
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["spaces only", "   "],
    ["tabs and newlines only", "\t\n "],
  ])("rejects %s", (_label, value) => {
    expect(seedPasswordProblem(value)).not.toBeNull();
  });

  it("rejects the published local literal itself", () => {
    expect(seedPasswordProblem(LOCAL_LITERAL_PASSWORD)).toMatch(/literal/);
  });

  it("rejects whatever literal the caller declares as local", () => {
    expect(seedPasswordProblem("custom-literal", "custom-literal")).not.toBeNull();
  });
});

describe("resolveSeedPassword", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function exitSpy() {
    vi.spyOn(console, "error").mockImplementation(() => {});
    return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
  }

  it("local keeps the literal and ignores the env", () => {
    vi.stubEnv("SEED_DEMO_PASSWORD", "ignored");
    expect(resolveSeedPassword(true, "t")).toBe(LOCAL_LITERAL_PASSWORD);
  });

  it("remote returns SEED_DEMO_PASSWORD when it is a real value", () => {
    vi.stubEnv("SEED_DEMO_PASSWORD", "a-fresh-remote-password");
    expect(resolveSeedPassword(false, "t")).toBe("a-fresh-remote-password");
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "  \t "],
    ["the published literal", LOCAL_LITERAL_PASSWORD],
  ])("remote exits 2 on %s", (_label, value) => {
    vi.stubEnv("SEED_DEMO_PASSWORD", value);
    const exit = exitSpy();
    expect(() => resolveSeedPassword(false, "t")).toThrow("exit 2");
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("remote exits 2 when SEED_DEMO_PASSWORD is unset", () => {
    vi.stubEnv("SEED_DEMO_PASSWORD", undefined);
    const exit = exitSpy();
    expect(() => resolveSeedPassword(false, "t")).toThrow("exit 2");
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("never prints the refused value", () => {
    vi.stubEnv("SEED_DEMO_PASSWORD", LOCAL_LITERAL_PASSWORD);
    exitSpy();
    const printed: string[] = [];
    vi.mocked(console.error).mockImplementation((m: unknown) => {
      printed.push(String(m));
    });
    expect(() => resolveSeedPassword(false, "t")).toThrow();
    expect(printed.join("\n")).not.toContain(LOCAL_LITERAL_PASSWORD);
  });
});

describe("shouldResetSeedPassword — a remote seed never touches an existing account's password", () => {
  it.each([
    // isLocal, created, expected
    [true, false, true],
    [true, true, false],
    [false, false, false],
    [false, true, false],
  ])("isLocal=%s created=%s → %s", (isLocal, created, expected) => {
    expect(shouldResetSeedPassword(isLocal, created)).toBe(expected);
  });
});

describe("seedPasswordForDisplay", () => {
  it("prints the literal locally", () => {
    expect(seedPasswordForDisplay(true, LOCAL_LITERAL_PASSWORD)).toBe(LOCAL_LITERAL_PASSWORD);
  });

  it("never prints the value on a remote target", () => {
    const shown = seedPasswordForDisplay(false, "a-fresh-remote-password");
    expect(shown).not.toContain("a-fresh-remote-password");
    expect(shown).toContain("SEED_DEMO_PASSWORD");
  });
});
