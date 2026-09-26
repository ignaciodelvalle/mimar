// The adopter DNI oracle has ONE door, and the door carries both guards
// (security review, third oracle: finalize-adoption called the raw lookup with
// no ceiling and no trail).
//
// consultAdopterAccountByDni takes the per-organization ceiling BEFORE the
// read and writes the hashed pii_queried trail AFTER it, found or not. The raw
// lookup is private to its module, so no caller — the confirmation action, the
// contract route, the finalize use case, or the next one — can reach the DNI
// space without both.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute, enforceRateLimit, logPii, FakeRateLimitError } = vi.hoisted(() => ({
  execute: vi.fn(),
  enforceRateLimit: vi.fn(),
  logPii: vi.fn(),
  FakeRateLimitError: class FakeRateLimitError extends Error {},
}));

vi.mock("@/db", () => ({ db: { execute: (...a: unknown[]) => execute(...a) } }));

vi.mock("@/lib/infra/rate-limit", () => ({
  RateLimitError: FakeRateLimitError,
  enforceRateLimit: (...a: unknown[]) => enforceRateLimit(...a),
}));

vi.mock("@/src/modules/organizations/application/admin-proposals/log-pii-query", () => ({
  logPiiQueryForAuthority: (...a: unknown[]) => logPii(...a),
}));

import { hashDni } from "@/lib/utils/dni-hash";
import { ADOPTER_DNI_CHECK_LIMITS } from "../../domain/dni-check-policy";
import { consultAdopterAccountByDni } from "../adopter-dni-consult";

const REGISTERED = [
  { id: "u-1", display_name: "Ana", dni_verified: false, has_auth_account: true },
];

describe("consultAdopterAccountByDni", () => {
  beforeEach(() => {
    execute.mockReset();
    enforceRateLimit.mockReset();
    logPii.mockReset();
  });

  it("takes the org ceiling before the read and leaves a hashed trail on a hit", async () => {
    execute.mockResolvedValue(REGISTERED);
    const r = await consultAdopterAccountByDni("org-1", "user-1", "30111222");
    expect(r).toEqual({ id: "u-1", displayName: "Ana", dniVerified: false, hasAuthAccount: true });
    expect(enforceRateLimit).toHaveBeenCalledWith(
      "adopter_dni_check",
      "org-1",
      ADOPTER_DNI_CHECK_LIMITS,
    );
    expect(enforceRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[0] ?? 0,
    );
    expect(logPii).toHaveBeenCalledWith("user-1", hashDni("30111222"), 1, "adopter_dni_check", {
      organization_id: "org-1",
    });
    expect(JSON.stringify(logPii.mock.calls)).not.toContain("30111222");
  });

  it("a miss is traced too, with a zero count", async () => {
    execute.mockResolvedValue([]);
    expect(await consultAdopterAccountByDni("org-1", "user-1", "30111223")).toBeNull();
    expect(logPii).toHaveBeenCalledWith("user-1", hashDni("30111223"), 0, "adopter_dni_check", {
      organization_id: "org-1",
    });
  });

  it("over the ceiling: refused before the read, nothing logged", async () => {
    enforceRateLimit.mockRejectedValue(new FakeRateLimitError("limit"));
    expect(await consultAdopterAccountByDni("org-1", "user-1", "30111222")).toBe("too_many");
    expect(execute).not.toHaveBeenCalled();
    expect(logPii).not.toHaveBeenCalled();
  });

  it("any other limiter failure propagates (fail closed)", async () => {
    enforceRateLimit.mockRejectedValue(new Error("db down"));
    await expect(consultAdopterAccountByDni("org-1", "user-1", "30111222")).rejects.toThrow(
      "db down",
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("the raw DNI lookup has no other door", () => {
  function walk(dir: string, out: string[]): void {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
  }

  it("no source outside adopter-dni-consult.ts names a DNI-keyed profile lookup", () => {
    const root = process.cwd();
    const files: string[] = [];
    for (const d of ["app", "lib", "src"]) walk(join(root, d), files);
    const offenders = files
      .map((f) => relative(root, f).split(sep).join("/"))
      .filter((f) => f !== "src/modules/adoption/infrastructure/adopter-dni-consult.ts")
      .filter((f) =>
        /findAdopterAccountByDni|findStubAdopterByDni/.test(readFileSync(join(root, f), "utf8")),
      );
    expect(offenders).toEqual([]);
    expect(files.length).toBeGreaterThan(500);
  });
});
