// "Esperan tu respuesta" on Mis mascotas — the card, its words, and its read.
//
// WHAT THESE HAVE TO PROVE
// ---------------------------------------------------------------------------
//   1. EVERY ROW CARRIES WHAT IT TAKES TO DECIDE: who asked, the animal and its
//      species, the dates of the care or the day the offer lapses.
//   2. ONLY WHAT WAITS ON THIS PERSON'S YES — the server's `canAccept`, never a
//      status this phone re-derives. Accepted, lapsed and outgoing rows stay off.
//   3. EACH ROW OPENS THE EXISTING SCREEN where the answer is given.
//   4. NOTHING PENDING, OR A FAILED READ, DRAWS NOTHING — and a failed read never
//      throws into the screen people open most.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react-native";

import type {
  MyCaretakerGrantV1,
  MyCaretakerGrantsV1,
  MyTransferV1,
  MyTransfersV1,
} from "@dim/contract/api";

const mockFetchTransfers = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockFetchGrants = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("../api/endpoints", () => ({
  fetchMyTransfers: (...args: unknown[]) => mockFetchTransfers(...args),
  fetchMyCaretakerGrants: (...args: unknown[]) => mockFetchGrants(...args),
}));
jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import { PendingIncomingCard } from "./PendingIncomingCard";
import { PENDING_INCOMING_MAX_ROWS, pendingIncomingRows } from "./pending-incoming-view-model";
import { usePendingIncoming } from "./use-pending-incoming";

// Noon in Buenos Aires on both ends, so no AR-midnight rollover moves a day.
function aGrant(over: Partial<MyCaretakerGrantV1> = {}): MyCaretakerGrantV1 {
  return {
    grantToken: "CG-pamp0001",
    status: "pending",
    direction: "incoming",
    pet: { publicToken: "DIM-PAMP-0001", name: "Pampita", species: "ferret" },
    counterpartyName: "Graciela",
    caretakerEmail: "yo@example.com",
    startsAt: "2026-10-07T15:00:00.000Z",
    endsAt: "2026-10-14T15:00:00.000Z",
    note: null,
    expired: false,
    scopeSentence: "Podés cargar eventos. No podés transferir la titularidad.",
    capabilities: { canAccept: true, canReject: true, canCancel: false, canRevoke: false },
    ...over,
  };
}

function aTransfer(over: Partial<MyTransferV1> = {}): MyTransferV1 {
  return {
    transferToken: "PTR-TANG-0001",
    status: "pending",
    direction: "incoming",
    pet: { publicToken: "DIM-TANG-0001", name: "Tango", species: "dog" },
    counterpartyName: "Graciela",
    toEmail: "yo@example.com",
    reason: "gift",
    note: null,
    rejectionReason: null,
    initiatedAt: "2026-10-05T15:00:00.000Z",
    respondedAt: null,
    expiresAt: "2026-10-12T15:00:00.000Z",
    expired: false,
    capabilities: { canAccept: true, canReject: true, canCancel: false },
    ...over,
  };
}

function grants(incoming: MyCaretakerGrantV1[]): MyCaretakerGrantsV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-10-06T00:00:00.000Z",
    staleAfter: "2026-10-06T00:01:00.000Z",
    incoming,
    outgoing: [],
  } as MyCaretakerGrantsV1;
}

function transfers(pending: MyTransferV1[]): MyTransfersV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-10-06T00:00:00.000Z",
    staleAfter: "2026-10-06T00:01:00.000Z",
    incoming: { pending, history: [] },
    outgoing: [],
  } as MyTransfersV1;
}

beforeEach(() => {
  mockFetchTransfers.mockReset();
  mockFetchGrants.mockReset();
});

describe("pendingIncomingRows", () => {
  it("writes who, which animal and its species, and the dates — invitations first", () => {
    const rows = pendingIncomingRows(transfers([aTransfer()]), grants([aGrant()]));

    expect(rows.map((r) => [r.eyebrow, r.sentence, r.route, r.cta])).toEqual([
      [
        "Cuidado temporal",
        "Graciela te pidió que cuides a Pampita (Hurón) del 07/10 al 14/10.",
        "/cuidado/CG-pamp0001",
        "Ver invitación",
      ],
      [
        "Transferencia",
        "Graciela quiere transferirte a Tango (Perro). Vence el 12/10.",
        "/transferencias/PTR-TANG-0001",
        "Ver transferencia",
      ],
    ]);
  });

  it("keeps only what the SERVER says this person can still accept", () => {
    const rows = pendingIncomingRows(
      transfers([
        aTransfer({
          transferToken: "PTR-LAPSED",
          expired: true,
          capabilities: { canAccept: false, canReject: true, canCancel: false },
        }),
      ]),
      grants([
        aGrant({ grantToken: "CG-active", status: "accepted" }),
        aGrant({
          grantToken: "CG-lapsed",
          expired: true,
          capabilities: { canAccept: false, canReject: true, canCancel: false, canRevoke: false },
        }),
      ]),
    );

    expect(rows).toEqual([]);
  });

  it("without a display name it says so in the passive — never with an address", () => {
    const rows = pendingIncomingRows(
      transfers([aTransfer({ counterpartyName: null })]),
      grants([aGrant({ counterpartyName: null })]),
    );

    expect(rows[0]?.sentence).toMatch(/^Te pidieron que cuides a Pampita/);
    expect(rows[1]?.sentence).toMatch(/^Te quieren transferir a Tango/);
    expect(rows.map((r) => r.sentence).join(" ")).not.toContain("@");
  });

  it("is empty before either payload has arrived", () => {
    expect(pendingIncomingRows(null, null)).toEqual([]);
  });
});

describe("<PendingIncomingCard>", () => {
  it("draws each row with its sentence and opens the invitation screen", () => {
    const onOpenRoute = jest.fn();
    render(
      <PendingIncomingCard
        rows={pendingIncomingRows(transfers([aTransfer()]), grants([aGrant()]))}
        onOpenRoute={onOpenRoute}
        onOpenAll={() => {}}
      />,
    );

    expect(screen.getByText("Esperan tu respuesta · 2 pedidos")).toBeTruthy();
    expect(
      screen.getByText("Graciela te pidió que cuides a Pampita (Hurón) del 07/10 al 14/10."),
    ).toBeTruthy();

    fireEvent.press(screen.getByRole("button", { name: "Ver invitación" }));
    expect(onOpenRoute).toHaveBeenCalledWith("/cuidado/CG-pamp0001");

    fireEvent.press(screen.getByRole("button", { name: "Ver transferencia" }));
    expect(onOpenRoute).toHaveBeenCalledWith("/transferencias/PTR-TANG-0001");
  });

  it("caps the rows and hands the rest to Transferencias", () => {
    const onOpenAll = jest.fn();
    const many = Array.from({ length: PENDING_INCOMING_MAX_ROWS + 1 }, (_, i) =>
      aGrant({ grantToken: `CG-${i}`, startsAt: `2026-10-0${i + 1}T15:00:00.000Z` }),
    );
    render(
      <PendingIncomingCard
        rows={pendingIncomingRows(null, grants(many))}
        onOpenRoute={() => {}}
        onOpenAll={onOpenAll}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Ver invitación" })).toHaveLength(
      PENDING_INCOMING_MAX_ROWS,
    );
    fireEvent.press(screen.getByText("Ver 1 pedido más en Transferencias"));
    expect(onOpenAll).toHaveBeenCalled();
  });

  it("draws nothing when nothing is pending", () => {
    render(<PendingIncomingCard rows={[]} onOpenRoute={() => {}} onOpenAll={() => {}} />);

    expect(screen.queryByText(/Esperan tu respuesta/)).toBeNull();
  });
});

describe("usePendingIncoming", () => {
  it("reads both hubs and yields the pending rows", async () => {
    mockFetchTransfers.mockResolvedValue({ outcome: "ok", payload: transfers([aTransfer()]) });
    mockFetchGrants.mockResolvedValue({ outcome: "ok", payload: grants([aGrant()]) });
    const { result } = renderHook(() => usePendingIncoming());

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.rows.map((r) => r.kind)).toEqual(["caretaker", "transfer"]);
  });

  it("a failed read is quiet: nothing drawn, nothing thrown", async () => {
    mockFetchTransfers.mockResolvedValue({ outcome: "ok", payload: transfers([aTransfer()]) });
    mockFetchGrants.mockResolvedValue({ outcome: "network" });
    const { result } = renderHook(() => usePendingIncoming());

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.rows).toEqual([]);
  });

  it("a read that throws is swallowed — a banner is never worth a crash", async () => {
    mockFetchTransfers.mockRejectedValue(new Error("boom"));
    mockFetchGrants.mockResolvedValue({ outcome: "ok", payload: grants([aGrant()]) });
    const { result } = renderHook(() => usePendingIncoming());

    await act(async () => {
      await expect(result.current.refresh()).resolves.toBeUndefined();
    });

    expect(result.current.rows).toEqual([]);
  });
});
