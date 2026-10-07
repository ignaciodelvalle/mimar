// `acceptLegalTermsForUser` against the REAL database (security review of
// textos-legales-v14, finding 7): when the audit row cannot be written, the
// re-acceptance must roll back — the profile keeps the acceptance it had, and
// no row claims a newer one. No `@/db` mock: only the audit writer is made to
// fail, so the UPDATE runs for real inside the real transaction.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infra/audit-log", () => ({
  writeAuditLog: async () => {
    throw new Error("audit_log unavailable");
  },
}));

import { db, profiles } from "@/db";
import { LEGAL_VERSION } from "@/lib/reference/legal-version";
import { acceptLegalTermsForUser } from "@/src/modules/auth/application/accept-legal-terms";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const supabaseAdmin = createSupabaseClient(
  "http://127.0.0.1:54321",
  "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz",
  { auth: { persistSession: false } },
);

const EMAIL = "legal-rollback@dim-test.local";
const ORIGINAL_AT = new Date("2026-09-25T12:00:00.000Z");
let userId: string;

beforeAll(async () => {
  const created = await createFreshTestUser(supabaseAdmin, {
    email: EMAIL,
    password: "LegalRollback_2026!",
    email_confirm: true,
    user_metadata: { display_name: "Rocío Prueba" },
  });
  if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
  userId = created.data.user.id;
  await db
    .update(profiles)
    .set({ displayName: "Rocío Prueba", tosAcceptedAt: ORIGINAL_AT, tosVersion: "2026-09-24" })
    .where(eq(profiles.id, userId));
});

afterAll(async () => {
  // No audit row was ever committed for this account, so it can be removed.
  if (userId) await supabaseAdmin.auth.admin.deleteUser(userId);
});

describe("acceptLegalTermsForUser — a failed audit row rolls the acceptance back", () => {
  it("answers WRITE_FAILED and leaves the previous acceptance untouched", async () => {
    const result = await acceptLegalTermsForUser({
      userId,
      email: EMAIL,
      tosAccepted: true,
      transferAccepted: true,
      adultDeclared: true,
      legalVersion: LEGAL_VERSION,
    });
    expect(result).toEqual({ ok: false, error: "WRITE_FAILED" });

    const [row] = await db
      .select({ tosAcceptedAt: profiles.tosAcceptedAt, tosVersion: profiles.tosVersion })
      .from(profiles)
      .where(eq(profiles.id, userId));
    expect(row?.tosVersion).toBe("2026-09-24");
    expect(row?.tosAcceptedAt?.toISOString()).toBe(ORIGINAL_AT.toISOString());
  });
});
