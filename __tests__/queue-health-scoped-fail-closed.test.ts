// A01-2 (dim-interno:docs/reviews/2026-09-fresh/lenses/A01.md, closed 2026-09-09):
// `fetchQueueHealthScoped` used to take a bare jurisdiction list and read `[]`
// as "admin, universal". `resolveJurisdictionScope` narrows a govt's mandate
// through `narrowGovtScope`, which returns `[]` for a `?province=` OUTSIDE the
// mandate, and the page's `hasAccess` gate tested the MANDATE rather than the
// narrowed set — so one out-of-mandate URL param on an already-assigned govt
// produced NATIONAL approval-queue counts.
//
// This test walks the SAME path the page walks (the real resolver, then the
// real fetcher against the live local database) and pins the closed behaviour:
// the narrowed-to-nothing govt sees ZERO, the same rows are visible to the
// universal scope and to the govt that actually holds the jurisdiction.
//
// Live DB (Supabase local stack) — seeds one pending approval_request in a
// jurisdiction no seeded govt covers and removes it afterwards.

import { createClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, db, profiles } from "@/db";
import { fetchQueueHealthScoped } from "@/lib/analytics/admin-metrics";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import { generateApprovalRequestToken } from "@/lib/infra/publicToken";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const APPLICANT_EMAIL = "a01-2-queue-applicant@dim-test.local";

// The seeded request lives here…
const ROW_PROVINCE = "Buenos Aires";
const ROW_LOCALITY = "La Plata";
// …and the govt under test is assigned somewhere else entirely.
const OUT_OF_MANDATE_GOVT = [{ province: "Tierra del Fuego", locality: "Ushuaia" }];
const IN_MANDATE_GOVT = [{ province: ROW_PROVINCE, locality: ROW_LOCALITY }];

let applicantId: string;
let seededToken: string;

async function deleteApplicant() {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === APPLICANT_EMAIL);
  if (seededToken) {
    await db.delete(approvalRequests).where(eq(approvalRequests.publicToken, seededToken));
  }
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
    password: "A012Queue_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser: ${r.error?.message}`);
  applicantId = r.data.user.id;

  seededToken = generateApprovalRequestToken();
  await db.insert(approvalRequests).values({
    publicToken: seededToken,
    type: "role_upgrade_vet",
    status: "pending",
    applicantUserId: applicantId,
    targetUserId: applicantId,
    jurisdictionProvince: ROW_PROVINCE,
    jurisdictionLocality: ROW_LOCALITY,
    payload: {
      payload_version: 1,
      matricula_number: "MN-A012",
      matricula_jurisdiccion: ROW_PROVINCE,
    },
  });
}, 30_000);

afterAll(async () => {
  await deleteApplicant();
});

const period = windows.trailing12m();

describe("fetchQueueHealthScoped fails CLOSED on an empty govt scope (A01-2)", () => {
  it("a govt narrowed OUT of its mandate by ?province= sees ZERO, not the national queue", async () => {
    // The exact page path: mandate → resolver → narrowed set → fetcher.
    const scope = await resolveJurisdictionScope({
      role: "govt",
      jurisdictions: OUT_OF_MANDATE_GOVT,
      params: { province: "AR-B" }, // Buenos Aires — outside a Tierra del Fuego mandate
    });
    expect(
      scope.filteredJurisdictions,
      "the fence narrows an out-of-mandate province to nothing",
    ).toEqual([]);

    const ctx = buildProjectionContext({ role: "govt" }, scope.filteredJurisdictions, period);
    const health = await fetchQueueHealthScoped(ctx);

    expect(health).toEqual({
      pendingTotal: 0,
      oldestPendingDaysAgo: null,
      pending14dPlus: 0,
      pending30dPlus: 0,
      pending60dPlus: 0,
    });
  });

  it("the same rows ARE counted for the universal scope and for the govt that holds the jurisdiction", async () => {
    const universal = await fetchQueueHealthScoped(
      buildProjectionContext({ role: "admin" }, [], period),
    );
    expect(universal.pendingTotal).toBeGreaterThanOrEqual(1);

    const holder = await fetchQueueHealthScoped(
      buildProjectionContext({ role: "govt" }, IN_MANDATE_GOVT, period),
    );
    expect(holder.pendingTotal).toBeGreaterThanOrEqual(1);
  });

  it("an admin drilled into the row's province still counts it; drilled elsewhere, not", async () => {
    const drilledIn = await fetchQueueHealthScoped(
      buildProjectionContext({ role: "admin" }, [], period, {
        adminProvince: ROW_PROVINCE,
        adminLocality: ROW_LOCALITY,
      }),
    );
    expect(drilledIn.pendingTotal).toBeGreaterThanOrEqual(1);

    const drilledOut = await fetchQueueHealthScoped(
      buildProjectionContext({ role: "admin" }, [], period, {
        adminProvince: "Tierra del Fuego",
        adminLocality: "Ushuaia",
      }),
    );
    // The seeded row is in La Plata; an Ushuaia drill must not see it. Other
    // Ushuaia rows may exist from seeds, so pin the drill to a DIRECT count of
    // that jurisdiction's pending rows — the fetcher must equal it exactly,
    // which it cannot if the La Plata row leaked in.
    const [direct] = await db
      .select({ n: sql<number>`count(*)` })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.status, "pending"),
          eq(approvalRequests.jurisdictionProvince, "Tierra del Fuego"),
          eq(approvalRequests.jurisdictionLocality, "Ushuaia"),
        ),
      );
    expect(drilledOut.pendingTotal).toBe(Number(direct.n));
  });
});
