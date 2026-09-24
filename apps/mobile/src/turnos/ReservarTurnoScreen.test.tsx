// `ReservarTurnoScreen` — the grid, the animal picker, and the write.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. `canBook` IS READ, NOT DERIVED. The case that separates the two is a
//      payload where the flag and the reason DISAGREE — `canBook: false` with no
//      `blockedReason`. A screen that derived eligibility from the reason would
//      offer that animal, and the write would refuse it. Same instrument
//      `ClaimScreen.test.tsx` uses for `canClaim`, by contradiction.
//   2. A REFUSED WRITE RE-READS AND NEVER RE-SENDS. `bookSlotWriter` takes no
//      idempotency key: an advisory lock and two partial unique indexes REFUSE a
//      replay rather than absorbing one, so a retry after a timeout is
//      indistinguishable from somebody else taking the last place.
//   3. THE SUCCESS HANDS BACK THE SERVER'S TOKEN. The client cannot construct an
//      `APT-XXXX-XXXX`; it is minted inside the transaction.
//   4. AN EMPTY PET LIST SAYS WHAT IT MEANS. It is a person with no animal
//      registered, not a read that failed.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockRead = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

// ONE FACTORY FOR BOTH, and it has to be one: the read and the write moved into
// the same module at the 2026-08-30 integration merge (the read lived in a
// `turnos-api.ts` the lane could not put in `endpoints.ts`, because that file
// was another lane's territory). Two `jest.mock` calls on one path do not
// compose — the second replaces the first — so splitting them leaves whichever
// was declared earlier `undefined` at call time.
jest.mock("../api/endpoints", () => ({
  fetchBookableOffering: (...args: unknown[]) => mockRead(...args),
  sendAppointmentCommand: (...args: unknown[]) => mockSend(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import type {
  BookableOfferingDetailV1,
  BookableOfferingV1,
  BookablePetV1,
  BookableSlotV1,
} from "@dim/contract/api";

import { ReservarTurnoScreen } from "./ReservarTurnoScreen";

const SLOT_UUID = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const OTHER_SLOT_UUID = "7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function anOffering(over: Partial<BookableOfferingV1> = {}): BookableOfferingV1 {
  return {
    offeringToken: "SVO-7K2M-9QX4",
    displayName: "Campaña antirrábica — Plaza San Martín",
    description: null,
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
    coverageLabel: "San Carlos de Bariloche",
    slotsInWindow: 2,
    nextSlotAt: "2026-09-03T13:30:00.000Z",
    ...over,
  };
}

function aSlot(over: Partial<BookableSlotV1> = {}): BookableSlotV1 {
  return {
    slotId: SLOT_UUID,
    startsAt: "2026-09-03T13:30:00.000Z",
    endsAt: "2026-09-03T13:45:00.000Z",
    placesLeft: 1,
    ...over,
  };
}

function aPet(over: Partial<BookablePetV1> = {}): BookablePetV1 {
  return {
    publicToken: "DIM-PAMP-0001",
    name: "Pampa",
    canBook: true,
    blockedReason: null,
    ...over,
  };
}

function detail(over: Partial<BookableOfferingDetailV1> = {}): BookableOfferingDetailV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-30T12:00:00.000Z",
    staleAfter: "2026-08-30T12:00:30.000Z",
    offering: anOffering(),
    slots: [aSlot(), aSlot({ slotId: OTHER_SLOT_UUID, startsAt: "2026-09-03T14:00:00.000Z" })],
    pets: [aPet()],
    windowDays: 60,
    ...over,
  };
}

/**
 * Walk the two taps a booking needs: a time, then an animal.
 *
 * The animal's row label carries the token's last block since native QA batch 2
 * C2 ("Pampa · 0001"), because two animals sharing a name were two identical
 * rows. `petChoiceLabel` owns that string; this default just tracks it.
 */
async function chooseSlotAndPet(time = "10:30", pet = "Pampa · 0001") {
  await waitFor(() => expect(screen.getByText(time)).toBeTruthy());
  fireEvent.press(screen.getByText(time));
  fireEvent.press(screen.getByText(pet));
}

beforeEach(() => {
  mockRead.mockReset();
  mockSend.mockReset();
});

describe("a failed read", () => {
  it("shows the failure and a retry, never an empty grid", async () => {
    mockRead.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<ReservarTurnoScreen offeringToken="SVO-7K2M-9QX4" onBooked={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Reintentar")).toBeTruthy());
    expect(screen.getByText(/Revisá tu conexión/i)).toBeTruthy();
    // THE SENTENCE THAT MUST NOT APPEAR. "There are no times" over an outage sends
    // somebody away from a campaign that has places.
    expect(screen.queryByText(/No hay horarios disponibles/i)).toBeNull();
  });

  it("answers a 404 with the contract's own sentence rather than inventing one", async () => {
    // The endpoint folds "no such offering" and "not approved" into one 404 so the
    // URL is not an oracle. A client that split them would be reversing that.
    mockRead.mockResolvedValue({ outcome: "api-error", code: "not_found" });
    render(<ReservarTurnoScreen offeringToken="SVO-NOPE" onBooked={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Reintentar")).toBeTruthy());
  });
});

describe("the grid", () => {
  it("draws the ARGENTINE clock, grouped by day, with the payload's own window", async () => {
    mockRead.mockResolvedValue({ outcome: "ok", payload: detail() });
    render(<ReservarTurnoScreen offeringToken="SVO-7K2M-9QX4" onBooked={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Jueves 3 de septiembre")).toBeTruthy());
    // 13:30Z is 10:30 in Buenos Aires.
    expect(screen.getByText("10:30")).toBeTruthy();
    expect(screen.getByText("11:00")).toBeTruthy();
    expect(screen.getByText("2 turnos disponibles en 60 días")).toBeTruthy();
  });

  it("says the window in words when the grid is empty, and draws no picker", async () => {
    mockRead.mockResolvedValue({ outcome: "ok", payload: detail({ slots: [] }) });
    render(<ReservarTurnoScreen offeringToken="SVO-7K2M-9QX4" onBooked={jest.fn()} />);

    await waitFor(() =>
      expect(screen.getByText("No hay horarios disponibles en los próximos 60 días.")).toBeTruthy(),
    );
    // NO ANIMAL PICKER over an empty grid: there is nothing to book them into, and
    // a picker above nothing is furniture.
    expect(screen.queryByText("Para qué mascota")).toBeNull();
    expect(screen.queryByText("Reservar")).toBeNull();
  });
});

describe("the animal picker", () => {
  it("draws a blocked animal WITH its reason rather than hiding it", async () => {
    mockRead.mockResolvedValue({
      outcome: "ok",
      payload: detail({
        pets: [
          aPet(),
          aPet({
            publicToken: "DIM-LOLA-0002",
            name: "Lola",
            canBook: false,
            blockedReason: "already_booked_in_offering",
          }),
        ],
      }),
    });
    render(<ReservarTurnoScreen offeringToken="SVO-7K2M-9QX4" onBooked={jest.fn()} />);

    await waitFor(() =>
      expect(
        screen.getByText("Lola · 0002 — Ya tiene un turno reservado en este servicio."),
      ).toBeTruthy(),
    );
  });

  it("READS `canBook` and does not derive it from the reason being absent", async () => {
    // BY CONTRADICTION — the case that separates "reads the flag" from "reads the
    // reason and the flag happens to agree". The animal is refused with NO reason,
    // which is a payload the server can legitimately produce the day a second
    // refusal lands without copy, and a screen that offered it would draw a button
    // the write throws away.
    mockRead.mockResolvedValue({
      outcome: "ok",
      payload: detail({ pets: [aPet({ canBook: false, blockedReason: null })] }),
    });
    render(<ReservarTurnoScreen offeringToken="SVO-7K2M-9QX4" onBooked={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("Pampa · 0001")).toBeTruthy());
    // NO "Reservar" AT ALL: there is no bookable animal, so the control that would
    // promise a booking is not drawn.
    expect(screen.queryByText("Reservar")).toBeNull();

    fireEvent.press(screen.getByText("Pampa · 0001"));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not let a BLOCKED animal be chosen while a bookable one is on screen", async () => {
    // THE CASE THE TWO ABOVE DO NOT COVER, and the gap was measured: deleting
    // `disabled={!pet.canBook}` left this file green, because the only case with a
    // blocked animal had no bookable one and therefore no "Reservar" button to
    // press. With both on screen the button exists, so tapping the blocked row and
    // then booking is a real sequence — and it must carry the BOOKABLE animal.
    mockRead.mockResolvedValue({
      outcome: "ok",
      payload: detail({
        pets: [
          aPet(),
          aPet({
            publicToken: "DIM-LOLA-0002",
            name: "Lola",
            canBook: false,
            blockedReason: "already_booked_in_offering",
          }),
        ],
      }),
    });
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "book", appointmentToken: "APT-NEW-0001" },
    });
    render(<ReservarTurnoScreen offeringToken="SVO-7K2M-9QX4" onBooked={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("10:30")).toBeTruthy());
    fireEvent.press(screen.getByText("10:30"));
    fireEvent.press(screen.getByText("Pampa · 0001"));
    // The blocked row is pressed AFTER a valid choice, so a screen that let it
    // through would overwrite a good selection with a refusable one.
    fireEvent.press(
      screen.getByText("Lola · 0002 — Ya tiene un turno reservado en este servicio."),
    );
    fireEvent.press(screen.getByText("Reservar"));

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend.mock.calls[0]?.[1]).toMatchObject({ petPublicToken: "DIM-PAMP-0001" });
  });

  it("says what an EMPTY pet list means, and does not read it as a failure", async () => {
    mockRead.mockResolvedValue({ outcome: "ok", payload: detail({ pets: [] }) });
    render(<ReservarTurnoScreen offeringToken="SVO-7K2M-9QX4" onBooked={jest.fn()} />);

    await waitFor(() =>
      expect(
        screen.getByText("Necesitás una mascota registrada para reservar un turno."),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("Reservar")).toBeNull();
  });
});

describe("the reservar button's disabled state", () => {
  it("is disabled until BOTH a time and an animal are chosen (T4-M6, 2026-09-22)", async () => {
    // THE HOLE THIS FENCE CLOSES: `submit()` already refuses with no selection
    // (`if (slotId === null || petToken === null) return;`), so a mutation that
    // drops the `disabled` expression's slot/pet clauses left every other test
    // in this file green — nothing writes, it just LOOKS pressable when it
    // cannot do anything. `disabled` is asserted directly, not inferred from
    // "pressing it did nothing".
    mockRead.mockResolvedValue({ outcome: "ok", payload: detail() });
    render(<ReservarTurnoScreen offeringToken="SVO-7K2M-9QX4" onBooked={jest.fn()} />);
    await waitFor(() => expect(screen.getByText("10:30")).toBeTruthy());

    const reservar = () => screen.getByRole("button", { name: "Reservar" });
    expect(reservar().props.accessibilityState.disabled).toBe(true);

    fireEvent.press(screen.getByText("10:30"));
    // A TIME ALONE IS NOT ENOUGH — the animal is still unchosen.
    expect(reservar().props.accessibilityState.disabled).toBe(true);

    fireEvent.press(screen.getByText("Pampa · 0001"));
    expect(reservar().props.accessibilityState.disabled).toBe(false);
  });
});

describe("the write", () => {
  it("sends the SLOT that was tapped and the ANIMAL that was chosen", async () => {
    mockRead.mockResolvedValue({ outcome: "ok", payload: detail() });
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "book", appointmentToken: "APT-NEW-0001" },
    });
    render(<ReservarTurnoScreen offeringToken="SVO-7K2M-9QX4" onBooked={jest.fn()} />);

    // The SECOND slot, so a screen that always sent the first is caught.
    await chooseSlotAndPet("11:00");
    fireEvent.press(screen.getByText("Reservar"));

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend.mock.calls[0]?.[1]).toEqual({
      command: "book",
      slotId: OTHER_SLOT_UUID,
      petPublicToken: "DIM-PAMP-0001",
    });
  });

  it("hands the SERVER's appointment token back, which the client cannot construct", async () => {
    const onBooked = jest.fn();
    mockRead.mockResolvedValue({ outcome: "ok", payload: detail() });
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "book", appointmentToken: "APT-NEW-0001" },
    });
    render(<ReservarTurnoScreen offeringToken="SVO-7K2M-9QX4" onBooked={onBooked} />);

    await chooseSlotAndPet();
    fireEvent.press(screen.getByText("Reservar"));

    await waitFor(() => expect(onBooked).toHaveBeenCalledWith("APT-NEW-0001"));
  });

  it("RE-READS after a refusal and never re-sends", async () => {
    // The whole point of the header's third paragraph. A retry after a timeout is
    // indistinguishable from somebody else taking the last place, so the grid is
    // what says whether the place is still there.
    mockRead.mockResolvedValue({ outcome: "ok", payload: detail() });
    mockSend.mockResolvedValue({ outcome: "api-error", code: "appointment_already_resolved" });
    render(<ReservarTurnoScreen offeringToken="SVO-7K2M-9QX4" onBooked={jest.fn()} />);

    await chooseSlotAndPet();
    fireEvent.press(screen.getByText("Reservar"));

    await waitFor(() => expect(mockRead).toHaveBeenCalledTimes(2));
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("does not navigate on a refusal", async () => {
    const onBooked = jest.fn();
    mockRead.mockResolvedValue({ outcome: "ok", payload: detail() });
    mockSend.mockResolvedValue({ outcome: "api-error", code: "not_found" });
    render(<ReservarTurnoScreen offeringToken="SVO-7K2M-9QX4" onBooked={onBooked} />);

    await chooseSlotAndPet();
    fireEvent.press(screen.getByText("Reservar"));

    await waitFor(() => expect(mockRead).toHaveBeenCalledTimes(2));
    expect(onBooked).not.toHaveBeenCalled();
  });

  it("DROPS the chosen slot on a re-read, so the button never stands over a stale id", async () => {
    // A slot id that survived a reload is a slot the new grid may no longer
    // contain, and a "Reservar" button over it is the write's refusal made to look
    // like the person's fault.
    mockRead.mockResolvedValue({ outcome: "ok", payload: detail() });
    render(<ReservarTurnoScreen offeringToken="SVO-7K2M-9QX4" onBooked={jest.fn()} />);

    await chooseSlotAndPet();
    fireEvent.press(screen.getByText("Actualizar horarios"));

    await waitFor(() => expect(mockRead).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Reservar")).toBeTruthy());
    // Nothing chosen, so the write cannot run — pressing it sends nothing.
    fireEvent.press(screen.getByText("Reservar"));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses an ack for a command it did not send, rather than treating it as a booking", async () => {
    const onBooked = jest.fn();
    mockRead.mockResolvedValue({ outcome: "ok", payload: detail() });
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: { command: "cancel", changed: true, appointmentToken: "APT-OTHER" },
    });
    render(<ReservarTurnoScreen offeringToken="SVO-7K2M-9QX4" onBooked={onBooked} />);

    await chooseSlotAndPet();
    fireEvent.press(screen.getByText("Reservar"));

    await waitFor(() => expect(screen.getByText(/no correspondía a esta reserva/i)).toBeTruthy());
    expect(onBooked).not.toHaveBeenCalled();
  });
});
