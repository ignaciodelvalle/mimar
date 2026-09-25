// `/api/v1/me/welfare-reports` and `/api/v1/me/welfare-reports/{referenceCode}`
// — "Mis denuncias" over a bearer token (M16).
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE READER IS THE VERIFIED CALLER. The list and the detail answer for
//      the user the liveness guard resolved, never for anything in the URL.
//   2. AN ANONYMOUS DENUNCIA IS NOT ANYBODY'S. It is stored with
//      `reporter_user_id = null`; it appears in no list and its code opens no
//      detail — the same 404 as a code that does not exist.
//   3. SOMEBODY ELSE'S DENUNCIA IS A 404, NOT A 403, byte-identical to a code
//      that does not exist, so the endpoint is not an oracle over codes.
//   4. THE PROJECTION IS THE AUTHOR'S VIEW. The authority's intervention note
//      on the same case timeline, the resolution notes, the assignee and the
//      uuid never reach the wire; the author's own comment does.
//   5. THE CURSOR PAGES the reader's `(created_at, id)` keyset.
//
// DB-BACKED ON PURPOSE. Points 2 and 4 are properties of the QUERY, and a
// mocked reader would pin only that the route calls it. Everything around the
// query (bearer, liveness, limiter, storage signing) is stubbed.

import { eq, inArray, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { caseEvents, cases, db, profiles, welfareReports } from "@/db";

import { withMutationOverride } from "./_helpers/db-overrides";

const REPORTER_ID = "a16e0000-0000-4000-8000-00000000a001";
const OTHER_ID = "a16e0000-0000-4000-8000-00000000a002";
const PROFILE_IDS = [REPORTER_ID, OTHER_ID];

const CODE_PREFIX = "DEN-M16";
const MINE_NEW = `${CODE_PREFIX}-0001`;
const MINE_OLD = `${CODE_PREFIX}-0002`;
const THEIRS = `${CODE_PREFIX}-0003`;
const ANONYMOUS = `${CODE_PREFIX}-0004`;
const CASE_CODE = "CAS-M16T-0001";

const INTERNAL_NOTE = "NOTA-INTERNA-DE-LA-AUTORIDAD";
const RESOLUTION = "RESOLUCION-INTERNA-M16";
const MY_COMMENT = "Sigue atado en el patio";

const control = vi.hoisted(() => ({
  userId: "",
  limits: [] as Array<{ endpoint: string; identifier: string }>,
}));

vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    createClientFromBearer: (header: string | null) =>
      header ? { ok: true, supabase: {}, token: "tok" } : { ok: false, reason: "MISSING" },
  };
});

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () => ({
      ok: true,
      supabase: {},
      user: { id: control.userId, emailConfirmed: true },
      profile: { id: control.userId, role: "owner" },
    }),
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string, identifier: string) => {
      control.limits.push({ endpoint, identifier });
    },
  };
});

vi.mock("@/lib/infra/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/storage")>();
  return {
    ...actual,
    welfareAttachmentSignedUrl: async (path: string) => `https://signed.test/${path}`,
  };
});

import {
  MY_WELFARE_REPORTS_PAYLOAD_VERSION,
  MY_WELFARE_REPORT_DETAIL_PAYLOAD_VERSION,
  type MyWelfareReportDetailV1,
  type MyWelfareReportsV1,
} from "@dim/contract/api";

import { GET as GET_DETAIL } from "@/app/api/v1/me/welfare-reports/[referenceCode]/route";
import { GET as GET_LIST } from "@/app/api/v1/me/welfare-reports/route";
import { listReporterWelfareReports } from "@/src/modules/welfare/infrastructure/reporter-reports-read";

function req(path: string, authorization: string | null = "Bearer test-token") {
  const headers: Record<string, string> = { "x-real-ip": "203.0.113.16" };
  if (authorization) headers.authorization = authorization;
  return new Request(`http://localhost:3000${path}`, { headers });
}

function detail(code: string) {
  return GET_DETAIL(req(`/api/v1/me/welfare-reports/${code}`), {
    params: Promise.resolve({ referenceCode: code }),
  });
}

async function cleanup() {
  await withMutationOverride(async (tx) => {
    await tx.execute(
      sql`DELETE FROM case_events WHERE case_id IN (SELECT id FROM cases WHERE public_code = ${CASE_CODE})`,
    );
    await tx.execute(sql`DELETE FROM cases WHERE public_code = ${CASE_CODE}`);
  });
  await db.delete(welfareReports).where(like(welfareReports.referenceCode, `${CODE_PREFIX}-%`));
  await db.delete(profiles).where(inArray(profiles.id, PROFILE_IDS));
}

beforeAll(async () => {
  await cleanup();

  await db.insert(profiles).values([
    { id: REPORTER_ID, displayName: "m16-reporter", role: "owner" },
    { id: OTHER_ID, displayName: "m16-other", role: "owner" },
  ]);

  const [caseRow] = await db
    .insert(cases)
    .values({ publicCode: CASE_CODE, caseKind: "welfare_denuncia", primarySubjectKind: "general" })
    .returning({ id: cases.id });

  await db.insert(caseEvents).values([
    { caseId: caseRow.id, entryType: "reporter_comment", notes: MY_COMMENT },
    { caseId: caseRow.id, entryType: "org_intervention_note", notes: INTERNAL_NOTE },
  ]);

  const base = {
    kind: "chained" as const,
    severity: "high" as const,
    subjectKind: "unowned_animal" as const,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "Tandil",
  };
  await db.insert(welfareReports).values([
    {
      ...base,
      referenceCode: MINE_NEW,
      reporterUserId: REPORTER_ID,
      reporterContactEmail: "yo@dim-test.local",
      description: "Perro encadenado sin agua desde hace días.",
      caseId: caseRow.id,
      status: "in_progress",
      // Operator-side columns the author must never be served.
      resolutionNotes: RESOLUTION,
      assignedToUserId: OTHER_ID,
      locationLat: "-37.3217000",
      locationLng: "-59.1332000",
      createdAt: new Date("2026-09-20T12:00:00.000Z"),
    },
    {
      ...base,
      referenceCode: MINE_OLD,
      reporterUserId: REPORTER_ID,
      description: "x".repeat(200),
      createdAt: new Date("2026-09-10T12:00:00.000Z"),
    },
    {
      ...base,
      referenceCode: THEIRS,
      reporterUserId: OTHER_ID,
      description: "Denuncia de otra persona.",
      createdAt: new Date("2026-09-21T12:00:00.000Z"),
    },
    {
      // Filed ANONYMOUSLY by the reporter: stored with no account, which is
      // exactly what anonymity means. It must never come back to them here.
      ...base,
      referenceCode: ANONYMOUS,
      reporterUserId: null,
      description: "Denuncia anónima.",
      createdAt: new Date("2026-09-22T12:00:00.000Z"),
    },
  ]);
});

afterAll(async () => {
  await cleanup();
});

beforeEach(() => {
  control.userId = REPORTER_ID;
  control.limits = [];
});

describe("GET /api/v1/me/welfare-reports", () => {
  it("lists only the caller's own denuncias, newest first — never an anonymous one", async () => {
    const res = await GET_LIST(req(`/api/v1/me/welfare-reports?userId=${OTHER_ID}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MyWelfareReportsV1;
    expect(body.payloadVersion).toBe(MY_WELFARE_REPORTS_PAYLOAD_VERSION);
    const mine = body.reports.map((r) => r.referenceCode).filter((c) => c.startsWith(CODE_PREFIX));
    expect(mine).toEqual([MINE_NEW, MINE_OLD]);
  });

  it("carries the web's row and nothing else", async () => {
    const body = (await (
      await GET_LIST(req("/api/v1/me/welfare-reports"))
    ).json()) as MyWelfareReportsV1;
    const row = body.reports.find((r) => r.referenceCode === MINE_NEW);
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "excerpt",
      "filedAt",
      "kindLabel",
      "place",
      "referenceCode",
      "severityLabel",
      "status",
      "statusLabel",
    ]);
    expect(row?.status).toBe("in_progress");
    expect(row?.statusLabel).toBe("En curso");
    expect(row?.place).toBe("Tandil, Buenos Aires");
    const old = body.reports.find((r) => r.referenceCode === MINE_OLD);
    // The web list's cut: 150 characters and an ellipsis.
    expect(old?.excerpt).toBe(`${"x".repeat(150)}…`);
  });

  it("gives the other person their own list, not the caller's", async () => {
    control.userId = OTHER_ID;
    const body = (await (
      await GET_LIST(req("/api/v1/me/welfare-reports"))
    ).json()) as MyWelfareReportsV1;
    expect(body.reports.map((r) => r.referenceCode)).toEqual([THEIRS]);
  });

  it("spends its own read buckets, IP first and then the verified user", async () => {
    await GET_LIST(req("/api/v1/me/welfare-reports"));
    expect(control.limits).toEqual([
      { endpoint: "api_v1_me_welfare_reports_read_ip", identifier: "203.0.113.16" },
      { endpoint: "api_v1_me_welfare_reports_read_user", identifier: REPORTER_ID },
    ]);
  });

  it("refuses a caller with no bearer before it reads anything", async () => {
    const res = await GET_LIST(req("/api/v1/me/welfare-reports", null));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_required" });
    expect(control.limits).toEqual([]);
  });

  it("pages with the reader's keyset cursor", async () => {
    const first = await listReporterWelfareReports({ reporterUserId: REPORTER_ID, limit: 1 });
    expect(first.rows.map((r) => r.referenceCode)).toEqual([MINE_NEW]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listReporterWelfareReports({
      reporterUserId: REPORTER_ID,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.rows.map((r) => r.referenceCode)).toEqual([MINE_OLD]);
    expect(second.nextCursor).toBeNull();
  });

  it("treats a malformed cursor as page one, not as an error", async () => {
    const res = await GET_LIST(req("/api/v1/me/welfare-reports?cursor=%%%garbage"));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/v1/me/welfare-reports/{referenceCode}", () => {
  it("serves the author's view of their denuncia", async () => {
    const res = await detail(MINE_NEW);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MyWelfareReportDetailV1;
    expect(body.payloadVersion).toBe(MY_WELFARE_REPORT_DETAIL_PAYLOAD_VERSION);
    expect(body.referenceCode).toBe(MINE_NEW);
    expect(body.statusLabel).toBe("En curso");
    expect(body.notice).toEqual({ tone: "info", text: "En revisión por la autoridad." });
    expect(body.case).toEqual({ publicCode: CASE_CODE, route: expect.anything() });
    expect(body.contact).toEqual({ email: "yo@dim-test.local", phone: null });
    expect(body.place?.point).toEqual({ lat: -37.3217, lng: -59.1332 });
    expect(body.constanciaUrl).toMatch(/\/denuncias\/codigo\/DEN-M16-0001$/);
  });

  it("carries the author's own comment and NOT the authority's note on the same case", async () => {
    const res = await detail(MINE_NEW);
    const text = await res.text();
    const body = JSON.parse(text) as MyWelfareReportDetailV1;
    expect(body.comments.map((c) => c.text)).toEqual([MY_COMMENT]);
    expect(text).not.toContain(INTERNAL_NOTE);
    expect(text).not.toContain(RESOLUTION);
    expect(text).not.toContain(OTHER_ID);
  });

  it("names no internal field", async () => {
    const body = (await (await detail(MINE_NEW)).json()) as Record<string, unknown>;
    for (const key of [
      "id",
      "caseId",
      "resolutionNotes",
      "assignedToUserId",
      "flagReasons",
      "reporterUserId",
      "derivedToOrganizationId",
      "seedTag",
    ]) {
      expect(body, key).not.toHaveProperty(key);
    }
  });

  it("answers somebody else's denuncia with the SAME 404 as a code that does not exist", async () => {
    const theirs = await detail(THEIRS);
    const missing = await detail(`${CODE_PREFIX}-9999`);
    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await theirs.json()).toEqual(await missing.json());
  });

  it("does not open an anonymous denuncia, even to the person who filed it", async () => {
    const res = await detail(ANONYMOUS);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("refuses an absurd segment without reading anything", async () => {
    const res = await detail("x".repeat(65));
    expect(res.status).toBe(404);
  });

  it("spends its own read buckets", async () => {
    await detail(MINE_NEW);
    expect(control.limits).toEqual([
      { endpoint: "api_v1_me_welfare_report_detail_ip", identifier: "203.0.113.16" },
      { endpoint: "api_v1_me_welfare_report_detail_user", identifier: REPORTER_ID },
    ]);
  });
});

describe("the web page and the API read one row the same way", () => {
  it("the web's anonymity boundary is the column, not a filter", async () => {
    const [row] = await db
      .select({ reporterUserId: welfareReports.reporterUserId })
      .from(welfareReports)
      .where(eq(welfareReports.referenceCode, ANONYMOUS));
    expect(row.reporterUserId).toBeNull();
  });
});
