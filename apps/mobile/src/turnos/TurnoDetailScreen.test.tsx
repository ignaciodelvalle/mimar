// `TurnoDetailScreen` — the screen somebody opens standing at a clinic desk.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. THE CHECK-IN QR IS GATED ON `canCheckIn` AND ON NOTHING ELSE. Not on
//      `status`, not on a date this device compared. The combination that matters
//      is a turno IN PROGRESS: `canCheckIn` true, `canCancel` false. A screen
//      that used one flag for both would hide the code from the person holding
//      the phone at the desk, which is the single moment this screen exists for.
//   2. THE TOKEN IS ON SCREEN UNDER THE QR. It is the stated fallback — "si el
//      escáner no lo lee, dictá el código" — and it matters more here than on the
//      web, because the reader for that QR does not exist yet.
//   3. CANCELLING TAKES TWO TAPS AND SAYS WHAT IT COSTS. The place is freed for
//      somebody else and getting it back means booking again.
//   4. A FAILED CANCEL RE-READS. There is no idempotency key, so a refusal after
//      a timeout may mean the first attempt landed; the list is the only thing
//      that can say which.
//   5. NO COMMAND CARRIES AN IDEMPOTENCY KEY, because the endpoint does not read
//      one — sending it would claim a guarantee nobody made.
//   6. A TOKEN THIS CALLER DOES NOT HOLD IS NOT CALLED "NON-EXISTENT".

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

jest.mock("../api/endpoints", () => ({
  fetchMyAppointments: (...args: unknown[]) => mockFetch(...args),
  sendAppointmentCommand: (...args: unknown[]) => mockSend(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import type { MyAppointmentV1, MyAppointmentsV1 } from "@dim/contract/api";
import { TurnoDetailScreen } from "./TurnoDetailScreen";

const TOKEN = "APT-7K2M-9QX4";

function anAppointment(over: Partial<MyAppointmentV1> = {}): MyAppointmentV1 {
  return {
    appointmentToken: TOKEN,
    status: "confirmed",
    section: "upcoming",
    pet: { publicToken: "DIM-PAMP-0001", name: "Pampa" },
    offeringName: "Campaña antirrábica — Plaza San Martín",
    serviceKind: "vaccination_rabies",
    serviceKindLabel: "Vacunación antirrábica",
    provider: {
      kind: "organization",
      displayName: "Zoonosis Bariloche",
      phone: "+54 294 442-0000",
      locality: "San Carlos de Bariloche",
    },
    durationMinutes: 15,
    priceArs: null,
    startsAt: "2026-09-03T13:30:00.000Z",
    endsAt: "2026-09-03T13:45:00.000Z",
    capabilities: { canCancel: true, canCheckIn: true },
    ...over,
  };
}

function hubWith(appointment: MyAppointmentV1): MyAppointmentsV1 {
  const bucket = appointment.section;
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-29T00:00:00.000Z",
    staleAfter: "2026-08-29T00:01:00.000Z",
    upcoming: bucket === "upcoming" ? [appointment] : [],
    past: bucket === "past" ? [appointment] : [],
    cancelled: bucket === "cancelled" ? [appointment] : [],
  };
}

function readsBack(appointment: MyAppointmentV1) {
  mockFetch.mockResolvedValue({ outcome: "ok", payload: hubWith(appointment) });
}

beforeEach(() => {
  mockFetch.mockReset();
  mockSend.mockReset();
});

describe("the check-in QR", () => {
  it("draws the code and the token when the server says canCheckIn", async () => {
    readsBack(anAppointment());
    render(<TurnoDetailScreen appointmentToken={TOKEN} />);

    // A LONGER WINDOW, and only here. This is the first render in the file that
    // reaches `CredentialQr`, so it pays the one-time cost of loading `qrcode`
    // and `react-native-svg` under Jest — measured at over a second on this
    // machine, which is `waitFor`'s default. Every later test in the file lands
    // well inside it. Raising the default for the whole file instead would hide a
    // screen that genuinely never leaves its loading state.
    await waitFor(() => expect(screen.getByText("Check-in en la clínica")).toBeTruthy(), {
      timeout: 10_000,
    });
    // The QR is an svg exposed as an image; its accessible name is what a screen
    // reader announces and what proves it rendered at all.
    expect(screen.getByLabelText("Código de check-in del turno de Pampa")).toBeTruthy();
    // THE DICTATED FALLBACK. See the header.
    expect(screen.getByText(TOKEN)).toBeTruthy();
  });

  it("still draws it for a turno IN PROGRESS, when cancelling is already closed", async () => {
    // THE COMBINATION THAT MATTERS. The two windows differ on purpose: cancelling
    // closes at `startsAt`, the QR stays good until `endsAt`. A screen that read
    // one flag for both would take the code away from somebody five minutes late.
    readsBack(anAppointment({ capabilities: { canCancel: false, canCheckIn: true } }));
    render(<TurnoDetailScreen appointmentToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Check-in en la clínica")).toBeTruthy());
    expect(screen.queryByText("Cancelar el turno")).toBeNull();
  });

  it("hides it the moment the server says the window closed, whatever the status", async () => {
    readsBack(
      anAppointment({
        status: "confirmed",
        section: "past",
        capabilities: { canCancel: false, canCheckIn: false },
      }),
    );
    render(<TurnoDetailScreen appointmentToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Confirmado")).toBeTruthy());
    expect(screen.queryByText("Check-in en la clínica")).toBeNull();
    expect(screen.queryByText(TOKEN)).toBeNull();
  });
});

describe("cancelling", () => {
  it("asks a second time and says the place is freed", async () => {
    readsBack(anAppointment());
    render(<TurnoDetailScreen appointmentToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Cancelar el turno")).toBeTruthy());
    fireEvent.press(screen.getByText("Cancelar el turno"));

    expect(screen.getByText(/el horario queda liberado para otra persona/i)).toBeTruthy();
    // Nothing has been sent on the first tap.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends the contract's command, with no idempotency key", async () => {
    readsBack(anAppointment());
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "cancel", changed: true, appointmentToken: TOKEN },
    });
    render(<TurnoDetailScreen appointmentToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Cancelar el turno")).toBeTruthy());
    fireEvent.press(screen.getByText("Cancelar el turno"));
    fireEvent.press(screen.getByText("Sí, cancelar el turno"));

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    // TWO ARGUMENTS AND NOT THREE. The endpoint does not read an idempotency
    // header, and a client that sent one would believe it holds a guarantee the
    // server never made.
    expect(mockSend.mock.calls[0]).toHaveLength(2);
    expect(mockSend.mock.calls[0]?.[1]).toEqual({ command: "cancel", appointmentToken: TOKEN });
  });

  it("re-reads after a refusal, because the refusal may mean it landed", async () => {
    readsBack(anAppointment());
    mockSend.mockResolvedValue({
      outcome: "api-error",
      code: "appointment_already_resolved",
      retryAfterSeconds: null,
    });
    render(<TurnoDetailScreen appointmentToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Cancelar el turno")).toBeTruthy());
    expect(mockFetch).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByText("Cancelar el turno"));
    fireEvent.press(screen.getByText("Sí, cancelar el turno"));

    // A SECOND READ. Not a retry of the write — that is the one thing a client
    // without an idempotency key must not do.
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("shows the refusal's own sentence, not a generic shrug", async () => {
    readsBack(anAppointment());
    mockSend.mockResolvedValue({
      outcome: "api-error",
      code: "appointment_past",
      retryAfterSeconds: null,
    });
    render(<TurnoDetailScreen appointmentToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Cancelar el turno")).toBeTruthy());
    fireEvent.press(screen.getByText("Cancelar el turno"));
    fireEvent.press(screen.getByText("Sí, cancelar el turno"));

    await waitFor(() => expect(screen.getByText(/ya pasó/i)).toBeTruthy());
  });

  it("offers no control at all when the server says canCancel is false", async () => {
    readsBack(
      anAppointment({
        status: "cancelled_by_org",
        section: "cancelled",
        capabilities: { canCancel: false, canCheckIn: false },
      }),
    );
    render(<TurnoDetailScreen appointmentToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Cancelado por el prestador")).toBeTruthy());
    expect(screen.queryByText("Cancelar el turno")).toBeNull();
  });
});

describe("the states this screen has to describe rather than imply", () => {
  it("says who cancelled, and says it on every later visit", async () => {
    // The web learned this the hard way: the small header badge alone was easy to
    // miss after the reload. The callout describes the STATE, so it is there on
    // the second visit too — not only in the frame after the tap.
    readsBack(
      anAppointment({
        status: "cancelled_by_org",
        section: "cancelled",
        capabilities: { canCancel: false, canCheckIn: false },
      }),
    );
    render(<TurnoDetailScreen appointmentToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText(/El prestador canceló este turno/i)).toBeTruthy());
  });

  it("does not call a turno somebody else booked non-existent", async () => {
    // A co-owner does not hold the other co-owner's turno, and this screen never
    // learned who booked it. "No existe" about a real turno is a lie told with
    // confidence.
    mockFetch.mockResolvedValue({
      outcome: "ok",
      payload: hubWith(anAppointment({ appointmentToken: "APT-OTHER" })),
    });
    render(<TurnoDetailScreen appointmentToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText(/No encontramos este turno/i)).toBeTruthy());
    expect(screen.queryByText(/no existe/i)).toBeNull();
  });

  it("shows the failure and a retry instead of an empty turno", async () => {
    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<TurnoDetailScreen appointmentToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Reintentar")).toBeTruthy());
    expect(screen.getByText(/Revisá tu conexión/i)).toBeTruthy();
  });
});
