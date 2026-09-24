// `FosterScreen` — a volunteer's own tránsito inbox.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. NO CONTROL IS GATED ON `capabilities` — there is none on this payload.
//      Every pending proposal offers both "Aceptar" and "Rechazar".
//   2. A REJECT WITHOUT A REASON REFUSES LOCALLY, before the network — the
//      screen must not send a command the schema will bounce.
//   3. A SUCCESSFUL COMMAND RE-READS THE HUB, and a FAILED ONE DOES TOO
//      (neither command carries an idempotency key — see `foster.ts`'s
//      header — so a refusal after a timeout may mean the first attempt
//      landed).
//   4. ACTIVE AND ENDED FOSTERS RENDER FROM `active`, never from `endedAt`
//      read directly.
//   5. AN EMPTY HUB IS AN INVITATION, not a bare "nothing here".

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("../api/endpoints", () => ({
  fetchMyFoster: (...args: unknown[]) => mockFetch(...args),
  sendFosterCommand: (...args: unknown[]) => mockSend(...args),
}));

// The real NetInfo has no native module under jest — it crashes inside its own
// reachability timer, several frames from anything this file is about. Same
// stand-in `TransfersScreen.test.tsx` uses for its own `useReconnect`.
jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined },
}));
jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import type { MyFosterOwnershipV1, MyFosterProposalV1, MyFosterV1 } from "@dim/contract/api";

import { FosterScreen } from "./FosterScreen";

const PROPOSAL_TOKEN = "FP-0123456789abcdef0123456789abcdef";

function aProposal(over: Partial<MyFosterProposalV1> = {}): MyFosterProposalV1 {
  return {
    proposalToken: PROPOSAL_TOKEN,
    pet: { publicToken: "DIM-PAMP-0001", name: "Pampa", species: "dog" },
    organizationName: "Refugio Esperanza",
    proposedDurationWeeks: 3,
    proposedNotes: null,
    proposedAt: "2026-09-01T12:00:00.000Z",
    expiresAt: "2026-09-08T12:00:00.000Z",
    expired: false,
    ...over,
  };
}

function aFoster(over: Partial<MyFosterOwnershipV1> = {}): MyFosterOwnershipV1 {
  return {
    fosterOwnershipId: "own-1",
    pet: { publicToken: "DIM-PAMP-0002", name: "Rocky", species: "dog" },
    organizationName: "Refugio Esperanza",
    startedAt: "2026-08-01T12:00:00.000Z",
    endedAt: null,
    active: true,
    proposedDurationWeeks: 4,
    ...over,
  };
}

function hub(over: Partial<MyFosterV1> = {}): MyFosterV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-09-01T00:00:00.000Z",
    staleAfter: "2026-09-01T00:01:00.000Z",
    proposals: [],
    fosters: [],
    ...over,
  };
}

function loads(payload: MyFosterV1) {
  mockFetch.mockResolvedValue({ outcome: "ok", payload });
}

const noopOpenPet = () => {};

beforeEach(() => {
  mockFetch.mockReset();
  mockSend.mockReset();
});

describe("loading and empty", () => {
  it("shows nothing to answer as an invitation, not a bare absence", async () => {
    loads(hub());
    render(<FosterScreen onOpenPet={noopOpenPet} />);
    await waitFor(() => screen.getByText("Todavía no tenés tránsitos"));
  });
});

describe("a pending proposal", () => {
  it("renders it with no capability gate — both controls always offered", async () => {
    loads(hub({ proposals: [aProposal()] }));
    render(<FosterScreen onOpenPet={noopOpenPet} />);
    await waitFor(() => screen.getByText("Refugio Esperanza te propone cuidar a Pampa"));
    expect(screen.getByText("Aceptar propuesta")).toBeTruthy();
    expect(screen.getByText("Rechazar")).toBeTruthy();
  });

  it("accepting opens the panel, sends the command, and re-reads on success", async () => {
    loads(hub({ proposals: [aProposal()] }));
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: {
        command: "accept",
        changed: true,
        proposalToken: PROPOSAL_TOKEN,
        fosterOwnershipId: "own-1",
      },
    });

    render(<FosterScreen onOpenPet={noopOpenPet} />);
    await waitFor(() => screen.getByText("Aceptar propuesta"));

    fireEvent.press(screen.getByText("Aceptar propuesta"));
    await waitFor(() => screen.getByText("Confirmar aceptación"));
    fireEvent.press(screen.getByText("Confirmar aceptación"));

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend).toHaveBeenCalledWith(
      {},
      {
        command: "accept",
        proposalToken: PROPOSAL_TOKEN,
        allowCoFoster: false,
        responseNotes: null,
      },
    );
    // RE-READ ON SUCCESS. The hub is the source of truth, not the ack.
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => screen.getByText("Listo. Ya podés ver el tránsito en tu lista."));
  });

  it("rejecting without a reason refuses locally and sends nothing", async () => {
    loads(hub({ proposals: [aProposal()] }));
    render(<FosterScreen onOpenPet={noopOpenPet} />);
    await waitFor(() => screen.getByText("Rechazar"));

    fireEvent.press(screen.getByText("Rechazar"));
    await waitFor(() => screen.getByText("Confirmar rechazo"));
    fireEvent.press(screen.getByText("Confirmar rechazo"));

    expect(mockSend).not.toHaveBeenCalled();
    await waitFor(() => screen.getByText("Elegí un motivo de la lista."));
  });

  it("rejecting with a reason sends the command and re-reads on success", async () => {
    loads(hub({ proposals: [aProposal()] }));
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: {
        command: "reject",
        changed: true,
        proposalToken: PROPOSAL_TOKEN,
        fosterOwnershipId: null,
      },
    });

    render(<FosterScreen onOpenPet={noopOpenPet} />);
    await waitFor(() => screen.getByText("Rechazar"));
    fireEvent.press(screen.getByText("Rechazar"));
    await waitFor(() => screen.getByText("No tengo capacidad ahora"));

    fireEvent.press(screen.getByText("No tengo capacidad ahora"));
    fireEvent.press(screen.getByText("Confirmar rechazo"));

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend).toHaveBeenCalledWith(
      {},
      {
        command: "reject",
        proposalToken: PROPOSAL_TOKEN,
        rejectionReason: "capacity",
        responseNotes: null,
      },
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it("re-reads on a failed command too, without an idempotency key to trust", async () => {
    loads(hub({ proposals: [aProposal()] }));
    mockSend.mockResolvedValue({ outcome: "api-error", code: "foster_already_resolved" });

    render(<FosterScreen onOpenPet={noopOpenPet} />);
    await waitFor(() => screen.getByText("Aceptar propuesta"));
    fireEvent.press(screen.getByText("Aceptar propuesta"));
    await waitFor(() => screen.getByText("Confirmar aceptación"));
    fireEvent.press(screen.getByText("Confirmar aceptación"));

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });
});

describe("fosters", () => {
  it("lists an active one under Tránsito activo, from the flag", async () => {
    loads(hub({ fosters: [aFoster({ active: true })] }));
    render(<FosterScreen onOpenPet={noopOpenPet} />);
    await waitFor(() => screen.getByText("Tránsito activo"));
    expect(screen.getByText("Estás cuidando a Rocky")).toBeTruthy();
    expect(screen.queryByText("Historial")).toBeNull();
  });

  it("lists an ended one under Historial, from the flag, and lets the reader open the ficha", async () => {
    const onOpenPet = jest.fn();
    loads(
      hub({
        fosters: [aFoster({ active: false, endedAt: "2026-09-10T12:00:00.000Z" })],
      }),
    );
    render(<FosterScreen onOpenPet={onOpenPet} />);
    await waitFor(() => screen.getByText("Historial"));
    expect(screen.getByText("Cuidaste a Rocky")).toBeTruthy();
    expect(screen.queryByText("Tránsito activo")).toBeNull();

    fireEvent.press(screen.getByText("Ver la ficha"));
    expect(onOpenPet).toHaveBeenCalledWith("DIM-PAMP-0002");
  });
});
