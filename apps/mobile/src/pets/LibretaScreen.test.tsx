// `LibretaScreen` — the face the product is named after, rendered.
//
// WHAT A RENDER TEST ADDS HERE that `libreta-view-model.test.ts` cannot:
// the view-model already proves an unavailable section keeps its refusal copy,
// and proves nothing at all about whether the SCREEN prints it. A section
// rendered as an empty View would tell an owner "this animal has no asientos"
// while the server said "we could not read them" — the exact dishonesty this
// screen's own header is written against, and invisible to a pure test.
//
// The other thing only a render test sees is the WRITE this face now offers.

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

/**
 * Every rendered string, in the order the tree draws them.
 *
 * `getByText` answers "is it there", which is the wrong question for a control
 * whose defect was WHERE it was. The rendered JSON is the only thing that
 * carries document order, so the walk is over that rather than over queries.
 */
function renderedTextsInOrder(): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node !== null && typeof node === "object" && "children" in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(screen.toJSON());
  return found;
}

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

describe("LibretaScreen — what a read that worked shows", () => {
  it("renders the animal, its vaccination verdict and its asientos", async () => {
    render(<LibretaScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Pampa")).toBeOnTheScreen();
    expect(screen.getByText(TOKEN)).toBeOnTheScreen();
    expect(screen.getByText("AL DÍA")).toBeOnTheScreen();
    expect(screen.getByText("Séxtuple")).toBeOnTheScreen();
    expect(screen.getByText("Antirrábica")).toBeOnTheScreen();
  });

  it("opens one asiento when it is pressed", async () => {
    render(<LibretaScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Antirrábica"));
    expect(mockPush).toHaveBeenCalledWith(`/mascotas/${TOKEN}/eventos/${EVENT_ID}`);
  });

  it("offers ASENTAR, and sends the person to the writer with no kind pre-picked", async () => {
    render(<LibretaScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Asentar"));
    expect(mockPush).toHaveBeenCalledWith(`/mascotas/${TOKEN}/asentar`);
  });

  it("draws ASENTAR BEFORE the ledger, so a long history cannot bury it", async () => {
    // D2 (native QA batch 1). The button used to be this face's last child, and
    // this face renders inside `PetDocumentScreen`'s single scroll view — so on
    // a pet with 26 asientos the only act the libreta offers sat under the whole
    // history, with no per-face scroll to pin it to.
    //
    // ORDER, not presence: every case around this one already proves the button
    // renders. Asserted against the masthead ("Pampa", the first thing the body
    // draws) AND against a timeline entry, because passing only the second would
    // still allow it to sit between the vaccination card and the ledger.
    render(<LibretaScreen publicToken={TOKEN} />);
    await screen.findByText("Pampa");

    const order = renderedTextsInOrder();
    expect(order).toContain("Asentar");
    expect(order.indexOf("Asentar")).toBeLessThan(order.indexOf("Pampa"));
    expect(order.indexOf("Asentar")).toBeLessThan(order.indexOf("Antirrábica"));
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

  it("still offers ASENTAR after a failed read", async () => {
    // A section this app could not load says nothing about whether the animal
    // was vaccinated this morning, and the server is the one that decides
    // whether the write is allowed. Hiding the affordance would be the client
    // guessing on the server's behalf.
    mockFetchPetLibreta.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<LibretaScreen publicToken={TOKEN} />);
    await screen.findByText(/Revisá tu conexión/);
    fireEvent.press(screen.getByText("Asentar"));
    expect(mockPush).toHaveBeenCalledWith(`/mascotas/${TOKEN}/asentar`);
  });

  it("re-reads when the screen is entered, not only when it is first built", async () => {
    // Since "Asentar" pushes a route on top of this one, coming back must show
    // what was just written. A mount-only effect would leave the owner staring
    // at the libreta they just added to, unchanged.
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

    await waitFor(() => expect(screen.getByText("Libreta sanitaria")).toBeTruthy());
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
