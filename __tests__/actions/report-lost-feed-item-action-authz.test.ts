// `reportLostFeedItemAction` — the WEB door of content reporting, and the
// authorization it was missing.
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// The org refusal shipped in the API's `checkCommandGuard` only. The mobile door
// was closed; this one was wide open — while THREE documents (AGENTS.md § 6c,
// the feature commit body, and `content-reports.ts`) asserted the control
// existed. The web component withheld the button on the org variant, and that
// looked like a fix: it is not one. The action is imported and bound at module
// level in a component that renders on BOTH variants, so its action id ships to
// the org client and can simply be POSTed. A HIDDEN BUTTON IS NOT AN
// AUTHORIZATION CONTROL.
//
// `requirePetAccess` answers ok for the org path and does not check
// `event.write` (that gate is in `requireAlivePetAccess`, which this action does
// not call), and the use-case contains no author-role refusal by design. So
// nothing anywhere on the web path refused an org, and the exact scenario the
// feature commit names in capitals was live: an org holding `shelter_custody`
// making a finder's "tengo a tu perro, llamame" vanish pet-globally from the
// owner's feed, counter, credential, /perdidas and /casos.
//
// The lesson is the one this range keeps re-learning: a control asserted in
// prose is not a control. This file is the assertion those three documents were
// standing in for.

import { beforeEach, describe, expect, it, vi } from "vitest";

const BASE_PET = {
  id: "pet-1",
  publicToken: "DIM-TEST-0001",
  name: "Firulais",
  species: "dog",
  sex: "female",
  status: "lost",
};

const mockRequirePetAccess = vi.hoisted(() => vi.fn());
const mockRequireAlivePetAccess = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/pet-access", () => ({
  requirePetAccess: mockRequirePetAccess,
  requireAlivePetAccess: mockRequireAlivePetAccess,
}));

const mockReportLostFeedItem = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ error: null, alreadyReported: false }),
);
vi.mock("@/src/modules/events/application/lifecycle/report-lost-feed-item-use-case", () => ({
  reportLostFeedItem: mockReportLostFeedItem,
}));

vi.mock("@/src/modules/events/infrastructure/events-repository", () => ({
  EventsRepository: class {},
}));

// ABSOLUTE SPECIFIER, and the first draft got this wrong in a way worth keeping.
// It said `"./action-support"` — copied from how `actions.ts` imports it — but a
// `vi.mock` path resolves relative to THE TEST FILE, not to the code under test.
// It matched no module, so it was a silent no-op and the real module loaded.
// `lint:mocks` caught it; the test had been passing anyway, because the writer
// below is mocked and the transaction closure is only constructed, never run.
// A green test over a dead mock is exactly the bucketize fallout that fence
// exists for.
vi.mock("@/src/modules/events/action-support", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, makeTransaction: () => async (cb: (tx: unknown) => unknown) => cb({}) };
});

import { reportLostFeedItemAction } from "@/src/modules/events/actions";

const TARGET = "77777777-7777-4777-8777-777777777777";

function personAccess(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    accessPath: "owner",
    user: { id: "user-1" },
    pet: BASE_PET,
    eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
    ...overrides,
  };
}

function orgAccess() {
  return personAccess({
    accessPath: "org",
    eventAuthorship: {
      authorRole: "shelter",
      authorOrganizationId: "org-1",
      authorVerified: true,
    },
  });
}

beforeEach(() => {
  mockRequirePetAccess.mockReset();
  mockReportLostFeedItem.mockClear();
  mockReportLostFeedItem.mockResolvedValue({ error: null, alreadyReported: false });
});

describe("reportLostFeedItemAction — who may report on the web door", () => {
  it("REFUSES the org path and writes NOTHING", async () => {
    mockRequirePetAccess.mockResolvedValue(orgAccess());

    const result = await reportLostFeedItemAction(BASE_PET.publicToken, TARGET, "harassment", null);

    expect(result.error).not.toBeNull();
    // The writer is never reached — the refusal is at the action edge, not a
    // failure deeper down that happens to look like one.
    expect(mockReportLostFeedItem).not.toHaveBeenCalled();
  });

  it("still lets the PERSON path report — the refusal is one path wide", async () => {
    // NON-VACUITY for the assertion above: if the guard had been written as
    // "refuse unless titular" this would fail too, and the first test would be
    // passing for the wrong reason.
    mockRequirePetAccess.mockResolvedValue(personAccess());

    const result = await reportLostFeedItemAction(BASE_PET.publicToken, TARGET, "harassment", null);

    expect(result).toEqual({ error: null, ok: true });
    expect(mockReportLostFeedItem).toHaveBeenCalledTimes(1);
  });

  it("lets a CARETAKER report — they arrive on the person path the titular opened", async () => {
    // A caretaker signs with OWNER_AUTHORSHIP, not `authorRole: "caretaker"` —
    // that is not a legal `PetEventAuthorship` value. An earlier draft of this
    // fixture used it: harmless, because the action never branches on authorship,
    // but a fixture depicting an impossible row teaches the next reader a shape
    // the system cannot produce. What actually distinguishes a caretaker here is
    // the ACCESS PATH (person, not org), which is what the guard reads.
    mockRequirePetAccess.mockResolvedValue(
      personAccess({
        eventAuthorship: {
          authorRole: "owner",
          authorOrganizationId: null,
          authorVerified: false,
        },
      }),
    );

    const result = await reportLostFeedItemAction(BASE_PET.publicToken, TARGET, "spam", null);

    expect(result.error).toBeNull();
    expect(mockReportLostFeedItem).toHaveBeenCalledTimes(1);
  });

  it("refuses a caller with no access at all, before anything else", async () => {
    mockRequirePetAccess.mockResolvedValue({ ok: false, error: "No tenés acceso." });

    const result = await reportLostFeedItemAction(BASE_PET.publicToken, TARGET, "other", null);

    expect(result.error).toBe("No tenés acceso.");
    expect(mockReportLostFeedItem).not.toHaveBeenCalled();
  });
});
