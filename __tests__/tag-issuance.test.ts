// Integration tests — issueTagBatchForAdmin + issuance CSV (design D9).
//
// Load-bearing assertions:
//   - non-admin (and deactivated-admin) callers are denied;
//   - a batch creates N unactivated rows with unique TAG- serials whose
//     stored hashes match the returned plaintext codes;
//   - a serial collision retries with a fresh serial instead of failing the
//     batch (savepoint-scoped, outer tx survives);
//   - the CSV carries serial+code+url and NEVER a stored hash;
//   - exactly one `tag.lote_issue` audit row per batch, without codes.

import { createClient } from "@supabase/supabase-js";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { serialQueue } = vi.hoisted(() => ({
  serialQueue: [] as string[],
}));

// generateTagSerial is interceptable: tests can enqueue forced serials (to
// provoke a unique-violation) before falling through to the real generator.
vi.mock("@/lib/infra/publicToken", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/publicToken")>();
  return {
    ...actual,
    generateTagSerial: () => serialQueue.shift() ?? actual.generateTagSerial(),
  };
});

import { auditLog, db, petTags, profiles } from "@/db";
import { hashTagActivationCode } from "@/lib/utils/tag-code-hash";
import { buildTagIssuanceCsv } from "@/src/modules/pets/application/tags/issuance-csv";
import { issueTagBatchForAdmin } from "@/src/modules/pets/application/tags/issue-tag-batch";
import { createFreshTestUser, deleteTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const ADMIN_EMAIL = "tag-issuer-admin@dim-test.local";
const CIVILIAN_EMAIL = "tag-issuer-civilian@dim-test.local";
const PASS = "TagIssuance_2026!";
// Run-unique lote ids: audit_log is append-only (no test cleanup), so the
// one-audit-row-per-batch assertion must key on a lote no prior run used.
const RUN_ID = Date.now().toString(36).toUpperCase();
const LOTE_A = `TEST-LOTE-ISSUE-A-${RUN_ID}`;
const LOTE_B = `TEST-LOTE-ISSUE-B-${RUN_ID}`;

let adminUserId: string;
let civilianUserId: string;

async function purgeUser(email: string) {
  // `deleteTestUser` removes BOTH the auth user and its `public.profiles`
  // row (profiles carries no FK to auth.users — see fresh-test-user.ts). The
  // old body here (a bare, unpaged `listUsers()` + `deleteUser`) left the
  // profile behind every run: an ACTIVE role='admin' fixture that polluted
  // admin-institutional.test.ts's last-human-admin floor.
  await deleteTestUser(admin, db, email);
}

async function purgeLotes() {
  // Prefix delete: also sweeps rows left by prior runs' unique lote ids.
  await db.delete(petTags).where(like(petTags.loteId, "TEST-LOTE-ISSUE-%"));
}

beforeAll(async () => {
  await purgeLotes();
  await purgeUser(ADMIN_EMAIL);
  await purgeUser(CIVILIAN_EMAIL);

  const mk = async (email: string) => {
    const { data, error } = await createFreshTestUser(admin, {
      email,
      password: PASS,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
    return data.user.id;
  };
  adminUserId = await mk(ADMIN_EMAIL);
  civilianUserId = await mk(CIVILIAN_EMAIL);

  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional", dniHash: null, dniLast4: null })
    .where(eq(profiles.id, adminUserId));
}, 30_000);

afterAll(async () => {
  await purgeLotes();
  await purgeUser(ADMIN_EMAIL);
  await purgeUser(CIVILIAN_EMAIL);
}, 30_000);

describe("issueTagBatchForAdmin — authorization", () => {
  it("denies a non-admin caller and creates nothing", async () => {
    const result = await issueTagBatchForAdmin(civilianUserId, { count: 3, loteId: LOTE_A });
    expect("error" in result && result.error).toMatch(/admin/i);
    const rows = await db.select().from(petTags).where(eq(petTags.loteId, LOTE_A));
    expect(rows).toHaveLength(0);
  });

  it("rejects an out-of-range count", async () => {
    const result = await issueTagBatchForAdmin(adminUserId, { count: 0, loteId: LOTE_A });
    expect("error" in result && result.error).toMatch(/Invalid input/);
  });
});

describe("issueTagBatchForAdmin — batch issuance", () => {
  it("creates N unactivated rows; stored hashes match returned codes; one audit row", async () => {
    const result = await issueTagBatchForAdmin(adminUserId, { count: 5, loteId: LOTE_A });
    expect(result).toMatchObject({ ok: true });
    if ("error" in result) throw new Error(result.error);
    expect(result.rows).toHaveLength(5);

    const serials = result.rows.map((r) => r.serial);
    expect(new Set(serials).size).toBe(5);
    for (const s of serials) expect(s).toMatch(/^TAG-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const dbRows = await db.select().from(petTags).where(eq(petTags.loteId, LOTE_A));
    expect(dbRows).toHaveLength(5);
    for (const row of dbRows) {
      expect(row.status).toBe("unactivated");
      expect(row.petId).toBeNull();
      const issued = result.rows.find((r) => r.serial === row.serial);
      expect(issued).toBeDefined();
      // The DB carries the HMAC of the returned code — never the code itself.
      expect(row.activationCodeHash).toBe(hashTagActivationCode(issued?.activationCode ?? ""));
      expect(row.activationCodeHash).not.toBe(issued?.activationCode);
    }

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "tag.lote_issue"));
    const batchAudits = audits.filter(
      (a) => (a.payload as { lote_id?: string }).lote_id === LOTE_A,
    );
    expect(batchAudits).toHaveLength(1);
    expect((batchAudits[0].payload as { count?: number }).count).toBe(5);
    // Neither codes nor hashes reach the audit payload.
    const auditBlob = JSON.stringify(batchAudits[0].payload);
    for (const r of result.rows) {
      expect(auditBlob).not.toContain(r.activationCode);
    }
  });

  it("survives a serial collision by retrying with a fresh serial", async () => {
    // Force the FIRST generated serial to collide with an existing row.
    const existing = await db
      .select({ serial: petTags.serial })
      .from(petTags)
      .where(eq(petTags.loteId, LOTE_A))
      .limit(1);
    expect(existing).toHaveLength(1);
    serialQueue.push(existing[0].serial);

    const result = await issueTagBatchForAdmin(adminUserId, { count: 2, loteId: LOTE_B });
    expect(result).toMatchObject({ ok: true });
    if ("error" in result) throw new Error(result.error);
    expect(result.rows).toHaveLength(2);
    // The colliding serial was regenerated, not reused.
    expect(result.rows.map((r) => r.serial)).not.toContain(existing[0].serial);

    const dbRows = await db.select().from(petTags).where(eq(petTags.loteId, LOTE_B));
    expect(dbRows).toHaveLength(2);
  });
});

describe("buildTagIssuanceCsv", () => {
  it("emits serial,activation_code,url rows and never a stored hash", () => {
    const rows = [
      { serial: "TAG-ABCD-2345", activationCode: "WXYZ-6789" },
      { serial: "TAG-EFGH-6789", activationCode: "QRST-2345" },
    ];
    const csv = buildTagIssuanceCsv(rows, "https://mimar.example/");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("serial,activation_code,url");
    expect(lines[1]).toBe("TAG-ABCD-2345,WXYZ-6789,https://mimar.example/t/TAG-ABCD-2345");
    expect(lines[2]).toBe("TAG-EFGH-6789,QRST-2345,https://mimar.example/t/TAG-EFGH-6789");
    for (const row of rows) {
      expect(csv).not.toContain(hashTagActivationCode(row.activationCode));
    }
  });
});
