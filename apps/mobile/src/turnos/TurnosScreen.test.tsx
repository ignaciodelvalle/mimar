// `TurnosScreen` — the hub's render tests.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. A FAILED READ IS NOT AN EMPTY LIST. What is being missed here is an
//      appointment somebody has to physically attend at a time they no longer
//      remember, so "no tenés turnos" over a server outage is the worst sentence
//      this screen can say. It must show the failure and a way to retry.
//   2. THE THREE SECTIONS ARE THE SERVER'S. Nothing here re-derives which list a
//      row belongs to — that is the server's clock against the slot.
//   3. THE EMPTY SECTIONS ARE NOT DRAWN. An empty "Pasados" heading over nothing
//      is furniture, and the transfers hub already settled that rule.
//   4. THE EMPTY STATE POINTS AT SOMETHING REAL. This used to read "does not
//      promise a button that does not exist — booking is not in this app yet; the
//      copy says where it is instead", and the copy said mimar.com.ar. Buscar y
//      reservar landed, so the claim inverts: the search is on this screen, and
//      the browser link is gone rather than left as a second way to do one thing.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();

/**
 * Every focus callback currently mounted, so a test can fire a RE-focus.
 *
 * The stand-in LibretaScreen uses ("run it on mount") is not enough here: the
 * defect is about a screen that is ALREADY MOUNTED when it regains focus, and a
 * mount-only stand-in can only be re-fired by remounting — which is precisely
 * the case that never had the bug.
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
  fetchMyAppointments: (...args: unknown[]) => mockFetch(...args),
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

import type { MyAppointmentV1, MyAppointmentsV1 } from "@dim/contract/api";
import { TurnosScreen } from "./TurnosScreen";

function anAppointment(over: Partial<MyAppointmentV1> = {}): MyAppointmentV1 {
  return {
    appointmentToken: "APT-7K2M-9QX4",
    status: "confirmed",
    section: "upcoming",
    pet: { publicToken: "DIM-PAMP-0001", name: "Pampa" },
    offeringName: "Campaña antirrábica — Plaza San Martín",
    serviceKind: "vaccination_rabies",
    serviceKindLabel: "Vacunación antirrábica",
    provider: {
      kind: "organization",
      displayName: "Zoonosis Bariloche",
      phone: null,
      locality: null,
    },
    durationMinutes: 15,
    priceArs: null,
    startsAt: "2026-09-03T13:30:00.000Z",
    endsAt: "2026-09-03T13:45:00.000Z",
    capabilities: { canCancel: true, canCheckIn: true },
    ...over,
  };
}

function payload(over: Partial<MyAppointmentsV1> = {}): MyAppointmentsV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-29T00:00:00.000Z",
    staleAfter: "2026-08-29T00:01:00.000Z",
    upcoming: [],
    past: [],
    cancelled: [],
    ...over,
  };
}

/** Re-focus every mounted screen, the way popping back to it does. */
async function refocus(): Promise<void> {
  await act(async () => {
    for (const callback of [...mockFocusCallbacks]) callback();
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFocusCallbacks.length = 0;
});

describe("a failed read", () => {
  it("shows the failure and a retry, never an empty list", async () => {
    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<TurnosScreen onOpen={jest.fn()} onSearch={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Reintentar")).toBeTruthy());
    expect(screen.getByText(/Revisá tu conexión/i)).toBeTruthy();
    // THE SENTENCE THAT MUST NOT APPEAR. "No tenés turnos" over an outage is how
    // somebody stops expecting an appointment they still have.
    expect(screen.queryByText(/No tenés turnos/i)).toBeNull();
  });

  it("reads again when the retry is pressed", async () => {
    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<TurnosScreen onOpen={jest.fn()} onSearch={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Reintentar")).toBeTruthy());
    fireEvent.press(screen.getByText("Reintentar"));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it("tells an out-of-date build to update instead of blaming the network", async () => {
    mockFetch.mockResolvedValue({ outcome: "unsupported-version", received: 2 });
    render(<TurnosScreen onOpen={jest.fn()} onSearch={jest.fn()} />);

    await waitFor(() => expect(screen.getByText(/Actualizá la app/i)).toBeTruthy());
  });
});

// ---------------------------------------------------------------------------
// COMING BACK TO A SCREEN THAT IS STILL MOUNTED (native QA batch 2, C1)
//
// Booking pushes `turnos/buscar` on top of this screen. Popping back does not
// remount it, so a mount-only effect left the list — and the "N turnos en
// total." line above it — showing the state from before the reservation. The
// person had just booked a turno the screen said they did not have.
// ---------------------------------------------------------------------------
describe("coming back into focus", () => {
  it("re-reads the list instead of showing the count from before the booking", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ upcoming: [anAppointment({ appointmentToken: "APT-ONE" })] }),
    });
    render(<TurnosScreen onOpen={jest.fn()} onSearch={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("1 turno en total.")).toBeTruthy());
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // A second turno was booked on the screen that was pushed on top of this one.
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        upcoming: [
          anAppointment({ appointmentToken: "APT-ONE" }),
          anAppointment({
            appointmentToken: "APT-TWO",
            pet: { publicToken: "DIM-ROCC-0002", name: "Rocco" },
          }),
        ],
      }),
    });
    await refocus();

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("2 turnos en total.")).toBeTruthy());
    expect(screen.getByText("Rocco")).toBeTruthy();
  });

  it("keeps the rows on screen while it re-reads, instead of blanking to a skeleton", async () => {
    // The mode matters: an "initial" read sets phase:"loading" and would replace
    // the list with a skeleton EVERY time somebody comes back from a detail
    // screen — trading a stale count for a flicker on every navigation.
    let resolveSecond: ((value: unknown) => void) | null = null;
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ upcoming: [anAppointment()] }),
    });
    render(<TurnosScreen onOpen={jest.fn()} onSearch={jest.fn()} />);
    await waitFor(() => expect(screen.getByText("1 turno en total.")).toBeTruthy());

    mockFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveSecond = resolve;
      }),
    );
    await refocus();

    // Mid-flight: the list is still there and the skeleton is not.
    expect(screen.getByText("1 turno en total.")).toBeTruthy();
    // The skeleton announces itself as a progressbar with this label, not as
    // visible text — `ListSkeleton` hides its own bones from the reader.
    expect(screen.queryByLabelText("Cargando tus turnos…")).toBeNull();

    await act(async () => {
      resolveSecond?.({ outcome: "ok", payload: payload({ upcoming: [anAppointment()] }) });
    });
  });

  it("still shows the skeleton on the FIRST appearance, when there is nothing to keep", async () => {
    let resolveFirst: ((value: unknown) => void) | null = null;
    mockFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    render(<TurnosScreen onOpen={jest.fn()} onSearch={jest.fn()} />);

    expect(screen.getByLabelText("Cargando tus turnos…")).toBeTruthy();

    await act(async () => {
      resolveFirst?.({ outcome: "ok", payload: payload() });
    });
  });
});

describe("the sections", () => {
  it("draws a row in the section the SERVER put it in", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        upcoming: [anAppointment({ appointmentToken: "APT-UP" })],
        past: [
          anAppointment({
            appointmentToken: "APT-PAST",
            section: "past",
            status: "attended",
            offeringName: "Castración",
          }),
        ],
        cancelled: [
          anAppointment({
            appointmentToken: "APT-CAN",
            section: "cancelled",
            status: "cancelled_by_org",
            offeringName: "Consulta clínica",
          }),
        ],
      }),
    });
    render(<TurnosScreen onOpen={jest.fn()} onSearch={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Próximos")).toBeTruthy());
    expect(screen.getByText("Pasados")).toBeTruthy();
    expect(screen.getByText("Cancelados")).toBeTruthy();
    expect(screen.getByText("Asistido")).toBeTruthy();
    expect(screen.getByText("Cancelado por el prestador")).toBeTruthy();
    expect(screen.getByText("3 turnos en total.")).toBeTruthy();
  });

  it("does not draw a heading for a section with no rows", async () => {
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ upcoming: [anAppointment()] }),
    });
    render(<TurnosScreen onOpen={jest.fn()} onSearch={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Próximos")).toBeTruthy());
    expect(screen.queryByText("Pasados")).toBeNull();
    expect(screen.queryByText("Cancelados")).toBeNull();
  });

  it("opens the row that was tapped, by its own token", async () => {
    const onOpen = jest.fn();
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ upcoming: [anAppointment({ appointmentToken: "APT-UP" })] }),
    });
    render(<TurnosScreen onOpen={onOpen} onSearch={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getByText("Campaña antirrábica — Plaza San Martín")).toBeTruthy(),
    );
    fireEvent.press(screen.getByText("Campaña antirrábica — Plaza San Martín"));
    expect(onOpen).toHaveBeenCalledWith("APT-UP");
  });
});

describe("the empty state", () => {
  // THIS CASE USED TO ASSERT THE OPPOSITE and its old name is worth keeping in
  // view: "says where turnos are booked instead of offering a button that does not
  // exist". It demanded the sentence "mimar.com.ar" and demanded the ABSENCE of a
  // search control, both correctly, because reserving was not in this app. It is
  // now, so the assertion inverts — and it inverts rather than being deleted,
  // because "the empty state points somewhere real" is the claim that survives.
  it("offers the search that now exists, and no longer sends anybody to a browser", async () => {
    mockFetch.mockResolvedValue({ outcome: "ok", payload: payload() });
    render(<TurnosScreen onOpen={jest.fn()} onSearch={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("No tenés turnos próximos.")).toBeTruthy());
    expect(screen.getByText("No tenés turnos reservados.")).toBeTruthy();
    expect(screen.getByText("Buscar un turno")).toBeTruthy();
    // THE SENTENCE THAT MUST NOT COME BACK. A browser link stands in front of a
    // session this app does not share, and it is a second way to do one thing.
    expect(screen.queryByText(/mimar\.com\.ar/i)).toBeNull();
  });

  it("hands the search back to the router rather than navigating itself", async () => {
    // The screen owns no route. `onSearch` is what the route shell binds, which
    // is the arrangement every other screen in this app uses: a screen never
    // navigates itself. (It DOES read `useFocusEffect` from expo-router now —
    // knowing you were re-entered is not navigating, and LibretaScreen has the
    // same pair.)
    const onSearch = jest.fn();
    mockFetch.mockResolvedValue({ outcome: "ok", payload: payload() });
    render(<TurnosScreen onOpen={jest.fn()} onSearch={onSearch} />);

    await waitFor(() => expect(screen.getByText("Buscar un turno")).toBeTruthy());
    fireEvent.press(screen.getByText("Buscar un turno"));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it("offers the search on a screen that ALREADY has turnos, not only on an empty one", async () => {
    // The button sits above the sections rather than inside the empty state. A
    // person with a long history still opens this to book the next one, and a
    // control reachable only by having nothing is a control most people never see.
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: payload({ upcoming: [anAppointment({ appointmentToken: "APT-UP" })] }),
    });
    render(<TurnosScreen onOpen={jest.fn()} onSearch={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Buscar un turno")).toBeTruthy());
  });
});
