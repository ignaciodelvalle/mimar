// Signup step 2 against the REAL database (re-review of textos-legales-v14,
// item 4): the acceptance audit row reads what step 1 left in auth.users
// app_metadata (`tos_boxes`, `tos_ticked_at`) through the raw subquery in
// complete-identity-for-user.ts — something a mocked `@/db` cannot exercise —
// and an account that accepted an OLDER version comes out of step 2 refused by
// the live-user guard with LEGAL_ACCEPTANCE_REQUIRED (real getProfileCached).
//
// Only the cookie Supabase client is faked, to name the caller; every read and
// write goes to the database.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: control.user }, error: null }),
      getSession: async () => ({ data: { session: null }, error: null }),
    },
  }),
}));

import { auditLog, db } from "@/db";
import { requireLiveUser } from "@/lib/infra/live-user";
import { completeIdentityForUser } from "@/src/modules/auth/application/complete-identity-for-user";
import { createFreshTestUser, deleteTestUser } from "./_helpers/fresh-test-user";

const supabaseAdmin = createSupabaseClient(
  "http://127.0.0.1:54321",
  "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz",
  { auth: { persistSession: false } },
);

const EMAIL = "signup-legal-audit@dim-test.local";
const TICKED_AT = "2026-10-07T10:00:00.000Z";
let userId: string;

beforeAll(async () => {
  const created = await createFreshTestUser(
    supabaseAdmin,
    {
      email: EMAIL,
      password: "SignupLegalAudit_2026!",
      email_confirm: true,
      // What signup step 1 records (consent-version-recorder.ts): a client that
      // displayed the PREVIOUS version and ticked the two newer boxes.
      app_metadata: {
        tos_version: "2026-09-24",
        tos_boxes: { transfer: true, adult: true },
        tos_ticked_at: TICKED_AT,
      },
    },
    { legalAcceptance: "none" },
  );
  if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
  userId = created.data.user.id;
  control.user = { id: userId, email: EMAIL };
});

afterAll(async () => {
  // The audit row is append-only, so this soft-deactivates the profile when the
  // delete is blocked (see deleteTestUser).
  await deleteTestUser(supabaseAdmin, db, EMAIL);
});

describe("signup step 2 on the real database", () => {
  it("records the acceptance with the boxes and tick time step 1 left in app_metadata", async () => {
    const result = await completeIdentityForUser({
      userId,
      email: EMAIL,
      firstName: "Sofía",
      lastName: "Prueba",
    });
    expect(result.ok).toBe(true);

    const rows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetUserId, userId),
          sql`${auditLog.payload}->>'via' = 'signup_legal_acceptance'`,
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      tos_version: "2026-09-24",
      boxes: { terms_privacy: true, international_transfer: true, adult_declaration: true },
      ticked_at: TICKED_AT,
    });
  });

  it("leaves the account refused by the live-user guard until it accepts the current version", async () => {
    const live = await requireLiveUser();
    expect(live.ok).toBe(false);
    if (live.ok) return;
    expect(live.reason).toBe("LEGAL_ACCEPTANCE_REQUIRED");
  });
});
