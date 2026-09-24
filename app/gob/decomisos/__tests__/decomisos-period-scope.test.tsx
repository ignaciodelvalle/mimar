// @vitest-environment jsdom
//
// /gob/decomisos — the period selector filters the KPI block and NOTHING else.
//
// The code has known this since the filter bar landed ("the seizures KPI below
// is the only period-aware element on this screen", page.tsx) but the SCREEN
// never said it: an operator moved the period to 7 días, watched the KPI drop
// and the list underneath stay identical, and had no way to tell whether the
// list was stale, broken, or simply not period-aware. Worse in the empty case —
// a narrow period over an empty list reads as "no hay decomisos EN ESTE
// PERÍODO" when the list never looked at the period at all.
//
// This pins the disclosure, not the behaviour: making the list period-aware is
// a product decision and is deliberately NOT taken here.

import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/gob/decomisos",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireDecomisoPrincipal: vi.fn(async () => ({
    user: { id: "admin-1", email: "admin@dim.test" },
    profile: { id: "admin-1", role: "admin" },
    jurisdictions: [],
  })),
}));

vi.mock("@/src/modules/decomiso/application/resolve-govt-org", () => ({
  // The page now resolves the authority org for EVERY role (admin included)
  // to decide read-only vs executable — these render tests mock the db with a
  // minimal chain, so the real query cannot run here.
  resolveGovtOrgForUser: vi.fn(async () => ({
    id: "org-badge-test",
    displayName: "Autoridad Test",
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "Palermo",
  })),
}));

vi.mock("@/lib/analytics/compliance-metrics", () => ({
  fetchSeizures: vi.fn(async () => ({ total: 4, byMotive: [] })),
}));

vi.mock("@/components/ui/dashboard/DashboardFreshnessFooter", () => ({
  DashboardFreshnessFooter: () => null,
}));

// Every query on this page ends in `.limit(n)`; both resolve to no rows, which
// is the harder (and more misleading) case for the disclosure.
vi.mock("@/db", async () => {
  const actual = await vi.importActual<typeof import("@/db")>("@/db");
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "from", "leftJoin", "where", "orderBy"]) {
    chain[method] = () => chain;
  }
  chain.limit = async () => [];
  return { ...actual, db: chain };
});

import DecomisosDashboardPage from "../page";

async function renderPage(): Promise<string> {
  const element = await DecomisosDashboardPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element);
}

describe("/gob/decomisos — the period selector declares what it does NOT filter", () => {
  it("labels the episode list as period-independent", async () => {
    const html = await renderPage();

    expect(html).toContain("El período seleccionado no filtra este listado");
  });

  it("keeps the KPI block's 'período seleccionado' framing, so the contrast is legible", async () => {
    const html = await renderPage();

    expect(html).toContain("Decomisos del período seleccionado");
  });
});
