// `EventDetailScreen` — one asiento, rendered.
//
// WHAT ONLY A RENDER TEST SEES HERE. `event-detail-view-model.test.ts` proves
// the mapping; this proves the SCREEN honours it. Two things in particular:
//
//   · THE CORRECTION AFFORDANCE IS GATED. `canAmend: false` must hide the
//     button and SHOW the reason — a screen that hid both would leave a person
//     hunting for a control that was deliberately withheld.
//   · "TERMINAR MEDICACIÓN" APPEARS ON EXACTLY ONE KIND OF ASIENTO. It is the
//     only entry point to the sixth writer, so if it renders on the wrong
//     record — or fails to render on the right one — that writer is unreachable
//     or reachable from nonsense, and no pure test would notice either.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import type { PetEventDetailV1 } from "@dim/contract/api";

const mockPush = jest.fn();
const mockFetchPetEventDetail = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockAmendPetEvent = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

jest.mock("../api/endpoints", () => ({
  fetchPetEventDetail: (...args: unknown[]) => mockFetchPetEventDetail(...args),
  amendPetEvent: (...args: unknown[]) => mockAmendPetEvent(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import { EventDetailScreen } from "./EventDetailScreen";
import { AMEND_READ_ONLY_TITLE } from "./event-detail-view-model";

const TOKEN = "DIM-PAMP-0001";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";

function payload(overrides: Record<string, unknown> = {}): PetEventDetailV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-25T15:00:00.000Z",
    staleAfter: "2026-08-25T15:05:00.000Z",
    publicToken: TOKEN,
    eventId: EVENT_ID,
    eventType: "vaccination_administered",
    kind: "Vacuna · obligatoria",
    title: "Antirrábica",
    subtitle: null,
    occurredAt: "2026-08-20T12:00:00.000Z",
    recordedAt: "2026-08-21T09:00:00.000Z",
    notes: null,
    location: null,
    author: { roleLabel: "Dueño", organizationName: null, verified: false },
    facts: [{ field: "batch", label: "Lote", value: "L-42" }],
    amendments: { status: "ok", data: { items: [] } },
    attachments: { status: "ok", data: { items: [] } },
    amend: { canAmend: true, refusal: null },
    ...overrides,
  } as unknown as PetEventDetailV1;
}

beforeEach(() => {
  mockPush.mockReset();
  mockAmendPetEvent.mockReset();
  mockFetchPetEventDetail.mockReset();
  mockFetchPetEventDetail.mockResolvedValue({ outcome: "ok", payload: payload() });
});

describe("EventDetailScreen — the record", () => {
  it("renders the asiento with both of its dates and its curated fields", async () => {
    render(<EventDetailScreen publicToken={TOKEN} eventId={EVENT_ID} />);
    expect(await screen.findByText("Antirrábica")).toBeOnTheScreen();
    expect(screen.getByText("Vacuna · obligatoria")).toBeOnTheScreen();
    expect(screen.getByText("L-42")).toBeOnTheScreen();
    // Two dates, two different questions — when it HAPPENED and when somebody
    // wrote it down. Collapsing them would hide an imported record's history.
    expect(screen.getByText("Ocurrió")).toBeOnTheScreen();
    expect(screen.getByText("Registrado")).toBeOnTheScreen();
  });

  it("renders a failed read as a failed read, with a way out", async () => {
    mockFetchPetEventDetail.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<EventDetailScreen publicToken={TOKEN} eventId={EVENT_ID} />);
    expect(await screen.findByText(/Revisá tu conexión/)).toBeOnTheScreen();
    expect(screen.getByText("Volver a intentar")).toBeOnTheScreen();
  });
});

describe("EventDetailScreen — the correction affordance", () => {
  it("offers it when the server says this viewer may correct", async () => {
    render(<EventDetailScreen publicToken={TOKEN} eventId={EVENT_ID} />);
    expect(await screen.findByText("Corregir registro")).toBeOnTheScreen();
  });

  it("hides the button and SHOWS THE REASON when the server refuses", async () => {
    // Hiding both would be worse than either: a person would hunt for a control
    // that was withheld on purpose, and never learn why.
    mockFetchPetEventDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        amend: { canAmend: false, refusal: "Este registro no admite correcciones." },
      }),
    });
    render(<EventDetailScreen publicToken={TOKEN} eventId={EVENT_ID} />);
    expect(await screen.findByText("Este registro no admite correcciones.")).toBeOnTheScreen();
    expect(screen.queryByText("Corregir registro")).toBeNull();
  });
});

describe("EventDetailScreen — terminar medicación", () => {
  it("does NOT offer it on an asiento that did not start a treatment", async () => {
    render(<EventDetailScreen publicToken={TOKEN} eventId={EVENT_ID} />);
    await screen.findByText("Antirrábica");
    expect(screen.queryByText("Terminar medicación")).toBeNull();
  });

  it("offers it on a medication_started, and carries that asiento to the writer", async () => {
    // The whole reason this affordance lives here: ending a treatment needs the
    // identifier of the event it ends, and this is the only screen where a
    // person already holds it.
    mockFetchPetEventDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        eventType: "medication_started",
        kind: "Medicación",
        title: "Amoxicilina",
      }),
    });
    render(<EventDetailScreen publicToken={TOKEN} eventId={EVENT_ID} />);
    fireEvent.press(await screen.findByText("Terminar medicación"));
    expect(mockPush).toHaveBeenCalledWith(
      `/mascotas/${TOKEN}/asentar?kind=medication_end&source=${EVENT_ID}`,
    );
  });

  it("matches on the SPINE's type, not on the worded eyebrow", async () => {
    // A record whose es-AR eyebrow says "Medicación" but whose event_type is the
    // STOP must not offer to stop it again. Matching on display copy would break
    // the day somebody rewords one.
    mockFetchPetEventDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        eventType: "medication_stopped",
        kind: "Medicación",
        title: "Amoxicilina",
      }),
    });
    render(<EventDetailScreen publicToken={TOKEN} eventId={EVENT_ID} />);
    await screen.findByText("Amoxicilina");
    expect(screen.queryByText("Terminar medicación")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The microchip replacement door (2026-09-11)
//
// `microchip_replace` was in `WRITABLE_KINDS` with a complete, tested form and
// NOTHING IN THE APP NAVIGATED TO IT. Its own docblock named the home it was
// meant to have — "from the microchip the animal already has" — and this screen
// is the only place in the app where a person is holding that number: the owner
// face's compliance card renders `card.state` and not `card.detail`, and the
// public credential prints "Microchip: Sí/No" and never the code. The server
// emits the number here, as the `Número` fact.
// ---------------------------------------------------------------------------

describe("EventDetailScreen — reemplazar el microchip", () => {
  it("does NOT offer it on an asiento that is not a microchip implant", async () => {
    render(<EventDetailScreen publicToken={TOKEN} eventId={EVENT_ID} />);
    await screen.findByText("Antirrábica");
    expect(screen.queryByText("Reemplazar el microchip")).toBeNull();
  });

  it("offers it on a microchip_implanted and opens the replacement form", async () => {
    mockFetchPetEventDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        eventType: "microchip_implanted",
        kind: "Microchip",
        title: "Microchip colocado",
      }),
    });
    render(<EventDetailScreen publicToken={TOKEN} eventId={EVENT_ID} />);
    fireEvent.press(await screen.findByText("Reemplazar el microchip"));
    // NO `source`, unlike "Terminar medicación" directly above, and the absence
    // is the assertion. The contract's `microchipReplace` carries no reference
    // to the event it supersedes and no `previousChipNumber`: the endpoint reads
    // the animal's canonical chip server-side. A `&source=` here would be this
    // screen asserting a fact the server already holds.
    expect(mockPush).toHaveBeenCalledWith(`/mascotas/${TOKEN}/asentar?kind=microchip_replace`);
  });

  it("matches on the SPINE's type, not on the worded eyebrow", async () => {
    // Same trap the medication door has: an asiento whose es-AR eyebrow reads
    // "Microchip" but whose event_type is the REPLACEMENT must not offer the
    // door again. `microchip_replaced` is also the umbrella for a pure
    // REVOCATION, whose meaning is that there is no chip left to replace — a
    // door there would 409 by construction.
    mockFetchPetEventDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        eventType: "microchip_replaced",
        kind: "Microchip",
        title: "Microchip reemplazado",
      }),
    });
    render(<EventDetailScreen publicToken={TOKEN} eventId={EVENT_ID} />);
    await screen.findByText("Microchip reemplazado");
    expect(screen.queryByText("Reemplazar el microchip")).toBeNull();
  });

  it("does not put the medication door on a microchip asiento", async () => {
    // The two blocks are siblings with the same shape, which is exactly how one
    // ends up rendering under the other's condition.
    mockFetchPetEventDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        eventType: "microchip_implanted",
        kind: "Microchip",
        title: "Microchip colocado",
      }),
    });
    render(<EventDetailScreen publicToken={TOKEN} eventId={EVENT_ID} />);
    await screen.findByText("Reemplazar el microchip");
    expect(screen.queryByText("Terminar medicación")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A2-alta-asentar-02 — the correction form draws a box only for a row it can
// post back unchanged
// ---------------------------------------------------------------------------
//
// The view-model test proves the SUBMIT cannot carry a formatted value. This
// proves the person never sees a box inviting them to type one, and — the half
// only a render test can see — that the row is still THERE, with the destination
// named. A row that silently vanished from the form would read as the app having
// forgotten a field.

describe("EventDetailScreen — the rows a correction may not touch", () => {
  it("draws no input for a formatted date, keeps the row visible, and names the web", async () => {
    mockFetchPetEventDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        facts: [
          { field: "batch", label: "Lote", value: "L-42" },
          { field: "next_due_at", label: "Próxima dosis", value: "12/03/2026" },
        ],
      }),
    });
    render(<EventDetailScreen publicToken={TOKEN} eventId={EVENT_ID} />);
    fireEvent.press(await screen.findByText("Corregir registro"));

    // The free-text row keeps its box…
    expect(screen.getByLabelText("Lote")).toBeOnTheScreen();
    // …and the formatted one has none. `getByLabelText` finds the INPUT, which
    // is the whole difference between "shown" and "editable".
    expect(screen.queryByLabelText("Próxima dosis")).toBeNull();
    // Shown, though — and TWICE, which is the whole assertion. `> 0` was
    // satisfied by the "Detalle" card alone, which renders every fact whether or
    // not the correction form is open, so the honest-degradation half was never
    // actually proven. Two occurrences means the read-only block rendered its own
    // copy; its heading and the destination sentence pin the rest.
    expect(screen.getAllByText("12/03/2026")).toHaveLength(2);
    expect(screen.getByText(AMEND_READ_ONLY_TITLE)).toBeOnTheScreen();
    expect(screen.getByText(/Corregilos desde miMAR en la web/)).toBeOnTheScreen();
  });

  it("does not offer the form at all on a peso, whose only row is formatted", async () => {
    // Opening it would give a form with zero boxes whose submit can only answer
    // "no modificaste ningún campo" — the contract requires one change.
    mockFetchPetEventDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        eventType: "weight_recorded",
        kind: "Peso",
        title: "Peso: 12,5 kg",
        facts: [{ field: "kg", label: "Peso", value: "12,5 kg" }],
      }),
    });
    render(<EventDetailScreen publicToken={TOKEN} eventId={EVENT_ID} />);
    await screen.findByText("Peso: 12,5 kg");

    expect(screen.queryByText("Corregir registro")).toBeNull();
    expect(
      screen.getByText(/no tiene datos que se puedan corregir desde la app/),
    ).toBeOnTheScreen();
  });

  it("posts only the free-text change, with the formatted row edited out of reach", async () => {
    // THE LAYER THAT PERSISTS, asserted through the screen: what actually
    // reaches `amendPetEvent`. A test that stopped at the rendered boxes could
    // not see a state map still carrying the date.
    mockAmendPetEvent.mockResolvedValue({ outcome: "ok", payload: {} });
    mockFetchPetEventDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        facts: [
          { field: "batch", label: "Lote", value: "L-42" },
          { field: "next_due_at", label: "Próxima dosis", value: "12/03/2026" },
        ],
      }),
    });
    render(<EventDetailScreen publicToken={TOKEN} eventId={EVENT_ID} />);
    fireEvent.press(await screen.findByText("Corregir registro"));
    fireEvent.changeText(screen.getByLabelText("Lote"), "L-99");
    fireEvent.press(screen.getByText("Confirmar corrección"));

    await waitFor(() => expect(mockAmendPetEvent).toHaveBeenCalled());
    const body = mockAmendPetEvent.mock.calls[0]?.[2] as { changes: Array<{ field: string }> };
    expect(body.changes).toEqual([{ field: "batch", value: "L-99" }]);
  });

  it("does not tell an asiento with NO curated rows that its rows are formatted", async () => {
    // `medication_started` and `clinical_info_logged` are amendable and have no
    // arm in `eventPayloadDetails`, so they render zero rows — the card above
    // already says "Sin campos adicionales". "los que tiene se muestran con
    // formato" would be a false statement on a citizen surface about a very
    // common asiento; the destination clause stays true and stays put.
    mockFetchPetEventDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        eventType: "medication_started",
        kind: "Medicación",
        title: "Amoxicilina",
        facts: [],
      }),
    });
    render(<EventDetailScreen publicToken={TOKEN} eventId={EVENT_ID} />);
    await screen.findByText("Amoxicilina");

    expect(screen.queryByText("Corregir registro")).toBeNull();
    expect(screen.queryByText(/los que tiene se muestran con formato/)).toBeNull();
    expect(screen.getByText(/no muestra campos que la app pueda corregir/)).toBeOnTheScreen();
    expect(screen.getByText(/ahí se ven todos los datos guardados/)).toBeOnTheScreen();
  });

  it("refuses to submit an EMPTIED box the spine requires, and says which one", async () => {
    // The allowlist decides which ROWS get a box, never which VALUES may go in
    // one. `note_added.text` is `z.string()`, so an emptied "Nota" used to post
    // `value: null` into a required field — nothing re-validates an amended
    // payload — and the projection then dropped the row.
    mockAmendPetEvent.mockResolvedValue({ outcome: "ok", payload: {} });
    mockFetchPetEventDetail.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        eventType: "note_added",
        kind: "Nota",
        title: "Nota",
        facts: [{ field: "text", label: "Nota", value: "hola" }],
      }),
    });
    render(<EventDetailScreen publicToken={TOKEN} eventId={EVENT_ID} />);
    fireEvent.press(await screen.findByText("Corregir registro"));
    fireEvent.changeText(screen.getByLabelText("Nota"), "   ");
    fireEvent.press(screen.getByText("Confirmar corrección"));

    expect(await screen.findByText(/«Nota» no puede quedar vacío/)).toBeOnTheScreen();
    expect(mockAmendPetEvent).not.toHaveBeenCalled();
  });
});
