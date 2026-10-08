// `LibretaScreen` — the face the product is named after, rendered.
//
// WHAT A RENDER TEST ADDS HERE that `libreta-view-model.test.ts` cannot:
// the view-model already proves an unavailable section keeps its refusal copy,
// and proves nothing at all about whether the SCREEN prints it. A section
// rendered as an empty View would tell an owner "this animal has no asientos"
// while the server said "we could not read them" — the exact dishonesty this
// screen's own header is written against, and invisible to a pure test.
//
// The other thing only a render test sees is how the face fails — a section
// drawn as empty vs a refusal — which the view-model alone cannot prove.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import type { PetLibretaV1 } from "@dim/contract/api";

const mockPush = jest.fn();
const mockFetchPetLibreta = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  // The real one runs its callback when the screen gains focus. Under test
  // there is no navigator, so the honest stand-in is "run it on mount" — which
  // is what focus does the first time, and the assertion that matters (one read
  // per appearance) is unchanged.
  useFocusEffect: (callback: () => void) => {
    const { useEffect } = require("react");
    useEffect(callback, [callback]);
  },
}));

jest.mock("../api/endpoints", () => ({
  fetchPetLibreta: (...args: unknown[]) => mockFetchPetLibreta(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import { LibretaScreen } from "./LibretaScreen";

const TOKEN = "DIM-PAMP-0001";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    eventId: EVENT_ID,
    eventType: "vaccination_administered",
    kind: "Vacuna · obligatoria",
    title: "Antirrábica",
    occurredAt: "2026-08-20T12:00:00.000Z",
    whenRelative: "hace 5 días",
    whenAbsolute: "20 de agosto de 2026",
    facts: [],
    note: null,
    provenance: { label: "Registrado por el dueño", verified: false },
    warning: null,
    amendedAt: null,
    hasAttachments: false,
    ...overrides,
  };
}

function payload(overrides: Partial<Record<string, unknown>> = {}): PetLibretaV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-25T15:00:00.000Z",
    staleAfter: "2026-08-25T15:05:00.000Z",
    publicToken: TOKEN,
    viewer: { role: "owner", isTitular: true, canAmend: true },
    identity: {
      status: "ok",
      data: { name: "Pampa", species: "Perro", sex: "female", publicToken: TOKEN },
    },
    vaccination: {
      status: "ok",
      data: {
        active: 1,
        dueSoon: 0,
        expired: 0,
        missing: 0,
        unconfirmed: 0,
        otherCount: 0,
        perVaccine: [{ vaccineName: "Séxtuple", status: "active" }],
      },
    },
    upcoming: { status: "ok", data: { items: [] } },
    timeline: { status: "ok", data: { entries: [entry()], total: 1, truncated: false } },
    ...overrides,
  } as unknown as PetLibretaV1;
}

beforeEach(() => {
  mockPush.mockReset();
  mockFetchPetLibreta.mockReset();
  mockFetchPetLibreta.mockResolvedValue({ outcome: "ok", payload: payload() });
});

describe("LibretaScreen — a species with no reference calendar (QA v14 P1)", () => {
  it("lists only what was recorded and says there is no calendar, with no 'sin aplicar' count", async () => {
    mockFetchPetLibreta.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        identity: {
          status: "ok",
          data: { name: "Pampita", species: "ferret", sex: "female", publicToken: TOKEN },
        },
        vaccination: {
          status: "ok",
          data: {
            active: 1,
            dueSoon: 0,
            expired: 0,
            missing: 0,
            unconfirmed: 0,
            otherCount: 0,
            perVaccine: [{ vaccineName: "Antirrábica", status: "active" }],
            calendarNote: "No tenemos un calendario de vacunas de referencia para hurones.",
          },
        },
      }),
    });
    render(<LibretaScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Pampita")).toBeOnTheScreen();
    expect(
      screen.getByText("No tenemos un calendario de vacunas de referencia para hurones."),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/sin aplicar/)).toBeNull();
    expect(screen.queryByText(/Séxtuple|Quíntuple|Triple felina/)).toBeNull();
    expect(screen.queryByText("Nunca aplicada")).toBeNull();
  });
});

describe("LibretaScreen — what a read that worked shows", () => {
  it("renders the animal, its vaccination verdict and its asientos", async () => {
    render(<LibretaScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Pampa")).toBeOnTheScreen();
    expect(screen.queryByText(TOKEN)).toBeNull();
    expect(screen.getAllByText("Vigente").length).toBeGreaterThan(0);
    expect(screen.getByText("Séxtuple")).toBeOnTheScreen();
    expect(screen.getByText("Antirrábica")).toBeOnTheScreen();
  });

  it("does not claim that asientos can never be erased", async () => {
    // PO 2026-09-30: the old footer ("Los eventos no se editan ni se borran")
    // contradicted Ley 25.326 art. 16, which allows audited erasure. Removed,
    // not reworded.
    render(<LibretaScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Pampa")).toBeOnTheScreen();
    expect(screen.queryByText(/se borran/i)).toBeNull();
  });

  it("opens one asiento when it is pressed", async () => {
    render(<LibretaScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Antirrábica"));
    expect(mockPush).toHaveBeenCalledWith(`/mascotas/${TOKEN}/eventos/${EVENT_ID}`);
  });

  it("does not offer Anotar on the dorso — that door lives on the credential face", async () => {
    // PO annotate 2026-10-05: one Anotar, below the front card. The ledger
    // face used to carry a second PrimaryButton that opened the same picker.
    render(<LibretaScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    expect(screen.queryByText("Anotar")).toBeNull();
  });

  it("does not repeat Libreta sanitaria or the DIM token in the masthead", async () => {
    render(<LibretaScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    expect(screen.queryByText("Libreta sanitaria")).toBeNull();
    expect(screen.queryByText(TOKEN)).toBeNull();
  });

  it("hides Próximo when nothing is due — no 'nada programado' empty box", async () => {
    render(<LibretaScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");
    expect(screen.queryByText("Próximo")).toBeNull();
    expect(screen.queryByText("No hay nada programado.")).toBeNull();
  });

  it("does not repeat the title as the kind, or the head date as a fact", async () => {
    mockFetchPetLibreta.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        timeline: {
          status: "ok",
          data: {
            entries: [
              entry({
                kind: "Antirrábica",
                title: "Antirrábica",
                facts: [
                  { key: "Fecha", value: "20 de agosto de 2026", missing: false, mono: false },
                  { key: "Lote", value: "AB-1", missing: false, mono: true },
                ],
              }),
            ],
            total: 1,
            truncated: false,
          },
        },
      }),
    });
    render(<LibretaScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Lote")).toBeOnTheScreen();
    expect(screen.getByText("AB-1")).toBeOnTheScreen();
    expect(screen.queryByText("Fecha")).toBeNull();
    expect(screen.getAllByText("Antirrábica")).toHaveLength(1);
  });
});

describe("LibretaScreen — a failure is never drawn as an absence", () => {
  it("says the SECTION could not be read, rather than rendering it empty", async () => {
    // The distinction this whole screen is written around: "todavía no hay
    // asientos" is a fact about the ANIMAL; "no se pudo leer" is a fact about
    // the READ. A blank card would say the first while the server said the
    // second.
    mockFetchPetLibreta.mockResolvedValue({
      outcome: "ok",
      payload: payload({ timeline: { status: "unavailable" } }),
    });
    render(<LibretaScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/No se pudo leer/i)).toBeOnTheScreen();
    // The sections that DID read are still there — one failure is not a page.
    expect(screen.getByText("Pampa")).toBeOnTheScreen();
  });

  it("says the LIBRETA could not be read when the whole call failed", async () => {
    mockFetchPetLibreta.mockResolvedValue({
      outcome: "api-error",
      code: "temporarily_unavailable",
    });
    render(<LibretaScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/El servidor no pudo responder/)).toBeOnTheScreen();
  });

  it("does not invent an Anotar door after a failed read either", async () => {
    mockFetchPetLibreta.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<LibretaScreen publicToken={TOKEN} />);
    await screen.findByText(/Revisá tu conexión/);
    expect(screen.queryByText("Anotar")).toBeNull();
  });

  it("re-reads when the screen is entered, not only when it is first built", async () => {
    // Writing an asiento (from the credential's Anotar) pushes a route on top
    // of this face; coming back must show what was just written. A mount-only
    // effect would leave the owner staring at the libreta they just added to,
    // unchanged.
    render(<LibretaScreen publicToken={TOKEN} />);
    await waitFor(() => expect(mockFetchPetLibreta).toHaveBeenCalledTimes(1));
    expect(mockFetchPetLibreta).toHaveBeenCalledWith({}, TOKEN);
  });
});

// ---------------------------------------------------------------------------
// S-3 — A DEAD ANIMAL HAS NO NEXT VACCINATION
// ---------------------------------------------------------------------------

describe("a deceased animal's ledger", () => {
  const UPCOMING = {
    status: "ok" as const,
    data: {
      items: [
        {
          id: "up-1",
          kind: "reminder" as const,
          label: "Antirrábica",
          dueAt: "2026-12-01T03:00:00.000Z",
        },
      ],
    },
  };

  it("does not print a due date for an animal that has died", async () => {
    // The schedule is a property of the VACCINE, so the server goes on
    // computing one. The libreta printed it under the name of an animal whose
    // memorial is on the other face of the same document.
    mockFetchPetLibreta.mockResolvedValue({
      outcome: "ok",
      payload: payload({ upcoming: UPCOMING }),
    });

    render(<LibretaScreen publicToken={TOKEN} deceased />);

    await waitFor(() => expect(screen.getByText("Pampa")).toBeTruthy());
    expect(screen.queryByText("Próximo")).toBeNull();
    expect(screen.queryByText(/Recordatorio · Antirrábica/)).toBeNull();
  });

  it("still prints it for a live one", async () => {
    // The control: the suppression must be about the animal, not about the
    // section.
    mockFetchPetLibreta.mockResolvedValue({
      outcome: "ok",
      payload: payload({ upcoming: UPCOMING }),
    });

    render(<LibretaScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Próximo")).toBeTruthy());
    expect(screen.getByText(/Recordatorio · Antirrábica/)).toBeTruthy();
  });
});

describe("a medication course in Próximo", () => {
  it("is one row naming the drug once, with what is left of the course beneath it", async () => {
    // Seen on a J7: "Dosis · Antiparasitario de amplio espectro – Dosis", once
    // per scheduled dose. The server now sends one row per course with the
    // drug's own name and a count.
    mockFetchPetLibreta.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        upcoming: {
          status: "ok" as const,
          data: {
            items: [
              {
                id: "med-r1",
                kind: "medication" as const,
                label: "Antiparasitario de amplio espectro",
                dueAt: "2026-12-01T03:00:00.000Z",
                reminderId: null,
                remainingDoses: 4,
              },
            ],
          },
        },
      }),
    });

    render(<LibretaScreen publicToken={TOKEN} />);

    await waitFor(() => expect(screen.getByText("Próximo")).toBeTruthy());
    expect(screen.getByText("Antiparasitario de amplio espectro · próxima dosis")).toBeTruthy();
    expect(screen.getByText("quedan 4 dosis")).toBeTruthy();
    expect(screen.queryByText(/Dosis · /)).toBeNull();
  });
});

describe("LibretaScreen — Pedir verificación", () => {
  it("links an unverified rabies dose to finding a turno, as the web does", async () => {
    mockFetchPetLibreta.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        timeline: {
          status: "ok",
          data: {
            entries: [entry({ warning: "Falta verificación profesional" })],
            total: 1,
            truncated: false,
          },
        },
      }),
    });
    render(<LibretaScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Falta verificación profesional")).toBeOnTheScreen();
    fireEvent.press(screen.getByRole("link", { name: "Pedir verificación" }));
    expect(mockPush).toHaveBeenCalledWith("/turnos/buscar");
    // The link is its own control: it does not also open the asiento.
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it("offers no link for a verified dose or for another vaccine", async () => {
    mockFetchPetLibreta.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        timeline: {
          status: "ok",
          data: {
            entries: [
              entry({ eventId: "e-1", provenance: { label: "Verificado", verified: true } }),
              entry({
                eventId: "e-2",
                kind: "Vacuna",
                title: "Séxtuple",
                warning: "Falta verificación profesional",
              }),
            ],
            total: 2,
            truncated: false,
          },
        },
      }),
    });
    render(<LibretaScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Verificado")).toBeOnTheScreen();
    expect(screen.queryByText("Pedir verificación")).toBeNull();
  });
});

describe("LibretaScreen — Pedir verificación is the owner path's", () => {
  it("is not offered to an organization's reader", async () => {
    mockFetchPetLibreta.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        viewer: { role: "org_member", isTitular: false, canAmend: false },
        timeline: {
          status: "ok",
          data: {
            entries: [entry({ warning: "Falta verificación profesional" })],
            total: 1,
            truncated: false,
          },
        },
      }),
    });
    render(<LibretaScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Falta verificación profesional")).toBeOnTheScreen();
    expect(screen.queryByText("Pedir verificación")).toBeNull();
  });

  it("is offered to a caretaker, who holds the animal as a person", async () => {
    mockFetchPetLibreta.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        viewer: { role: "caretaker", isTitular: false, canAmend: false },
        timeline: {
          status: "ok",
          data: {
            entries: [entry({ warning: "Falta verificación profesional" })],
            total: 1,
            truncated: false,
          },
        },
      }),
    });
    render(<LibretaScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Pedir verificación")).toBeOnTheScreen();
  });
});

describe("LibretaScreen — trip papers ticks", () => {
  function tick(id: string) {
    return entry({
      eventId: id,
      eventType: "event_amended",
      kind: "Viaje",
      title: "Papeles del viaje actualizados",
      facts: [
        { key: "Fecha", value: "20 de agosto de 2026", missing: false, mono: false },
        { key: "Destino", value: "Chile", missing: false, mono: false },
        { key: "Fecha del viaje", value: "15 de nov de 2026", missing: false, mono: false },
      ],
    });
  }

  it("draws consecutive same-day ticks of one trip as ONE row, opening the newest", async () => {
    mockFetchPetLibreta.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        timeline: {
          status: "ok",
          data: { entries: [tick("t-3"), tick("t-2"), tick("t-1")], total: 3, truncated: false },
        },
      }),
    });
    render(<LibretaScreen publicToken={TOKEN} />);
    const row = await screen.findByText("Papeles del viaje actualizados · 3 cambios · Chile");
    expect(screen.queryByText("Papeles del viaje actualizados")).toBeNull();
    // The count above the ledger is still the log's: three asientos.
    expect(screen.getByText("3 registros")).toBeOnTheScreen();
    fireEvent.press(row);
    expect(mockPush).toHaveBeenCalledWith(`/mascotas/${TOKEN}/eventos/t-3`);
  });

  it("keeps every tick reachable: 'Ver cada cambio' lists one link per tick", async () => {
    mockFetchPetLibreta.mockResolvedValue({
      outcome: "ok",
      payload: payload({
        timeline: {
          status: "ok",
          data: { entries: [tick("t-3"), tick("t-2"), tick("t-1")], total: 3, truncated: false },
        },
      }),
    });
    render(<LibretaScreen publicToken={TOKEN} />);
    await screen.findByText("Papeles del viaje actualizados · 3 cambios · Chile");
    expect(screen.queryByText("Cambio 2 de 3")).toBeNull();

    const collapsed = screen.getByRole("button", { name: "Ver cada cambio" });
    expect(collapsed).toBeCollapsed();
    fireEvent.press(collapsed);
    expect(screen.getByRole("button", { name: "Ocultar los cambios" })).toBeExpanded();
    for (const [label, id] of [
      ["Cambio 3 de 3", "t-3"],
      ["Cambio 2 de 3", "t-2"],
      ["Cambio 1 de 3", "t-1"],
    ]) {
      fireEvent.press(screen.getByRole("link", { name: label }));
      expect(mockPush).toHaveBeenLastCalledWith(`/mascotas/${TOKEN}/eventos/${id}`);
    }

    fireEvent.press(screen.getByRole("button", { name: "Ocultar los cambios" }));
    expect(screen.queryByText("Cambio 2 de 3")).toBeNull();
    expect(screen.getByRole("button", { name: "Ver cada cambio" })).toBeCollapsed();
  });
});

describe("LibretaScreen — the first read", () => {
  it("shows a skeleton the shape of the libreta, not a spinner", () => {
    mockFetchPetLibreta.mockReturnValue(new Promise(() => {}));
    render(<LibretaScreen publicToken={TOKEN} />);
    // Announced once, with the sentence the spinner carried…
    expect(screen.getByRole("progressbar", { name: "Leyendo la libreta…" })).toBeOnTheScreen();
    // …and drawn as the face itself, not as a line of text.
    expect(
      screen.getByTestId("libreta-face-skeleton", { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(screen.queryByText("Leyendo la libreta…")).toBeNull();
  });

  it("replaces the skeleton with the ledger when the read lands", async () => {
    render(<LibretaScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Pampa")).toBeOnTheScreen();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
