// AC2 unit test — logPiiReadSafely never breaks the page render.
//
// The list pages await logPiiReadSafely to log the PII read. If the audit
// insert fails (DB hiccup, constraint, etc.) the render must STILL complete:
// the wrapper logs to console.error and swallows the error rather than letting
// it propagate. We mock @/db so the insert throws, with no real DB involved.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the db so `db.insert(...).values(...)` rejects. logPiiReadSafely calls
// logPiiQueryForAuthority → db.insert(auditLog).values({...}).
const insertValues = vi.fn();
vi.mock("@/db", () => ({
  db: { insert: () => ({ values: insertValues }) },
  auditLog: {},
}));

import { hashDni } from "@/lib/utils/dni-hash";
import { redactDni } from "@/lib/utils/dni-redact";
import {
  logPiiQueryForAuthority,
  logPiiReadSafely,
} from "@/src/modules/organizations/application/admin-proposals/log-pii-query";

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

// Invariant 5 on the audit trail. `audit_log` is append-only, so a DNI typed
// into an operator search and stored as `payload.query` would live forever.
// The writer redacts at the chokepoint; callers still pass the raw text.
describe("logPiiQueryForAuthority — DNI never reaches audit_log (invariant 5)", () => {
  afterEach(() => {
    insertValues.mockReset();
  });

  async function storedPayload(
    query: string,
    surface: Parameters<typeof logPiiQueryForAuthority>[3],
  ) {
    insertValues.mockResolvedValueOnce(undefined);
    await logPiiQueryForAuthority("actor-1", query, 1, surface);
    return insertValues.mock.calls[0][0].payload as Record<string, unknown>;
  }

  it("replaces a plain 8-digit DNI and records its hash + last4", async () => {
    const payload = await storedPayload("30111222", "omnibox");
    expect(payload.query).toBe("[DNI ···1222]");
    expect(payload.dni_hash).toBe(hashDni("30111222"));
    expect(payload.dni_last4).toBe("1222");
    expect(JSON.stringify(payload)).not.toContain("30111222");
  });

  it("replaces a 7-digit DNI", async () => {
    const payload = await storedPayload("9876543", "users");
    expect(payload.query).toBe("[DNI ···6543]");
    expect(payload.dni_hash).toBe(hashDni("9876543"));
    expect(JSON.stringify(payload)).not.toContain("9876543");
  });

  it("replaces a dotted DNI and hashes the digits, not the dots", async () => {
    const payload = await storedPayload("12.345.678", "users");
    expect(payload.query).toBe("[DNI ···5678]");
    expect(payload.dni_hash).toBe(hashDni("12345678"));
    expect(JSON.stringify(payload)).not.toContain("12.345.678");
    expect(JSON.stringify(payload)).not.toContain("12345678");
  });

  it("redacts a DNI embedded in surrounding text and keeps the rest", async () => {
    const payload = await storedPayload("garcia dni 27.456.789 vecino", "organizations");
    expect(payload.query).toBe("garcia dni [DNI ···6789] vecino");
    expect(payload.dni_hash).toBe(hashDni("27456789"));
    expect(JSON.stringify(payload)).not.toContain("27456789");
  });

  it("redacts every DNI when several are typed and stores one hash per DNI", async () => {
    const payload = await storedPayload("30111222 y 20.333.444", "omnibox");
    expect(payload.query).toBe("[DNI ···1222] y [DNI ···3444]");
    expect(payload.dni_hashes).toEqual([hashDni("30111222"), hashDni("20333444")]);
    expect(payload).not.toHaveProperty("dni_hash");
  });

  it("leaves non-DNI queries untouched, with no dni keys", async () => {
    const queries = [
      "garcia",
      "",
      "DIM-TEST-0001",
      "CAS-TEST-0001",
      "1234567890123",
      "123456",
      "11-4567-8901",
    ];
    for (const q of queries) {
      const payload = await storedPayload(q, "users");
      expect(payload.query).toBe(q);
      expect(payload).not.toHaveProperty("dni_hash");
      expect(payload).not.toHaveProperty("dni_hashes");
      expect(payload).not.toHaveProperty("dni_last4");
      insertValues.mockReset();
    }
  });

  it("keeps result_count, surface and extra keys alongside the redacted query", async () => {
    insertValues.mockResolvedValueOnce(undefined);
    await logPiiQueryForAuthority("actor-1", "30111222", 3, "omnibox", {
      organization_id: "org-1",
    });
    expect(insertValues.mock.calls[0][0]).toMatchObject({
      actorUserId: "actor-1",
      action: "pii_queried",
      payload: { result_count: 3, surface: "omnibox", organization_id: "org-1" },
    });
  });

  it("does not touch the adopter desk check, whose query is already the DNI HMAC", async () => {
    // A hex digest can hold a 7-8 digit run; rewriting it would corrupt the key.
    const hashed = `ab${"12345678"}cd${"0".repeat(52)}`;
    const payload = await storedPayload(hashed, "adopter_dni_check");
    expect(payload.query).toBe(hashed);
    expect(payload).not.toHaveProperty("dni_hash");
  });

  it("still writes the row (redacted, unhashed) when the pepper is unusable", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("DNI_HASH_PEPPER", undefined);
    try {
      const payload = await storedPayload("30111222", "omnibox");
      expect(payload.query).toBe("[DNI ···1222]");
      expect(payload).not.toHaveProperty("dni_hash");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("logPiiReadSafely goes through the same redaction", async () => {
    insertValues.mockResolvedValueOnce(undefined);
    await logPiiReadSafely("actor-1", "30.111.222", 1, "users");
    const payload = insertValues.mock.calls[0][0].payload as Record<string, unknown>;
    expect(payload.query).toBe("[DNI ···1222]");
  });
});

describe("redactDni", () => {
  it("does not split a longer digit run or match shorter ones", () => {
    expect(redactDni("123456789").dnis).toEqual([]);
    expect(redactDni("123456").dnis).toEqual([]);
    expect(redactDni("1.234.567").dnis).toEqual(["1234567"]);
  });
});

// Cheap guard against a bypass: every writer of a `pii_queried` row either goes
// through the redacting chokepoint or stores structured filters (never typed
// text). A NEW writer fails here until someone decides which of the two it is.
describe("pii_queried writers — the set is pinned", () => {
  const ROOTS = ["app", "lib", "src"];
  const KNOWN_WRITERS = [
    "lib/infra/outreach-pipelines.ts", // pipeline + zone only
    "lib/metrics/alert-firing-inbox.ts", // structured filters only
    "lib/metrics/event-ledger.ts", // structured filters only
    "src/modules/organizations/application/admin-proposals/log-pii-query.ts", // the chokepoint
  ];

  function walk(dir: string, out: string[]) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === "__tests__") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(full);
    }
  }

  it("finds exactly the known writers", () => {
    const files: string[] = [];
    for (const r of ROOTS) walk(path.resolve(process.cwd(), r), files);
    const writers = files
      .filter((f) => /action:\s*"pii_queried"/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(process.cwd(), f).split(path.sep).join("/"))
      .sort();
    expect(writers).toEqual(KNOWN_WRITERS);
  });
});
