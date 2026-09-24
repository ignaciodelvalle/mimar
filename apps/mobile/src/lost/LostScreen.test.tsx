// `LostScreen` — the render tests for the one screen where being wrong costs
// somebody their animal.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. EVERY AFFORDANCE COMES FROM `capabilities`. Four of the five conditions
//      need facts a client does not hold, and the fifth — reactivation, refused
//      on the ORG path alone — is invisible in `status`. A screen that
//      recomputed them would be right four times out of five and wrong in
//      somebody's hands.
//   2. THE PRIVACY ROWS ARE HONEST. A preference this caller may not change is
//      SHOWN and marked, never hidden and never a live switch that answers 403.
//   3. THE AVISTAJE CARRIES A KEY AND THE OTHER FOUR DO NOT. One command
//      appends; sending a key the server ignores is a client believing it holds
//      a guarantee it does not.
//   4. "NOTHING CHANGED" IS SAID OUT LOUD rather than dressed as success.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";

import { createNavigationFake } from "../ui/navigation-fake";

const mockPush = jest.fn();
const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();

/**
 * Every focus callback currently mounted, so a test can fire a RE-focus.
 *
 * The stand-in `TransfersScreen.test.tsx` and `NotificationsScreen.test.tsx`
 * use, for their reason: the defect (A4-custodia-07) is about a screen that is
 * ALREADY MOUNTED when it regains focus, and a mount-only stand-in can only be
 * re-fired by remounting — precisely the case that never had the bug.
 */
const mockFocusCallbacks: Array<() => void> = [];

// A REAL LISTENER REGISTRY — see `ui/navigation-fake.ts`. The mark-lost form is
// a PANE on this screen, so the discard the guard covers is a navigation away
// from the whole screen with eight fields filled in.
const mockNav = createNavigationFake();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  useNavigation: () => mockNav.navigation,
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
  fetchPetLostMode: (...args: unknown[]) => mockFetch(...args),
  sendLostCommand: (...args: unknown[]) => mockSend(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import { Share } from "react-native";

import type { PetLostV1 } from "@dim/contract/api";
import { LostScreen } from "./LostScreen";

const TOKEN = "DIM-PAMP-0001";

const ALL_KEYS = [
  "discloseFirstNameWhenLost",
  "disclosePhoneWhenLost",
  "discloseEmailWhenLost",
  "discloseLastLocationWhenLost",
  "allowFinderFormWhenLost",
  "discloseCaretakerContactWhenLost",
] as const;

function payload(overrides: Partial<PetLostV1> = {}): PetLostV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-26T00:00:00.000Z",
    staleAfter: "2026-08-26T00:01:00.000Z",
    publicToken: TOKEN,
    petName: "Pampa",
    petSex: "female",
    status: "active",
    episode: null,
    disclosure: {
      discloseFirstNameWhenLost: false,
      disclosePhoneWhenLost: false,
      discloseEmailWhenLost: false,
      discloseLastLocationWhenLost: false,
      allowFinderFormWhenLost: true,
      discloseCaretakerContactWhenLost: false,
    },
    capabilities: {
      canMarkLost: true,
      canReportLastSeen: false,
      canMarkFound: false,
      canReactivateSearch: false,
      canReportContent: true,
      editableDisclosureKeys: [...ALL_KEYS],
    },
    feed: { items: [], truncated: false, totalScans: 0, totalSightings: 0 },
    ...overrides,
  };
}

const LOST_EPISODE = {
  publicCode: "LOS-00042",
  openedAt: "2026-08-20T12:00:00.000Z",
  placeName: "Plaza San Martín",
  ownerNote: "Se escapó por el portón",
  lastSeenAt: "2026-08-21T15:00:00.000Z",
  lastSeenLat: -36.6167,
  lastSeenLng: -64.2833,
  jurisdictionLocality: "Santa Rosa",
  sightingsCount: 3,
};

/** A pet mid-search: every running-search affordance available. */
function searching(overrides: Partial<PetLostV1> = {}) {
  return payload({
    status: "lost",
    episode: LOST_EPISODE,
    capabilities: {
      canMarkLost: false,
      canReportLastSeen: true,
      canMarkFound: true,
      canReactivateSearch: false,
      canReportContent: true,
      editableDisclosureKeys: [...ALL_KEYS],
    },
    ...overrides,
  });
}

function ok(body: unknown) {
  return { outcome: "ok", payload: body };
}

function ack(command: string, changed: boolean, status = "lost") {
  return ok({ command, status, changed });
}

/** The body of the Nth command the screen sent. */
function sentBody(index = 0) {
  const call = mockSend.mock.calls[index] as unknown[] | undefined;
  return call?.[2] as Record<string, unknown> | undefined;
}

/** The Idempotency-Key of the Nth command, or `null` when none was sent. */
function sentKey(index = 0) {
  const call = mockSend.mock.calls[index] as unknown[] | undefined;
  return call?.[3] as string | null | undefined;
}

beforeEach(() => {
  mockPush.mockReset();
  mockFetch.mockReset();
  mockSend.mockReset();
  mockFetch.mockResolvedValue(ok(payload()));
  mockSend.mockResolvedValue(ack("mark_found", true, "active"));
});

describe("LostScreen — the affordances come from capabilities, never from status", () => {
  it("offers ONLY marcar perdida for an animal that is not lost", async () => {
    render(<LostScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Marcar como perdida")).toBeOnTheScreen();
    expect(screen.queryByText("Actualizar dónde la vieron")).toBeNull();
    expect(screen.queryByText("Marcar como encontrada")).toBeNull();
    expect(screen.queryByText("Reactivar búsqueda")).toBeNull();
  });

  it("offers the running-search affordances mid-search, and not marcar perdida", async () => {
    mockFetch.mockResolvedValue(ok(searching()));
    render(<LostScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Actualizar dónde la vieron")).toBeOnTheScreen();
    expect(screen.getByText("Marcar como encontrada")).toBeOnTheScreen();
    expect(screen.queryByText("Marcar como perdida")).toBeNull();
  });

  it("offers REACTIVAR for a stale search and refuses to offer an avistaje", async () => {
    // `status: "lost"` with no open episode: the cron closed the case and left
    // the status alone. Logging a sighting is impossible until it reopens, and
    // the screen must not offer a button that would 409.
    mockFetch.mockResolvedValue(
      ok(
        payload({
          status: "lost",
          episode: null,
          capabilities: {
            canMarkLost: false,
            canReportLastSeen: false,
            canMarkFound: true,
            canReactivateSearch: true,
            canReportContent: true,
            editableDisclosureKeys: [...ALL_KEYS],
          },
        }),
      ),
    );
    render(<LostScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Reactivar búsqueda")).toBeOnTheScreen();
    expect(screen.queryByText("Actualizar dónde la vieron")).toBeNull();
    expect(screen.getByText(/se cerró por inactividad/)).toBeOnTheScreen();
  });

  it("hides reactivation when the server did not offer it, whatever the status says", async () => {
    // The org path is refused for this one command alone, and nothing in
    // `status` or `episode` hints at it. A screen deriving the flag itself would
    // render a button that answers 403.
    mockFetch.mockResolvedValue(
      ok(
        payload({
          status: "lost",
          episode: null,
          capabilities: {
            canMarkLost: false,
            canReportLastSeen: false,
            canMarkFound: true,
            canReactivateSearch: false,
            canReportContent: true,
            editableDisclosureKeys: [...ALL_KEYS],
          },
        }),
      ),
    );
    render(<LostScreen publicToken={TOKEN} />);
    await screen.findByText("Marcar como encontrada");
    expect(screen.queryByText("Reactivar búsqueda")).toBeNull();
  });
});

describe("LostScreen — compartir la búsqueda", () => {
  it("hands the OS sheet a message carrying the public URL, mid-search", async () => {
    const shareSpy = jest
      .spyOn(Share, "share")
      .mockResolvedValue({ action: "sharedAction" } as Awaited<ReturnType<typeof Share.share>>);
    mockFetch.mockResolvedValue(ok(searching()));
    render(<LostScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Compartir la búsqueda"));
    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    const message = (shareSpy.mock.calls[0]?.[0] as { message: string }).message;
    expect(message).toContain("Pampa");
    expect(message).toContain(TOKEN);
    // The disclosure surface stays off the message — a group chat outlives
    // every toggle; the credential page obeys them at read time instead.
    expect(message).not.toContain(LOST_EPISODE.placeName);
    shareSpy.mockRestore();
  });

  it("still offers sharing on a STALE search — the public page takes sightings on status alone", async () => {
    // report-pet-sighting.ts refuses on `pet.status !== "lost"`, not on an open
    // episode, so the link keeps working after the cron closes the case.
    mockFetch.mockResolvedValue(
      ok(
        payload({
          status: "lost",
          episode: null,
          capabilities: {
            canMarkLost: false,
            canReportLastSeen: false,
            canMarkFound: true,
            canReactivateSearch: true,
            canReportContent: true,
            editableDisclosureKeys: [...ALL_KEYS],
          },
        }),
      ),
    );
    render(<LostScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Compartir la búsqueda")).toBeOnTheScreen();
  });

  it("offers NO share for an animal that is not lost — there is no search to spread", async () => {
    render(<LostScreen publicToken={TOKEN} />);
    await screen.findByText("Marcar como perdida");
    expect(screen.queryByText("Compartir la búsqueda")).toBeNull();
  });
});

describe("LostScreen — the privacy rows", () => {
  it("shows a preference this caller may not change, and marks it", async () => {
    mockFetch.mockResolvedValue(
      ok(
        payload({
          capabilities: {
            canMarkLost: true,
            canReportLastSeen: false,
            canMarkFound: false,
            canReactivateSearch: false,
            canReportContent: true,
            editableDisclosureKeys: ALL_KEYS.filter(
              (k) => k !== "discloseCaretakerContactWhenLost",
            ),
          },
        }),
      ),
    );
    render(<LostScreen publicToken={TOKEN} />);
    // The row is PRESENT — hiding it would leave a caretaker wondering whether
    // the setting exists at all.
    expect(await screen.findByText("Mostrar el contacto de su cuidador/a")).toBeOnTheScreen();
    expect(screen.getByText(/Solo el titular puede cambiar esto/)).toBeOnTheScreen();
  });

  it("sends one command per toggle, with the value it wants stated", async () => {
    mockSend.mockResolvedValue(ack("set_disclosure", true, "active"));
    render(<LostScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Mostrar mi teléfono"));

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({
      command: "set_disclosure",
      key: "disclosePhoneWhenLost",
      value: true,
    });
    // NO KEY: the writer is idempotent on the state, and a header it would
    // ignore is a guarantee nobody has.
    expect(sentKey()).toBeNull();
  });

  it("says a preference was already that way instead of claiming a change", async () => {
    mockSend.mockResolvedValue(ack("set_disclosure", false, "active"));
    render(<LostScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Mostrar mi email"));
    expect(await screen.findByText("Esa preferencia ya estaba así.")).toBeOnTheScreen();
  });

  it("warns when the last contact channel is off, on the RUNNING search (A4-custodia-09)", async () => {
    // The three channels off means the credential shows a search notice and no
    // way to answer it: whoever is holding the dog can log a sighting and
    // nothing else. The fixture's `allowFinderFormWhenLost: true` is the only
    // one on, so this is the state one tap away from the default.
    mockFetch.mockResolvedValue(
      ok(
        payload({
          disclosure: {
            discloseFirstNameWhenLost: true,
            disclosePhoneWhenLost: false,
            discloseEmailWhenLost: false,
            discloseLastLocationWhenLost: true,
            allowFinderFormWhenLost: false,
            discloseCaretakerContactWhenLost: false,
          },
        }),
      ),
    );
    render(<LostScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Nadie va a poder contactarte")).toBeOnTheScreen();
    expect(
      screen.getByText(/quien encuentre a Pampa no tiene forma de avisarte/),
    ).toBeOnTheScreen();
  });

  it("stays quiet while ONE channel is still open", async () => {
    // The non-vacuity half. A name and a last-seen place are things a finder
    // READS, not ways to write back, so neither of them silences the warning —
    // and the form alone is enough to keep it away.
    render(<LostScreen publicToken={TOKEN} />);
    await screen.findByText("Mostrar mi teléfono");
    expect(screen.queryByText("Nadie va a poder contactarte")).toBeNull();
  });

  it("does not tell a reader with no switches to flip one (F11)", async () => {
    // The rows above this callout draw a switch only for the keys in
    // `editableDisclosureKeys`. A caretaker or a co-owner gets none of the three
    // finder channels, so "Te recomendamos habilitar al menos el formulario" was
    // an instruction printed over rows that carry "Solo el titular puede cambiar
    // esto" — advice the person reading it cannot follow, addressed in the
    // second person to somebody the finder would not be contacting anyway.
    mockFetch.mockResolvedValue(
      ok(
        payload({
          disclosure: {
            discloseFirstNameWhenLost: true,
            disclosePhoneWhenLost: false,
            discloseEmailWhenLost: false,
            discloseLastLocationWhenLost: true,
            allowFinderFormWhenLost: false,
            discloseCaretakerContactWhenLost: false,
          },
          capabilities: {
            canMarkLost: false,
            canReportLastSeen: true,
            canMarkFound: false,
            canReactivateSearch: false,
            canReportContent: true,
            editableDisclosureKeys: [],
          },
        }),
      ),
    );
    render(<LostScreen publicToken={TOKEN} />);

    // THE FACT STILL REACHES THEM — it is the fact that matters, and they may be
    // the person standing next to the titular.
    expect(await screen.findByText("Nadie va a poder avisar")).toBeOnTheScreen();
    // Once per row that has no switch, PLUS the callout's own closing sentence:
    // whose decision it is, said where the recommendation used to be.
    expect(screen.getAllByText(/Solo el titular puede cambiar esto/).length).toBeGreaterThan(6);
    // The instruction, and the second person, do not.
    expect(screen.queryByText("Nadie va a poder contactarte")).toBeNull();
    expect(screen.queryByText(/Te recomendamos habilitar/)).toBeNull();
  });
});

describe("LostScreen — marcar perdida", () => {
  it("sends the five toggles it collected, with nothing inherited", async () => {
    mockSend.mockResolvedValue(ack("mark_lost", true));
    render(<LostScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Marcar como perdida"));

    fireEvent.changeText(
      screen.getByLabelText("Dónde la viste por última vez"),
      "Plaza San Martín",
    );
    // Publishing a phone is a decision somebody makes on this screen.
    fireEvent.press(screen.getByText("Mostrar mi teléfono"));
    fireEvent.press(screen.getByText("Marcar como perdida"));

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({
      command: "mark_lost",
      locationDescription: "Plaza San Martín",
      disclosure: {
        discloseFirstNameWhenLost: false,
        disclosePhoneWhenLost: true,
        discloseEmailWhenLost: false,
        discloseLastLocationWhenLost: false,
        allowFinderFormWhenLost: true,
      },
    });
    expect(sentKey()).toBeNull();
  });

  it("warns on the FORM when the last channel is switched off (A4-custodia-09)", async () => {
    // Phone and email start OFF on the draft, so a privacy-minded person only
    // has to turn the finder form off — one tap — to publish a search nobody can
    // answer. The web's wizard says so; the phone said nothing.
    render(<LostScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Marcar como perdida"));
    expect(screen.queryByText("Nadie va a poder contactarte")).toBeNull();

    fireEvent.press(screen.getByText("Permitir que quien la encuentre me escriba"));

    expect(screen.getByText("Nadie va a poder contactarte")).toBeOnTheScreen();
    // A WARNING AND NOT A BLOCK: the choice is theirs and the button stays live.
    expect(screen.getAllByText("Marcar como perdida").length).toBeGreaterThan(0);
  });

  it("guards the form against the back gesture, and stays quiet before it (A2-alta-asentar-08)", async () => {
    // Eight free-text fields and five decisions about what gets published,
    // filled in by somebody whose animal is missing — the worst moment in this
    // app to lose a form to a gesture the platform teaches.
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    mockNav.reset();
    alert.mockClear();

    render(<LostScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Marcar como perdida"));
    // Nothing typed yet: opening the form may not interrupt anybody.
    expect(mockNav.pressBack().blocked).toBe(false);

    fireEvent.changeText(
      screen.getByLabelText("Dónde la viste por última vez"),
      "Plaza San Martín",
    );
    expect(mockNav.pressBack().blocked).toBe(true);
    expect(alert.mock.calls[0]?.[0]).toBe("¿Salir sin guardar?");
    alert.mockRestore();
  });

  it("guards a DISCLOSURE decision too, not only the free text", async () => {
    // `disclosure` is a nested object: compared by reference it would read as
    // "nothing typed" after somebody switched the finder form off, which is one
    // of the more consequential things they can do on this form.
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    mockNav.reset();

    render(<LostScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Marcar como perdida"));
    fireEvent.press(screen.getByText("Mostrar mi teléfono"));

    expect(mockNav.pressBack().blocked).toBe(true);
    alert.mockRestore();
  });

  it("marks lost with NOTHING filled in — the fast path the wizard protects", async () => {
    mockSend.mockResolvedValue(ack("mark_lost", true));
    render(<LostScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Marcar como perdida"));
    fireEvent.press(screen.getByText("Marcar como perdida"));

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({ enrichedDescription: null, locationDescription: null });
  });

  it("re-reads after the command instead of patching its own copy", async () => {
    mockSend.mockResolvedValue(ack("mark_lost", true));
    render(<LostScreen publicToken={TOKEN} />);
    await screen.findByText("Marcar como perdida");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByText("Marcar como perdida"));
    fireEvent.press(screen.getByText("Marcar como perdida"));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });
});

describe("LostScreen — the avistaje is the one command that appends", () => {
  it("carries an Idempotency-Key, unlike the other four", async () => {
    mockFetch.mockResolvedValue(ok(searching()));
    mockSend.mockResolvedValue(ack("report_last_seen", true));
    render(<LostScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Actualizar dónde la vieron"));

    fireEvent.changeText(screen.getByLabelText("Dónde"), "Cerca de la plaza");
    fireEvent.press(screen.getByText("Guardar avistaje"));

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(sentBody()).toMatchObject({
      command: "report_last_seen",
      locationDescription: "Cerca de la plaza",
    });
    expect(sentKey()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("says a REPLAY did not duplicate instead of claiming a second sighting", async () => {
    mockFetch.mockResolvedValue(ok(searching()));
    mockSend.mockResolvedValue(ack("report_last_seen", false));
    render(<LostScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Actualizar dónde la vieron"));
    fireEvent.press(screen.getByText("Guardar avistaje"));

    expect(await screen.findByText(/no se duplicó/)).toBeOnTheScreen();
  });
});

describe("LostScreen — marcar encontrada is a two-step", () => {
  it("asks before closing the search, because a mis-tap must not end it", async () => {
    mockFetch.mockResolvedValue(ok(searching()));
    render(<LostScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Marcar como encontrada"));

    // Nothing sent yet — the first press only opens the confirmation.
    expect(mockSend).not.toHaveBeenCalled();
    expect(screen.getByText(/avisamos a quienes la estaban buscando/)).toBeOnTheScreen();

    fireEvent.press(screen.getByText("Sí, la encontré"));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({ command: "mark_found" });
    expect(sentKey()).toBeNull();
  });

  it("says the animal came home in her own gender", async () => {
    mockFetch.mockResolvedValue(ok(searching()));
    mockSend.mockResolvedValue(ack("mark_found", true, "active"));
    render(<LostScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Marcar como encontrada"));
    fireEvent.press(screen.getByText("Sí, la encontré"));
    expect(await screen.findByText(/como encontrada/)).toBeOnTheScreen();
  });
});

describe("LostScreen — the feed and the poster", () => {
  it("renders each kind of row, and never a photo it cannot show", async () => {
    mockFetch.mockResolvedValue(
      ok(
        searching({
          feed: {
            truncated: true,
            totalScans: 1,
            totalSightings: 1,
            items: [
              {
                kind: "finder",
                id: "f1",
                at: "2026-08-22T10:00:00.000Z",
                finderName: "Vecina",
                finderContact: "11-5555-5555",
                petCondition: "bien",
                localityLabel: "Santa Rosa",
                message: "La tengo en casa",
                availabilityLabel: "indefinido",
                hasPhoto: true,
              },
              {
                kind: "scan",
                id: "s1",
                at: "2026-08-22T09:00:00.000Z",
                count: 3,
                localityLabel: "Toay",
              },
            ],
          },
        }),
      ),
    );
    render(<LostScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Vecina dice que la tiene")).toBeOnTheScreen();
    expect(screen.getByText(/Escanearon su QR 3 veces/)).toBeOnTheScreen();
    expect(screen.getByText("11-5555-5555")).toBeOnTheScreen();
    // A photo exists and the payload carries no URL for it — saying so is
    // honest, a broken image would not be.
    expect(screen.getByText(/Dejó una foto/)).toBeOnTheScreen();
    // A capped list that does not say so is the same dishonesty as an empty
    // state over a failed read.
    expect(screen.getByText(/Puede haber más/)).toBeOnTheScreen();
  });

  it("says the feed is empty rather than rendering nothing", async () => {
    mockFetch.mockResolvedValue(ok(searching()));
    render(<LostScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/Todavía no hay avistajes/)).toBeOnTheScreen();
  });

  it("says where the printable poster lives instead of leaving a gap", async () => {
    render(<LostScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/cartel para imprimir se arma desde la web/i)).toBeOnTheScreen();
  });
});

describe("LostScreen — the refusals a person sees", () => {
  it("renders a failed read as a refusal with a retry, not as an empty search", async () => {
    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<LostScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/Revisá tu conexión/)).toBeOnTheScreen();
    expect(screen.getByText("Reintentar")).toBeOnTheScreen();
    // NOT an empty feed: a read that failed and a search nobody reported on are
    // different facts.
    expect(screen.queryByText(/Todavía no hay avistajes/)).toBeNull();
  });

  it("renders a command refusal in the person's own words, and stays put", async () => {
    mockFetch.mockResolvedValue(ok(searching()));
    mockSend.mockResolvedValue({ outcome: "api-error", code: "lost_episode_closed" });
    render(<LostScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Actualizar dónde la vieron"));
    fireEvent.press(screen.getByText("Guardar avistaje"));

    expect(await screen.findByText(/se cerró por inactividad/)).toBeOnTheScreen();
    // The form is still standing, with what was typed still in it.
    expect(screen.getByText("Guardar avistaje")).toBeOnTheScreen();
  });

  it("renders a titular-only refusal as whose decision it is", async () => {
    mockSend.mockResolvedValue({ outcome: "api-error", code: "lost_forbidden" });
    render(<LostScreen publicToken={TOKEN} />);
    fireEvent.press(await screen.findByText("Mostrar el contacto de su cuidador/a"));
    expect(await screen.findByText(/solo del titular/i)).toBeOnTheScreen();
  });
});

// ---------------------------------------------------------------------------
// lote 1b F7 — THE MODE THAT WAS WRITTEN AND NEVER WIRED
//
// This screen grew a `hasLoaded` ref and never READ it, so every focus took the
// `loading` branch and every failure took `{ phase: "failed" }`. The pane the
// person just closed is two lines away from a focus, and the S-2 rule the rest
// of this batch enforces was newly broken on the screen somebody opens at 2 a.m.
// looking for their dog.
// ---------------------------------------------------------------------------

/** Re-focus every mounted screen, the way popping back to a pane does. */
async function refocus(): Promise<void> {
  await act(async () => {
    for (const callback of [...mockFocusCallbacks]) callback();
  });
}

describe("LostScreen — coming back does not blank or delete the search (F7)", () => {
  it("does not spin the whole panel when the screen regains focus", async () => {
    mockFetch.mockResolvedValue(ok(searching()));
    render(<LostScreen publicToken={TOKEN} />);
    await screen.findByText("Actualizar dónde la vieron");

    // A read held in flight, so the assertion below describes the window the
    // person actually sees rather than the state after it closes.
    mockFetch.mockReturnValue(new Promise(() => {}));
    await refocus();

    expect(screen.queryByText("Leyendo la búsqueda…")).toBeNull();
    expect(screen.getByText("Actualizar dónde la vieron")).toBeOnTheScreen();
  });

  it("keeps the search when a focus re-read fails, and says so in a banner", async () => {
    mockFetch.mockResolvedValue(ok(searching()));
    render(<LostScreen publicToken={TOKEN} />);
    await screen.findByText("Actualizar dónde la vieron");

    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    await refocus();

    await waitFor(() => expect(screen.getByText("No pudimos actualizar")).toBeOnTheScreen());
    // The search is STILL THERE. Deleting it is the exact defect S-2 names, and
    // this screen is the worst place in the app to do it.
    expect(screen.getByText("Actualizar dónde la vieron")).toBeOnTheScreen();
  });

  it("still empties the screen when the FIRST read fails", async () => {
    // The control: with nothing on screen there is nothing to keep. It is the
    // assertion the block above must not have loosened.
    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<LostScreen publicToken={TOKEN} />);

    expect(await screen.findByText("Reintentar")).toBeOnTheScreen();
    expect(screen.queryByText("No pudimos actualizar")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reportar — the affordance a content-rating declaration already promised
// ---------------------------------------------------------------------------
//
// WHAT THESE HAVE TO PROVE
//   5. THE CONTROL IS ON THE TWO AUTHORED KINDS AND NOT ON A SCAN. A QR read has
//      no author and no text; offering to report one would be a control the
//      server refuses, and the person who tapped it would learn that as an
//      error.
//   6. THE COMMAND CARRIES THE ROW'S OWN ID. The screen echoes what it was
//      given; an id built or guessed here would hide the wrong message.
//   7. NO IDEMPOTENCY KEY. The command appends and still needs none, because its
//      writer is idempotent on the state.
//   8. THE PERSON IS TOLD WHAT ACTUALLY HAPPENS — it leaves their search, it is
//      not erased, and nobody is notified. This app promises everywhere else
//      that events are never deleted, and this screen must not appear to break
//      that promise.

// REAL UUIDs, because a feed item's `id` IS a `pet_events.id` and the contract
// refuses anything else. A first draft of this fixture used "ev-sighting-1" and
// every send test failed with the screen showing "la app no pudo identificar el
// mensaje" — the client-side schema doing exactly its job, on a fixture that
// could never have existed.
const SIGHTING_EVENT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SCAN_EVENT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";

/**
 * The one "Reportar" control on the feed, asserted to exist as it is fetched.
 *
 * `getAllByLabelText(...)[0]` is `T | undefined` under this project's
 * `noUncheckedIndexedAccess`, and silencing that with a `!` would turn "the
 * control is missing" into a null-press somewhere further down the test.
 */
function theReportControl() {
  const [control] = screen.getAllByLabelText(/Reportar este mensaje/);
  if (!control) throw new Error("no Reportar control on the feed");
  return control;
}

const SIGHTING_ROW = {
  kind: "sighting" as const,
  id: SIGHTING_EVENT_ID,
  at: "2026-08-22T10:00:00.000Z",
  description: "Andá a buscarla vos",
  localityLabel: null,
  lat: null,
  lng: null,
  finderContact: null,
  hasPhoto: false,
};

const SCAN_ROW = {
  kind: "scan" as const,
  id: SCAN_EVENT_ID,
  at: "2026-08-22T09:00:00.000Z",
  count: 1,
  localityLabel: null,
};

const REPORTABLE_FEED = {
  truncated: false,
  totalScans: 1,
  totalSightings: 1,
  items: [SIGHTING_ROW, SCAN_ROW],
};

describe("LostScreen — reportar un mensaje del feed", () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue(ok(searching({ feed: REPORTABLE_FEED })));
  });

  it("offers ONE Reportar — on the sighting, never on the scan", async () => {
    render(<LostScreen publicToken={TOKEN} />);
    await screen.findByText("Alguien la vio");
    // Two rows, one control. If the scan grew one, this would be 2 — which is
    // the whole assertion, so it counts rather than checking existence.
    expect(screen.getAllByLabelText(/Reportar este mensaje/)).toHaveLength(1);
  });

  // A4-custodia-13 — the CALLER's half of the answer, which only the server has.
  //
  // The route refuses `report_content` on the ORG path, in the same condition
  // that refuses `reactivate_search`: an organization holding `shelter_custody`
  // could otherwise make a finder's "tengo a tu perro, llamame" disappear from
  // the owner's feed during a custody dispute, silently and with no un-report.
  // Nothing on the feed says which path the reader came through, so the app drew
  // the control for everybody and the server answered with titular-only copy.
  it("draws no Reportar for a reader the server would refuse", async () => {
    mockFetch.mockResolvedValue(
      ok(
        searching({
          feed: REPORTABLE_FEED,
          capabilities: {
            canMarkLost: false,
            canReportLastSeen: false,
            canMarkFound: true,
            canReactivateSearch: false,
            canReportContent: false,
            editableDisclosureKeys: [],
          },
        }),
      ),
    );
    render(<LostScreen publicToken={TOKEN} />);
    await screen.findByText("Alguien la vio");
    // The reportable ROW is on screen — this is not the scan case.
    expect(screen.queryAllByLabelText(/Reportar este mensaje/)).toHaveLength(0);
  });

  it("offers none at all when the feed is only scans", async () => {
    mockFetch.mockResolvedValue(ok(searching({ feed: { ...REPORTABLE_FEED, items: [SCAN_ROW] } })));
    render(<LostScreen publicToken={TOKEN} />);
    await screen.findByText(/Escanearon su QR/);
    expect(screen.queryAllByLabelText(/Reportar este mensaje/)).toHaveLength(0);
  });

  it("says what reporting does and does NOT do before anybody commits", async () => {
    render(<LostScreen publicToken={TOKEN} />);
    await screen.findByText("Alguien la vio");
    fireEvent.press(theReportControl());

    expect(await screen.findByText(/deja de aparecer en tu búsqueda/)).toBeOnTheScreen();
    expect(screen.getByText(/No se borra del historial/)).toBeOnTheScreen();
    expect(screen.getByText(/no recibe ningún aviso/)).toBeOnTheScreen();
    // The word is "Reportar". "Denunciar" already means a Ley 14.346 complaint
    // routed to an authority, and it must never appear on this flow.
    expect(screen.queryByText(/[Dd]enunci/)).toBeNull();
  });

  it("refuses to send without a motive, and says so instead of doing nothing", async () => {
    render(<LostScreen publicToken={TOKEN} />);
    await screen.findByText("Alguien la vio");
    fireEvent.press(theReportControl());
    fireEvent.press(await screen.findByText("Reportar"));

    expect(await screen.findByText("Elegí un motivo.")).toBeOnTheScreen();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends the row's OWN id, the chosen category, and NO idempotency key", async () => {
    mockSend.mockResolvedValue(ack("report_content", true));
    render(<LostScreen publicToken={TOKEN} />);
    await screen.findByText("Alguien la vio");
    fireEvent.press(theReportControl());
    fireEvent.press(await screen.findByText("Me insultan o me amenazan"));
    fireEvent.press(screen.getByText("Reportar"));

    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    expect(sentBody()).toEqual({
      command: "report_content",
      targetEventId: SIGHTING_EVENT_ID,
      category: "harassment",
      reason: null,
    });
    expect(sentKey()).toBeNull();
  });

  it("tells the person what changed, and re-reads rather than patching the list", async () => {
    mockSend.mockResolvedValue(ack("report_content", true));
    render(<LostScreen publicToken={TOKEN} />);
    await screen.findByText("Alguien la vio");
    fireEvent.press(theReportControl());
    fireEvent.press(await screen.findByText("Otro motivo"));
    fireEvent.press(screen.getByText("Reportar"));

    expect(await screen.findByText(/ya no aparece en tu búsqueda/)).toBeOnTheScreen();
    // The ack deliberately does not carry the new feed; the screen re-reads.
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it("says 'ya estaba reportado' rather than congratulating somebody twice", async () => {
    mockSend.mockResolvedValue(ack("report_content", false));
    render(<LostScreen publicToken={TOKEN} />);
    await screen.findByText("Alguien la vio");
    fireEvent.press(theReportControl());
    fireEvent.press(await screen.findByText("Otro motivo"));
    fireEvent.press(screen.getByText("Reportar"));

    expect(await screen.findByText("Ese mensaje ya estaba reportado.")).toBeOnTheScreen();
  });
});

// ---------------------------------------------------------------------------
// A4-custodia-07 — COMING BACK RE-READS
// ---------------------------------------------------------------------------

describe("LostScreen — regaining focus", () => {
  it("re-reads the search instead of showing the state from before", async () => {
    // A lost-mode command can be refused for a reason that is ABOUT this
    // screen's data (`lost_episode_closed`), and the reader's next move is to
    // come back to it. A mount-only effect left them looking at the affordances
    // the refusal had just invalidated.
    render(<LostScreen publicToken={TOKEN} />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      for (const callback of [...mockFocusCallbacks]) callback();
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
