// @vitest-environment jsdom
//
// /admin/adopciones — species axis wiring smoke test (Fase B "regalos
// olvidados" twin port, 2026-07-22). /gob/adopciones already exposes an
// Especie axis whose value narrows fetchCustodyFunnel/fetchTimeInState/
// fetchReturnRate/fetchAdoptionTrend/fetchPrevAdoptionCount via opts.species
// (all five fetchers already accepted the param). fetchFosterPoolUtilization
// and fetchShelterOccupancyNational deliberately do NOT take species (no
// species dimension / org-level denominator — same as /gob/adopciones) so
// they are asserted to be called with ZERO extra args, proving the honest
// exclusion wasn't silently dropped either way. Fetcher-level narrowing
// itself is byte-identical code already exercised in production by
// /gob/adopciones.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireAdminOrRedirect: vi.fn(async () => ({
    profile: { id: "admin-1", role: "admin" },
  })),
}));

// DashboardFreshnessFooter is an async Server Component (fetches its own
// freshness timestamp) — renderToStaticMarkup can't resolve an async
// component synchronously ("component suspended while responding to
// synchronous input"). Same stub used by app/gob/usuarios/page.test.tsx.
vi.mock("@/components/ui/dashboard/DashboardFreshnessFooter", () => ({
  DashboardFreshnessFooter: () => null,
}));

// vi.mock factories are hoisted above top-level const declarations — mocks
// referenced inside a factory must be created via vi.hoisted (plain
// top-level consts throw "Cannot access before initialization").
const mocks = vi.hoisted(() => ({
  fetchCustodyFunnel: vi.fn(async (_ctx: unknown, _opts?: { species?: string }) => ({
    intake: 4,
    foster: 3,
    adoption: 2,
    reversed: 1,
  })),
  fetchTimeInState: vi.fn(async (_ctx: unknown, _opts?: { species?: string }) => []),
  fetchReturnRate: vi.fn(async (_ctx: unknown, _opts?: { species?: string }) => 0.1),
  fetchFosterPoolUtilization: vi.fn(async (_ctx: unknown) => ({
    activeVolunteers: 1,
    withCapacity: 1,
    activeFosterPlacements: 1,
  })),
  fetchShelterOccupancyNational: vi.fn(async (_ctx: unknown) => ({
    occupied: 1,
    capacity: 10,
    pct: 10,
  })),
  fetchAdoptionTrend: vi.fn(async (_ctx: unknown, _opts?: { species?: string }) => ({
    granularity: "month" as const,
    points: [],
    suppressedCount: 0,
  })),
  fetchPrevAdoptionCount: vi.fn(async (_ctx: unknown, _opts?: { species?: string }) => 0),
}));

vi.mock("@/lib/metrics/custody", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metrics/custody")>();
  return { ...actual, ...mocks };
});

import AdminAdopcionesPage from "./page";

const {
  fetchCustodyFunnel,
  fetchTimeInState,
  fetchReturnRate,
  fetchFosterPoolUtilization,
  fetchShelterOccupancyNational,
  fetchAdoptionTrend,
  fetchPrevAdoptionCount,
} = mocks;

function clearAll() {
  for (const fn of [
    fetchCustodyFunnel,
    fetchTimeInState,
    fetchReturnRate,
    fetchFosterPoolUtilization,
    fetchShelterOccupancyNational,
    fetchAdoptionTrend,
    fetchPrevAdoptionCount,
  ]) {
    fn.mockClear();
  }
}

describe("/admin/adopciones — species axis wiring", () => {
  it("no ?species param → the 5 species-aware fetchers receive species: undefined", async () => {
    clearAll();
    await AdminAdopcionesPage({ searchParams: Promise.resolve({}) });

    expect(fetchCustodyFunnel.mock.calls[0]?.[1]).toEqual({ species: undefined });
    expect(fetchTimeInState.mock.calls[0]?.[1]).toEqual({ species: undefined });
    expect(fetchReturnRate.mock.calls[0]?.[1]).toEqual({ species: undefined });
    expect(fetchAdoptionTrend.mock.calls[0]?.[1]).toEqual({ species: undefined });
    expect(fetchPrevAdoptionCount.mock.calls[0]?.[1]).toEqual({ species: undefined });
  });

  it("?species=other reaches ALL FIVE species-aware fetchers — no dead filter", async () => {
    clearAll();
    const node = await AdminAdopcionesPage({
      searchParams: Promise.resolve({ species: "other" }),
    });
    renderToStaticMarkup(node);

    expect(fetchCustodyFunnel.mock.calls[0]?.[1]).toEqual({ species: "other" });
    expect(fetchTimeInState.mock.calls[0]?.[1]).toEqual({ species: "other" });
    expect(fetchReturnRate.mock.calls[0]?.[1]).toEqual({ species: "other" });
    expect(fetchAdoptionTrend.mock.calls[0]?.[1]).toEqual({ species: "other" });
    expect(fetchPrevAdoptionCount.mock.calls[0]?.[1]).toEqual({ species: "other" });
  });

  it("fosterPool/shelterOccupancy stay species-blind by design (honest exclusion)", async () => {
    clearAll();
    await AdminAdopcionesPage({ searchParams: Promise.resolve({ species: "dog" }) });

    // Called with ONLY ctx — no second (species) argument, matching
    // /gob/adopciones' deliberate exclusion (no species dimension / org-level
    // denominator that can't be split by species).
    expect(fetchFosterPoolUtilization.mock.calls[0]).toHaveLength(1);
    expect(fetchShelterOccupancyNational.mock.calls[0]).toHaveLength(1);
  });

  it("renders the Especie axis control (twin of /gob/adopciones' rail)", async () => {
    const node = await AdminAdopcionesPage({ searchParams: Promise.resolve({ species: "cat" }) });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Especie");
  });
});
