// Integration tests — admin approval-queue pagination (C1).
//
// Regression under test: /admin/cola previously selected ALL pending
// approval_requests with no LIMIT and rendered them in a bulk-select list —
// the single universal queue across every jurisdiction, the one most prone to
// unbounded growth. fetchPendingApprovalsPage() bounds the fetch with keyset
// pagination and derives the total from a SEPARATE count(*) (the
// listOpenCasesForAdminPreview pattern), so the header total stays accurate
// while the rendered page stays bounded.

import { createClient } from "@supabase/supabase-js";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, auditLog, db, profiles } from "@/db";
import { fetchPendingApprovalsPage } from "@/lib/infra/admin-approval-queue";
import { encodeCursor } from "@/lib/utils/keyset-pagination";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const APPLICANT_EMAIL = "c1-queue-applicant@dim-test.local";
const TOKEN_PREFIX = "C1-QUEUE";
const SEED_COUNT = 12;
const PAGE_LIMIT = 5;
// Use a single controlled type so the seeded rows are an isolatable cohort.
// role_upgrade_vet targets a user (the applicant self-upgrading) — satisfies the
// approval_target_consistent CHECK.
const SEED_TYPE = "role_upgrade_vet" as const;

let applicantId: string;
const seededTokens: string[] = [];

async function deleteApplicant() {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === APPLICANT_EMAIL);
  await db.delete(approvalRequests).where(inArray(approvalRequests.publicToken, seededTokens));
  if (found) {
    await db.delete(approvalRequests).where(eq(approvalRequests.applicantUserId, found.id));
    await db.delete(profiles).where(eq(profiles.id, found.id));
    await adminSdk.auth.admin.deleteUser(found.id);
  }
}

beforeAll(async () => {
  await deleteApplicant();
  const r = await createFreshTestUser(adminSdk, {
    email: APPLICANT_EMAIL,
    password: "C1Queue_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser: ${r.error?.message}`);
  applicantId = r.data.user.id;

  // Seed SEED_COUNT pending requests with staggered, recent createdAt so the
  // cohort sorts to the FRONT of the DESC-ordered queue regardless of any
  // pre-existing rows (seed:panorama etc.). token0 is the newest.
  const base = Date.now();
  const rows = Array.from({ length: SEED_COUNT }, (_, i) => {
    const token = `${TOKEN_PREFIX}-${String(i).padStart(2, "0")}`;
    seededTokens.push(token);
    return {
      publicToken: token,
      type: SEED_TYPE,
      status: "pending" as const,
      applicantUserId: applicantId,
      targetUserId: applicantId,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      payload: {
        payload_version: 1,
        matricula_number: "MN-C1",
        matricula_jurisdiccion: "Buenos Aires",
      },
      createdAt: new Date(base - i * 1000),
    };
  });
  await db.insert(approvalRequests).values(rows);
}, 30_000);

afterAll(async () => {
  await deleteApplicant();
});

describe("fetchPendingApprovalsPage — bounded fetch + accurate total (C1)", () => {
  it("returns at most `limit` rows on page 1 and a total that exceeds the page", async () => {
    const page = await fetchPendingApprovalsPage({ type: SEED_TYPE, limit: PAGE_LIMIT });

    // The fetch is bounded by the page limit (the bug rendered ALL rows).
    expect(page.items.length).toBe(PAGE_LIMIT);
    // total is a SEPARATE count(*), so it reflects the full queue, not the page.
    expect(page.total).toBeGreaterThanOrEqual(SEED_COUNT);
    expect(page.total).toBeGreaterThan(page.items.length);
    expect(page.hasMore).toBe(true);
  });

  it("orders newest-first and paginates the full cohort via keyset cursor", async () => {
    const collected: string[] = [];
    let cursor: string | undefined;
    // Bounded loop — never trust hasMore blindly in a test.
    for (let guard = 0; guard < 50; guard++) {
      const page = await fetchPendingApprovalsPage({
        type: SEED_TYPE,
        limit: PAGE_LIMIT,
        cursor,
      });
      collected.push(...page.items.map((r) => r.publicToken));
      if (!page.hasMore || !page.items.length) break;
      const last = page.items[page.items.length - 1];
      cursor = encodeCursor(last.createdAt, last.id);
    }

    // Every seeded token is reachable through pagination (nothing dropped).
    for (const token of seededTokens) {
      expect(collected).toContain(token);
    }

    // The seeded cohort appears in createdAt DESC order (token00 newest → token11).
    const seededInOrder = collected.filter((t) => t.startsWith(TOKEN_PREFIX));
    const expectedOrder = [...seededTokens];
    expect(seededInOrder).toEqual(expectedOrder);
  });

  it("does not double-log or mutate audit on read (queue is a pure projection)", async () => {
    const before = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, applicantId)));
    await fetchPendingApprovalsPage({ type: SEED_TYPE, limit: PAGE_LIMIT });
    const after = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, applicantId)));
    expect(after.length).toBe(before.length);
  });
});
