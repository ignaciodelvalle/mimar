// @vitest-environment jsdom
//
// /org/[orgToken]/agenda — the DENIAL branch (native QA batch 2, C3; code
// review #4, 2026-09-04).
//
// The bug this pins: the page answered a missing `appointment.manage` with
// `notFound()`, so a member of the organization was shown "No encontramos esta
// página" for a page that exists, inside an org they provably belong to
// (`requireOrgAccessByToken` refuses every non-member before this point). Its
// sibling `/org/{token}/checkins` has always answered "Sin acceso — pedile el
// alta a un administrador", which is both true and actionable.
//
// THE STRING NOW COMES FROM requireCapability's OWN `error`, not a literal
// copy of it (code review #4). The page used to call `getGrantedCapabilities`
// and hardcode a sentence that happened to match authz-resolver.ts's wording —
// a copy that could have drifted silently. There is no exported constant for
// the message in authz-resolver.ts (it is inlined at its two call sites), so
// DENIAL_MESSAGE below is still a literal — that is a normal test oracle
// asserting an expected value, not the drift risk the page-level fix closes.
//
// Only the denial branch is exercised here. The granted branch runs two Drizzle
// queries against the live local database and is covered by the flows that own
// it; a "renders the agenda" assertion built on a hand-mocked query builder
// would pin the mock, not the page.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireOrgAccess, mockRequireCapability } = vi.hoisted(() => ({
  mockRequireOrgAccess: vi.fn(),
  mockRequireCapability: vi.fn(),
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireOrgAccessByToken: (orgToken: string) => mockRequireOrgAccess(orgToken),
}));

vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  requireCapability: (capability: string, organizationId?: string, options?: unknown) =>
    mockRequireCapability(capability, organizationId, options),
}));

// A stub Drizzle chain for the GRANTED branch's two queries (vet-visit-record,
// W1). Every intermediate method returns the chain itself; the terminal
// `.orderBy()` shifts one fixture array off a FIFO queue — [appointment rows,
// slot-occupancy rows], the same order page.tsx's Promise.all issues them in.
// This does not pin the page to Drizzle's real query semantics (the header
// comment above rules that out) — it only hands back plain objects shaped
// exactly like page.tsx destructures them, so it stays a rendering test, not
// a query test.
const { dbChain, dbState } = vi.hoisted(() => {
  const dbState = { results: [] as unknown[][] };
  const dbChain: Record<string, unknown> = {
    select: () => dbChain,
    from: () => dbChain,
    innerJoin: () => dbChain,
    leftJoin: () => dbChain,
    where: () => dbChain,
    orderBy: () => Promise.resolve(dbState.results.shift() ?? []),
  };
  return { dbChain, dbState };
});

vi.mock("@/db", () => ({
  db: dbChain,
  appointments: {},
  pets: {},
  profiles: {},
  serviceOfferings: {},
  timeSlots: {},
}));

import OrgAgendaPage from "./page";

const ORG_TOKEN = "ORG-TEST-0001";
const DENIAL_MESSAGE = "No tenés permiso para esta acción. Pedile el alta a un administrador.";

async function renderDenied() {
  mockRequireOrgAccess.mockResolvedValue({
    organization: { id: "org-1", displayName: "Refugio Pampa" },
    membership: { id: "mem-1", organizationId: "org-1" },
  });
  mockRequireCapability.mockResolvedValue({
    user: { id: "user-1" },
    membership: null,
    organization: null,
    granted: null,
    error: DENIAL_MESSAGE,
  });
  const node = await OrgAgendaPage({
    params: Promise.resolve({ orgToken: ORG_TOKEN }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(node);
}

beforeEach(() => {
  mockRequireOrgAccess.mockReset();
  mockRequireCapability.mockReset();
});

describe("/org/[orgToken]/agenda — a member without appointment.manage", () => {
  it("renders the honest denial instead of throwing a 404", async () => {
    // Before the fix this line threw NEXT_NOT_FOUND — the assertion below could
    // not even be reached, which is exactly what the tester saw as a "page not
    // found" for a page that is right there.
    const html = await renderDenied();

    expect(html).toContain("Sin acceso");
  });

  it("says what to do about it, in the same words checkins uses", async () => {
    const html = await renderDenied();

    expect(html).toContain(DENIAL_MESSAGE);
  });

  it("never claims the page does not exist", async () => {
    const html = await renderDenied();

    expect(html).not.toContain("No encontramos esta página");
  });

  it("leaves a way back to the org panel", async () => {
    const html = await renderDenied();

    expect(html).toContain(`href="/org/${ORG_TOKEN}"`);
    expect(html).toContain("Volver al panel");
  });

  it("still resolves the org from the URL token before deciding anything, and pins the capability check to it", async () => {
    await renderDenied();

    // The confused-deputy guard is untouched by this change: the capability
    // check is still pinned to THIS token's org.id (via requireCapability's
    // second argument), not to a session-default membership.
    expect(mockRequireOrgAccess).toHaveBeenCalledWith(ORG_TOKEN);
    expect(mockRequireCapability).toHaveBeenCalledWith("appointment.manage", "org-1", {
      access: "read",
    });
  });
});

// vet-visit-record W1 — the appointments list shows WHERE the care happens.
// Regression pinned by the verify report: the granted branch rendered
// `appointment.modality` (page.tsx ~343) with no test ever asserting it.
describe("/org/[orgToken]/agenda — appointments show their modality", () => {
  function appointmentRow(modality: string, overrides: Record<string, unknown> = {}) {
    return {
      appointment: {
        id: `apt-${modality}`,
        publicToken: `TURNO-${modality.toUpperCase()}`,
        status: "confirmed",
        modality,
      },
      slot: { id: `slot-${modality}`, startsAt: new Date("2026-09-29T15:00:00Z") },
      offering: { serviceKind: "vaccination", displayName: "Vacunación" },
      pet: { name: `Mascota ${modality}` },
      ownerProfile: { displayName: "Dueño Test", phone: null },
      ...overrides,
    };
  }

  beforeEach(() => {
    mockRequireOrgAccess.mockResolvedValue({
      organization: { id: "org-1", displayName: "Refugio Pampa" },
      membership: { id: "mem-1", organizationId: "org-1" },
    });
    mockRequireCapability.mockResolvedValue({
      user: { id: "user-1" },
      membership: { id: "mem-1" },
      organization: { id: "org-1", displayName: "Refugio Pampa" },
      granted: new Set(["appointment.manage"]),
      error: null,
    });
  });

  it("renders 'A domicilio' for a home appointment and 'En la clínica' for a clinic one", async () => {
    dbState.results = [
      [appointmentRow("home"), appointmentRow("clinic")],
      [], // no slot-occupancy rows for this day
    ];
    const node = await OrgAgendaPage({
      params: Promise.resolve({ orgToken: ORG_TOKEN }),
      searchParams: Promise.resolve({ fecha: "2026-09-29" }),
    });
    const html = renderToStaticMarkup(node);

    expect(html).toContain("A domicilio");
    expect(html).toContain("En la clínica");
  });
});
