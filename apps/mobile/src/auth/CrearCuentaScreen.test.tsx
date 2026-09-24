// `CrearCuentaScreen` — the account half of the signup.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. NOTHING IS SENT UNTIL THE CONTRACT'S SCHEMA SAYS SO. A short password
//      gets a field sentence, not a round trip — and not one of the three
//      signups per minute this caller's IP is allowed.
//   2. THE 201 WITH NO SESSION IS A SUCCESS, and the panel it produces says
//      NOTHING about why. That is the account-enumeration masquerade (audit
//      28-#3) reaching the screen intact; copy that helpfully said "esa cuenta
//      ya existe" would rebuild the oracle on the phone.
//   3. THE SIGNED-IN ARM DOES NOT ROUTE ITSELF. The store flips the session and
//      the route's redirect fires; this screen names no destination, because
//      `useGate` is what decides that a brand-new account goes to
//      identidad-pendiente.
//   4. THE LEGAL CHECKBOX IS A CHECKBOX to a screen reader, starts unchecked,
//      and gates the submit.
//   5. THE SERVER'S REFUSALS ARE RENDERED AS-IS, including the one that matters
//      most here — `rate_limited`, which this screen can reach three submits
//      into a minute.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockSignUp = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockOpenURL = jest.fn();

jest.mock("expo-linking", () => ({ openURL: (...args: unknown[]) => mockOpenURL(...args) }));

jest.mock("./session-store", () => ({
  signUp: (...args: unknown[]) => mockSignUp(...args),
}));

import { CrearCuentaScreen } from "./CrearCuentaScreen";

const TOS_LABEL =
  "Leí y acepto los Términos y condiciones y la Política de privacidad, obligatorio";

const noop = () => {};

function renderScreen(onGoToSignIn: () => void = noop) {
  return render(<CrearCuentaScreen onGoToSignIn={onGoToSignIn} />);
}

/**
 * Fill the form. `accept` false leaves the legal checkbox alone.
 *
 * The three names carry ", obligatorio" (CA-M1, finding A1-entrada-07): these
 * fields name their own `accessibilityLabel`, which the kit used to let REPLACE
 * the derived name — so the whole signup form announced no requiredness at all.
 */
function fill(overrides: { password?: string; confirmPassword?: string; accept?: boolean } = {}) {
  const password = overrides.password ?? "unaClaveLarga";
  fireEvent.changeText(screen.getByLabelText("Correo electrónico, obligatorio"), "ana@example.com");
  fireEvent.changeText(screen.getByLabelText("Contraseña, obligatorio"), password);
  fireEvent.changeText(
    screen.getByLabelText("Repetir contraseña, obligatorio"),
    overrides.confirmPassword ?? password,
  );
  if (overrides.accept !== false) fireEvent.press(screen.getByLabelText(TOS_LABEL));
}

beforeEach(() => {
  mockSignUp.mockReset();
  mockOpenURL.mockReset();
});

describe("the form", () => {
  it("uses the web's own copy for the heading, the step and the CTA", () => {
    renderScreen();
    expect(screen.getByText("Crear cuenta")).toBeTruthy();
    expect(screen.getByText("Creá la libreta digital de tu mascota")).toBeTruthy();
    expect(screen.getByText("Paso 1 de 2")).toBeTruthy();
    expect(screen.getByText("Mínimo 8 caracteres.")).toBeTruthy();
    expect(screen.getByText("Continuar")).toBeTruthy();
  });

  it("keeps the Mi Argentina promise the web makes on this page, disabled", () => {
    // Invariant #6 — federation is the premise. An app that omits the promise
    // makes the roadmap look like it has two different futures.
    renderScreen();
    const stub = screen.getByText("Conectar con Mi Argentina (próximamente)");
    expect(stub).toBeTruthy();
  });

  it("says the identity step is coming BEFORE it happens, and that it is in the app", () => {
    // Arriving at identidad-pendiente unannounced reads like the signup failed.
    renderScreen();
    expect(screen.getByText(/te vamos a pedir tu nombre y tu apellido/)).toBeTruthy();
    // AND IT NO LONGER SENDS ANYBODY TO THE WEB (PO 2026-09-05). This callout
    // used to end "Ese paso se hace en la web por ahora", which was true until the
    // identity door landed and is now an instruction to leave the app for a step
    // the next screen performs.
    expect(screen.queryByText(/se hace en la web/)).toBeNull();
  });

  it("opens each legal document in the browser", () => {
    renderScreen();
    fireEvent.press(screen.getByText("Términos y condiciones"));
    fireEvent.press(screen.getByText("Política de privacidad"));
    expect(mockOpenURL.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining("/terminos"),
      expect.stringContaining("/privacidad"),
    ]);
  });
});

describe("the legal checkbox", () => {
  it("announces itself as a checkbox, starts unchecked, and gates the submit", () => {
    renderScreen();
    const box = screen.getByLabelText(TOS_LABEL);
    expect(box.props.accessibilityState.checked).toBe(false);

    fill({ accept: false });
    fireEvent.press(screen.getByText("Continuar"));
    expect(mockSignUp).not.toHaveBeenCalled();

    fireEvent.press(box);
    expect(screen.getByLabelText(TOS_LABEL).props.accessibilityState.checked).toBe(true);
  });
});

describe("validation before the network", () => {
  it("refuses a short password with a FIELD sentence and never calls the API", async () => {
    renderScreen();
    fill({ password: "corta" });
    fireEvent.press(screen.getByText("Continuar"));

    await waitFor(() =>
      expect(screen.getByText("La contraseña debe tener al menos 8 caracteres.")).toBeTruthy(),
    );
    // The signup budget is 3/min per IP. A refusal the app can reach on its own
    // must not spend one.
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it("refuses a mismatch, in the contract's order", async () => {
    renderScreen();
    fill({ password: "unaClaveLarga", confirmPassword: "otraClaveLarga" });
    fireEvent.press(screen.getByText("Continuar"));

    await waitFor(() => expect(screen.getByText("Las contraseñas no coinciden.")).toBeTruthy());
    expect(mockSignUp).not.toHaveBeenCalled();
  });
});

describe("sending", () => {
  it("hands the store exactly the four fields the endpoint takes", async () => {
    mockSignUp.mockResolvedValue({ ok: true, signedIn: true });
    renderScreen();
    fill();
    fireEvent.press(screen.getByText("Continuar"));

    await waitFor(() => expect(mockSignUp).toHaveBeenCalledTimes(1));
    expect(mockSignUp.mock.calls[0]?.[0]).toEqual({
      email: "ana@example.com",
      password: "unaClaveLarga",
      confirmPassword: "unaClaveLarga",
      tosAccepted: true,
    });
  });

  it("does NOT route itself on the signed-in arm — the gate decides that", async () => {
    const onGoToSignIn = jest.fn();
    mockSignUp.mockResolvedValue({ ok: true, signedIn: true });
    renderScreen(onGoToSignIn);
    fill();
    fireEvent.press(screen.getByText("Continuar"));

    await waitFor(() => expect(mockSignUp).toHaveBeenCalledTimes(1));
    // The form is still what is on screen — and still BUSY, because the busy
    // flag is deliberately never cleared on this arm. The store flipped the
    // session and the ROUTE's redirect is what unmounts this. A screen that
    // navigated here would be re-deciding what useGate decides for every other
    // screen, and would send a brand-new (profile-pending) account to the wrong
    // place.
    expect(screen.getByText("Creando la cuenta…")).toBeTruthy();
    // NOT the no-session panel either: `signedIn: true` and `signedIn: false`
    // are different outcomes of the same 201 and must not collapse.
    expect(screen.queryByText("Tu cuenta está lista")).toBeNull();
    expect(onGoToSignIn).not.toHaveBeenCalled();
  });

  it("stays disabled after a successful submit, so a second one cannot race it", async () => {
    mockSignUp.mockResolvedValue({ ok: true, signedIn: true });
    renderScreen();
    fill();
    fireEvent.press(screen.getByText("Continuar"));

    await waitFor(() => expect(screen.getByText("Creando la cuenta…")).toBeTruthy());
    fireEvent.press(screen.getByText("Creando la cuenta…"));
    expect(mockSignUp).toHaveBeenCalledTimes(1);
  });
});

describe("the 201 that carries no session", () => {
  it("is a SUCCESS, and points at ingreso without naming a cause", async () => {
    mockSignUp.mockResolvedValue({ ok: true, signedIn: false });
    renderScreen();
    fill();
    fireEvent.press(screen.getByText("Continuar"));

    await waitFor(() => expect(screen.getByText("Tu cuenta está lista")).toBeTruthy());
    // Two facts and no cause: READY, and the door is IN THIS APP. A panel that
    // only said "ya podés ingresar" read as a rejection after "Crear cuenta",
    // and the week's stale bundle was already sending testers to a browser.
    expect(screen.getByText(/Ya podés ingresar desde esta misma app/)).toBeTruthy();

    // THE ORACLE CHECK. `session: null` means "the email already has an
    // account" OR "a new one is waiting to be confirmed", and the server keeps
    // the two byte-identical on purpose. Any copy that leaned either way would
    // undo that from the client side, which nothing on the server would notice.
    const forbidden = [/ya existe/i, /ya está registrad/i, /esa cuenta/i, /confirmá tu correo/i];
    for (const pattern of forbidden) {
      expect(screen.queryByText(pattern)).toBeNull();
    }
  });

  it("hands the person to sign-in from that panel", async () => {
    const onGoToSignIn = jest.fn();
    mockSignUp.mockResolvedValue({ ok: true, signedIn: false });
    renderScreen(onGoToSignIn);
    fill();
    fireEvent.press(screen.getByText("Continuar"));

    await waitFor(() => expect(screen.getByText("Ir a iniciar sesión")).toBeTruthy());
    fireEvent.press(screen.getByText("Ir a iniciar sesión"));
    expect(onGoToSignIn).toHaveBeenCalledTimes(1);
  });
});

describe("the server's refusals", () => {
  it("renders the store's message and lets the person try again", async () => {
    // `rate_limited` is the one this screen can reach on its own: the budget is
    // 3/min · 15/hr per IP, spent server-side inside the shared use-case, and
    // there is no client-side counter to invent beside it.
    mockSignUp.mockResolvedValue({
      ok: false,
      message: "Demasiadas consultas. Probá de nuevo en 30 segundos.",
    });
    renderScreen();
    fill();
    fireEvent.press(screen.getByText("Continuar"));

    await waitFor(() =>
      expect(screen.getByText("Demasiadas consultas. Probá de nuevo en 30 segundos.")).toBeTruthy(),
    );
    // Re-enabled, unlike the success path: a refusal is something to act on.
    expect(screen.getByText("Continuar")).toBeTruthy();
  });

  it("keeps the typed email after a refusal", async () => {
    // React 19's form auto-reset is what makes this worth asserting on the WEB
    // (bug #46). Here the state is ours and cannot reset itself — which is
    // exactly why an accidental `setDraft(EMPTY_SIGNUP_DRAFT)` in the failure
    // arm would be invisible without this line.
    mockSignUp.mockResolvedValue({ ok: false, message: "No pudimos crear la cuenta." });
    renderScreen();
    fill();
    fireEvent.press(screen.getByText("Continuar"));

    await waitFor(() => expect(screen.getByText("No pudimos crear la cuenta.")).toBeTruthy());
    expect(screen.getByLabelText("Correo electrónico, obligatorio").props.value).toBe(
      "ana@example.com",
    );
  });
});

describe("the accessible names — CA-M1 / finding A1-entrada-07", () => {
  it("announces requiredness on all three fields, though each names its own label", () => {
    // The kit spread `...rest` AFTER the name it derived, so an explicit
    // `accessibilityLabel` — which these three pass, and five more sites across
    // signup and sign-in — silently took ", obligatorio" with it. A screen
    // reader on this form announced three optional-sounding fields, all of
    // which the submit gates on.
    renderScreen();
    expect(screen.getByLabelText("Correo electrónico, obligatorio")).toBeTruthy();
    expect(screen.getByLabelText("Contraseña, obligatorio")).toBeTruthy();
    expect(screen.getByLabelText("Repetir contraseña, obligatorio")).toBeTruthy();
    // The bare names are GONE, not merely joined by the suffixed ones.
    expect(screen.queryByLabelText("Correo electrónico")).toBeNull();
  });
});
