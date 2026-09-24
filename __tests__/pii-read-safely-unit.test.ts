// AC2 unit test — logPiiReadSafely never breaks the page render.
//
// The list pages await logPiiReadSafely to log the PII read. If the audit
// insert fails (DB hiccup, constraint, etc.) the render must STILL complete:
// the wrapper logs to console.error and swallows the error rather than letting
// it propagate. We mock @/db so the insert throws, with no real DB involved.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the db so `db.insert(...).values(...)` rejects. logPiiReadSafely calls
// logPiiQueryForAuthority → db.insert(auditLog).values({...}).
const insertValues = vi.fn();
vi.mock("@/db", () => ({
  db: { insert: () => ({ values: insertValues }) },
  auditLog: {},
}));

import { logPiiReadSafely } from "@/src/modules/organizations/application/admin-proposals/log-pii-query";

describe("logPiiReadSafely — failure path (AC2)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    insertValues.mockReset();
  });

  it("returns false and logs to console.error when the audit insert throws — without rethrowing", async () => {
    insertValues.mockRejectedValueOnce(new Error("insert exploded"));

    // Must NOT throw — the page render survives an audit-log failure.
    const result = await logPiiReadSafely("actor-1", "", 50, "users");

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("pii_queried log failed");
  });

  it("returns true and does not log an error when the insert succeeds", async () => {
    insertValues.mockResolvedValueOnce(undefined);

    const result = await logPiiReadSafely("actor-1", "garcia", 4, "organizations");

    expect(result).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
