// `MudanzaScreen` — the render tests for the screen that changes which
// authority answers for an animal.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. THE SCREEN NEVER PRE-JUDGES WHO MAY MOVE THE ANIMAL. There is no
//      capability flag on this feature; the rule is the server's and the screen
//      posts and renders the refusal. A local guess would refuse a FOSTER the
//      browser admits — which is why the 403 case asserts a sentence and not a
//      hidden button.
//   2. "THE READ FAILED" AND "THIS ANIMAL HAS NO LOCALITY" ARE DIFFERENT
//      SENTENCES on the screen, not only in the view-model. The second invites a
//      move nobody needs.
//   3. WHAT IS CONFIRMED IS WHAT WAS STORED. The typed destination is short and
//      lowercase; the ack's is the catalog's spelling, and the screen says the
//      ack's.
//   4. NOTHING IS POSTED THAT THE CONTRACT WOULD REFUSE — and the two halves of
//      that are fenced SEPARATELY, because measuring showed they are two things.
//      The button's `disabled` covers the missing destination (and only that:
//      with it disabled, `submit` is never reached, so deleting the refusal's
//      `return` leaves that case green). `buildMove`'s refusal covers a draft
//      that reaches `submit` and is still invalid — the over-long reason.
//   5. AFTER A LANDED MOVE THE FORM IS GONE, because a second identical submit
//      is refused (409) and a still-live button over a success message is an
//      invitation to meet a refusal that reads like a failure.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";

import { createNavigationFake } from "../ui/navigation-fake";

const mockFetchPet = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSendMove = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSearchLocalities = jest.fn<(...args: unknown[]) => Promise<unknown>>();

// A REAL LISTENER REGISTRY, NOT THE NO-OP STUB (finding F4, review 2026-09-07).
// The stub this file carried — `addListener: () => () => {}` — never fires the
// listener, so it cannot tell a guarded screen from an unguarded one, and this
// screen exempts its own success with a `done` FLAG rather than `allowLeave()`:
// nothing in `ui/use-draft-discard-guard.test.tsx` can see that decision,
// because the flag lives here.
const mockNav = createNavigationFake();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useNavigation: () => mockNav.navigation,
}));

jest.mock("../api/endpoints", () => ({
  fetchOwnerPetDetail: (...args: unknown[]) => mockFetchPet(...args),
  sendPetMoveCommand: (...args: unknown[]) => mockSendMove(...args),
  searchLocalities: (...args: unknown[]) => mockSearchLocalities(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import type { OwnerPetDetailV1 } from "@dim/contract/api";

import { MudanzaScreen } from "./MudanzaScreen";

const TOKEN = "DIM-PAMP-0001";

function detail(over: Record<string, unknown> = {}): OwnerPetDetailV1 {
  return {
    identity: {
      status: "ok",
      data: {
        name: "Pampa",
        species: "dog",
        sex: "female",
        breed: null,
        breedLine: "Mestiza",
        photoUrl: null,
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "La Plata",
        tags: [],
      },
    },
    ...over,
  } as unknown as OwnerPetDetailV1;
}

/** Walk the cascade: province first (L3·0), then type, let the debounce fire, tap the row. */
async function pickBariloche() {
  fireEvent.press(screen.getByRole("radio", { name: "Río Negro" }));
  fireEvent.changeText(screen.getByLabelText("Localidad, obligatorio"), "barilo");
  const row = await screen.findByText("San Carlos de Bariloche", {}, { timeout: 3000 });
  fireEvent.press(row);
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick"] });
  mockNav.reset();
  mockFetchPet.mockReset();
  mockSendMove.mockReset();
  mockSearchLocalities.mockReset();
  mockFetchPet.mockResolvedValue({ outcome: "ok", payload: detail() });
  mockSearchLocalities.mockResolvedValue({
    outcome: "ok",
    payload: {
      results: [
        {
          // A2-alta-asentar-03: the row carries INDEC's own id now, and it is
          // what the write sends back so the server resolves THIS row instead of
          // the alphabetically first department among the name's homonyms.
          indecId: "620105",
          localityName: "San Carlos de Bariloche",
          localitySlug: "san-carlos-de-bariloche",
          provinceCode: "AR-R",
          provinceName: "Río Negro",
          departmentName: "Bariloche",
        },
      ],
    },
  });
  mockSendMove.mockResolvedValue({
    outcome: "ok",
    payload: {
      command: "record_move",
      eventId: "evt-1",
      jurisdiction: { province: "Río Negro", locality: "San Carlos de Bariloche" },
    },
  });
});

describe("MudanzaScreen — where the animal lives today", () => {
  it("prints the current pair locality-first and names the animal", async () => {
    render(<MudanzaScreen publicToken={TOKEN} />);
    expect(await screen.findByText("Mudanza de Pampa")).toBeOnTheScreen();
    expect(screen.getByText("La Plata, Buenos Aires")).toBeOnTheScreen();
  });

  it("says the READ failed rather than saying the animal has no locality", async () => {
    // MUTATION APPLIED: render the `unavailable` arm with the `none` sentence.
    // Red — and the failure it prevents is somebody registering a move because
    // a pooler blip told them nothing was on file.
    mockFetchPet.mockResolvedValue({
      outcome: "ok",
      payload: detail({ identity: { status: "unavailable" } }),
    });
    render(<MudanzaScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/No pudimos leer dónde figura hoy/)).toBeOnTheScreen();
    expect(screen.queryByText(/no tiene una localidad registrada/)).toBeNull();
    // The form is still usable — a failed read of where it lives does not stop
    // somebody recording where it moved to.
    expect(screen.getByText("Registrar mudanza")).toBeOnTheScreen();
  });

  it("says so plainly when the animal genuinely has no locality on file", async () => {
    mockFetchPet.mockResolvedValue({
      outcome: "ok",
      payload: detail({
        identity: {
          status: "ok",
          data: {
            name: "Pampa",
            species: "dog",
            sex: null,
            breed: null,
            breedLine: "",
            photoUrl: null,
            jurisdictionProvince: null,
            jurisdictionLocality: null,
            tags: [],
          },
        },
      }),
    });
    render(<MudanzaScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/no tiene una localidad registrada/)).toBeOnTheScreen();
  });

  it("offers a retry when the pet read fails outright", async () => {
    mockFetchPet.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<MudanzaScreen publicToken={TOKEN} />);
    expect(await screen.findByText(/No pudimos conectarnos/)).toBeOnTheScreen();
    expect(screen.getByText("Reintentar")).toBeOnTheScreen();
    expect(screen.queryByText("Registrar mudanza")).toBeNull();
  });
});

describe("MudanzaScreen — recording the move", () => {
  it("posts the PICKED pair, not what was typed into the search box", async () => {
    // The person typed "barilo"; what goes on the wire is the row they tapped.
    // MUTATION APPLIED: send `localityName: draft.reason` — nonsense, but the
    // shape of "the wrong field travelled". Red.
    render(<MudanzaScreen publicToken={TOKEN} />);
    await screen.findByText("Mudanza de Pampa");
    await pickBariloche();
    fireEvent.press(screen.getByText("Registrar mudanza"));
    await waitFor(() => expect(mockSendMove).toHaveBeenCalled());
    expect(mockSendMove).toHaveBeenCalledWith({}, TOKEN, {
      command: "record_move",
      provinceCode: "AR-R",
      localityName: "San Carlos de Bariloche",
      // The id of the ROW that was tapped, not a name for the server to guess a
      // department from (A2-alta-asentar-03).
      localityIndecId: "620105",
      reason: null,
    });
  });

  it("confirms with the CANONICAL pair the server stored", async () => {
    // MUTATION APPLIED: build the sentence from the whole draft instead of from
    // `result.payload.jurisdiction`. RED — the draft holds the province CODE
    // ("AR-R") and the ack holds its NAME ("Río Negro"), so echoing the request
    // shows a person an ISO code where a province should be.
    //
    // WHAT IT DOES NOT CATCH is the reason the next case exists: the picker
    // writes the LOCALITY canonically into the draft, so a half-echo —
    // `{ province: ack.province, locality: draft.localityName }` — leaves this
    // case GREEN. Measured, not predicted.
    render(<MudanzaScreen publicToken={TOKEN} />);
    await screen.findByText("Mudanza de Pampa");
    await pickBariloche();
    fireEvent.press(screen.getByText("Registrar mudanza"));
    expect(
      await screen.findByText(/San Carlos de Bariloche, Río Negro quedó registrada/),
    ).toBeOnTheScreen();
  });

  it("says what the SERVER stored even when it differs from what was picked", async () => {
    // THE CASE THAT ACTUALLY FENCES THE ACK. The catalog can resolve a picked
    // row to a different official spelling — homonym disambiguation, an accent,
    // a renamed locality — and the screen must report the stored one. Without
    // this the previous case passes for a screen that echoes the draft's
    // LOCALITY, which the picker already wrote canonically.
    // MUTATION APPLIED: `moveRecordedMessage({ province:
    // result.payload.jurisdiction.province, locality: draft.localityName })` —
    // the half-echo. Red here, 22/22 GREEN without this case.
    mockSendMove.mockResolvedValue({
      outcome: "ok",
      payload: {
        command: "record_move",
        eventId: "evt-1",
        jurisdiction: { province: "Río Negro", locality: "Bariloche (San Carlos de)" },
      },
    });
    render(<MudanzaScreen publicToken={TOKEN} />);
    await screen.findByText("Mudanza de Pampa");
    await pickBariloche();
    fireEvent.press(screen.getByText("Registrar mudanza"));
    expect(
      await screen.findByText(/Bariloche \(San Carlos de\), Río Negro quedó registrada/),
    ).toBeOnTheScreen();
  });

  it("stops saying the animal 'figura hoy' in the locality it just LEFT (A4-R-03)", async () => {
    // The card is read on mount and was left standing: "Dónde figura hoy: La
    // Plata, Buenos Aires" sat directly above "San Carlos de Bariloche, Río
    // Negro quedó registrada…", on one screen, and the stale half is the one
    // labelled "hoy".
    render(<MudanzaScreen publicToken={TOKEN} />);
    await screen.findByText("Mudanza de Pampa");
    expect(screen.getByText("La Plata, Buenos Aires")).toBeOnTheScreen();

    await pickBariloche();
    fireEvent.press(screen.getByText("Registrar mudanza"));
    await screen.findByText(/quedó registrada/);

    expect(screen.queryByText("La Plata, Buenos Aires")).toBeNull();
    // And it says the new one, in the CATALOG's spelling — the same canonical
    // pair the ack carries, never the draft.
    expect(screen.getByText("San Carlos de Bariloche, Río Negro")).toBeOnTheScreen();
  });

  it("takes the form away once the move landed", async () => {
    // MUTATION APPLIED: never set `done`. Red — and the button would stay live
    // over a success message, so the next tap meets `move_same_locality` (409),
    // whose copy says "no hay mudanza que anotar" about a mudanza that worked.
    render(<MudanzaScreen publicToken={TOKEN} />);
    await screen.findByText("Mudanza de Pampa");
    await pickBariloche();
    fireEvent.press(screen.getByText("Registrar mudanza"));
    await screen.findByText(/quedó registrada/);
    expect(screen.queryByText("Registrar mudanza")).toBeNull();
  });

  it("posts NOTHING when no destination was picked", async () => {
    // THIS CASE FENCES THE BUTTON'S `disabled` AND NOTHING ELSE, and the first
    // draft of this comment claimed otherwise ("`buildMove` is what actually
    // refuses"). Measured: deleting the `return` after `buildMove`'s refusal in
    // `submit` leaves the whole suite 22/22 GREEN, because with no destination
    // the button is disabled and `onPress` never fires — so `submit` is never
    // reached from here. The case BELOW is the one that reaches it.
    //
    // Same shape as the declared debt on the reservar screen's `disabled`, in
    // mirror image: there the affordance was unfenced, here it was the only
    // thing fenced while the comment claimed the rule was.
    render(<MudanzaScreen publicToken={TOKEN} />);
    await screen.findByText("Mudanza de Pampa");
    fireEvent.press(screen.getByText("Registrar mudanza"));
    await waitFor(() => expect(screen.getByText("Registrar mudanza")).toBeOnTheScreen());
    expect(mockSendMove).not.toHaveBeenCalled();
  });

  it("refuses a too-long reason LOCALLY, with the button enabled and nothing posted", async () => {
    // THE CASE THAT ACTUALLY REACHES `submit`. A destination is picked, so the
    // button is live; the reason is past the contract's cap, so `buildMove`
    // refuses and the round trip never happens. `maxLength` on the field is a
    // native affordance and `fireEvent.changeText` goes straight to the handler,
    // which is exactly the path a paste on a real device takes.
    //
    // MUTATION APPLIED: delete the `return` after `buildMove`'s refusal in
    // `submit`. Red HERE — `sendPetMoveCommand` is then called with
    // `undefined` — and green on every other case in this file.
    render(<MudanzaScreen publicToken={TOKEN} />);
    await screen.findByText("Mudanza de Pampa");
    await pickBariloche();
    fireEvent.changeText(screen.getByLabelText("Motivo (opcional)"), "x".repeat(201));
    fireEvent.press(screen.getByText("Registrar mudanza"));
    expect(await screen.findByText(/El motivo es muy largo/)).toBeOnTheScreen();
    expect(mockSendMove).not.toHaveBeenCalled();
  });

  it("renders the server's REFUSAL rather than hiding the control", async () => {
    // THE AUTHORIZATION RULE IS THE SERVER'S. A screen that hid this button for
    // anybody who is not the legal owner would refuse a FOSTER, whom
    // `requireTitularAccess` admits — so the button is always drawn and the 403
    // becomes a sentence.
    mockSendMove.mockResolvedValue({ outcome: "api-error", code: "move_forbidden" });
    render(<MudanzaScreen publicToken={TOKEN} />);
    await screen.findByText("Mudanza de Pampa");
    await pickBariloche();
    fireEvent.press(screen.getByText("Registrar mudanza"));
    expect(await screen.findByText(/Sos cuidador\/a de esta mascota/)).toBeOnTheScreen();
    // Still there: a refusal is not the end of the screen.
    expect(screen.getByText("Registrar mudanza")).toBeOnTheScreen();
  });

  it("renders `move_same_locality` as its own sentence, not as a generic failure", async () => {
    mockSendMove.mockResolvedValue({ outcome: "api-error", code: "move_same_locality" });
    render(<MudanzaScreen publicToken={TOKEN} />);
    await screen.findByText("Mudanza de Pampa");
    await pickBariloche();
    fireEvent.press(screen.getByText("Registrar mudanza"));
    expect(await screen.findByText(/ya es la localidad registrada/)).toBeOnTheScreen();
  });
});

describe("MudanzaScreen — the discard guard (finding F4)", () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});

  beforeEach(() => {
    alert.mockClear();
  });

  it("says nothing to somebody who only opened the screen", async () => {
    // The control. A guard that fires on an untouched form teaches people to
    // dismiss it, and then it is not there on the day it mattered.
    render(<MudanzaScreen publicToken={TOKEN} />);
    await screen.findByText("Mudanza de Pampa");

    expect(mockNav.pressBack().blocked).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it("stops the back gesture once a destination has been picked", async () => {
    render(<MudanzaScreen publicToken={TOKEN} />);
    await screen.findByText("Mudanza de Pampa");
    await pickBariloche();

    expect(mockNav.pressBack().blocked).toBe(true);
    expect(alert.mock.calls[0]?.[0]).toBe("¿Salir sin guardar?");
  });

  it("lets go once the move LANDED, which is a flag and not `allowLeave`", async () => {
    // THE CASE THE NO-OP STUB COULD NOT SEE. This screen exempts its own success
    // with `done` — `useDraftDiscardGuard(!done && draft !== EMPTY_MOVE_DRAFT)`
    // — rather than by calling `allowLeave()`, so the decision lives HERE and
    // nowhere else. Drop `setDone(true)` and the person who just registered a
    // move is asked whether they want to discard it on the way out of an
    // acknowledgement screen that has no form left on it.
    render(<MudanzaScreen publicToken={TOKEN} />);
    await screen.findByText("Mudanza de Pampa");
    await pickBariloche();
    fireEvent.press(screen.getByText("Registrar mudanza"));
    await screen.findByText(/quedó registrada/);

    expect(mockNav.pressBack().blocked).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });
});
