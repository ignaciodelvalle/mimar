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
