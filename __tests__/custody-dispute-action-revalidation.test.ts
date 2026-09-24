// Every mutating custody-dispute action must revalidate the Casos hub.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The security review of T4-D1 found that `escalateDisputeAction` revalidated
// only the dispute detail page, while resolve and withdraw also revalidated
// `/gob/casos`. That was CORRECT before this change: escalation left a note in
// the timeline and altered nothing the queue rendered, so there was nothing on
// the hub to invalidate.
//
// Making escalation write `custody_disputes.status` silently changed that. The
// hub renders the dispute's state, so an escalation that skips the hub leaves
// the arbiter looking at a cached "Abierto" for a file that has moved into
// judicial hands — the exact "everything looks settled" failure the whole
// change exists to prevent, arriving through the cache instead of the query.
//
// So the property is not "escalate revalidates two paths". It is: a writer that
// changes what the queue shows must tell the queue. This asserts it for all
// three writers together, because the next one will be added by copying one of
// them and the odds of copying the incomplete one are exactly one in three.
//
// Pure unit test — the use-cases and the auth guard are mocked. It asserts the
// controller's revalidation contract, nothing about the database.

import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireAdminOrGovtOrRedirect: vi.fn(async () => ({
    user: { id: "11111111-1111-4111-8111-111111111111" },
    profile: { role: "admin" },
    jurisdictions: [],
  })),
}));

const escalateDisputeUseCase = vi.fn(async () => ({ escalatedAt: new Date() }));
const resolveDisputeUseCase = vi.fn(async () => ({ resolvedAt: new Date() }));
const withdrawDisputeUseCase = vi.fn(async () => ({ withdrawnAt: new Date() }));

vi.mock("@/src/modules/custody-disputes/application/escalate-dispute", () => ({
  escalateDisputeUseCase,
}));
vi.mock("@/src/modules/custody-disputes/application/resolve-dispute", () => ({
  resolveDisputeUseCase,
}));
vi.mock("@/src/modules/custody-disputes/application/withdraw-dispute", () => ({
  withdrawDisputeUseCase,
}));
vi.mock("@/src/modules/custody-disputes/application/add-dispute-party", () => ({
  addDisputePartyUseCase: vi.fn(),
}));
vi.mock("@/src/modules/custody-disputes/application/lookup-transfer-target", () => ({
  lookupTransferTargetUseCase: vi.fn(),
}));
vi.mock("@/src/modules/custody-disputes/application/search-party-candidates", () => ({
  searchPartyCandidatesUseCase: vi.fn(),
}));

const DISPUTE_TOKEN = "DIS-ABCD-1234";

beforeEach(() => {
  revalidatePath.mockClear();
});

async function actions() {
  return import("@/app/actions/custody-disputes");
}

describe("custody-dispute actions revalidate the Casos hub", () => {
  it("escalateDisputeAction revalidates /gob/casos and the detail page", async () => {
    const { escalateDisputeAction } = await actions();
    await escalateDisputeAction({
      disputeToken: DISPUTE_TOKEN,
      notes: "Motivo de escalada suficientemente largo para el test.",
    });
    const paths = revalidatePath.mock.calls.map((c) => c[0]);
    expect(paths).toContain("/gob/casos");
    expect(paths).toContain(`/gob/disputas/${DISPUTE_TOKEN}`);
  });

  it("resolveDisputeAction revalidates /gob/casos and the detail page", async () => {
    const { resolveDisputeAction } = await actions();
    await resolveDisputeAction({
      disputeToken: DISPUTE_TOKEN,
      resolution: "ownership_confirmed",
      resolutionSummary: "x".repeat(120),
    });
    const paths = revalidatePath.mock.calls.map((c) => c[0]);
    expect(paths).toContain("/gob/casos");
    expect(paths).toContain(`/gob/disputas/${DISPUTE_TOKEN}`);
  });

  it("withdrawDisputeAction revalidates /gob/casos and the detail page", async () => {
    const { withdrawDisputeAction } = await actions();
    await withdrawDisputeAction({ disputeToken: DISPUTE_TOKEN, reason: "motivo" });
    const paths = revalidatePath.mock.calls.map((c) => c[0]);
    expect(paths).toContain("/gob/casos");
    expect(paths).toContain(`/gob/disputas/${DISPUTE_TOKEN}`);
  });

  it("revalidates nothing when the use-case refuses", async () => {
    // The guard that keeps the assertions above honest: if the action
    // revalidated unconditionally, all three would pass even with the
    // success check deleted.
    escalateDisputeUseCase.mockResolvedValueOnce({ error: "no" } as never);
    const { escalateDisputeAction } = await actions();
    await escalateDisputeAction({ disputeToken: DISPUTE_TOKEN, notes: "x".repeat(30) });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
