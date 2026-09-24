// `CaretakerPetScreen` — the titular's side of cuidador temporal.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. THE FORM AND THE CONTROLS ARE NEVER BOTH OFFERED. Two partial unique
//      indexes allow at most one open arrangement per pet, so a screen showing
//      "invitar" beside "finalizar" would be offering something the database
//      refuses.
//   2. RETIRAR AND FINALIZAR ARE DIFFERENT FACTS AND THE COPY KEEPS THEM APART.
//      One withdraws an invitation nobody answered; the other ends a live
//      arrangement and appends `caretaker_ended` to the spine.
//   3. THE FINALIZAR CONFIRMATION SAYS WHAT IT DOES NOT DO. Ending the grant ends
//      ACCESS. The animal may still be at the caretaker's house, and a titular who
//      reads "finalizar" as "get my pet back" has been misled by their own app.
//   4. AN IMPOSSIBLE DAY NEVER LEAVES THE DEVICE. `2026-02-31` would reach a
//      server whose boundary parser rolls it over to the 3rd of March.
//   5. A DESIGNATION TO AN ADDRESS WITH NO ACCOUNT SAYS SO. No invitation mail is
//      sent from this endpoint and no in-app notice is written either, so
//      `inviteeNeedsAccount: true` means NOBODY has been told.
//   6. A FAILED READ IS NOT AN EMPTY COCKPIT. Saying "no hay ningún cuidado" over
//      an outage would invite a titular to designate a second caretaker while one
//      is already running.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";

import { createNavigationFake } from "../ui/navigation-fake";

const mockFetch = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();

// A REAL LISTENER REGISTRY — see `ui/navigation-fake.ts`. A `useNavigation`
// stub that never fires its listener makes a missing discard guard invisible.
const mockNav = createNavigationFake();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useNavigation: () => mockNav.navigation,
}));

jest.mock("../api/endpoints", () => ({
  fetchMyCaretakerGrants: (...args: unknown[]) => mockFetch(...args),
  sendCaretakerCommand: (...args: unknown[]) => mockSend(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import { Share } from "react-native";

/**
 * SPIED ON THE PUBLIC API, not mocked by internal file path — the rule
 * `SharesScreen.test.tsx` states: a path mock works until React Native moves the
 * file and then fails as "share was never called", which is a green-looking
 * assertion about the one exit this invitation link has.
 */
const mockShare = jest.spyOn(Share, "share");

import type { MyCaretakerGrantV1, MyCaretakerGrantsV1 } from "@dim/contract/api";
import { CaretakerPetScreen } from "./CaretakerPetScreen";

const PET = "DIM-PAMP-0001";
const TOKEN = "CG-0123456789abcdef0123456789abcdef";

function aGrant(over: Partial<MyCaretakerGrantV1> = {}): MyCaretakerGrantV1 {
  return {
    grantToken: TOKEN,
    status: "pending",
    direction: "outgoing",
    pet: { publicToken: PET, name: "Pampa", species: "dog" },
    counterpartyName: null,
    caretakerEmail: "ana@example.com",
    startsAt: "2026-09-01T03:00:00.000Z",
    endsAt: "2026-09-16T02:59:59.999Z",
    note: null,
    expired: false,
    scopeSentence: "Podés cargar eventos médicos, notas y marcar perdido/encontrado.",
    capabilities: { canAccept: false, canReject: false, canCancel: true, canRevoke: false },
    ...over,
  };
}

function hub(outgoing: MyCaretakerGrantV1[]): MyCaretakerGrantsV1 {
  return {
    payloadVersion: 1,
    issuedAt: "2026-08-26T00:00:00.000Z",
    staleAfter: "2026-08-26T00:01:00.000Z",
    incoming: [],
    outgoing,
  };
}

function loads(outgoing: MyCaretakerGrantV1[]) {
  mockFetch.mockResolvedValue({ outcome: "ok", payload: hub(outgoing) });
}

function designateAck(inviteeNeedsAccount: boolean) {
  return {
    outcome: "ok",
    payload: {
      command: "designate",
      changed: true,
      grantToken: TOKEN,
      petPublicToken: null,
      inviteeNeedsAccount,
    },
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockSend.mockReset();
  mockShare.mockReset();
  mockShare.mockResolvedValue({ action: "sharedAction" });
});

describe("the two states are never both offered", () => {
  it("shows the form when nothing is running", async () => {
    loads([]);
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Invitar como cuidador/a")).toBeTruthy());
    expect(screen.queryByText(/Finalizar el cuidado/)).toBeNull();
    expect(screen.queryByText(/Retirar la invitación/)).toBeNull();
  });

  it("shows the withdraw control on a pending invitation, and no form", async () => {
    loads([aGrant()]);
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Retirar la invitación")).toBeTruthy());
    expect(screen.queryByText("Invitar como cuidador/a")).toBeNull();
    expect(screen.getByText("Pendiente")).toBeTruthy();
  });
});

describe("handing over an invitation nobody was told about (A4-custodia-10)", () => {
  it("offers the link when the invited address has no account", async () => {
    // The titular invites her sister, who has no miMAR account. The write sends
    // no mail on purpose (a magic link would land her in a browser), so the ack
    // says "avisale vos" — and there was nothing to hand over.
    loads([aGrant({ counterpartyName: null })]);
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Todavía no le avisamos")).toBeTruthy());
    fireEvent.press(screen.getByText("Compartir el link de la invitación"));

    await waitFor(() => expect(mockShare).toHaveBeenCalled());
    const message = (mockShare.mock.calls[0]?.[0] as { message: string }).message;
    // The `/cuidado/{token}` address the invitation mail and the notification CTA
    // both name — not a token on its own, which nobody can open.
    expect(message).toContain(`/cuidado/${TOKEN}`);
    expect(message).toContain("Pampa");
  });

  it("states the no-account fact in the PAST, because that is when it was measured (F10)", async () => {
    // `counterpartyName === null` is an exact proxy for "no profile" AT
    // DESIGNATION TIME and never refreshes: `caretakerUserId` is written once and
    // never backfilled. So the day the sister signs up, this card would go on
    // saying "esa dirección no tiene cuenta en miMAR, así que no le mandamos
    // nada" — while `addressedToCaller` matches her by e-mail and the invitation
    // is already in her app. The titular reads that and chases somebody who is
    // looking at the thing they are chasing them about.
    loads([aGrant({ counterpartyName: null })]);
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Todavía no le avisamos")).toBeTruthy());
    expect(screen.getByText(/Cuando la designaste, esa dirección no tenía cuenta/)).toBeTruthy();
    // And the OTHER possibility is named, because the client cannot tell which.
    expect(screen.getByText(/ya le aparece en su app/)).toBeTruthy();
    expect(screen.queryByText(/esa dirección no tiene cuenta/i)).toBeNull();
  });

  it("does NOT offer it once somebody is behind the address", async () => {
    // `counterpartyName` non-null means the address has a profile: that person
    // has the invitation in their own app, and a live invitation link is not a
    // thing to keep passing around.
    loads([aGrant({ counterpartyName: "Ana" })]);
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Retirar la invitación")).toBeTruthy());
    expect(screen.queryByText("Compartir el link de la invitación")).toBeNull();
  });

  it("does NOT offer it on an ACCEPTED arrangement", async () => {
    loads([
      aGrant({
        status: "accepted",
        counterpartyName: null,
        capabilities: { canAccept: false, canReject: false, canCancel: false, canRevoke: true },
      }),
    ]);
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Finalizar el cuidado ahora")).toBeTruthy());
    expect(screen.queryByText("Compartir el link de la invitación")).toBeNull();
  });

  it("shows the end control on a live arrangement, and no form", async () => {
    loads([
      aGrant({
        status: "accepted",
        counterpartyName: "Ana",
        capabilities: { canAccept: false, canReject: false, canCancel: false, canRevoke: true },
      }),
    ]);
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Finalizar el cuidado ahora")).toBeTruthy());
    expect(screen.queryByText("Invitar como cuidador/a")).toBeNull();
    expect(screen.getByText("Activo")).toBeTruthy();
    expect(screen.getByText("Para: Ana")).toBeTruthy();
  });

  it("ignores a grant on ANOTHER pet", async () => {
    loads([aGrant({ pet: { publicToken: "DIM-OTRO-0002", name: "Otro", species: "cat" } })]);
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);
    await waitFor(() => expect(screen.getByText("Invitar como cuidador/a")).toBeTruthy());
  });
});

describe("retirar and finalizar are different facts", () => {
  it("says nobody loses anything when withdrawing an invitation", async () => {
    loads([aGrant()]);
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Retirar la invitación")).toBeTruthy());
    fireEvent.press(screen.getByText("Retirar la invitación"));

    await waitFor(() => expect(screen.getByText(/Nunca tuvo acceso/)).toBeTruthy());
    expect(screen.getByText("Confirmar el retiro")).toBeTruthy();
  });

  it("says ending the grant does NOT bring the animal home", async () => {
    // The load-bearing sentence of this whole screen. `caretaker_ended` removes
    // ACCESS; where the animal physically is remains an open question the titular
    // has to act on.
    loads([
      aGrant({
        status: "accepted",
        capabilities: { canAccept: false, canReject: false, canCancel: false, canRevoke: true },
      }),
    ]);
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Finalizar el cuidado ahora")).toBeTruthy());
    fireEvent.press(screen.getByText("Finalizar el cuidado ahora"));

    await waitFor(() => expect(screen.getByText(/esto no la trae de vuelta/)).toBeTruthy());
    expect(screen.getByText("Confirmar la finalización")).toBeTruthy();
  });

  it("sends revoke with BOTH tokens, because the guard runs against the pet", async () => {
    loads([
      aGrant({
        status: "accepted",
        capabilities: { canAccept: false, canReject: false, canCancel: false, canRevoke: true },
      }),
    ]);
    mockSend.mockResolvedValue({
      outcome: "ok",
      payload: {
        command: "revoke",
        changed: true,
        grantToken: TOKEN,
        petPublicToken: null,
        inviteeNeedsAccount: null,
      },
    });
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Finalizar el cuidado ahora")).toBeTruthy());
    fireEvent.press(screen.getByText("Finalizar el cuidado ahora"));
    await waitFor(() => expect(screen.getByText("Confirmar la finalización")).toBeTruthy());
    fireEvent.press(screen.getByText("Confirmar la finalización"));

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend.mock.calls[0]?.[1]).toEqual({
      command: "revoke",
      petPublicToken: PET,
      grantToken: TOKEN,
    });
  });
});

describe("the designation form", () => {
  // The names carry ", obligatorio" (CA-M1/CA-M2): these three fields pass an
  // explicit `accessibilityLabel`, which used to REPLACE the kit's derived name
  // and take the requiredness suffix with it. See the a11y describe below.
  function fill(values: { email: string; endsAt: string }) {
    fireEvent.changeText(screen.getByLabelText("Correo de la persona, obligatorio"), values.email);
    fireEvent.changeText(screen.getByLabelText("Hasta, obligatorio"), values.endsAt);
  }

  it("refuses an impossible day BEFORE the network", async () => {
    // `31/02/2026` looks fine and the server's own boundary parser rolls it over
    // to the 3rd of March — three days of somebody else's access nobody asked for.
    loads([]);
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Invitar como cuidador/a")).toBeTruthy());
    fill({ email: "ana@example.com", endsAt: "31/02/2026" });
    fireEvent.press(screen.getByText("Invitar como cuidador/a"));

    await waitFor(() => expect(screen.getByText(/días reales/)).toBeTruthy());
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses a malformed address BEFORE the network", async () => {
    loads([]);
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Invitar como cuidador/a")).toBeTruthy());
    fill({ email: "ana", endsAt: "15/09/2026" });
    fireEvent.press(screen.getByText("Invitar como cuidador/a"));

    await waitFor(() => expect(screen.getByText(/correo válido/)).toBeTruthy());
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("says NOBODY was told when the address has no account", async () => {
    // No invitation mail is sent from this endpoint (the web's `redirectTo` is a
    // browser link), and `designateCaretaker` writes an in-app notice only when
    // the address resolved. So `true` means the titular has to reach them.
    loads([]);
    mockSend.mockResolvedValue(designateAck(true));
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Invitar como cuidador/a")).toBeTruthy());
    fill({ email: "ana@example.com", endsAt: "15/09/2026" });
    fireEvent.press(screen.getByText("Invitar como cuidador/a"));

    await waitFor(() => expect(screen.getByText(/avisale vos/)).toBeTruthy());
  });

  it("says the other thing when the address DOES have an account", async () => {
    loads([]);
    mockSend.mockResolvedValue(designateAck(false));
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Invitar como cuidador/a")).toBeTruthy());
    fill({ email: "ana@example.com", endsAt: "15/09/2026" });
    fireEvent.press(screen.getByText("Invitar como cuidador/a"));

    await waitFor(() => expect(screen.getByText(/Le avisamos a esa persona/)).toBeTruthy());
  });

  it("takes the two days as DD/MM/AAAA off a number pad and posts them as the wire's ISO", async () => {
    // forms-F1/F2: both fields asked for `AAAA-MM-DD` over
    // `keyboardType="numbers-and-punctuation"` — an iOS-only value, so Android
    // opened QWERTY. Now the field shows the format an Argentine form uses, the
    // mask draws the slashes, and the view-model converts before the contract.
    loads([]);
    mockSend.mockResolvedValue(designateAck(false));
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Invitar como cuidador/a")).toBeTruthy());
    const desde = screen.getByLabelText("Desde, obligatorio");
    expect(desde.props.inputMode).toBe("numeric");
    expect(desde.props.keyboardType).toBeUndefined();
    expect(desde.props.placeholder).toBe("DD/MM/AAAA");

    // Eight digits, the way a number pad hands them over: the mask makes the date.
    fireEvent.changeText(desde, "01092026");
    fill({ email: "ana@example.com", endsAt: "15/09/2026" });
    fireEvent.press(screen.getByText("Invitar como cuidador/a"));

    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    expect(mockSend.mock.calls[0]?.[1]).toMatchObject({
      command: "designate",
      startsAt: "2026-09-01",
      endsAt: "2026-09-15",
    });
  });

  it("keeps ', obligatorio' on fields that name their own accessibility label", async () => {
    // CA-M1/CA-M2: these three pass an explicit `accessibilityLabel`, which the
    // kit used to let REPLACE the derived name — suffix and all — so a screen
    // reader announced no requiredness on any of them.
    loads([]);
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Invitar como cuidador/a")).toBeTruthy());
    expect(screen.getByLabelText("Correo de la persona, obligatorio")).toBeTruthy();
    expect(screen.getByLabelText("Desde, obligatorio")).toBeTruthy();
    expect(screen.getByLabelText("Hasta, obligatorio")).toBeTruthy();
  });

  it("names the relationship on a refusal, not an answer that moved (A3-documento-credencial-05)", async () => {
    // A person-path holder whose role is `caretaker` — deny-list row
    // `caretaker-sub-designation`. The screen does not pre-judge; it asks. What
    // it may NOT do is hand back the shared sentence, which is answer-time copy:
    // "Actualizá la pantalla para ver cómo quedó" describes an arrangement that
    // moved, and nothing moved — the refusal is about who this person is, so
    // refreshing produces the identical screen forever.
    loads([]);
    mockSend.mockResolvedValue({
      outcome: "api-error",
      code: "caretaker_forbidden",
      retryAfterSeconds: null,
    });
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Invitar como cuidador/a")).toBeTruthy());
    fill({ email: "ana@example.com", endsAt: "15/09/2026" });
    fireEvent.press(screen.getByText("Invitar como cuidador/a"));

    await waitFor(() =>
      expect(screen.getByText(/El cuidado temporal lo designa el titular/)).toBeTruthy(),
    );
    expect(screen.queryByText(/no es tuya para hacer/)).toBeNull();
  });

  it("does not tell a co-owner to end a cuidado their screen never showed (A4-custodia-06)", async () => {
    // Two co-titulares; one designated a dog-sitter. `grantForPet` reads the
    // caller's OWN outgoing grants, so the other opens an EMPTY cockpit with an
    // invite form — and the shared sentence answers "Terminá o retirá el que
    // está", about something that is not on the screen and that they could not
    // end anyway (`endCaretakerGrant` refuses `revoke` unless the actor is the
    // granter).
    loads([]);
    mockSend.mockResolvedValue({
      outcome: "api-error",
      code: "caretaker_grant_exists",
      retryAfterSeconds: null,
    });
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Invitar como cuidador/a")).toBeTruthy());
    fill({ email: "ana@example.com", endsAt: "15/09/2026" });
    fireEvent.press(screen.getByText("Invitar como cuidador/a"));

    await waitFor(() => expect(screen.getByText(/lo designó otra persona/)).toBeTruthy());
    expect(screen.queryByText(/Terminá o retirá el que está/)).toBeNull();
  });

  it("KEEPS the typed form when the refusal is about the form (A4-custodia-04)", async () => {
    // The titular typed an address, a note with the medication routine and a
    // "Hasta" the server refuses. The screen answered "Revisá las fechas…" over
    // an EMPTY form, because every failure re-read and `load()` unmounts the
    // form with its draft inside it.
    loads([]);
    mockSend.mockResolvedValue({
      outcome: "api-error",
      code: "caretaker_period_invalid",
      retryAfterSeconds: null,
    });
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Invitar como cuidador/a")).toBeTruthy());
    expect(mockFetch).toHaveBeenCalledTimes(1);
    fill({ email: "vecina@example.com", endsAt: "15/09/2026" });
    fireEvent.changeText(
      screen.getByLabelText("Nota para quien cuida"),
      "Media pastilla con la cena",
    );
    fireEvent.press(screen.getByText("Invitar como cuidador/a"));

    await waitFor(() => expect(screen.getByText(/Revisá las fechas/)).toBeTruthy());
    expect(screen.getByLabelText("Correo de la persona, obligatorio").props.value).toBe(
      "vecina@example.com",
    );
    expect(screen.getByLabelText("Nota para quien cuida").props.value).toBe(
      "Media pastilla con la cena",
    );
    // And it did NOT spend a round trip on a refusal a re-read cannot answer.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("still RE-READS when the refusal says the server's state moved", async () => {
    // The non-vacuity half of the rule above: `caretaker_grant_exists` means
    // something really is there, and the cockpit has to show it rather than keep
    // offering a form that cannot succeed.
    loads([]);
    mockSend.mockResolvedValue({
      outcome: "api-error",
      code: "caretaker_grant_exists",
      retryAfterSeconds: null,
    });
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText("Invitar como cuidador/a")).toBeTruthy());
    expect(mockFetch).toHaveBeenCalledTimes(1);
    fill({ email: "ana@example.com", endsAt: "15/09/2026" });
    fireEvent.press(screen.getByText("Invitar como cuidador/a"));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });
});

describe("the discard guard (A2-alta-asentar-08)", () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});

  beforeEach(() => {
    alert.mockClear();
    mockNav.reset();
  });

  it("does NOT ask anything of somebody who only opened the form", async () => {
    // `Desde` is PRE-FILLED with today, so a predicate that compared against a
    // blank form would fire on mount for everybody who opened this screen.
    loads([]);
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);
    await waitFor(() => expect(screen.getByText("Invitar como cuidador/a")).toBeTruthy());

    expect(mockNav.pressBack().blocked).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it("asks before the back gesture discards a typed invitation", async () => {
    loads([]);
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);
    await waitFor(() => expect(screen.getByText("Invitar como cuidador/a")).toBeTruthy());
    fireEvent.changeText(
      screen.getByLabelText("Correo de la persona, obligatorio"),
      "vecina@example.com",
    );

    expect(mockNav.pressBack().blocked).toBe(true);
    expect(alert.mock.calls[0]?.[0]).toBe("¿Salir sin guardar?");
  });
});

describe("a failed read", () => {
  it("is not an empty cockpit", async () => {
    // Saying "no hay ningún cuidado" over an outage would invite a titular to
    // designate a SECOND caretaker while one is already running — which the
    // database would then refuse, after they filled in a form.
    mockFetch.mockResolvedValue({ outcome: "unreachable", detail: "offline" });
    render(<CaretakerPetScreen publicToken={PET} petName="Pampa" />);

    await waitFor(() => expect(screen.getByText(/No pudimos conectarnos/)).toBeTruthy());
    expect(screen.queryByText("Invitar como cuidador/a")).toBeNull();
    expect(screen.getByText("Reintentar")).toBeTruthy();
  });
});
