// Anti-loop guard for the two-step signup (FIX #2 / QA 2026-07-10).
//
// Bug: with email confirmation ON, step 1's signUp returns NO session, so step 2
// (completeIdentityAction) found no user and silently redirect("/signup")'d back
// to step 1 — a silent loop that also discarded the typed name.
//
// PO decision (2026-07-10): confirmations stay OFF (single-step signup, no
// verification). Regardless of posture, step 2 must fail HONESTLY when there is
// no session instead of silently looping. These tests pin that contract:
//   - no session  → an honest error state (no redirect), name echoed, no write.
//   - has session → the profile UPDATE runs and the happy path returns ok:true.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
const mockWhere = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: (...args: unknown[]) => mockGetUser(...args),
    },
  })),
}));

// A TRANSACTION SINCE 2026-09-05, and the extra links are not decoration. The
// act moved into `completeIdentityForUser`, which now (a) reads the prior name so
// the audit row has a `before`, (b) ends its UPDATE in a `RETURNING` because its
// other caller (`POST /api/v1/me/identity`) answers with the fresh `MeV1User`,
// and (c) writes a `profile_self_updated` row in the same transaction —
// `lib/infra/audit-history-query.ts` renders operator labels from
// `profiles.display_name` at READ time, so a rename retroactively relabels
// history and has to leave a trail.
//
// `mockWhere` still records the UPDATE, which is what both assertions below turn
// on: no write attempted on the no-session path, exactly one on the happy path.
vi.mock("@/db", () => {
  const tx = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ displayName: "ana.perez" }] }) }),
    }),
    update: () => ({
      set: () => ({
        where: (...args: unknown[]) => {
          mockWhere(...args);
          return {
            returning: async () => [
              { displayName: "Ana Pérez", role: "owner", accountType: "personal" },
            ],
          };
        },
      }),
    }),
    insert: () => ({ values: () => ({ returning: async () => [{ id: "audit-0001" }] }) }),
  };
  return {
    db: { transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) },
    profiles: {},
    auditLog: {},
  };
});

// Fail the test loudly if the production code ever reaches for a redirect again —
// the honest-failure contract must NOT bounce the user back to step 1.
const mockRedirect = vi.fn((..._args: unknown[]) => {
  throw new Error("redirect() must not be called by completeIdentityAction");
});
vi.mock("next/navigation", () => ({ redirect: (...args: unknown[]) => mockRedirect(...args) }));

import { completeIdentityAction } from "@/app/actions/auth";

function identityForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("firstName", "Ana");
  fd.set("lastName", "Pérez");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("completeIdentityAction — no-session anti-loop guard", () => {
  it("returns an honest error (no redirect, no write) when there is no session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const result = await completeIdentityAction({ error: null }, identityForm());

    // Honest, actionable message — never a silent bounce to step 1.
    expect(result.error).toMatch(/no pudimos activar tu sesión|iniciá sesión/i);
    // AND IT MUST NOT MENTION CONFIRMING AN EMAIL (2026-09-05). Confirmations
    // have been OFF since the PO decided it on 2026-07-10, and the old sentence
    // hedged about them anyway — testers read the hedge as an instruction, went
    // looking for a mail that is never sent, and some created a second account
    // instead. A conditional about a switched-off feature is a wrong instruction
    // with a "si" in front of it. If confirmations are ever turned on, this
    // assertion is one of the things that has to change with them.
    expect(result.error).not.toMatch(/confirmar tu correo|casilla|spam/i);
    expect(result.ok).toBeUndefined();
    // The typed name survives (echoed back so the React 19 form reset lands on it).
    expect(result.firstName).toBe("Ana");
    expect(result.lastName).toBe("Pérez");
    // No profile write and no redirect were attempted.
    expect(mockWhere).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("writes the profile and returns ok when a session is present (happy path)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-0001" } } });
    mockWhere.mockResolvedValue(undefined);

    const result = await completeIdentityAction({ error: null }, identityForm());

    expect(result).toEqual({ error: null, ok: true });
    // Step 2 overwrites the provisional (email-derived) display_name with the real one.
    expect(mockWhere).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
