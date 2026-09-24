// `/api/v1/me/cases` and `/api/v1/me/cases/{publicCode}` — the owner's casos.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. AUTHORIZATION, the same failure space as every sibling on `/me`.
//   2. THE VIEWER IS THE VERIFIED CALLER. The list loaders are called with the
//      live user's id and nothing from the request; the detail runs
//      `canReadCase` with a viewer built from the live profile.
//   3. ANOTHER PERSON'S CASE IS A 404, NOT A 403 — byte-identical to a code
//      that does not exist, so the endpoint is not an oracle over case codes.
//   4. THE CARETAKER EXCEPTION is a 200 carrying only the pet, and is reached
//      only when `holdsActiveCaretakerRow` says so.
//   5. THE PROJECTION carries no internal ids, drops dispute tips for an owner,
//      and resolves web paths to in-app routes only through the deep-link table.
//   6. THE HISTORY PAGE is bounded, with `hasMore` derived from one extra row.
//
// The decision functions (`canReadCase`, `holdsActiveCaretakerRow`) and the
// loaders are mocked: their SQL is exercised by the DB-backed suites that
// cover `/casos` and `/mis-mascotas`. What is asserted here is that the route
// reaches them through `readCaseForViewer` with the right viewer, and what it
// does with the answer.

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const STRANGER_ID = "22222222-2222-4222-8222-222222222222";
const CASE_UUID = "33333333-3333-4333-8333-333333333333";
const PET_UUID = "44444444-4444-4444-4444-444444444444";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  open: null as null | ((userId: string) => unknown),
  previous: null as null | ((userId: string, limit: number) => unknown),
  loaderCalls: [] as Array<{ fn: string; args: unknown[] }>,
  detail: null as null | (() => unknown),
  canReadCalls: [] as Array<unknown>,
  caretaker: false,
  piiLogs: [] as Array<unknown[]>,
}));

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () =>
      control.live
        ? control.live()
        : {
            ok: true,
            supabase: {},
            user: { id: OWNER_ID, emailConfirmed: true },
            profile: { id: OWNER_ID, role: "owner" },
          },
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

vi.mock("@/lib/analytics/owner-dashboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics/owner-dashboard")>();
  return {
    ...actual,
    fetchOpenWorkflows: async (...args: unknown[]) => {
      control.loaderCalls.push({ fn: "fetchOpenWorkflows", args });
      return control.open ? control.open(args[0] as string) : [];
    },
    fetchPreviousWorkflows: async (...args: unknown[]) => {
      control.loaderCalls.push({ fn: "fetchPreviousWorkflows", args });
      return control.previous ? control.previous(args[0] as string, args[1] as number) : [];
    },
  };
});

vi.mock("@/lib/infra/case-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/case-queries")>();
  return {
    ...actual,
    getCaseDetailByPublicCode: async (code: string) =>
      control.detail && code === "CAS-TEST-0001" ? control.detail() : null,
  };
});

// A stand-in for the real rule with the one property this file needs: the
// subject owner (OWNER_ID) may read, anyone else may not. What is asserted is
// WHICH viewer reaches it.
vi.mock("@/lib/infra/case-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/case-access")>();
  return {
    ...actual,
    canReadCase: async (_detail: unknown, viewer: { userId: string } | null) => {
      control.canReadCalls.push(viewer);
      return viewer?.userId === OWNER_ID;
    },
    holdsActiveCaretakerRow: async () => control.caretaker,
  };
});

vi.mock("@/src/modules/organizations/application/admin-proposals/log-pii-query", () => ({
  logPiiReadSafely: async (...args: unknown[]) => {
    control.piiLogs.push(args);
    return true;
  },
}));

vi.mock("@/lib/infra/request-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/request-cache")>();
  return { ...actual, getJurisdictionsCached: async () => [] };
});

vi.mock("@/lib/infra/storage", () => ({
  petPhotoUrl: (path: string) => `https://storage.test/${path}`,
}));

import { DbBudgetExceededError } from "@/lib/infra/db-budget";
import {
  MY_CASES_HISTORY_LIMIT,
  MY_CASES_PAYLOAD_VERSION,
  MY_CASE_DETAIL_PAYLOAD_VERSION,
  type MyCaseReadableV1,
  type MyCasesV1,
} from "@dim/contract/api";

import { GET as GET_DETAIL } from "@/app/api/v1/me/cases/[publicCode]/route";
import { GET as GET_LIST } from "@/app/api/v1/me/cases/route";

function req(path: string, authorization: string | null = "Bearer test-token") {
  const headers: Record<string, string> = { "x-real-ip": "203.0.113.22" };
  if (authorization) headers.authorization = authorization;
  return new Request(`http://localhost:3000${path}`, { headers });
}

function detailReq(code: string, authorization?: string | null) {
  return GET_DETAIL(req(`/api/v1/me/cases/${code}`, authorization), {
    params: Promise.resolve({ publicCode: code }),
  });
}

function workflow(overrides: Record<string, unknown> = {}) {
  return {
    id: `case_generic:${CASE_UUID}`,
    kind: "case_generic_open",
    title: "Caso CAS-TEST-0001 · Pampa",
    subtitle: "Episodio de custodia",
    ctaUrl: "/casos/CAS-TEST-0001",
    since: new Date("2026-09-01T12:00:00.000Z"),
    severity: "info",
    ...overrides,
  };
}

function caseDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: CASE_UUID,
    publicCode: "CAS-TEST-0001",
    caseKind: "bite_incident",
    status: "open",
    closedReason: null,
    primarySubjectKind: "pet",
    primaryLocationLat: "-34.6",
    primaryLocationLng: "-58.4",
    jurisdictionCountry: "AR",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "Tandil",
    openedAt: new Date("2026-09-01T12:00:00.000Z"),
    openedReason: null,
    openedReasonCode: null,
    openedReasonParams: null,
    closedAt: null,
    pet: {
      id: PET_UUID,
      publicToken: "DIM-PAMP-0001",
      name: "Pampa",
      species: "dog",
      sex: "female",
      primaryPhotoStoragePath: "pets/pampa.jpg",
      status: "registered",
      discloseLastLocationWhenLost: false,
    },
    welfareReport: null,
    custodyDispute: null,
    openedByUser: { id: STRANGER_ID, displayName: "Operadora Municipal" },
    openedByOrganization: null,
    receiverOrganization: null,
    receiverOrganizationId: null,
    closedByUser: null,
    events: [
      {
        id: "ev-1",
        eventType: "case_note",
        occurredAt: new Date("2026-09-02T12:00:00.000Z"),
        payload: {},
        notes: "Se citó a la titular.",
        authorRole: null,
      },
      {
        id: "ev-2",
        eventType: "finder_tip",
        occurredAt: new Date("2026-09-03T12:00:00.000Z"),
        payload: {},
        notes: "Lo vi en la plaza",
        authorRole: null,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  control.live = null;
  control.limits = [];
  control.open = null;
  control.previous = null;
  control.loaderCalls = [];
  control.detail = null;
  control.canReadCalls = [];
  control.caretaker = false;
  control.piiLogs = [];
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("/api/v1/me/cases — authorization", () => {
  it("refuses a request with no Authorization header on both routes", async () => {
    for (const res of [
      await GET_LIST(req("/api/v1/me/cases", null)),
      await detailReq("CAS-TEST-0001", null),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "auth_required" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("never opens a loader when the bearer resolves to nobody", async () => {
    control.live = () => ({ ok: false, reason: "NO_SESSION" });
    control.detail = () => {
      throw new Error("the case must not be read for an unauthenticated caller");
    };
    expect((await GET_LIST(req("/api/v1/me/cases"))).status).toBe(401);
    expect((await detailReq("CAS-TEST-0001")).status).toBe(401);
    expect(control.loaderCalls).toEqual([]);
  });

  it.each([
    ["ACCOUNT_ERASED", 403, "account_erased"],
    ["DEACTIVATED", 403, "account_deactivated"],
    ["SHIFT_EXPIRED", 401, "session_shift_expired"],
  ])("maps %s to %i %s", async (reason, status, code) => {
    control.live = () => ({ ok: false, reason });
    const res = await detailReq("CAS-TEST-0001");
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code });
  });

  it("spends an IP bucket before the guard and a user bucket after it, per route", async () => {
    await GET_LIST(req("/api/v1/me/cases"));
    await detailReq("CAS-TEST-0404");
    expect(control.limits).toEqual([
      { endpoint: "api_v1_me_cases_read_ip", identifier: "203.0.113.22" },
      { endpoint: "api_v1_me_cases_read_user", identifier: OWNER_ID },
      { endpoint: "api_v1_me_case_detail_ip", identifier: "203.0.113.22" },
      { endpoint: "api_v1_me_case_detail_user", identifier: OWNER_ID },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

describe("GET /api/v1/me/cases — the list", () => {
  it("runs the web's two loaders for the VERIFIED caller, history one row over the limit", async () => {
    const res = await GET_LIST(req("/api/v1/me/cases?userId=someone-else"));
    expect(res.status).toBe(200);
    expect(control.loaderCalls).toEqual([
      { fn: "fetchOpenWorkflows", args: [OWNER_ID] },
      { fn: "fetchPreviousWorkflows", args: [OWNER_ID, MY_CASES_HISTORY_LIMIT + 1] },
    ]);
  });

  it("carries the row a client renders, with an in-app route and no internal id", async () => {
    control.open = () => [
      workflow(),
      workflow({
        id: "bite_case:x",
        kind: "bite_observation_open",
        ctaUrl: "/mis-mascotas/DIM-PAMP-0001",
        severity: "warning",
        subtitle: null,
      }),
      workflow({
        id: "approval_request_pending:y",
        kind: "approval_request_pending",
        ctaUrl: "/cuenta/solicitudes",
      }),
    ];
    const body = (await (await GET_LIST(req("/api/v1/me/cases"))).json()) as MyCasesV1;

    expect(body.payloadVersion).toBe(MY_CASES_PAYLOAD_VERSION);
    expect(body.open).toHaveLength(3);
    expect(Object.keys(body.open[0] ?? {}).sort()).toEqual(
      ["kind", "route", "severity", "since", "subtitle", "title"].sort(),
    );
    expect(body.open[1]).toMatchObject({
      kind: "bite_observation_open",
      subtitle: "",
      severity: "warning",
      route: "/mascotas/DIM-PAMP-0001",
    });
    // No app screen for the account-requests inbox: plain text, not a button.
    expect(body.open[2]?.route).toBe(null);
    expect(JSON.stringify(body)).not.toContain(CASE_UUID);
  });

  it("bounds the history and says when older rows exist", async () => {
    control.previous = (_u, limit) =>
      Array.from({ length: limit }, (_, i) =>
        workflow({ kind: "welfare_report_closed", ctaUrl: `/denuncias/codigo/DEN-${i}` }),
      );
    const body = (await (await GET_LIST(req("/api/v1/me/cases"))).json()) as MyCasesV1;
    expect(body.history.rows).toHaveLength(MY_CASES_HISTORY_LIMIT);
    expect(body.history.hasMore).toBe(true);

    control.previous = () => [workflow({ kind: "welfare_report_closed" })];
    const short = (await (await GET_LIST(req("/api/v1/me/cases"))).json()) as MyCasesV1;
    expect(short.history.rows).toHaveLength(1);
    expect(short.history.hasMore).toBe(false);
  });

  it("answers 503, not an empty list, when the read exceeds its budget", async () => {
    control.open = () => {
      throw new DbBudgetExceededError("api-v1-me-cases-read", 8_000);
    };
    const res = await GET_LIST(req("/api/v1/me/cases"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "temporarily_unavailable" });
  });
});

// ---------------------------------------------------------------------------
// The detail
// ---------------------------------------------------------------------------

describe("GET /api/v1/me/cases/{publicCode} — access", () => {
  it("asks canReadCase about the VERIFIED caller, built from the live profile", async () => {
    control.detail = () => caseDetail();
    const res = await detailReq("CAS-TEST-0001");
    expect(res.status).toBe(200);
    expect(control.canReadCalls).toEqual([{ userId: OWNER_ID, role: "owner", jurisdictions: [] }]);
  });

  it("answers another person's case exactly like a code that does not exist", async () => {
    control.detail = () => caseDetail();
    control.live = () => ({
      ok: true,
      supabase: {},
      user: { id: STRANGER_ID, emailConfirmed: true },
      profile: { id: STRANGER_ID, role: "owner" },
    });
    const foreign = await detailReq("CAS-TEST-0001");
    const missing = await detailReq("CAS-NONE-0000");
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "not_found" });
    expect(await missing.json()).toEqual({ error: "not_found" });
  });

  it("refuses a caller with no profile row instead of serving the anonymous view", async () => {
    control.detail = () => caseDetail();
    control.live = () => ({
      ok: true,
      supabase: {},
      user: { id: OWNER_ID, emailConfirmed: true },
      profile: null,
    });
    const res = await detailReq("CAS-TEST-0001");
    expect(res.status).toBe(404);
    expect(control.canReadCalls).toEqual([]);
  });

  it("answers the live caretaker with the pet only, never the case", async () => {
    control.detail = () => caseDetail();
    control.caretaker = true;
    control.live = () => ({
      ok: true,
      supabase: {},
      user: { id: STRANGER_ID, emailConfirmed: true },
      profile: { id: STRANGER_ID, role: "owner" },
    });
    const res = await detailReq("CAS-TEST-0001");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      payloadVersion: MY_CASE_DETAIL_PAYLOAD_VERSION,
      access: "caretaker_only",
      pet: { name: "Pampa", route: "/mascotas/DIM-PAMP-0001" },
    });
    expect(JSON.stringify(body)).not.toContain("CAS-TEST-0001");
    expect(JSON.stringify(body)).not.toContain("Operadora");
  });

  it("does not query for an absurdly long segment", async () => {
    control.detail = () => {
      throw new Error("must not be read");
    };
    const res = await detailReq("X".repeat(65));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/me/cases/{publicCode} — the projection", () => {
  it("carries what the web shows the owner, and no dispute tip, map or internal id", async () => {
    control.detail = () => caseDetail();
    const body = (await (await detailReq("CAS-TEST-0001")).json()) as MyCaseReadableV1;

    expect(body.access).toBe("full");
    expect(body.publicCode).toBe("CAS-TEST-0001");
    expect(body.status).toBe("open");
    expect(body.statusLabel).toBe("Abierto");
    expect(body.jurisdiction).toBe("Tandil, Buenos Aires");
    expect(body.subject).toMatchObject({
      kind: "pet",
      name: "Pampa",
      photoUrl: "https://storage.test/pets/pampa.jpg",
      route: "/mascotas/DIM-PAMP-0001",
    });
    expect(body.parties).toEqual([
      { role: "opener", roleLabel: "Abrió", name: "Operadora Municipal" },
    ]);
    // The owner's view keeps notes (the web shows them to a signed-in reader)…
    expect(body.timeline.map((e) => e.notes)).toEqual(["Se citó a la titular."]);
    // …and never learns a dispute tip exists.
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("Lo vi en la plaza");
    expect(wire).not.toContain("-34.6");
    expect(wire).not.toContain(CASE_UUID);
    expect(wire).not.toContain(PET_UUID);
    expect(control.piiLogs).toEqual([]);
  });

  it("logs a PII read for an authority, exactly as the web page does", async () => {
    control.detail = () => caseDetail();
    control.live = () => ({
      ok: true,
      supabase: {},
      user: { id: OWNER_ID, emailConfirmed: true },
      profile: { id: OWNER_ID, role: "admin" },
    });
    const body = (await (await detailReq("CAS-TEST-0001")).json()) as MyCaseReadableV1;
    expect(control.piiLogs).toEqual([[OWNER_ID, "CAS-TEST-0001", 1, "case_detail"]]);
    // An authority does see the tip — the same filter, the other branch.
    expect(body.timeline).toHaveLength(2);
  });
});
