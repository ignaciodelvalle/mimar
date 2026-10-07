// `acceptLegalTermsForUser` — an existing account accepts the current legal
// version (2026-10-07; legal review 2026-10-02 rows P10/P11/D5; PO decision
// D2 = b, conservative interim).
//
// WHAT THIS FILE PROVES
//   · the acceptance is RECORDED WITH ITS VERSION: one UPDATE writing
//     `tos_version = LEGAL_VERSION` and a fresh `tos_accepted_at`, and one
//     audit row, in the same transaction, carrying the acceptance it replaced;
//   · each of the three boxes is required, and a client that displayed another
//     version is refused before anything is written;
//   · an account already on the current version is answered with no write and
//     no audit row (a retried lost response must not claim a second acceptance);
//   · a failed audit row rolls the acceptance back.
//
// Mocked at the driver, like complete-identity-for-user.test.ts and for the
// same reason: what is under test is the write this builds and the decisions
// around it; a live version would need a seeded account per case on a shared
// Supabase, and an audit row a teardown cannot delete.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  sets: [] as Array<Record<string, unknown>>,
  current: [] as unknown[],
  returning: [] as unknown[],
  throwOnAudit: null as null | (() => never),
  audit: [] as Array<Record<string, unknown>>,
  rolledBack: false,
}));

vi.mock("@/db", () => {
  const tx = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => control.current }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        control.sets.push(values);
        return { where: () => ({ returning: async () => control.returning }) };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          control.throwOnAudit?.();
          control.audit.push(values);
          return [{ id: "audit-0001" }];
        },
      }),
    }),
  };
  return {
    db: {
      transaction: async (fn: (t: unknown) => Promise<unknown>) => {
        try {
          return await fn(tx);
        } catch (err) {
          control.rolledBack = true;
          throw err;
        }
      },
    },
    profiles: {
      id: { name: "id" },
      displayName: { name: "display_name" },
      role: { name: "role" },
      accountType: { name: "account_type" },
      tosAcceptedAt: { name: "tos_accepted_at" },
      tosVersion: { name: "tos_version" },
      updatedAt: { name: "updated_at" },
    },
    auditLog: {},
  };
});

import { LEGAL_VERSION } from "@/lib/reference/legal-version";
import { acceptLegalTermsForUser } from "@/src/modules/auth/application/accept-legal-terms";

const USER_ID = "0f3f2e4a-2222-4222-8222-abcdefabcdef";
const EMAIL = "ana.perez@example.com";
const ORIGINAL = new Date("2026-09-25T12:00:00.000Z");

const OWES = {
  displayName: "Ana Pérez",
  role: "owner",
  accountType: "personal",
  tosAcceptedAt: ORIGINAL,
  tosVersion: "2026-09-24",
} as const;

function run(overrides: Partial<Parameters<typeof acceptLegalTermsForUser>[0]> = {}) {
  return acceptLegalTermsForUser({
    userId: USER_ID,
    email: EMAIL,
    tosAccepted: true,
    transferAccepted: true,
    adultDeclared: true,
    legalVersion: LEGAL_VERSION,
    ...overrides,
  });
}

beforeEach(() => {
  control.sets = [];
  control.current = [OWES];
  control.returning = [{ ...OWES, tosAcceptedAt: new Date(), tosVersion: LEGAL_VERSION }];
  control.throwOnAudit = null;
  control.audit = [];
  control.rolledBack = false;
});

describe("the version under test", () => {
  it("is the 2026-10-07 interim (written out, so a bump is a deliberate edit here)", () => {
    expect(LEGAL_VERSION).toBe("2026-10-07");
  });
});

describe("recording", () => {
  it("writes the CURRENT version and a fresh instant, in one UPDATE", async () => {
    const before = Date.now();
    const result = await run();

    expect(result.ok).toBe(true);
    expect(control.sets).toHaveLength(1);
    const set = control.sets[0] as { tosVersion: unknown; tosAcceptedAt: unknown };
    expect(set.tosVersion).toBe("2026-10-07");
    expect(set.tosAcceptedAt).toBeInstanceOf(Date);
    expect((set.tosAcceptedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("writes ONE audit row that keeps the acceptance it replaced", async () => {
    await run();

    expect(control.audit).toHaveLength(1);
    const row = control.audit[0] as {
      action: string;
      actorUserId: string;
      targetUserId: string;
      payload: Record<string, unknown>;
    };
    expect(row.action).toBe("profile_self_updated");
    expect(row.actorUserId).toBe(USER_ID);
    expect(row.targetUserId).toBe(USER_ID);
    expect(row.payload.via).toBe("legal_reacceptance");
    expect(row.payload.boxes).toEqual([
      "terms_privacy",
      "international_transfer",
      "adult_declaration",
    ]);
    expect(row.payload.before_values).toEqual({
      tosAcceptedAt: ORIGINAL.toISOString(),
      tosVersion: "2026-09-24",
    });
    expect((row.payload.after_values as { tosVersion: string }).tosVersion).toBe("2026-10-07");
  });

  it("hands back a user that no longer owes an acceptance", async () => {
    const result = await run();
    expect(result.ok && result.user).toEqual({
      profilePending: false,
      id: USER_ID,
      displayName: "Ana Pérez",
      role: "owner",
      accountType: "personal",
    });
    expect(result.ok && result.recorded).toBe(true);
  });
});

describe("refusals", () => {
  it.each([["tosAccepted"], ["transferAccepted"], ["adultDeclared"]] as const)(
    "refuses when %s is false, and writes nothing",
    async (field) => {
      const result = await run({ [field]: false });
      expect(result).toEqual({ ok: false, error: "NOT_ACCEPTED" });
      expect(control.sets).toEqual([]);
      expect(control.audit).toEqual([]);
    },
  );

  it("refuses a client that displayed another version, and writes nothing", async () => {
    // Recording the current version for it would be a consent to a text it
    // never showed; recording its own would leave the person on the gate.
    for (const legalVersion of ["2026-09-24", "2099-01-01", ""]) {
      expect(await run({ legalVersion })).toEqual({ ok: false, error: "VERSION_MISMATCH" });
    }
    expect(control.sets).toEqual([]);
  });

  it("rolls the acceptance back when the audit row fails", async () => {
    control.throwOnAudit = () => {
      throw new Error("audit insert refused");
    };
    expect(await run()).toEqual({ ok: false, error: "WRITE_FAILED" });
    expect(control.rolledBack).toBe(true);
  });

  it("answers WRITE_FAILED for a missing profile row", async () => {
    control.current = [];
    expect(await run()).toEqual({ ok: false, error: "WRITE_FAILED" });
    expect(control.sets).toEqual([]);
  });
});

describe("idempotence", () => {
  it("answers an account already on the current version with NO write and NO audit row", async () => {
    control.current = [{ ...OWES, tosVersion: LEGAL_VERSION }];
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.ok && result.recorded).toBe(false);
    expect(control.sets).toEqual([]);
    expect(control.audit).toEqual([]);
  });
});
