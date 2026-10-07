// The "Esperan tu respuesta" read: what it picks, the order it keeps, and that a
// slow or failing read degrades to `null` instead of reaching the page.
//
// The repositories are FAKES at the port boundary, so the two real use-cases
// (`listTransfersForUser`, `listCaretakerGrantsForUser`) run in between — the
// selection is tested against what they actually return, capabilities included.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/report-error", () => ({ reportError: vi.fn() }));

import { loadPendingIncoming, selectPendingIncoming } from "./pending-incoming";

const ME = "11111111-1111-4111-8111-111111111111";
const GRACIELA = "22222222-2222-4222-8222-222222222222";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function grantRow(over: {
  token: string;
  status?: string;
  startsInDays?: number;
  endsInDays?: number;
  grantedBy?: string;
  caretakerUserId?: string | null;
  grantedByDisplayName?: string | null;
  petName?: string;
}) {
  return {
    grant: {
      publicToken: over.token,
      status: over.status ?? "pending",
      petId: `pet-${over.token}`,
      grantedByUserId: over.grantedBy ?? GRACIELA,
      caretakerUserId: over.caretakerUserId === undefined ? ME : over.caretakerUserId,
      caretakerEmail: "po@example.com",
      startsAt: new Date(NOW + (over.startsInDays ?? 1) * DAY),
      endsAt: new Date(NOW + (over.endsInDays ?? 8) * DAY),
      note: null,
    },
    petName: over.petName ?? "Pampita",
    petToken: `DIM-${over.token}`,
    petSpecies: "ferret",
    grantedByDisplayName:
      over.grantedByDisplayName === undefined ? "Graciela" : over.grantedByDisplayName,
    caretakerDisplayName: "PO",
  };
}

function transferRow(over: {
  token: string;
  status?: string;
  expiresInDays?: number;
  from?: string;
  to?: string;
  petName?: string;
}) {
  return {
    transfer: {
      publicToken: over.token,
      status: over.status ?? "pending",
      petId: `pet-${over.token}`,
      fromOwnerId: over.from ?? GRACIELA,
      toOwnerId: over.to ?? ME,
      toOwnerEmail: "po@example.com",
      reason: "gift",
      note: null,
      rejectionReason: null,
      initiatedAt: new Date(NOW - DAY),
      respondedAt: null,
      expiresAt: new Date(NOW + (over.expiresInDays ?? 6) * DAY),
    },
    petName: over.petName ?? "Tango",
    petToken: `DIM-${over.token}`,
    petSpecies: "dog",
    fromDisplayName: "Graciela",
    toDisplayName: "PO",
  };
}

function repos(grants: unknown[], transfers: unknown[]) {
  return {
    caretakersRepo: { listGrantsForUser: vi.fn(async () => grants) } as never,
    transfersRepo: { listTransfersForUser: vi.fn(async () => transfers) } as never,
  };
}

const CALLER = { userId: ME, callerEmail: "", callerEmailConfirmed: false };

afterEach(() => {
  vi.useRealTimers();
});

describe("loadPendingIncoming — what waits on this person's answer", () => {
  it("returns the pending invitation and the pending offer, invitations first", async () => {
    const pending = await loadPendingIncoming(
      CALLER,
      repos([grantRow({ token: "CTG-1" })], [transferRow({ token: "PTR-1" })]),
    );

    expect(pending?.items.map((i) => [i.kind, i.token, i.href])).toEqual([
      ["caretaker", "CTG-1", "/cuidado/CTG-1"],
      ["transfer", "PTR-1", "/transferencias/PTR-1"],
    ]);
    const invitation = pending?.items[0];
    expect(invitation).toMatchObject({
      petName: "Pampita",
      petSpecies: "ferret",
      counterpartyName: "Graciela",
    });
  });

  it("leaves out what this person can no longer say yes to", async () => {
    const pending = await loadPendingIncoming(
      CALLER,
      repos(
        [
          // Already accepted — an arrangement, not a question.
          grantRow({ token: "CTG-ACCEPTED", status: "accepted" }),
          // The period lapsed before the sweep reached it: accept is refused.
          grantRow({ token: "CTG-LAPSED", startsInDays: -9, endsInDays: -1 }),
          // The caller GRANTED it — outgoing, never "waiting on you".
          grantRow({ token: "CTG-MINE", grantedBy: ME, caretakerUserId: GRACIELA }),
        ],
        [
          transferRow({ token: "PTR-EXPIRED", expiresInDays: -1 }),
          transferRow({ token: "PTR-ANSWERED", status: "rejected" }),
          transferRow({ token: "PTR-SENT", from: ME, to: GRACIELA }),
        ],
      ),
    );

    expect(pending).toEqual({ items: [] });
  });

  it("orders invitations by start and offers by expiry", async () => {
    const pending = await loadPendingIncoming(
      CALLER,
      repos(
        [
          grantRow({ token: "CTG-LATER", startsInDays: 5, endsInDays: 9 }),
          grantRow({ token: "CTG-SOONER", startsInDays: 1, endsInDays: 3 }),
        ],
        [
          transferRow({ token: "PTR-LATER", expiresInDays: 6 }),
          transferRow({ token: "PTR-SOONER", expiresInDays: 2 }),
        ],
      ),
    );

    expect(pending?.items.map((i) => i.token)).toEqual([
      "CTG-SOONER",
      "CTG-LATER",
      "PTR-SOONER",
      "PTR-LATER",
    ]);
  });

  it("a failed read resolves null — never rejects into the page", async () => {
    const deps = {
      caretakersRepo: {
        listGrantsForUser: vi.fn(async () => {
          throw new Error("57P01 terminating connection");
        }),
      } as never,
      transfersRepo: { listTransfersForUser: vi.fn(async () => []) } as never,
    };

    await expect(loadPendingIncoming(CALLER, deps)).resolves.toBeNull();
  });

  it("a read that outlives its budget resolves null", async () => {
    const deps = {
      caretakersRepo: { listGrantsForUser: vi.fn(() => new Promise(() => {})) } as never,
      transfersRepo: { listTransfersForUser: vi.fn(async () => []) } as never,
    };

    await expect(loadPendingIncoming(CALLER, deps, 20)).resolves.toBeNull();
  });

  it("passes the caller's identity through to both addressee predicates", async () => {
    const deps = repos([], []);
    await loadPendingIncoming(
      { userId: ME, callerEmail: "PO@Example.com", callerEmailConfirmed: true },
      deps,
    );

    const caretakers = (
      deps.caretakersRepo as unknown as { listGrantsForUser: ReturnType<typeof vi.fn> }
    ).listGrantsForUser;
    const transfers = (
      deps.transfersRepo as unknown as { listTransfersForUser: ReturnType<typeof vi.fn> }
    ).listTransfersForUser;
    expect(caretakers).toHaveBeenCalledWith({ userId: ME, callerEmail: "po@example.com" });
    expect(transfers).toHaveBeenCalledWith({ userId: ME, callerEmail: "po@example.com" });
  });
});

describe("selectPendingIncoming", () => {
  it("is empty when both hubs are empty", () => {
    expect(
      selectPendingIncoming(
        { incoming: { pending: [], history: [] }, outgoing: [] },
        { incoming: [], outgoing: [] },
      ),
    ).toEqual({ items: [] });
  });
});
