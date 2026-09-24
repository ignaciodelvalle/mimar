// @vitest-environment jsdom
//
// /admin/sistema streamed sections (platform-budget T3.1).
//
// Two layers, mirroring src/modules/panorama/application/__tests__/db-budget.test.ts:
//   1. budgetedOrDegraded — the page-caller wrapper over withDbBudget: real
//      value / degraded-timeout / degraded-error / late-rejection crash safety.
//   2. Section components — a hanging fetcher degrades ITS section alone into
//      the honest es-AR notice ("Esta sección tardó más de N s…"), sibling
//      data still renders, and degraded states never show invented zeros.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecisionsMetrics, QueueHealth, UserMetrics } from "@/lib/analytics/admin-metrics";
import type { EnoSlaMetric } from "@/lib/analytics/surveillance-metrics";

// vi.mock factories are hoisted above top-level const declarations — mocks
// referenced inside a factory must be created via vi.hoisted.
const mocks = vi.hoisted(() => ({
  fetchCronRuns: vi.fn(),
  fetchFailedCronNames: vi.fn(),
  fetchPetStatusDrift: vi.fn(),
  fetchGovtActivity: vi.fn(),
}));

vi.mock("@/lib/analytics/admin-metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics/admin-metrics")>();
  return { ...actual, ...mocks };
});

import {
  SISTEMA_KPI_BUDGET_MS,
  SISTEMA_SECTION_BUDGET_MS,
  SistemaCronsBanner,
  SistemaCronsCard,
  SistemaGovtActivity,
  SistemaKpiStrip,
  SistemaStatCards,
  budgetedOrDegraded,
  isDegraded,
} from "./sistema-sections";

const later = <T,>(value: T, ms: number): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));
const rejectLater = (err: unknown, ms: number): Promise<never> =>
  new Promise((_, reject) => setTimeout(() => reject(err), ms));
/** A promise that never settles — the pathological pooler-contention hang. */
const hang = <T,>(): Promise<T> => new Promise<T>(() => {});

const USERS: UserMetrics = {
  totalPersonal: 42,
  totalInstitutionalActive: 7,
  new24h: 1,
  new7d: 3,
  new30d: 9,
};
const QUEUE: QueueHealth = {
  pendingTotal: 5,
  oldestPendingDaysAgo: 12,
  pending14dPlus: 2,
  pending30dPlus: 1,
  pending60dPlus: 0,
};
const DECISIONS: DecisionsMetrics = {
  approved7d: 4,
  rejected7d: 2,
  approved30d: 11,
  rejected30d: 3,
  revocations30d: 1,
};
const ENO: EnoSlaMetric = {
  total: 6,
  onTime: 6,
  onTimePct: 100,
  breachedOpen: 0,
  medianLatencyHours: 2,
} as EnoSlaMetric;

const TIMEOUT = { degraded: "timeout" } as const;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const fn of Object.values(mocks)) fn.mockReset();
});

// ---------------------------------------------------------------------------
// budgetedOrDegraded — mirrors db-budget.test.ts
// ---------------------------------------------------------------------------

describe("budgetedOrDegraded", () => {
  it("resolves the real value when the promise settles before the budget", async () => {
    const result = await budgetedOrDegraded(later("real", 5), 1000, "fast");
    expect(result).toBe("real");
  });

  it("resolves {degraded:'timeout'} when the budget elapses first", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await budgetedOrDegraded(later("real", 200), 20, "slow");
    expect(result).toEqual({ degraded: "timeout" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exceeded 20ms budget"));
  });

  it("resolves {degraded:'error'} when the promise rejects BEFORE the budget (never throws)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await budgetedOrDegraded(rejectLater(new Error("db down"), 5), 1000, "reject");
    expect(result).toEqual({ degraded: "error" });
    expect(errSpy).toHaveBeenCalled();
  });

  it("swallows a LATE rejection (after the budget) — never an unhandledRejection", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const result = await budgetedOrDegraded(rejectLater(new Error("late boom"), 60), 10, "late");
      expect(result).toEqual({ degraded: "timeout" });
      await new Promise((r) => setTimeout(r, 120));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("isDegraded discriminates the marker from real data", () => {
    expect(isDegraded(TIMEOUT)).toBe(true);
    expect(isDegraded({ degraded: "error" })).toBe(true);
    expect(isDegraded(USERS)).toBe(false);
    expect(isDegraded(null)).toBe(false);
    expect(isDegraded([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// KPI strip + stat cards — one slow query degrades ALONE, honestly
// ---------------------------------------------------------------------------

describe("SistemaKpiStrip", () => {
  it("renders the full 4-tile strip when every fetcher resolved", async () => {
    const node = await SistemaKpiStrip({
      users: Promise.resolve(USERS),
      queue: Promise.resolve(QUEUE),
      decisions: Promise.resolve(DECISIONS),
      enoSla: Promise.resolve(ENO),
    });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Usuarios personales");
    expect(html).toContain("SLA ENO");
  });

  it("a degraded core fetcher replaces the strip with the honest timeout notice — no invented zeros", async () => {
    const node = await SistemaKpiStrip({
      users: Promise.resolve(USERS),
      queue: Promise.resolve(TIMEOUT),
      decisions: Promise.resolve(DECISIONS),
      enoSla: Promise.resolve(ENO),
    });
    const html = renderToStaticMarkup(node);
    expect(html).toContain(`Esta sección tardó más de ${SISTEMA_KPI_BUDGET_MS / 1000}`);
    expect(html).toContain("Reintentá");
    // The strip must NOT render with fabricated values for the missing metric.
    expect(html).not.toContain("Usuarios personales");
  });

  it("ENO SLA degrades ALONE: 3-tile strip + explicit 'sin datos por demora' note", async () => {
    const node = await SistemaKpiStrip({
      users: Promise.resolve(USERS),
      queue: Promise.resolve(QUEUE),
      decisions: Promise.resolve(DECISIONS),
      enoSla: Promise.resolve(TIMEOUT),
    });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Usuarios personales");
    expect(html).toContain("SLA ENO: sin datos por demora");
    // No fabricated SLA tile.
    expect(html).not.toContain("Cumplimiento");
  });
});

describe("SistemaStatCards", () => {
  it("one degraded fetcher degrades ONLY its card; siblings render real data", async () => {
    const node = await SistemaStatCards({
      users: Promise.resolve(TIMEOUT),
      queue: Promise.resolve(QUEUE),
      decisions: Promise.resolve(DECISIONS),
    });
    const html = renderToStaticMarkup(node);
    // Usuarios card: honest notice, none of its rows.
    expect(html).toContain("Esta sección tardó más de 5");
    expect(html).not.toContain("Institucional activo");
    // Siblings keep their real numbers.
    expect(html).toContain("Pendientes");
    expect(html).toContain("Revocaciones · 30d");
    expect(html).toContain("4 / 11");
  });
});

// ---------------------------------------------------------------------------
// Self-fetching sections — hanging fetcher + fake timers = honest degraded card
// ---------------------------------------------------------------------------

describe("SistemaCronsCard", () => {
  it("renders cron rows when fetchCronRuns resolves", async () => {
    mocks.fetchCronRuns.mockResolvedValue([
      {
        cronName: "drain_outbox",
        lastRunAt: new Date("2026-07-31T12:00:00Z"),
        lastStatus: "ok",
        itemsProcessed: 3,
        lastDetails: null,
      },
    ]);
    const html = renderToStaticMarkup(await SistemaCronsCard());
    expect(html).toContain("Crons");
    expect(html).toContain("3 items");
  });

  it("degrades to the honest timeout notice when fetchCronRuns hangs past its budget", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    mocks.fetchCronRuns.mockReturnValue(hang());
    const pending = SistemaCronsCard();
    await vi.advanceTimersByTimeAsync(SISTEMA_SECTION_BUDGET_MS + 1);
    const node = await pending;
    vi.useRealTimers();
    const html = renderToStaticMarkup(node);
    expect(html).toContain(`Esta sección tardó más de ${SISTEMA_SECTION_BUDGET_MS / 1000}`);
    expect(html).toContain("Reintentá");
    expect(html).not.toContain("Sin runs registrados");
  });
});

describe("SistemaCronsBanner", () => {
  it("renders the banner from the cheap fetchFailedCronNames query", async () => {
    mocks.fetchFailedCronNames.mockResolvedValue(["drain_outbox"]);
    const html = renderToStaticMarkup(await SistemaCronsBanner());
    expect(html).toContain("Procesos automáticos caídos");
    // Pilot T1-P5: it names the channel instead of "avisá a soporte".
    expect(html).toContain('href="mailto:hola@mimar.com.ar?subject=');
    expect(html).not.toContain("avisá a soporte");
  });

  it("renders NOTHING when the banner query hangs (unknown ≠ healthy claim)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    mocks.fetchFailedCronNames.mockReturnValue(hang());
    const pending = SistemaCronsBanner();
    await vi.advanceTimersByTimeAsync(SISTEMA_SECTION_BUDGET_MS + 1);
    const node = await pending;
    vi.useRealTimers();
    expect(node).toBeNull();
  });
});

describe("SistemaGovtActivity", () => {
  it("renders the activity table when fetchGovtActivity resolves", async () => {
    mocks.fetchGovtActivity.mockResolvedValue([
      {
        userId: "u1",
        displayName: "Municipalidad Demo",
        localitiesCount: 2,
        decisions30d: 5,
        lastActionAt: new Date("2026-07-30T12:00:00Z"),
      },
    ]);
    const html = renderToStaticMarkup(await SistemaGovtActivity());
    expect(html).toContain("Municipalidad Demo");
  });

  it("degrades to the honest timeout notice when fetchGovtActivity hangs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    mocks.fetchGovtActivity.mockReturnValue(hang());
    const pending = SistemaGovtActivity();
    await vi.advanceTimersByTimeAsync(SISTEMA_SECTION_BUDGET_MS + 1);
    const node = await pending;
    vi.useRealTimers();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Actividad por gobierno");
    expect(html).toContain(`Esta sección tardó más de ${SISTEMA_SECTION_BUDGET_MS / 1000}`);
    expect(html).not.toContain("No hay gobiernos activos");
  });
});
