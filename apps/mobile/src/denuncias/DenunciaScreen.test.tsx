// `DenunciaScreen` — the render tests for the one screen that files a criminal
// allegation.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. THE ANONYMOUS SUBMISSION CARRIES NO CONTACT, all the way from a form
//      whose contact fields have been typed into. The contract makes it
//      unrepresentable and the handler reads off the branch; this is the third
//      layer, and it is the one that watches the actual body leave the app.
//   2. THE POINT COMES FROM A TAP, NEVER FROM THIS APP. There is no
//      `expo-location` and no map, so a screen that invented a coordinate would
//      send an inspector to a street nobody named. The send must refuse until a
//      candidate has been chosen, and it must send THAT candidate's numbers.
//   3. CHANGING THE ADDRESS INVALIDATES THE CHOSEN POINT. The dangerous state is
//      a denuncia filed against the previous street because somebody retyped the
//      address and did not re-tap.
//   4. THE SCREEN SAYS WHAT IT CANNOT DO, BEFORE THE FORM. No attachments — and
//      not "not yet in this session": evidence is only ever accepted at
//      creation, so somebody with a photo has to be sent to the browser BEFORE
//      they spend five minutes typing.
//   5. THE RECEIPT IS A CODE AND A DOOR. Not a case id, not a status, and — for
//      an anonymous reporter — a warning that the code is the only thread back.
//
// It runs under JEST. `apps` is excluded from the Vitest walk
// (`__tests__/db-reachability.ts`), so a file written in Vitest's dialect here
// would never run and would look like coverage.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";

import { createNavigationFake } from "../ui/navigation-fake";

const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockOpenURL = jest.fn<(url: string) => Promise<unknown>>();

jest.mock("expo-linking", () => ({ openURL: (url: string) => mockOpenURL(url) }));

// A REAL LISTENER REGISTRY, NOT THE NO-OP STUB (finding F4, review 2026-09-07).
// `addListener: () => () => {}` never fires the listener, so it cannot tell a
// guarded screen from an unguarded one — and this screen exempts its own
// success with `phase.name !== "filed"` rather than with `allowLeave()`, which
// is a decision `ui/use-draft-discard-guard.test.tsx` cannot see from where it
// stands.
const mockNav = createNavigationFake();

jest.mock("expo-router", () => ({
  useNavigation: () => mockNav.navigation,
}));

jest.mock("../api/endpoints", () => ({
  sendWelfareReportCommand: (...args: unknown[]) => mockSend(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import { DenunciaScreen } from "./DenunciaScreen";

const ADDRESS = "Av. Bustillo 1200";
const PLACE_LABEL = "Avenida Bustillo 1200, San Carlos de Bariloche, Río Negro, Argentina";
const OTHER_LABEL = "Bustillo 1200, Villa La Angostura, Neuquén, Argentina";
const DESCRIPTION = "Vi al perro atado al sol sin agua y con golpes visibles en el lomo.";
const SUBJECT = "Perro mestizo marrón, atado en el fondo de una casa.";

function matchesAck(labels: string[] = [PLACE_LABEL]) {
  return {
    outcome: "ok" as const,
    payload: {
      command: "resolve_location",
      version: 1,
      matches: labels.map((label, index) => ({
        label,
        lat: -41.135 - index,
        lng: -71.3103 - index,
        province: "Río Negro",
        locality: "San Carlos de Bariloche",
      })),
    },
  };
}

const FILED_ACK = {
  outcome: "ok" as const,
  payload: {
    command: "file",
    version: 1,
    referenceCode: "DEN-9KSC-MRMZ",
    followUpUrl: "https://mimar.ar/denuncias/codigo/DEN-9KSC-MRMZ",
  },
};

/** The body of the Nth call to the endpoint. */
function bodyOf(call: number): Record<string, unknown> {
  return mockSend.mock.calls[call]?.[1] as Record<string, unknown>;
}

async function searchAddress(value = ADDRESS, labels = [PLACE_LABEL]) {
  mockSend.mockResolvedValueOnce(matchesAck(labels));
  fireEvent.changeText(screen.getByLabelText("¿Dónde está pasando?, obligatorio"), value);
  fireEvent.press(screen.getByText("Buscar el lugar"));
  await waitFor(() => expect(screen.getByText(labels[0] ?? "")).toBeTruthy());
}

/** Fill everything except the place. */
function fillFacts() {
  fireEvent.press(screen.getByText("Maltrato físico, golpes o lesiones"));
  fireEvent.press(screen.getByText("Grave / urgente"));
  fireEvent.press(screen.getByText("Un animal sin dueño identificado"));
  fireEvent.changeText(
    screen.getByLabelText("¿Qué o a quién estás denunciando?, obligatorio"),
    SUBJECT,
  );
  fireEvent.changeText(screen.getByLabelText("Contanos qué pasó, obligatorio"), DESCRIPTION);
}

beforeEach(() => {
  mockNav.reset();
  mockSend.mockReset();
  mockOpenURL.mockReset();
});

describe("what the screen says before it asks anything", () => {
  it("names the law and the fact that a denuncia cannot be taken back", () => {
    render(<DenunciaScreen />);
    expect(screen.getByText(/Ley 14\.346/)).toBeTruthy();
    expect(screen.getByText(/no se puede borrar/)).toBeTruthy();
  });

  it("tells somebody with a photo to use the browser BEFORE they fill anything in", () => {
    // NOT "you can add them later": no surface accepts evidence for an existing
    // denuncia. Copy that said otherwise would cost somebody their evidence and
    // five minutes.
    //
    // This comment used to say `uploadWelfareEvidence` has two call sites. It
    // has THREE — the third is `submit-claim-dispute.ts`, a custody dispute
    // rather than a denuncia, and also a creation path. Corrected in place; see
    // `denuncia-view-model.ts`.
    //
    // THE MUTATION: move this Callout below the send button. Applied: the block
    // still renders, so this test is about the WORDS, and the words are what a
    // person can act on — "hacé la denuncia desde el navegador" is only useful
    // before they start.
    render(<DenunciaScreen />);
    expect(screen.getByText(/no se pueden sumar después/)).toBeTruthy();
    expect(screen.getByText("Denunciar desde la web")).toBeTruthy();
  });

  it("says what anónima buys and what it does not", () => {
    // Every `/api/v1` door authenticates. What this transport offers is that
    // nothing is written down — not that the request was unattributable.
    //
    // THE MUTATION: drop the "iniciaste sesión" sentence from
    // `DENUNCIA_ANONYMOUS_CAVEAT`. Applied: fails.
    render(<DenunciaScreen />);
    expect(screen.getByText(/iniciaste sesión para llegar hasta acá/)).toBeTruthy();
  });
});

describe("the place comes from a tap, never from this app", () => {
  it("refuses to send with nothing typed, and asks for the ADDRESS rather than the list", async () => {
    // THE MUTATION: default `place` to a hardcoded coordinate in `EMPTY`.
    // Applied: the send goes through and this fails.
    //
    // THE SENTENCE CHANGED (finding L3, review 2026-09-07). It used to be "Elegí
    // el lugar de la lista", which is advice about a list that does not exist
    // until somebody types an address and searches: `ADDRESS_REQUIRED` sat in
    // `DENUNCIA_FIELD_ORDER` and nothing could ever produce it, so both place
    // failures answered with the second one's copy.
    render(<DenunciaScreen />);
    fillFacts();
    fireEvent.press(screen.getByText("Enviar la denuncia"));

    expect(screen.getByText(/Escribí la dirección o el lugar/)).toBeTruthy();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("asks for the LIST once an address was typed and no candidate tapped", async () => {
    // The other half of the same heading, and the reason the two codes exist.
    render(<DenunciaScreen />);
    await searchAddress();
    fillFacts();
    fireEvent.press(screen.getByText("Enviar la denuncia"));

    expect(screen.getByText(/Elegí el lugar de la lista/)).toBeTruthy();
    expect(mockSend).toHaveBeenCalledTimes(1); // the search only
  });

  it("sends the chosen candidate's own coordinates and label", async () => {
    render(<DenunciaScreen />);
    await searchAddress();
    fireEvent.press(screen.getByText(PLACE_LABEL));
    fillFacts();

    mockSend.mockResolvedValueOnce(FILED_ACK);
    fireEvent.press(screen.getByText("Enviar la denuncia"));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));

    expect(bodyOf(1)).toMatchObject({
      command: "file",
      locationLat: -41.135,
      locationLng: -71.3103,
      locationAddress: PLACE_LABEL,
    });
    // AND NOT WHAT WAS TYPED. The typed string is the person's; the label is the
    // gazetteer's, and it is the one the authority reads.
    expect(JSON.stringify(bodyOf(1))).not.toContain(ADDRESS);
  });

  it("picks the candidate that was tapped, not the first one", async () => {
    // A list that always yields index 0 would pass every other test here.
    render(<DenunciaScreen />);
    await searchAddress(ADDRESS, [PLACE_LABEL, OTHER_LABEL]);
    fireEvent.press(screen.getByText(OTHER_LABEL));
    fillFacts();

    mockSend.mockResolvedValueOnce(FILED_ACK);
    fireEvent.press(screen.getByText("Enviar la denuncia"));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));

    expect(bodyOf(1)).toMatchObject({ locationLat: -42.135, locationAddress: OTHER_LABEL });
  });

  it("DROPS the chosen point when the address is retyped", async () => {
    // THE DANGEROUS STATE: a denuncia filed against the previous street because
    // somebody corrected the address and did not re-tap.
    //
    // THE MUTATION: delete the `if (values.place !== null) patch({ place: null })`
    // line in the address field's `onChangeText`. Applied: the send goes through
    // carrying the stale point and this fails.
    render(<DenunciaScreen />);
    await searchAddress();
    fireEvent.press(screen.getByText(PLACE_LABEL));
    fireEvent.changeText(
      screen.getByLabelText("¿Dónde está pasando?, obligatorio"),
      "Otra calle 500",
    );
    fillFacts();
    fireEvent.press(screen.getByText("Enviar la denuncia"));

    expect(screen.getByText(/Elegí el lugar de la lista/)).toBeTruthy();
    expect(mockSend).toHaveBeenCalledTimes(1); // the search only
  });

  it("says the honest thing when the geocoder answers with nothing", async () => {
    // A miss, a timeout and a rate-limit refusal are indistinguishable. "Esa
    // dirección no existe" would be a claim the server did not make.
    render(<DenunciaScreen />);
    mockSend.mockResolvedValueOnce(matchesAck([]));
    fireEvent.changeText(screen.getByLabelText("¿Dónde está pasando?, obligatorio"), ADDRESS);
    fireEvent.press(screen.getByText("Buscar el lugar"));

    await waitFor(() =>
      expect(screen.getByText(/No pudimos encontrar esa dirección/)).toBeTruthy(),
    );
    expect(screen.queryByText(/no existe/)).toBeNull();
  });
});

describe("the anonymous submission carries nothing about the reporter", () => {
  it("sends no contact even when the fields were typed into first", async () => {
    // THE THIRD LAYER. The contract makes it unrepresentable and the handler
    // reads off the branch; this watches the body actually leave the app after
    // somebody filled the fields in and then switched back to anonymous.
    //
    // THE MUTATION: in `buildFileDenunciaCommand`, always take the
    // `with_contact` branch. Applied: fails.
    render(<DenunciaScreen />);
    await searchAddress();
    fireEvent.press(screen.getByText(PLACE_LABEL));
    fillFacts();

    fireEvent.press(screen.getByText("Con mi contacto"));
    fireEvent.changeText(screen.getByLabelText("Correo"), "vecina@example.com");
    fireEvent.press(screen.getByText("Anónima"));

    mockSend.mockResolvedValueOnce(FILED_ACK);
    fireEvent.press(screen.getByText("Enviar la denuncia"));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));

    expect(bodyOf(1)).toMatchObject({ contactMode: "anonymous" });
    expect(JSON.stringify(bodyOf(1))).not.toContain("vecina@example.com");
  });

  it("sends the contact when the person chose to leave one", async () => {
    render(<DenunciaScreen />);
    await searchAddress();
    fireEvent.press(screen.getByText(PLACE_LABEL));
    fillFacts();
    fireEvent.press(screen.getByText("Con mi contacto"));
    fireEvent.changeText(screen.getByLabelText("Correo"), "vecina@example.com");

    mockSend.mockResolvedValueOnce(FILED_ACK);
    fireEvent.press(screen.getByText("Enviar la denuncia"));
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));

    expect(bodyOf(1)).toMatchObject({
      contactMode: "with_contact",
      reporterContactEmail: "vecina@example.com",
    });
  });
});

describe("the receipt", () => {
  it("shows the code and, for an anonymous reporter, that it is the only thread back", async () => {
    // An anonymous denuncia leaves the server no address to mint an access link
    // into. That is the honest cost of the choice and the screen has to say it
    // at the one moment the person can still write the code down.
    render(<DenunciaScreen />);
    await searchAddress();
    fireEvent.press(screen.getByText(PLACE_LABEL));
    fillFacts();

    mockSend.mockResolvedValueOnce(FILED_ACK);
    fireEvent.press(screen.getByText("Enviar la denuncia"));

    await waitFor(() => expect(screen.getByText("DEN-9KSC-MRMZ")).toBeTruthy());
    expect(screen.getByText(/si lo perdés, no vas a poder seguirla/i)).toBeTruthy();
    // NO CASE ID AND NO STATUS on this screen — the ack carries neither, and a
    // screen that displayed one would mean the ack had grown one.
    expect(screen.queryByText(/Abierta|En curso|caso/)).toBeNull();
  });

  it("opens the constancia in the browser with the URL the server built", async () => {
    render(<DenunciaScreen />);
    await searchAddress();
    fireEvent.press(screen.getByText(PLACE_LABEL));
    fillFacts();
    mockSend.mockResolvedValueOnce(FILED_ACK);
    fireEvent.press(screen.getByText("Enviar la denuncia"));
    await waitFor(() => expect(screen.getByText("DEN-9KSC-MRMZ")).toBeTruthy());

    fireEvent.press(screen.getByText("Ver la constancia en la web"));
    expect(mockOpenURL).toHaveBeenCalledWith("https://mimar.ar/denuncias/codigo/DEN-9KSC-MRMZ");
  });
});

describe("a failed call is never a result", () => {
  it("returns to the form with a sentence when the send fails", async () => {
    render(<DenunciaScreen />);
    await searchAddress();
    fireEvent.press(screen.getByText(PLACE_LABEL));
    fillFacts();

    mockSend.mockResolvedValueOnce({ outcome: "unreachable" });
    fireEvent.press(screen.getByText("Enviar la denuncia"));

    await waitFor(() => expect(screen.getByText(/No pudimos conectarnos/)).toBeTruthy());
    // AND THE FORM IS STILL THERE, with what was typed in it — a denuncia is
    // several minutes of writing and a failed request may not throw it away.
    expect(screen.getByDisplayValue(DESCRIPTION)).toBeTruthy();
  });

  it("does not draw a receipt when the server answers the other command", async () => {
    render(<DenunciaScreen />);
    await searchAddress();
    fireEvent.press(screen.getByText(PLACE_LABEL));
    fillFacts();

    mockSend.mockResolvedValueOnce(matchesAck());
    fireEvent.press(screen.getByText("Enviar la denuncia"));

    await waitFor(() => expect(screen.getByText(/No pudimos enviar la denuncia/)).toBeTruthy());
    expect(screen.queryByText("DEN-9KSC-MRMZ")).toBeNull();
  });
});

describe("the emergency off-ramp", () => {
  it("names 911 when the severity is the urgent one, and not otherwise", () => {
    // Copied from the web's own Step 2: a denuncia is asynchronous, and an
    // animal in immediate danger needs a phone call the form must not stand in
    // front of.
    render(<DenunciaScreen />);
    expect(screen.queryByText(/911/)).toBeNull();
    fireEvent.press(screen.getByText("Grave / urgente"));
    expect(screen.getByText(/911/)).toBeTruthy();
  });
});

describe("two candidates with the SAME name are still two places (A5-ciudadanas-13)", () => {
  it("checks only the row that was tapped", async () => {
    // The geocoder returns identical `display_name`s for a corner, and the row
    // used to highlight on the label alone — so tapping either lit BOTH, while
    // the point actually filed was the one under the thumb. `matchesAck` gives
    // each row its own lat/lng, which is what the key already compared on.
    render(<DenunciaScreen />);
    const twin = "Calle San Martín 100, San Carlos de Bariloche, Río Negro";
    // NOT `searchAddress`: its own wait uses `getByText`, which throws on the
    // duplicate this test exists to create.
    mockSend.mockResolvedValueOnce(matchesAck([twin, twin]));
    fireEvent.changeText(screen.getByLabelText("¿Dónde está pasando?, obligatorio"), ADDRESS);
    fireEvent.press(screen.getByText("Buscar el lugar"));
    await waitFor(() => expect(screen.getAllByRole("radio", { name: twin })).toHaveLength(2));

    const rows = screen.getAllByRole("radio", { name: twin });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.props.accessibilityState?.checked)).toEqual([false, false]);

    fireEvent.press(rows[1] as never);

    const after = screen.getAllByRole("radio", { name: twin });
    expect(after.map((row) => row.props.accessibilityState?.checked)).toEqual([false, true]);
  });
});

describe("the discard guard (finding F4)", () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});

  beforeEach(() => {
    alert.mockClear();
  });

  it("says nothing to somebody who only opened the screen", async () => {
    // The control. This form is long and somebody who opened it, read the "no se
    // puede borrar" warning and changed their mind has typed nothing.
    render(<DenunciaScreen />);

    expect(mockNav.pressBack().blocked).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it("stops the back gesture once anything has been typed", async () => {
    render(<DenunciaScreen />);
    fillFacts();

    expect(mockNav.pressBack().blocked).toBe(true);
    expect(alert.mock.calls[0]?.[0]).toBe("¿Salir sin guardar?");
  });

  it("lets go once the denuncia was FILED, which is a phase and not `allowLeave`", async () => {
    // THE CASE THE NO-OP STUB COULD NOT SEE. The exemption is
    // `phase.name !== "filed"`, so it lives in this screen and nowhere else.
    // Without it, the person who just filed is asked whether they want to
    // discard — over a receipt screen whose whole point is a reference code they
    // have to keep, and on a denuncia that cannot be taken back anyway.
    render(<DenunciaScreen />);
    await searchAddress();
    fireEvent.press(screen.getByText(PLACE_LABEL));
    fillFacts();
    mockSend.mockResolvedValueOnce(FILED_ACK);
    fireEvent.press(screen.getByText("Enviar la denuncia"));
    await screen.findByText("DEN-9KSC-MRMZ");

    expect(mockNav.pressBack().blocked).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });
});
