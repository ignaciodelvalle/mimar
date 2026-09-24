// `completeIdentityForUser` — the act, with no transport in it.
//
// WHAT THIS FILE IS FOR
// ---------------------------------------------------------------------------
// The route test mocks this function, so nothing there exercises the RULES. Two
// surfaces now write `profiles.display_name` through it — the web's server action
// and `POST /api/v1/me/identity` — and every property that used to be an argument
// in `completeIdentityAction`'s docblock is now a property of THIS function:
//
//   · both halves required, trimmed and SHAPE-checked, judged by the contract's
//     own schema (no `\p{C}`, at least one `\p{L}`);
//   · ONE TRANSACTION carrying the prior-name read, the UPDATE and the audit
//     row — never a rename with no record of it, because
//     `lib/infra/audit-history-query.ts` renders operator labels from this very
//     column at read time;
//   · `COALESCE` on `tos_accepted_at` AND the matching `CASE` on `tos_version`,
//     so a retry after a `LEGAL_VERSION` bump cannot record the pair (original
//     instant, new version);
//   · a name that would leave `isIdentityPending` true is REFUSED, not stored;
//   · every driver failure collapses into ONE arm, which is the DNI-enumeration
//     defence (audit 28-#3) and not laziness;
//   · the fresh `MeV1User` comes from the UPDATE's own `RETURNING`, not from a
//     follow-up read that could observe a different row.
//
// Mocked at the driver: what is under test is the SQL this builds and the
// decisions around it, and a live version would need a seeded account per case on
// a shared Supabase.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  /** Every `.set()` payload, in order — two calls have to be comparable. */
  sets: [] as Array<Record<string, unknown>>,
  where: null as unknown,
  /** What the prior-name read answers. `[]` means "no such profile row". */
  current: [{ displayName: "ana.perez" }] as unknown[],
  returning: [] as unknown[],
  throwOnReturning: null as null | (() => never),
  throwOnAudit: null as null | (() => never),
  audit: [] as unknown[],
  calls: 0,
  rolledBack: false,
}));

vi.mock("@/db", () => {
  const tx = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => control.current }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        control.calls += 1;
        control.sets.push(values);
        return {
          where: (clause: unknown) => {
            control.where = clause;
            return {
              returning: async () => {
                control.throwOnReturning?.();
                return control.returning;
              },
            };
          },
        };
      },
    }),
    insert: () => ({
      values: (values: unknown) => ({
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
      // A REAL ROLLBACK IS NOT SIMULATED — nothing here is a database — but the
      // BOUNDARY is: anything thrown inside the callback propagates out of
      // `transaction`, and `rolledBack` records that the writer's work was
      // abandoned rather than half-committed. That is the property the
      // audit-failure case below turns on.
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
    },
    auditLog: {},
  };
});

import { completeIdentityForUser } from "@/src/modules/auth/application/complete-identity-for-user";

const USER_ID = "0f3f2e4a-2222-4222-8222-abcdefabcdef";
const EMAIL = "ana.perez@example.com";

/** What the UPDATE hands back for a completed row. */
const ROW = { displayName: "Ana Pérez", role: "owner", accountType: "personal" } as const;

// BUILT FROM CODE POINTS, NEVER TYPED. A zero-width space pasted into this file
// would be invisible in every diff and every review of it — which is the exact
// defect under test, reproduced in the test's own source. `String.fromCharCode`
// rather than a `\u` escape so no tool between here and the file can normalise
// it back into the character.
/** U+200B ZERO WIDTH SPACE — one character long, and `String.trim()` keeps it. */
const ZERO_WIDTH = String.fromCharCode(0x200b);
/** U+202E RIGHT-TO-LEFT OVERRIDE — renders everything after it reversed. */
const RTL_OVERRIDE = String.fromCharCode(0x202e);

function run(overrides: Partial<Parameters<typeof completeIdentityForUser>[0]> = {}) {
  return completeIdentityForUser({
    userId: USER_ID,
    email: EMAIL,
    firstName: "Ana",
    lastName: "Pérez",
    ...overrides,
  });
}

/** The single `.set()` payload of a run that made exactly one write. */
function onlySet(): Record<string, unknown> {
  expect(control.sets).toHaveLength(1);
  return control.sets[0] as Record<string, unknown>;
}

beforeEach(() => {
  control.sets = [];
  control.where = null;
  control.current = [{ displayName: "ana.perez" }];
  control.returning = [ROW];
  control.throwOnReturning = null;
  control.throwOnAudit = null;
  control.audit = [];
  control.calls = 0;
  control.rolledBack = false;
});

describe("completeIdentityForUser — the happy path", () => {
  it("stores the two halves joined by a single space", async () => {
    const result = await run();

    expect(result).toEqual({
      ok: true,
      user: {
        profilePending: false,
        id: USER_ID,
        displayName: "Ana Pérez",
        role: "owner",
        accountType: "personal",
      },
    });
    expect(onlySet().displayName).toBe("Ana Pérez");
  });

  it("trims each half before joining", async () => {
    await run({ firstName: "  Ana  ", lastName: "  Pérez  " });
    expect(onlySet().displayName).toBe("Ana Pérez");
  });

  it("writes exactly ONE update statement", async () => {
    await run();
    // The name, the consent stamp and (when present) the DNI go together. Two
    // writes would leave a window in which one landed and the other did not.
    expect(control.calls).toBe(1);
  });

  it("records the consent version and the instant UNDER THE SAME CONDITION", async () => {
    await run();
    const set = onlySet();

    // NEITHER IS A PLAIN JS VALUE. `tosAcceptedAt` is COALESCE'd so a retry keeps
    // the ORIGINAL instant (Ley 25.326 art. 5) — and `tosVersion` used to be a
    // bare `LEGAL_VERSION` string beside it, so a second call after a version
    // bump recorded (original instant, NEW version): a row asserting somebody
    // accepted a document that did not exist when they accepted. Both are SQL
    // now, keyed on the same `tos_accepted_at IS NULL`.
    expect(set.tosAcceptedAt).not.toBeInstanceOf(Date);
    expect(typeof set.tosAcceptedAt).not.toBe("string");
    expect(set.tosVersion).not.toBeInstanceOf(Date);
    expect(typeof set.tosVersion).not.toBe("string");
    expect(set.updatedAt).toBeInstanceOf(Date);
  });

  it("reports the user built from the row the UPDATE returned, not from its input", async () => {
    // A concurrent writer moved the row. The answer must describe what is stored,
    // which is the whole reason this uses RETURNING instead of trusting its own
    // arithmetic.
    control.returning = [{ displayName: "Ana Pérez", role: "vet", accountType: "institutional" }];

    const result = await run();

    expect(result).toEqual({
      ok: true,
      user: {
        profilePending: false,
        id: USER_ID,
        displayName: "Ana Pérez",
        role: "vet",
        accountType: "institutional",
      },
    });
  });
});

describe("completeIdentityForUser — the audit row", () => {
  it("writes profile_self_updated with the prior name as `before`", async () => {
    // `lib/infra/audit-history-query.ts` resolves the actor labels in
    // /gob/historial from `profiles.display_name` at READ time, so a rename
    // relabels that person's past rows. This row is the only record of what the
    // label used to be.
    await run();

    expect(control.audit).toHaveLength(1);
    const values = control.audit[0] as Record<string, unknown>;
    expect(values.action).toBe("profile_self_updated");
    expect(values.actorUserId).toBe(USER_ID);
    expect(values.targetUserId).toBe(USER_ID);
    expect(values.payload).toMatchObject({
      changed_fields: ["displayName"],
      via: "identity_completion",
      before_values: { displayName: "ana.perez" },
      after_values: { displayName: "Ana Pérez" },
    });
  });

  it("reports NO changed field when the stored name already matched", async () => {
    control.current = [{ displayName: "Ana Pérez" }];

    await run();

    const values = control.audit[0] as { payload: Record<string, unknown> };
    expect(values.payload.changed_fields).toEqual([]);
  });

  it("carries no DNI, in any form, even when one was written", async () => {
    await run({ dni: "30111222" });

    // `audit_log.payload` is free-form jsonb that operators read in
    // /gob/historial. A DNI there is plaintext PII on the exact surface the
    // hashing exists to keep it off (invariant #5).
    const serialised = JSON.stringify(control.audit[0]);
    expect(serialised).not.toContain("30111222");
    expect(serialised).not.toContain("dni");
  });

  it("ROLLS THE RENAME BACK when the audit row cannot be written", async () => {
    control.throwOnAudit = () => {
      throw new Error("audit_log unavailable");
    };

    const result = await run();

    // The direction is the intended one: `writeAuditLog` does not swallow its
    // errors, and a display name changed with no record of the change is exactly
    // the state this transaction exists to make impossible.
    expect(result).toEqual({ ok: false, error: "WRITE_FAILED" });
    expect(control.rolledBack).toBe(true);
  });
});

describe("completeIdentityForUser — the DNI", () => {
  it("writes no DNI columns when none is given — the native step's shape", async () => {
    await run();

    expect(onlySet()).not.toHaveProperty("dniHash");
    expect(onlySet()).not.toHaveProperty("dniLast4");
  });

  it("hashes the DNI and keeps only the last four in the clear", async () => {
    await run({ dni: "30123456" });
    const set = onlySet();

    expect(set.dniLast4).toBe("3456");
    expect(typeof set.dniHash).toBe("string");
    // Invariant #5: no DNI in plaintext, anywhere, ever.
    expect(JSON.stringify(set)).not.toContain("30123456");
  });

  it("treats an empty DNI as absent rather than as a value to hash", async () => {
    await run({ dni: "" });
    expect(onlySet()).not.toHaveProperty("dniHash");
  });
});

describe("completeIdentityForUser — idempotence", () => {
  it("writes the SAME payload twice and answers the same both times", async () => {
    // NOT a tautology over one fixture: the two `.set()` payloads are compared to
    // EACH OTHER, and the call counter proves two writes really happened. What
    // this pins is that a second identical call carries no drifting field — the
    // one that used to drift is `tosVersion`, which was a bare `LEGAL_VERSION`
    // and is now conditional SQL like its timestamp.
    const first = await run();
    const second = await run();

    expect(control.calls).toBe(2);
    expect(second).toEqual(first);
    expect(control.sets).toHaveLength(2);
    const [a, b] = control.sets as [Record<string, unknown>, Record<string, unknown>];
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.displayName).toBe(b.displayName);
    // `updatedAt` is the one field that MUST differ run to run; everything else
    // is compared by its serialised form, which is what "the same write twice"
    // means for a payload carrying SQL fragments.
    expect(JSON.stringify({ ...a, updatedAt: null })).toBe(
      JSON.stringify({ ...b, updatedAt: null }),
    );
  });
});

describe("completeIdentityForUser — the refusals", () => {
  it.each([
    ["an empty first name", { firstName: "" }, "firstName", "FIRST_NAME_REQUIRED"],
    ["a whitespace-only first name", { firstName: "   " }, "firstName", "FIRST_NAME_REQUIRED"],
    ["an empty last name", { lastName: "" }, "lastName", "LAST_NAME_REQUIRED"],
    ["a first name past the bound", { firstName: "A".repeat(200) }, "firstName", "NAME_TOO_LONG"],
    ["a last name past the bound", { lastName: "P".repeat(200) }, "lastName", "NAME_TOO_LONG"],
    ["a zero-width first name", { firstName: ZERO_WIDTH }, "firstName", "NAME_INVALID"],
    [
      "a zero-width space INSIDE a name",
      { firstName: `An${ZERO_WIDTH}a` },
      "firstName",
      "NAME_INVALID",
    ],
    [
      "a bidi override in the surname",
      { lastName: `P${RTL_OVERRIDE}rez` },
      "lastName",
      "NAME_INVALID",
    ],
    ["a newline in the surname", { lastName: "Pe\nrez" }, "lastName", "NAME_INVALID"],
    ["a digits-only first name", { firstName: "12345" }, "firstName", "NAME_INVALID"],
  ])("refuses %s and writes nothing", async (_label, overrides, field, code) => {
    const result = await run(overrides);

    expect(result).toEqual({ ok: false, error: "VALIDATION", field, code });
    expect(control.calls).toBe(0);
    expect(control.audit).toHaveLength(0);
  });

  it("refuses a name that would STILL read as the email local part", async () => {
    // Reached through a quoted local part, which is a legal address. The stored
    // value would satisfy `isIdentityPending`, so a 200 here would hand a client
    // `profilePending: false` that `/me` contradicts on the next cold start.
    // The quotes are PART OF the local part — `emailLocalPart` splits on the
    // first `@` and keeps everything before it verbatim — so the two halves have
    // to carry them for the joined name to collide with it. That is what makes
    // this the one reachable shape of the refusal, and why it looks odd.
    const result = await completeIdentityForUser({
      userId: USER_ID,
      email: '"ana perez"@example.com',
      firstName: '"ana',
      lastName: 'perez"',
    });

    expect(result).toEqual({ ok: false, error: "STILL_PROVISIONAL" });
    expect(control.calls).toBe(0);
  });

  it("does NOT refuse a real name that merely shares a prefix with the address", async () => {
    const result = await run({ firstName: "Ana", lastName: "Perez" });
    expect(result.ok).toBe(true);
  });

  it("collapses every driver failure into one arm — the DNI-enumeration defence", async () => {
    control.throwOnReturning = () => {
      throw Object.assign(new Error("duplicate key value"), { code: "23505" });
    };

    const result = await run({ dni: "30123456" });

    // Byte-identical to any other write failure. A distinct message would confirm
    // to an authenticated attacker which DNIs already exist (audit 28-#3); the
    // duplicate is still prevented by `profiles_dni_hash_unique`.
    expect(result).toEqual({ ok: false, error: "WRITE_FAILED" });
    expect(control.audit).toHaveLength(0);
  });

  it("refuses when the profile row is gone, rather than projecting an undefined row", async () => {
    control.current = [];

    const result = await run();

    expect(result).toEqual({ ok: false, error: "WRITE_FAILED" });
    expect(control.calls).toBe(0);
  });

  it("refuses when the UPDATE matched nothing after the read found a row", async () => {
    control.returning = [];

    const result = await run();

    expect(result).toEqual({ ok: false, error: "WRITE_FAILED" });
    expect(control.audit).toHaveLength(0);
  });
});
