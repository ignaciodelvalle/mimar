// lib/metrics/alert-evaluation.test.ts — isBreaching (pure) +
// evaluateAlertSubscriptions (runtime, mocked db/fetchers).
//
// HISTORY — why the runtime tests exist (numbers-that-lie audit 2026-08-01):
// evaluateAlertSubscriptions used to be covered ONLY by a tsc-only shape
// check. That is how a real scoping bug shipped: buildProjectionScope
// discards the per-subscription jurisdictions for admin actors, so every
// jurisdiction-scoped subscription evaluated the NATIONAL metric value under
// its provincial label (and record-firings persisted that national value as
// observedValue). The tests below run the evaluator for real with the db and
// fetchers mocked, and assert the ctx each fetcher receives is scoped via
// adminProvince/adminLocality.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mutable store the hoisted db mock reads lazily (per-test subscriptions).
const store = vi.hoisted(() => ({ subs: [] as unknown[] }));

vi.mock("@/db", async () => {
  const actual = await vi.importActual<typeof import("@/db")>("@/db");
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: async () => store.subs,
        }),
      }),
    },
  };
});

// Mock every metric fetcher the evaluator dispatches to — the tests assert on
// the ProjectionContext they receive, not on their internals.
vi.mock("@/lib/analytics/govt-home-kpis", () => ({
  fetchActiveZoonosis: vi.fn(),
  fetchOpenWelfareReportsCount: vi.fn(),
}));
vi.mock("@/lib/analytics/surveillance-metrics", () => ({ fetchEnoSla: vi.fn() }));
vi.mock("@/lib/analytics/admin-metrics", () => ({ fetchQueueHealth: vi.fn() }));
vi.mock("@/lib/analytics/compliance-metrics", () => ({ fetchMicrochipPenetration: vi.fn() }));
vi.mock("@/lib/metrics/population-control", () => ({ fetchSterilizationCoverage: vi.fn() }));

import { fetchActiveZoonosis } from "@/lib/analytics/govt-home-kpis";
import type { ProjectionContext } from "@/lib/metrics";

import {
  evaluateAlertSubscriptions,
  intersectWithCallerScope,
  isBreaching,
} from "./alert-evaluation";

// ---------------------------------------------------------------------------
// isBreaching — pure function
// ---------------------------------------------------------------------------

describe("isBreaching", () => {
  // --- direction: 'above' ---

  it("above: value > threshold → breaching", () => {
    expect(isBreaching(101, "above", 100)).toBe(true);
  });

  it("above: value === threshold → NOT breaching (strict inequality)", () => {
    expect(isBreaching(100, "above", 100)).toBe(false);
  });

  it("above: value < threshold → NOT breaching", () => {
    expect(isBreaching(50, "above", 100)).toBe(false);
  });

  // --- direction: 'below' ---

  it("below: value < threshold → breaching", () => {
    expect(isBreaching(49, "below", 50)).toBe(true);
  });

  it("below: value === threshold → NOT breaching (strict inequality)", () => {
    expect(isBreaching(50, "below", 50)).toBe(false);
  });

  it("below: value > threshold → NOT breaching", () => {
    expect(isBreaching(99, "below", 50)).toBe(false);
  });

  // --- null input ---

  it("null currentValue → false (no data = not breaching)", () => {
    expect(isBreaching(null, "above", 0)).toBe(false);
  });

  it("null currentValue with below direction → false", () => {
    expect(isBreaching(null, "below", 100)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateAlertSubscriptions — runtime scoping
// ---------------------------------------------------------------------------

const NATIONAL_COUNT = 40;
const SCOPED_COUNT = 3;

const mockZoonosis = vi.mocked(fetchActiveZoonosis);

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    actorUserId: "user-1",
    metricKey: "active_zoonosis",
    direction: "above",
    threshold: "10",
    isActive: true,
    jurisdictionProvince: null,
    jurisdictionLocality: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("evaluateAlertSubscriptions — each subscription evaluates ITS jurisdiction", () => {
  beforeEach(() => {
    store.subs = [];
    mockZoonosis.mockReset();
    // The scoped and the national fetch return DIFFERENT values, so a
    // subscription reading the wrong scope produces the wrong number — the
    // exact bug this guards against (national value under a provincial label).
    mockZoonosis.mockImplementation(async (ctx: ProjectionContext) => ({
      count: ctx.adminProvince ? SCOPED_COUNT : NATIONAL_COUNT,
      rabies: 0,
      lepto: 0,
      hidat: 0,
      deltaWeek: 0,
    }));
  });

  it("a province subscription builds a ctx scoped to that province (adminProvince)", async () => {
    store.subs = [makeSub({ jurisdictionProvince: "Ciudad Autónoma de Buenos Aires" })];

    const [row] = await evaluateAlertSubscriptions("user-1", { role: "admin" });

    expect(mockZoonosis).toHaveBeenCalledTimes(1);
    const ctx = mockZoonosis.mock.calls[0][0];
    // Admin actor keeps global scope kind; the narrowing travels on the admin
    // drill-down channel every fetcher honors (petsScopeClause et al.).
    expect(ctx.scope.kind).toBe("global");
    expect(ctx.adminProvince).toBe("Ciudad Autónoma de Buenos Aires");
    expect(ctx.adminLocality).toBeUndefined();

    // The row carries the SCOPED value — not the national one. Against the
    // old code this read 40 (national) and flipped breaching to true.
    expect(row.currentValue).toBe(SCOPED_COUNT);
    expect(row.breaching).toBe(false);
  });

  it("a locality subscription passes the locality through as adminLocality", async () => {
    store.subs = [
      makeSub({ jurisdictionProvince: "Buenos Aires", jurisdictionLocality: "La Plata" }),
    ];

    await evaluateAlertSubscriptions("user-1", { role: "admin" });

    const ctx = mockZoonosis.mock.calls[0][0];
    expect(ctx.adminProvince).toBe("Buenos Aires");
    expect(ctx.adminLocality).toBe("La Plata");
  });

  it("a national subscription stays unscoped (no adminProvince)", async () => {
    store.subs = [makeSub()];

    const [row] = await evaluateAlertSubscriptions("user-1", { role: "admin" });

    const ctx = mockZoonosis.mock.calls[0][0];
    expect(ctx.adminProvince).toBeUndefined();
    expect(ctx.adminLocality).toBeUndefined();
    expect(row.currentValue).toBe(NATIONAL_COUNT);
    expect(row.breaching).toBe(true); // 40 > 10
  });

  it("national + provincial subscriptions of the same metric fetch separately, each with its own value", async () => {
    store.subs = [
      makeSub({ id: "00000000-0000-4000-8000-00000000000a" }),
      makeSub({
        id: "00000000-0000-4000-8000-00000000000b",
        jurisdictionProvince: "Salta",
      }),
    ];

    const rows = await evaluateAlertSubscriptions("user-1", { role: "admin" });

    // Distinct cache keys (national vs Salta) → two real fetches.
    expect(mockZoonosis).toHaveBeenCalledTimes(2);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("00000000-0000-4000-8000-00000000000a")?.currentValue).toBe(NATIONAL_COUNT);
    expect(byId.get("00000000-0000-4000-8000-00000000000b")?.currentValue).toBe(SCOPED_COUNT);
  });
});

// ---------------------------------------------------------------------------
// A10-G2 — a govt caller never evaluates outside its own mandate
// ---------------------------------------------------------------------------

describe("evaluateAlertSubscriptions — govt caller is bounded by its own assignments", () => {
  const ALMAGRO = { province: "CABA", locality: "Almagro" };

  beforeEach(() => {
    store.subs = [];
    mockZoonosis.mockReset();
    mockZoonosis.mockImplementation(async () => ({
      count: SCOPED_COUNT,
      rabies: 0,
      lepto: 0,
      hidat: 0,
      deltaWeek: 0,
    }));
  });

  it("a subscription outside the caller's mandate fetches nothing and reads as no data", async () => {
    store.subs = [makeSub({ jurisdictionProvince: "Salta", jurisdictionLocality: "Cafayate" })];

    const [row] = await evaluateAlertSubscriptions("user-1", { role: "govt" }, [ALMAGRO]);

    expect(mockZoonosis).not.toHaveBeenCalled();
    expect(row.currentValue).toBeNull();
    expect(row.breaching).toBe(false);
  });

  it("a subscription inside the caller's mandate is scoped to exactly that pair", async () => {
    store.subs = [makeSub({ jurisdictionProvince: "CABA", jurisdictionLocality: "Almagro" })];

    const [row] = await evaluateAlertSubscriptions("user-1", { role: "govt" }, [ALMAGRO]);

    const ctx = mockZoonosis.mock.calls[0][0];
    expect(ctx.scope).toEqual({
      kind: "jurisdictions",
      jurisdictions: [{ province: "CABA", locality: "Almagro" }],
    });
    expect(ctx.adminProvince).toBeUndefined();
    expect(row.currentValue).toBe(SCOPED_COUNT);
  });

  it("a national subscription evaluates over the caller's whole mandate, not the country", async () => {
    store.subs = [makeSub()];

    await evaluateAlertSubscriptions("user-1", { role: "govt" }, [
      ALMAGRO,
      { province: "Buenos Aires", locality: "La Plata" },
    ]);

    const ctx = mockZoonosis.mock.calls[0][0];
    expect(ctx.scope).toEqual({
      kind: "jurisdictions",
      jurisdictions: [
        { province: "CABA", locality: "Almagro" },
        { province: "Buenos Aires", locality: "La Plata" },
      ],
    });
  });

  it("a govt with no assignments evaluates nothing (fail closed)", async () => {
    store.subs = [makeSub()];

    const [row] = await evaluateAlertSubscriptions("user-1", { role: "govt" });

    expect(mockZoonosis).not.toHaveBeenCalled();
    expect(row.currentValue).toBeNull();
  });
});

describe("intersectWithCallerScope", () => {
  it("narrows a whole-province subscription to the caller's barrios in that province", () => {
    expect(
      intersectWithCallerScope("Buenos Aires", null, [
        { province: "Buenos Aires", locality: "La Plata" },
        { province: "Salta", locality: "Cafayate" },
      ]),
    ).toEqual([{ province: "Buenos Aires", locality: "La Plata" }]);
  });

  it("admits a barrio subscription under a whole-province assignment", () => {
    expect(
      intersectWithCallerScope("CABA", "Almagro", [{ province: "CABA", locality: "" }]),
    ).toEqual([{ province: "CABA", locality: "Almagro" }]);
  });

  it("refuses a barrio next door to the caller's barrio", () => {
    expect(
      intersectWithCallerScope("CABA", "Palermo", [{ province: "CABA", locality: "Almagro" }]),
    ).toEqual([]);
  });
});
