// `TransfersScreen` — the hub's render tests.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. A FAILED READ IS NOT AN EMPTY HUB. What is being missed here is a
//      seven-day window that closes by itself, so "no tenés transferencias
//      pendientes" over a server outage is the worst sentence this screen can
//      say. It must show the failure and a way to retry.
//   2. THE THREE SECTIONS ARE THE SERVER'S. Nothing here re-derives which list a
//      row belongs to; a row's section is decided by the addressee rule, which a
//      phone cannot evaluate.
//   3. THE SENDER'S E-MAIL IS NEVER ON SCREEN, on any row, in any state.
//   4. THE EMPTY STATES ARE DIFFERENT SENTENCES, because "nobody offered me
//      anything" and "I have not sent anything" are different facts.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockFetchGrants = jest.fn<(...args: unknown[]) => Promise<unknown>>();

/**
 * Every focus callback currently mounted, so a test can fire a RE-focus.
 *
 * A mount-only stand-in is not enough here: the defect is about a screen that
 * is ALREADY MOUNTED when it regains focus, and a mount-only stand-in can only
 * be re-fired by remounting — which is precisely the case that never had the
 * bug.
 */
const mockFocusCallbacks: Array<() => void> = [];

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useFocusEffect: (callback: () => void) => {
    const { useEffect } = require("react");
    useEffect(() => {
      mockFocusCallbacks.push(callback);
      // A mount IS a first focus, which is what the real hook does too.
      callback();
      return () => {
        const at = mockFocusCallbacks.indexOf(callback);
        if (at >= 0) mockFocusCallbacks.splice(at, 1);
      };
    }, [callback]);
  },
}));

jest.mock("../api/endpoints", () => ({
  fetchMyTransfers: (...args: unknown[]) => mockFetch(...args),
  fetchMyCaretakerGrants: (...args: unknown[]) => mockFetchGrants(...args),
}));

// The screen now re-reads when the network comes back (B-05, `useReconnect`),
// and the real NetInfo has no native module under jest — it crashes inside its
// own reachability timer, several frames from anything this file is about. The
// stand-in `MisMascotasFooter.test.tsx` already uses.
jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined },
}));
jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import type {
  MyCaretakerGrantV1,
  MyCaretakerGrantsV1,
  MyTransferV1,
  MyTransfersV1,
} from "@dim/contract/api";
import { TransfersScreen } from "./TransfersScreen";

function aCaretakerGrant(over: Partial<MyCaretakerGrantV1> = {}): MyCaretakerGrantV1 {
  return {
    grantToken: "CG-abcd1234",
    status: "pending",
    direction: "incoming",
    pet: { publicToken: "DIM-PAMP-0001", name: "Pampa", species: "dog" },
    counterpartyName: "Ana",
    caretakerEmail: "yo@example.com",
    startsAt: "2026-08-20T10:00:00.000Z",
    endsAt: "2026-08-27T10:00:00.000Z",
    note: null,
    expired: false,
    scopeSentence: "Podés cargar eventos. No podés transferir la titularidad.",
    capabilities: { canAccept: true, canReject: true, canCancel: false, canRevoke: false },
    ...over,
  };
}

function caretakerGrantsPayload(over: Partial<MyCaretakerGrantsV1> = {}): MyCaretakerGrantsV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-26T00:00:00.000Z",
    staleAfter: "2026-08-26T00:01:00.000Z",
    incoming: [],
    outgoing: [],
    ...over,
  };
}

function aTransfer(over: Partial<MyTransferV1> = {}): MyTransferV1 {
  return {
    transferToken: "PTR-ABCD-2345",
    status: "pending",
    direction: "incoming",
    pet: { publicToken: "DIM-PAMP-0001", name: "Pampa", species: "dog" },
    counterpartyName: "Vecina",
    toEmail: "yo@example.com",
    reason: "gift",
    note: null,
    rejectionReason: null,
    initiatedAt: "2026-08-20T10:00:00.000Z",
    respondedAt: null,
    expiresAt: "2026-08-27T10:00:00.000Z",
    expired: false,
    capabilities: { canAccept: true, canReject: true, canCancel: false },
    ...over,
  };
}

function payload(over: Partial<MyTransfersV1> = {}): MyTransfersV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-26T00:00:00.000Z",
    staleAfter: "2026-08-26T00:01:00.000Z",
    incoming: { pending: [], history: [] },
    outgoing: [],
    ...over,
  };
}

const noop = () => {};

/** Re-focus every mounted screen, the way popping back to it does. */
async function refocus(): Promise<void> {
  await act(async () => {
    for (const callback of [...mockFocusCallbacks]) callback();
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetchGrants.mockReset();
  // Defaults: an empty hub on both reads. Every existing test about
  // transfers already overrides `mockFetch`, so this default only changes
  // behaviour for tests that DON'T — which, before this section existed, could
  // not exist, because `mockFetch` was the only read. The caretaker-grants
  // tests below override `mockFetchGrants` and leave the transfers default in
  // place.
  mockFetch.mockResolvedValue({ outcome: "ok", payload: payload() });
  mockFetchGrants.mockResolvedValue({ outcome: "ok", payload: caretakerGrantsPayload() });
  mockFocusCallbacks.length = 0;
});

describe("a failed read", () => {
  it("says so and offers a retry — never an empty list", async () => {
    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<TransfersScreen onOpen={noop} onOpenCaretakerGrant={noop} />);

    await waitFor(() => expect(screen.getByText(/No pudimos conectarnos/)).toBeTruthy());
    // The absence that would have been a lie.
    expect(screen.queryByText("No tenés transferencias pendientes.")).toBeNull();
    expect(screen.getByText("Reintentar")).toBeTruthy();
  });

  it("re-reads when the retry is pressed", async () => {
    mockFetch.mockResolvedValueOnce({ outcome: "unreachable", detail: "offline" });
    mockFetch.mockResolvedValueOnce({ outcome: "ok", payload: payload() });
    render(<TransfersScreen onOpen={noop} onOpenCaretakerGrant={noop} />);

    await waitFor(() => expect(screen.getByText("Reintentar")).toBeTruthy());
    fireEvent.press(screen.getByText("Reintentar"));
    await waitFor(() =>
      expect(screen.getByText("No tenés transferencias pendientes.")).toBeTruthy(),
    );
  });

  it("names an unsupported payload version as an app problem, not a network one", async () => {
    mockFetch.mockResolvedValue({ outcome: "unsupported-version", received: 2 });
    render(<TransfersScreen onOpen={noop} onOpenCaretakerGrant={noop} />);
    await waitFor(() => expect(screen.getByText(/Actualizá la app/)).toBeTruthy());
  });
});

// ---------------------------------------------------------------------------
// COMING BACK TO A SCREEN THAT IS STILL MOUNTED (native QA batch 3, C4)
//
// Opening a proposal pushes `transferencias/[transferToken]` on top of this
// screen. Popping back — after a reject, which answers in place and leaves
// the person to go back themselves, or after an accept, whose `replace`
// still leaves the hub one step behind in the stack — does not remount it.
// A mount-only effect left the hub showing the pending state from before the
// decision. The person had just rejected an offer the screen still listed as
// something to answer.
// ---------------------------------------------------------------------------
describe("coming back into focus", () => {
  it("re-reads the hub instead of showing the state from before the decision", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ incoming: { pending: [aTransfer()], history: [] } }),
    });
    render(<TransfersScreen onOpen={noop} onOpenCaretakerGrant={noop} />);

    await waitFor(() => expect(screen.getByText("Pampa")).toBeTruthy());
    expect(screen.queryByText("No tenés transferencias pendientes.")).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // The proposal was rejected on the detail screen pushed on top of this one.
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        incoming: { pending: [], history: [aTransfer({ status: "rejected" })] },
      }),
    });
    await refocus();

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByText("No tenés transferencias pendientes.")).toBeTruthy(),
    );
    expect(screen.getByText("Recibidas · Historial")).toBeTruthy();
    expect(screen.getByText("Rechazada")).toBeTruthy();
  });

  it("keeps the rows on screen while it re-reads, instead of blanking to a skeleton", async () => {
    // The mode matters: an "initial" read sets phase:"loading" and would
    // replace the hub with a skeleton EVERY time somebody comes back from a
    // proposal's detail screen — trading a stale row for a flicker on every
    // navigation.
    let resolveSecond: ((value: unknown) => void) | null = null;
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ incoming: { pending: [aTransfer()], history: [] } }),
    });
    render(<TransfersScreen onOpen={noop} onOpenCaretakerGrant={noop} />);
    await waitFor(() => expect(screen.getByText("Pampa")).toBeTruthy());

    mockFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveSecond = resolve;
      }),
    );
    await refocus();

    // Mid-flight: the row is still there and the skeleton is not.
    expect(screen.getByText("Pampa")).toBeTruthy();
    // The skeleton announces itself as a progressbar with this label, not as
    // visible text — `ListSkeleton` hides its own bones from the reader.
    expect(screen.queryByLabelText("Cargando transferencias…")).toBeNull();

    await act(async () => {
      resolveSecond?.({
        outcome: "ok",
        payload: payload({ incoming: { pending: [aTransfer()], history: [] } }),
      });
    });
  });

  it("still shows the skeleton on the FIRST appearance, when there is nothing to keep", async () => {
    let resolveFirst: ((value: unknown) => void) | null = null;
    mockFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    render(<TransfersScreen onOpen={noop} onOpenCaretakerGrant={noop} />);

    expect(screen.getByLabelText("Cargando transferencias…")).toBeTruthy();

    await act(async () => {
      resolveFirst?.({ outcome: "ok", payload: payload() });
    });
  });
});

describe("the three sections", () => {
  it("gives the two empties different sentences", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: payload() });
    render(<TransfersScreen onOpen={noop} onOpenCaretakerGrant={noop} />);

    await waitFor(() =>
      expect(screen.getByText("No tenés transferencias pendientes.")).toBeTruthy(),
    );
    expect(screen.getByText("No enviaste ninguna transferencia todavía.")).toBeTruthy();
  });

  it("draws no Historial heading when there is no history", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ incoming: { pending: [aTransfer()], history: [] } }),
    });
    render(<TransfersScreen onOpen={noop} onOpenCaretakerGrant={noop} />);

    await waitFor(() => expect(screen.getByText("Pampa")).toBeTruthy());
    expect(screen.queryByText("Recibidas · Historial")).toBeNull();
  });

  it("draws it when there is", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        incoming: {
          pending: [],
          history: [aTransfer({ transferToken: "PTR-OLD0-0001", status: "rejected" })],
        },
      }),
    });
    render(<TransfersScreen onOpen={noop} onOpenCaretakerGrant={noop} />);
    await waitFor(() => expect(screen.getByText("Recibidas · Historial")).toBeTruthy());
    expect(screen.getByText("Rechazada")).toBeTruthy();
  });
});

describe("a row", () => {
  it("names the animal, the other party and the deadline", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ incoming: { pending: [aTransfer()], history: [] } }),
    });
    render(<TransfersScreen onOpen={noop} onOpenCaretakerGrant={noop} />);

    await waitFor(() => expect(screen.getByText("Pampa")).toBeTruthy());
    expect(screen.getByText("De: Vecina")).toBeTruthy();
    expect(screen.getByText("Vence el 27/08/2026")).toBeTruthy();
  });

  it("shows NO e-mail on an incoming row", async () => {
    // `toEmail` is the caller's own address on an incoming row. Printing it
    // would read as the sender's, and the sender's is not in the payload at all.
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        incoming: { pending: [aTransfer({ counterpartyName: null })], history: [] },
      }),
    });
    render(<TransfersScreen onOpen={noop} onOpenCaretakerGrant={noop} />);

    await waitFor(() => expect(screen.getByText("Pampa")).toBeTruthy());
    expect(screen.queryByText(/yo@example\.com/)).toBeNull();
  });

  it("says venció when the SERVER says so, with the status still pending", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        incoming: { pending: [aTransfer({ expired: true })], history: [] },
      }),
    });
    render(<TransfersScreen onOpen={noop} onOpenCaretakerGrant={noop} />);
    await waitFor(() => expect(screen.getByText("Venció el 27/08/2026")).toBeTruthy());
  });

  it("opens the proposal by its token when pressed", async () => {
    const onOpen = jest.fn();
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ incoming: { pending: [aTransfer()], history: [] } }),
    });
    render(<TransfersScreen onOpen={onOpen} onOpenCaretakerGrant={noop} />);

    await waitFor(() => expect(screen.getByText("Pampa")).toBeTruthy());
    fireEvent.press(screen.getByText("Pampa"));
    expect(onOpen).toHaveBeenCalledWith("PTR-ABCD-2345");
  });
});

// ---------------------------------------------------------------------------
// CUIDADOS — invitaciones de cuidado temporal, lado del invitado (T4-M4)
//
// Before this section existed, a caretaker invitation was reachable ONLY
// through the e-mail/notification link naming `/cuidado/{grantToken}` — there
// was nowhere in the app to go LOOKING for one. These tests pin that the hub
// now shows it, names who invited, and opens the SAME deep-link destination the
// notification already points at, through `onOpenCaretakerGrant` and never a
// second, screen-local accept/reject flow.
// ---------------------------------------------------------------------------
describe("cuidados — caretaker invitations", () => {
  it("shows a pending invitation with the pet and who invited", async () => {
    mockFetchGrants.mockResolvedValue({
      outcome: "ok",
      payload: caretakerGrantsPayload({ incoming: [aCaretakerGrant()] }),
    });
    render(<TransfersScreen onOpen={noop} onOpenCaretakerGrant={noop} />);

    await waitFor(() => expect(screen.getByText("Cuidados · Invitaciones")).toBeTruthy());
    expect(screen.getByText("Pampa")).toBeTruthy();
    expect(screen.getByText("De: Ana")).toBeTruthy();
  });

  it("says nothing is pending when the hub has no caretaker invitation", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: payload() });
    render(<TransfersScreen onOpen={noop} onOpenCaretakerGrant={noop} />);

    await waitFor(() =>
      expect(screen.getByText("No tenés invitaciones a cuidar mascotas pendientes.")).toBeTruthy(),
    );
  });

  it("shows an accepted grant under Cuidados · Activos, not under the invitations list", async () => {
    mockFetchGrants.mockResolvedValue({
      outcome: "ok",
      payload: caretakerGrantsPayload({
        incoming: [aCaretakerGrant({ status: "accepted", grantToken: "CG-active0001" })],
      }),
    });
    render(<TransfersScreen onOpen={noop} onOpenCaretakerGrant={noop} />);

    await waitFor(() => expect(screen.getByText("Cuidados · Activos")).toBeTruthy());
    expect(screen.getByText("No tenés invitaciones a cuidar mascotas pendientes.")).toBeTruthy();
  });

  it("opens the invitation by its grant token when pressed, not the transfer opener", async () => {
    const onOpenCaretakerGrant = jest.fn();
    const onOpen = jest.fn();
    mockFetchGrants.mockResolvedValue({
      outcome: "ok",
      payload: caretakerGrantsPayload({ incoming: [aCaretakerGrant()] }),
    });
    render(<TransfersScreen onOpen={onOpen} onOpenCaretakerGrant={onOpenCaretakerGrant} />);

    await waitFor(() => expect(screen.getByText("Pampa")).toBeTruthy());
    fireEvent.press(screen.getByText("Pampa"));
    expect(onOpenCaretakerGrant).toHaveBeenCalledWith("CG-abcd1234");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("a failed caretaker-grants read fails the whole screen — never a silently empty section", async () => {
    // The same rule `reload-state.ts` states for every other read on this
    // surface: what would be hidden is somebody waiting for an answer about an
    // animal, and a section that quietly rendered empty over an outage would be
    // exactly the lie "no tenés ninguna" tells.
    mockFetchGrants.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<TransfersScreen onOpen={noop} onOpenCaretakerGrant={noop} />);

    await waitFor(() => expect(screen.getByText(/No pudimos conectarnos/)).toBeTruthy());
    expect(screen.queryByText("No tenés invitaciones a cuidar mascotas pendientes.")).toBeNull();
  });
});
