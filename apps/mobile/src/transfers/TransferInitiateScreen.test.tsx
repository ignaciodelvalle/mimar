// `TransferInitiateScreen` — the form that offers an animal to somebody.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. NOTHING IS PRESELECTED. The web's `<select>` opens on "Regalo", so its
//      commonest submission carries a reason nobody chose. On a form that hands
//      over an animal that is worth one extra tap.
//   2. THE ADDRESS IS VALIDATED LOCALLY FIRST, against the contract's own
//      schema, so a typo gets a field sentence instead of a round trip that
//      answers `invalid_request` with no field detail.
//   3. NO IDEMPOTENCY KEY, like the other three commands.
//   4. THE SERVER'S REFUSAL IS RENDERED AS-IS. There is no local "am I the
//      owner?" guess — the rule (the active `role='owner'` ownership row) lives
//      in one place and a co-owner has to be told by it.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert, type StyleProp, StyleSheet, type TextStyle } from "react-native";

import { createNavigationFake } from "../ui/navigation-fake";
import { COLORS } from "../ui/theme";

const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();

// A REAL LISTENER REGISTRY, not the no-op stub this file used to carry
// (finding H1, review 2026-09-07). The stub was `addListener: () => () => {}` —
// the guard subscribed, the listener was never fired, and a whole class of
// defect became untestable from any screen: this screen shipped without
// `allowLeave`, so its OWN success navigation was intercepted with "¿Salir sin
// guardar?" and nothing here could see it. What the guard DOES is still pinned
// in ui/use-draft-discard-guard.test.tsx; what this registry adds is the ability
// to ask whether THIS screen exempted its own exit.
//
// FROM THE SHARED FAKE since finding F4: the two properties it needs — a stable
// object and a real unsubscribe — were hand-copied into this file, and a subtle
// fake with four copies is a fake that degrades back into the stub in one of
// them.
const mockNav = createNavigationFake();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useNavigation: () => mockNav.navigation,
}));

jest.mock("../api/endpoints", () => ({
  sendTransferCommand: (...args: unknown[]) => mockSend(...args),
}));

jest.mock("../auth/session-store", () => ({ sessionPort: {} }));

import { TransferInitiateScreen } from "./TransferInitiateScreen";

const TOKEN = "DIM-PAMP-0001";
const noop = () => {};

function renderScreen(onSent: (t: string) => void = noop) {
  return render(<TransferInitiateScreen publicToken={TOKEN} petName="Pampa" onSent={onSent} />);
}

/**
 * The address field, by its ACCESSIBLE name — which carries ", obligatorio"
 * (CA-M1): the field names its own `accessibilityLabel`, and the kit used to
 * let that replace the derived name, suffix included.
 */
function emailField() {
  return screen.getByLabelText("Email del receptor, obligatorio");
}

/**
 * The border colour the kit resolved for a field, out of its style array. The
 * `invalid` prop is the LAST entry, so this reads what actually painted.
 */
function borderColorOf(input: { props: { style?: StyleProp<TextStyle> } }) {
  return StyleSheet.flatten(input.props.style)?.borderColor;
}

function ok(transferToken: string) {
  return {
    outcome: "ok" as const,
    payload: {
      command: "initiate" as const,
      changed: true,
      transferToken,
      petPublicToken: null,
      recipientNeedsInvite: false,
    },
  };
}

/** Fire the back gesture at whatever the guard subscribed. */
function pressBack(): { prevented: boolean } {
  return { prevented: mockNav.pressBack().blocked };
}

let alerts: string[] = [];

beforeEach(() => {
  mockSend.mockReset();
  mockNav.reset();
  alerts = [];
  jest.spyOn(Alert, "alert").mockImplementation((title: string) => {
    alerts.push(title);
  });
});

describe("the form", () => {
  it("names the animal and the window the contract carries", () => {
    renderScreen();
    expect(screen.getByText("Transferir Pampa")).toBeTruthy();
    expect(screen.getByText(/7 días/)).toBeTruthy();
  });

  it("falls back honestly when the name is not known", () => {
    render(<TransferInitiateScreen publicToken={TOKEN} petName={null} onSent={noop} />);
    expect(screen.getByText("Transferir esta mascota")).toBeTruthy();
  });

  it("offers the four reasons as a radio group, with none checked", () => {
    renderScreen();
    for (const label of ["Venta", "Regalo", "Herencia", "Otro"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // A DEFAULT WOULD BE A CHOICE SOMEBODY DID NOT MAKE. The submit stays
    // disabled until one is picked, which is how that is enforced rather than
    // merely stated.
    fireEvent.changeText(emailField(), "vecina@example.com");
    fireEvent.press(screen.getByText("Enviar la propuesta"));
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("validation before the network", () => {
  it("refuses a malformed address with a FIELD sentence and never calls the API", async () => {
    renderScreen();
    fireEvent.changeText(emailField(), "vecina");
    fireEvent.press(screen.getByText("Regalo"));
    fireEvent.press(screen.getByText("Enviar la propuesta"));

    await waitFor(() =>
      expect(screen.getByText("Escribí un email válido para el receptor.")).toBeTruthy(),
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("draws the red border on the field the refusal is ABOUT, and clears it on the next keystroke", async () => {
    // forms-F3: the kit has had an `invalid` prop since it was written and
    // almost nothing passed it, so a refusal named a field in a sentence at the
    // top of the screen and left every box looking equally fine. The code the
    // contract already returned is what picks the box — no new validation.
    renderScreen();
    fireEvent.changeText(emailField(), "vecina");
    fireEvent.press(screen.getByText("Regalo"));
    fireEvent.press(screen.getByText("Enviar la propuesta"));

    await waitFor(() => expect(borderColorOf(emailField())).toBe(COLORS.danger));

    // Touching the field takes the red away — waiting for the next submit to
    // clear it would keep shouting at somebody already fixing it.
    fireEvent.changeText(emailField(), "vecina@");
    expect(borderColorOf(emailField())).not.toBe(COLORS.danger);
  });
});

describe("sending", () => {
  it("sends the command with NO idempotency key and hands back the new token", async () => {
    const onSent = jest.fn();
    mockSend.mockResolvedValue(ok("PTR-NEW0-0001"));
    renderScreen(onSent);

    fireEvent.changeText(emailField(), "  Vecina@Example.COM ");
    fireEvent.press(screen.getByText("Herencia"));
    fireEvent.changeText(screen.getByLabelText("Comentario para el receptor"), " se muda ");
    fireEvent.press(screen.getByText("Enviar la propuesta"));

    await waitFor(() => expect(onSent).toHaveBeenCalledWith("PTR-NEW0-0001"));
    // TWO arguments — the session port and the command.
    expect(mockSend.mock.calls[0]).toHaveLength(2);
    expect(mockSend.mock.calls[0]?.[1]).toEqual({
      command: "initiate",
      petPublicToken: TOKEN,
      // Lowercased and trimmed by the contract's own schema, because the accept
      // side matches on this string.
      toEmail: "vecina@example.com",
      reason: "inheritance",
      note: "se muda",
    });
  });

  it("renders the refusal in SEND-time words, not answer-time ones (A3-documento-credencial-05)", async () => {
    // A co-owner or a caretaker passes every other pet guard in this app and is
    // refused here, because `initiate` needs the ACTIVE `role='owner'` row. The
    // screen has no flag for that and must not invent one — but the SENTENCE
    // must be about sending, not about answering: "Esta propuesta no es tuya
    // para responder. Actualizá la pantalla." describes a proposal that does not
    // exist yet, and the refresh it asks for changes nothing, because the
    // refusal is about who this person is.
    mockSend.mockResolvedValue({ outcome: "api-error", code: "transfer_forbidden" });
    renderScreen();

    fireEvent.changeText(emailField(), "vecina@example.com");
    fireEvent.press(screen.getByText("Regalo"));
    fireEvent.press(screen.getByText("Enviar la propuesta"));

    await waitFor(() => expect(screen.getByText(/la inicia el titular/)).toBeTruthy());
    expect(screen.queryByText(/no es tuya para responder/)).toBeNull();
  });

  it("names the one-in-flight rule when the server reports it", async () => {
    mockSend.mockResolvedValue({ outcome: "api-error", code: "transfer_pending_exists" });
    renderScreen();

    fireEvent.changeText(emailField(), "vecina@example.com");
    fireEvent.press(screen.getByText("Regalo"));
    fireEvent.press(screen.getByText("Enviar la propuesta"));

    await waitFor(() => expect(screen.getByText(/Cancelala antes de enviar otra/)).toBeTruthy());
  });
});

// ---------------------------------------------------------------------------
// H1 — THE DISCARD GUARD MAY NOT INTERCEPT THIS SCREEN'S OWN SUCCESS
// ---------------------------------------------------------------------------

describe("the back guard, and the exit it must let through", () => {
  it("asks before discarding a proposal somebody typed and never sent", () => {
    // The control. Without this the test below would pass against a screen that
    // simply has no guard at all.
    renderScreen();
    fireEvent.changeText(emailField(), "vecina@example.com");

    expect(pressBack().prevented).toBe(true);
    expect(alerts).toEqual(["¿Salir sin guardar?"]);
  });

  it("does NOT ask once the proposal is on the server", async () => {
    // THE DEFECT (finding H1): the screen called `useDraftDiscardGuard(...)` and
    // threw away its `allowLeave`, so after the server had created the transfer
    // the person was asked "¿Salir sin guardar?" on the way to the proposal —
    // and "Seguir editando" left them on a form whose submission had landed.
    // Re-sending from there is refused as `transfer_pending_exists`.
    const onSent = jest.fn();
    mockSend.mockResolvedValue(ok("PTR-NEW0-0004"));
    renderScreen(onSent);

    fireEvent.changeText(emailField(), "vecina@example.com");
    fireEvent.press(screen.getByText("Regalo"));
    fireEvent.press(screen.getByText("Enviar la propuesta"));
    await waitFor(() => expect(onSent).toHaveBeenCalledWith("PTR-NEW0-0004"));

    expect(pressBack().prevented).toBe(false);
    expect(alerts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A4-custodia-01 — AN ADDRESS WITH NO ACCOUNT IS A DIFFERENT OUTCOME
// ---------------------------------------------------------------------------

describe("a recipient who has no account", () => {
  it("tells the sender what happens instead of navigating away silently", async () => {
    // The app fires no invitation — the web's magic link lands in a browser, so
    // the native write deliberately does not send one. Both outcomes used to
    // look identical from here: a proposal in somebody's inbox, and a proposal
    // nobody has been told about.
    const onSent = jest.fn();
    const answer = ok("PTR-NEW0-0002");
    mockSend.mockResolvedValue({
      ...answer,
      payload: { ...answer.payload, recipientNeedsInvite: true },
    });
    renderScreen(onSent);

    fireEvent.changeText(emailField(), "sincuenta@example.com");
    fireEvent.press(screen.getByText("Herencia"));
    fireEvent.press(screen.getByText("Enviar la propuesta"));

    await waitFor(() =>
      expect(screen.getByText("Esa persona todavía no tiene cuenta en miMAR")).toBeTruthy(),
    );
    expect(screen.getByText(/Avisale vos/)).toBeTruthy();
    // It did NOT walk off to the proposal on its own.
    expect(onSent).not.toHaveBeenCalled();

    // …and the way there is still one tap.
    fireEvent.press(screen.getByText("Ver la propuesta"));
    expect(onSent).toHaveBeenCalledWith("PTR-NEW0-0002");
  });

  it("goes straight through when the address DOES have an account", async () => {
    // The control: the new arm must not swallow the ordinary success.
    const onSent = jest.fn();
    mockSend.mockResolvedValue(ok("PTR-NEW0-0003"));
    renderScreen(onSent);

    fireEvent.changeText(emailField(), "vecina@example.com");
    fireEvent.press(screen.getByText("Herencia"));
    fireEvent.press(screen.getByText("Enviar la propuesta"));

    await waitFor(() => expect(onSent).toHaveBeenCalledWith("PTR-NEW0-0003"));
    expect(screen.queryByText("Esa persona todavía no tiene cuenta en miMAR")).toBeNull();
  });
});
