// Unit tests: declared-by-owner chip/esterilización sign-off surface (#3).
//
// Strategy — pure mock-based, no DB (mirrors ./atender-access.test.ts). These
// cover PROJECTION shape (summary/prefill strings, latest-per-type, error
// copy). The signing RULE itself — "does a professional record of this act
// exist?" — is exercised against the real spine in
// ./atender-declared-events.db.test.ts, because that rule is a statement about
// how append-only rows relate to each other and a mock can assert it either
// way. The pre-fix version of this file "proved" the bug fixed by feeding an
// owner-filtered query a vet row it could never have returned.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Chainable @/db mock. Each terminal call (.orderBy() — both consumers now run
// the same pet-scoped list query) shifts one result array off dbState.results
// (FIFO).
const { chain, dbState } = vi.hoisted(() => {
  const dbState = { results: [] as unknown[][] };
  const terminal = () => Promise.resolve(dbState.results.shift() ?? []);
  const chain: Record<string, unknown> = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => terminal(),
    limit: () => terminal(),
  };
  return { chain, dbState };
});

vi.mock("@/db", () => ({
  db: chain,
  petEvents: {
    id: "id",
    petId: "pet_id",
    eventType: "event_type",
    occurredAt: "occurred_at",
    recordedAt: "recorded_at",
    payload: "payload",
    authorRole: "author_role",
    authorVerified: "author_verified",
    authorOrganizationId: "author_organization_id",
  },
}));

import {
  type SignerAuthorship,
  fetchPendingDeclaredEvents,
  rejectIfAlreadySigned,
} from "./atender-declared-events";

// The matriculated signer — the only tier that produces a SIGNATURE. The
// org_registered arm is pinned against the real spine in the .db.test.ts
// sibling (RA-2 F2), where the row relationships are not a mock's opinion.
const VET_SIGNER: SignerAuthorship = {
  authorRole: "vet",
  authorVerified: true,
  authorOrganizationId: "org-1",
};

function ownerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    petId: "pet-1",
    eventType: "microchip_implanted",
    occurredAt: new Date("2026-06-01T12:00:00Z"),
    payload: { chip_number: "985141004321456" },
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    ...overrides,
  };
}

function queue(...rows: unknown[][]) {
  dbState.results = rows;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.results = [];
});

describe("fetchPendingDeclaredEvents", () => {
  it("surfaces an owner-declared, unverified chip event", async () => {
    queue([ownerRow()]);
    const pending = await fetchPendingDeclaredEvents("pet-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: "evt-1",
      eventType: "microchip_implanted",
      // These two lines used to read
      //   summary: "Microchip 985141004321456"
      //   expect(pending[0].prefill.chipNumber).toBe("985141004321456")
      // — the third and last place that asserted the defect. Both the summary
      // and the prefill reach the browser (the prefill via the confirm link's
      // query string), and reaching the atender page needs only event.write in
      // ANY org plus a DIM token, which /perdidas publishes for every lost
      // animal with no login. The card says a declaration is WAITING; the
      // number stays server-side and the signer proves it by scanning.
      summary: "Microchip declarado",
    });
    expect(pending[0].prefill.chipNumber).toBeUndefined();
    expect(JSON.stringify(pending[0])).not.toContain("985141004321456");
  });

  it("surfaces an owner-declared, unverified sterilization event, procedure prefilled", async () => {
    queue([
      ownerRow({
        id: "evt-2",
        eventType: "sterilization_performed",
        payload: { procedure: "castration" },
      }),
    ]);
    const pending = await fetchPendingDeclaredEvents("pet-1");
    expect(pending).toEqual([
      expect.objectContaining({
        id: "evt-2",
        eventType: "sterilization_performed",
        summary: "Castración",
      }),
    ]);
    // Fila 10 (walkthrough 2026-08-31): the confirm link carried the date but
    // both procedure radios arrived unchecked — the vet re-picked a value the
    // card's own summary was displaying. The prefill now carries it. Unlike
    // the chip number, this discloses nothing: the summary above already says
    // "Castración" on the same card.
    expect(pending[0].prefill.procedure).toBe("castration");
  });

  it("does not prefill a procedure outside the closed vocabulary", async () => {
    // An unknown/legacy payload value must not ride a query string into the
    // form — the radio simply arrives unchecked, as before.
    queue([
      ownerRow({
        id: "evt-3",
        eventType: "sterilization_performed",
        payload: { procedure: "something-else" },
      }),
    ]);
    const pending = await fetchPendingDeclaredEvents("pet-1");
    expect(pending[0].summary).toBe("Esterilización");
    expect(pending[0].prefill.procedure).toBeUndefined();
  });

  it("excludes a declaration once a SEPARATE vet row signs the same chip", async () => {
    // The shape the real spine produces: the owner row is untouched (invariant
    // #2) and the signature is an additional row.
    queue([
      ownerRow({ id: "vet-signature", authorRole: "vet", authorVerified: true }),
      ownerRow({ id: "owner-declaration" }),
    ]);
    const pending = await fetchPendingDeclaredEvents("pet-1");
    expect(pending).toEqual([]);
  });

  it("ignores a vet row for a DIFFERENT chip (repeatable act, occurrence-scoped)", async () => {
    queue([
      ownerRow({ id: "owner-new-chip", payload: { chip_number: "985141009999999" } }),
      ownerRow({
        id: "vet-old-chip",
        authorRole: "vet",
        authorVerified: true,
        occurredAt: new Date("2024-01-01T12:00:00Z"),
      }),
    ]);
    const pending = await fetchPendingDeclaredEvents("pet-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("owner-new-chip");
  });

  it("does not treat org_registered (no matrícula) as a professional signature", async () => {
    queue([
      ownerRow({
        id: "org-record",
        authorRole: "shelter",
        authorVerified: false,
        authorOrganizationId: "org-1",
      }),
      ownerRow({ id: "owner-declaration" }),
    ]);
    const pending = await fetchPendingDeclaredEvents("pet-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("owner-declaration");
  });

  it("ignores event types outside the signable set", async () => {
    queue([
      ownerRow({ eventType: "vaccination_administered", payload: { vaccine_name: "Antirrábica" } }),
    ]);
    const pending = await fetchPendingDeclaredEvents("pet-1");
    expect(pending).toEqual([]);
  });

  it("keeps only the latest row per type", async () => {
    queue([
      ownerRow({ id: "evt-newest", occurredAt: new Date("2026-07-01T00:00:00Z") }),
      ownerRow({ id: "evt-older", occurredAt: new Date("2026-01-01T00:00:00Z") }),
    ]);
    const pending = await fetchPendingDeclaredEvents("pet-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("evt-newest");
  });
});

describe("rejectIfAlreadySigned — append-only sign-off guard", () => {
  it("returns null (safe to sign) for a still-pending declared event", async () => {
    queue([ownerRow()]);
    const result = await rejectIfAlreadySigned("pet-1", "microchip_implanted", "evt-1", VET_SIGNER);
    expect(result).toBeNull();
  });

  it("rejects (no-op) an already professional_verified event", async () => {
    queue([ownerRow({ authorRole: "vet", authorVerified: true })]);
    const result = await rejectIfAlreadySigned("pet-1", "microchip_implanted", "evt-1", VET_SIGNER);
    expect(result?.error).toMatch(/ya fue firmado/i);
  });

  it("rejects when a SEPARATE vet row already signed the same chip", async () => {
    queue([
      ownerRow({ id: "vet-signature", authorRole: "vet", authorVerified: true }),
      ownerRow({ id: "evt-1" }),
    ]);
    const result = await rejectIfAlreadySigned("pet-1", "microchip_implanted", "evt-1", VET_SIGNER);
    expect(result?.error).toMatch(/ya fue firmado/i);
  });

  it("still allows signing a DIFFERENT chip while an older chip is signed", async () => {
    queue([
      ownerRow({ id: "evt-1", payload: { chip_number: "985141009999999" } }),
      ownerRow({
        id: "vet-old-chip",
        authorRole: "vet",
        authorVerified: true,
        occurredAt: new Date("2024-01-01T12:00:00Z"),
      }),
    ]);
    const result = await rejectIfAlreadySigned("pet-1", "microchip_implanted", "evt-1", VET_SIGNER);
    expect(result).toBeNull();
  });

  it("rejects when the target event belongs to a different pet", async () => {
    queue([ownerRow({ petId: "other-pet" })]);
    const result = await rejectIfAlreadySigned("pet-1", "microchip_implanted", "evt-1", VET_SIGNER);
    expect(result?.error).toMatch(/ya no está disponible/i);
  });

  it("rejects when the target event is a different event type", async () => {
    queue([ownerRow({ eventType: "sterilization_performed" })]);
    const result = await rejectIfAlreadySigned("pet-1", "microchip_implanted", "evt-1", VET_SIGNER);
    expect(result?.error).toMatch(/ya no está disponible/i);
  });

  it("rejects when the target event no longer exists", async () => {
    queue([]);
    const result = await rejectIfAlreadySigned(
      "pet-1",
      "microchip_implanted",
      "evt-missing",
      VET_SIGNER,
    );
    expect(result?.error).toMatch(/ya no está disponible/i);
  });
});
