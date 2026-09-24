// @vitest-environment jsdom
//
// /gob/decomisos — operator-queue anatomy alignment (A5, 2026-07-30).
//
// The six operator queues were measured and five distinct row anatomies were
// found. The dominant one — components/ui/dashboard/CaseQueue.tsx, used by 4
// operator surfaces — renders every identifier through the shared OpCodeBadge
// atom. This queue rendered its case code as a bare mono <Link> and the pet
// token as bare mono text.
//
// The alignment adopts the ATOM inside the existing card (this queue keeps its
// OpCard rows and inline Reasignar/Devolver actions — a <table> would break
// them). Tones carry the distinction the old markup made with ad-hoc classes:
// blue for the row's own linked case code, neutral for the pet token, which is
// a reference to another record.
//
// The expected markup is READ FROM OpCodeBadge itself rather than hardcoded, so
// the test pins "goes through the shared atom" instead of a class list that
// would drift the moment the atom is restyled.
//
// Mocking mirrors decomisos-period-scope.test.tsx; the only difference is that
// the first `.limit()` (the episode list) resolves to ONE row instead of none.

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

const OPENED_AT = new Date("2026-06-19T13:00:00Z");
const CLOSED_AT = new Date("2026-06-24T13:00:00Z");

// A CLOSED episode: canReassign / canReturnToOwner are both false, so the row's
// client action buttons stay out of this render. The code + date treatment
// under test is identical on open rows.
const EPISODE_ROW = {
  c: {
    id: "case-1",
    publicCode: "CAS-DECO-0001",
    status: "closed",
    receiverOrganizationId: null,
    openedAt: OPENED_AT,
    closedAt: CLOSED_AT,
  },
  petName: "Firulais",
  petToken: "DIM-DECO-0001",
  petSpecies: "dog",
  receiverName: null,
};

// Every render of the page issues exactly two `.limit(200)` queries, in order:
// the episode list, then the verified-orgs list for the Reasignar combobox.
// The mock is module-scoped and outlives a single test, so it cycles per PAIR
// (odd call = episode list) instead of counting from one — counting absolutely
// would silently starve every test after the first.
vi.mock("@/db", async () => {
  const actual = await vi.importActual<typeof import("@/db")>("@/db");
  let limitCalls = 0;
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "from", "leftJoin", "where", "orderBy"]) {
    chain[method] = () => chain;
  }
  chain.limit = async () => {
    limitCalls += 1;
    return limitCalls % 2 === 1 ? [EPISODE_ROW] : [];
  };
  return { ...actual, db: chain };
});

import { OpCodeBadge } from "@/components/ui/dashboard";
import { formatDate } from "@/lib/utils/format";

import DecomisosDashboardPage from "../page";

async function renderPage(): Promise<string> {
  const element = await DecomisosDashboardPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element);
}

/** The exact markup the shared atom produces for a given code + tone. */
function codeBadgeMarkup(tone: "blue" | "neutral", code: string): string {
  return renderToStaticMarkup(<OpCodeBadge tone={tone}>{code}</OpCodeBadge>);
}

describe("/gob/decomisos — dominant-anatomy atoms (A5)", () => {
  it("renders the case code through the shared OpCodeBadge atom, still inside its link", async () => {
    const html = await renderPage();

    expect(html).toContain(codeBadgeMarkup("blue", "CAS-DECO-0001"));
    expect(html).toContain('href="/gob/casos/CAS-DECO-0001"');
  });

  it("renders the pet token through the same atom, toned as the secondary reference", async () => {
    const html = await renderPage();

    expect(html).toContain(codeBadgeMarkup("neutral", "DIM-DECO-0001"));
  });

  it("keeps the absolute formatDate vocabulary alongside the elapsed-days counter", async () => {
    // This queue was already on the dominant date vocabulary — the alignment
    // must not regress it. It is also the precedent the whole date decision
    // rests on: an absolute date next to a prominent elapsed-days figure.
    const html = await renderPage();

    expect(html).toContain(`Abierto el ${formatDate(OPENED_AT)}`);
    expect(html).toContain(`Cerrado el ${formatDate(CLOSED_AT)}`);
    expect(html).toContain("días");
  });
});
