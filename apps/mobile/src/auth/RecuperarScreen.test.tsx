// `RecuperarScreen` — password recovery without leaving the app.
//
// WHAT THESE HAVE TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. THE SCREEN NEVER LEARNS WHETHER THE ACCOUNT EXISTS, and therefore never
//      says. The request half always advances to the code step, and the copy it
//      shows is the "si existe una cuenta" hedge — the same masquerade audit
//      28-#3 bought on signup, reaching a second screen intact. A screen that
//      advanced only for a known address WOULD BE the oracle, so the assertion is
//      that it advances on a success it was told nothing about.
//   2. THE CODE IS SPENT AFTER THE PASSWORD IS CHECKED, NOT BEFORE. A recovery
//      code is single-use; validating the confirmation only after `verifyOtp` has
//      consumed it burns the code on a typo, on a flow that allows five mails an
//      hour to that address. This is the ordering assertion, and it is checked at
//      the boundary the screen owns — what it hands `resetPasswordWithCode`.
//   3. EVERY REFUSAL IS THE STORE'S SENTENCE, RENDERED AS-IS. The screen composes
//      no copy of its own for a failure, for `ingreso.tsx`'s reason.
//   4. THE COPY IS es-AR AND THE WEB'S WHERE THE SURFACE IS SHARED.
//   5. THE BROWSER BRIDGE IS STILL THERE while the Supabase template gate is
//      open, and it opens the WEB recovery page — not a `mimar://` url.
//
// The screen lives under `src/` rather than in `app/` precisely so this file can
// exist: this app's jest suite is anchored at `<rootDir>/src`.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockRequestPasswordReset = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockResetPasswordWithCode = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockOpenURL = jest.fn();

jest.mock("expo-linking", () => ({ openURL: (...args: unknown[]) => mockOpenURL(...args) }));

jest.mock("./session-store", () => ({
  requestPasswordReset: (...args: unknown[]) => mockRequestPasswordReset(...args),
  resetPasswordWithCode: (...args: unknown[]) => mockResetPasswordWithCode(...args),
}));

import { RecuperarScreen } from "./RecuperarScreen";

const noop = () => {};

function renderScreen(onGoToSignIn: () => void = noop) {
  return render(<RecuperarScreen onGoToSignIn={onGoToSignIn} />);
}

/** Ask for a code and wait for the second step to appear. */
async function reachCodeStep(email = "ana@example.com") {
  mockRequestPasswordReset.mockResolvedValue({ ok: true });
  fireEvent.changeText(screen.getByLabelText("Correo electrónico, obligatorio"), email);
  fireEvent.press(screen.getByText("Enviar código"));
  await waitFor(() => expect(screen.getByLabelText("Código, obligatorio")).toBeTruthy());
}

function fillRedemption(overrides: { code?: string; password?: string; confirm?: string } = {}) {
  const password = overrides.password ?? "unaClaveLarga";
  fireEvent.changeText(screen.getByLabelText("Código, obligatorio"), overrides.code ?? "123456");
  fireEvent.changeText(screen.getByLabelText("Nueva contraseña, obligatorio"), password);
  fireEvent.changeText(
    screen.getByLabelText("Repetir contraseña, obligatorio"),
    overrides.confirm ?? password,
  );
}

beforeEach(() => {
  mockRequestPasswordReset.mockReset();
  mockResetPasswordWithCode.mockReset();
  mockOpenURL.mockReset();
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

describe("the copy", () => {
  it("uses the web's own heading for the shared surface", () => {
    renderScreen();
    expect(screen.getByText("Recuperar contraseña")).toBeTruthy();
    expect(
      screen.getByText(
        "Ingresá tu correo y te enviamos un código para crear una nueva contraseña.",
      ),
    ).toBeTruthy();
  });

  it("uses the web's password-field copy on the redemption step", async () => {
    renderScreen();
    await reachCodeStep();
    // `UpdatePasswordForm`'s literal strings — two surfaces, one act, one set of
    // words.
    expect(screen.getByLabelText("Nueva contraseña, obligatorio")).toBeTruthy();
    expect(screen.getByLabelText("Repetir contraseña, obligatorio")).toBeTruthy();
    expect(screen.getByText("Mínimo 8 caracteres.")).toBeTruthy();
  });

  it("is written in es-AR, with voseo and no imported Spanish", () => {
    renderScreen();
    // The whole point of an es-AR product is that it does not read as translated.
    // "Ingresá" is the tell; "Ingresa" / "Introduce tu correo" would be the
    // regression this catches.
    const subtitle = screen.getByText(
      "Ingresá tu correo y te enviamos un código para crear una nueva contraseña.",
    );
    expect(subtitle).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The request half — the oracle that must not appear
// ---------------------------------------------------------------------------

describe("asking for a code", () => {
  it("advances to the code step on a success it was told nothing about", async () => {
    renderScreen();
    await reachCodeStep();
    // The server answered 202 and said nothing about the address. Advancing ONLY
    // for a known address is what an oracle looks like from the outside, so the
    // assertion is that it advances at all.
    expect(screen.getByText("Cambiar contraseña")).toBeTruthy();
  });

  it("shows the hedged copy and never claims an account exists", async () => {
    renderScreen();
    await reachCodeStep();
    expect(
      screen.getByText(
        "Si existe una cuenta con ese correo, te enviamos un código de 6 dígitos. Revisá también tu carpeta de spam.",
      ),
    ).toBeTruthy();
    // The words a helpful screen would reach for, and must not.
    expect(screen.queryByText(/no encontramos esa cuenta/i)).toBeNull();
    expect(screen.queryByText(/ya existe/i)).toBeNull();
  });

  it("trims the address before sending it", async () => {
    renderScreen();
    mockRequestPasswordReset.mockResolvedValue({ ok: true });
    fireEvent.changeText(screen.getByLabelText("Correo electrónico, obligatorio"), "  ana@x.ar  ");
    fireEvent.press(screen.getByText("Enviar código"));
    await waitFor(() => expect(mockRequestPasswordReset).toHaveBeenCalledWith("ana@x.ar"));
  });

  it("renders the store's refusal verbatim and stays on the first step", async () => {
    renderScreen();
    mockRequestPasswordReset.mockResolvedValue({
      ok: false,
      message: "Demasiadas consultas. Probá de nuevo en 30 segundos.",
    });
    fireEvent.changeText(screen.getByLabelText("Correo electrónico, obligatorio"), "ana@x.ar");
    fireEvent.press(screen.getByText("Enviar código"));

    await waitFor(() =>
      expect(screen.getByText("Demasiadas consultas. Probá de nuevo en 30 segundos.")).toBeTruthy(),
    );
    // A 429 must not advance: there is no code coming.
    expect(screen.queryByLabelText("Código, obligatorio")).toBeNull();
  });

  it("does not send an empty address", () => {
    renderScreen();
    fireEvent.press(screen.getByText("Enviar código"));
    expect(mockRequestPasswordReset).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The redemption half
// ---------------------------------------------------------------------------

describe("redeeming the code", () => {
  it("hands the store the address it already holds, so it is never re-typed", async () => {
    renderScreen();
    await reachCodeStep("ana@example.com");
    mockResetPasswordWithCode.mockResolvedValue({ ok: true });
    fillRedemption();
    fireEvent.press(screen.getByText("Cambiar contraseña"));

    // `verifyOtp` needs the address as well as the code — a six-digit code is not
    // globally unique — and asking for it twice is how a two-route split would
    // have paid for itself.
    await waitFor(() =>
      expect(mockResetPasswordWithCode).toHaveBeenCalledWith({
        email: "ana@example.com",
        code: "123456",
        password: "unaClaveLarga",
        confirmPassword: "unaClaveLarga",
      }),
    );
  });

  it("passes BOTH passwords through, so the code is not spent on a typo", async () => {
    renderScreen();
    await reachCodeStep();
    mockResetPasswordWithCode.mockResolvedValue({
      ok: false,
      message: "Las contraseñas no coinciden.",
    });
    fillRedemption({ password: "unaClaveLarga", confirm: "otraDistinta" });
    fireEvent.press(screen.getByText("Cambiar contraseña"));

    // THE ORDERING ASSERTION, at the boundary this screen owns. The mismatch is
    // decided by `resetPasswordWithCode` BEFORE it calls `verifyOtp`, which is
    // only possible because the screen hands over both fields rather than
    // pre-collapsing them into one. A screen that compared them itself and sent
    // one would make that ordering unobservable from here.
    await waitFor(() =>
      expect(mockResetPasswordWithCode).toHaveBeenCalledWith(
        expect.objectContaining({ password: "unaClaveLarga", confirmPassword: "otraDistinta" }),
      ),
    );
    expect(screen.getByText("Las contraseñas no coinciden.")).toBeTruthy();
  });

  it("renders the store's single sentence for every redemption failure", async () => {
    renderScreen();
    await reachCodeStep();
    mockResetPasswordWithCode.mockResolvedValue({
      ok: false,
      message: "El código no es válido o ya venció. Pedí uno nuevo y volvé a intentar.",
    });
    fillRedemption();
    fireEvent.press(screen.getByText("Cambiar contraseña"));

    await waitFor(() =>
      expect(
        screen.getByText("El código no es válido o ya venció. Pedí uno nuevo y volvé a intentar."),
      ).toBeTruthy(),
    );
    // The screen composes nothing of its own here. Telling a wrong code apart
    // from an address with no account would answer the question the request half
    // refuses to.
    expect(screen.queryByText(/esa cuenta/i)).toBeNull();
  });

  it("does not submit until a full code and both passwords are present", async () => {
    renderScreen();
    await reachCodeStep();
    fillRedemption({ code: "123" });
    fireEvent.press(screen.getByText("Cambiar contraseña"));
    expect(mockResetPasswordWithCode).not.toHaveBeenCalled();
  });

  it("names no destination on success — the gate decides that", async () => {
    renderScreen();
    await reachCodeStep();
    mockResetPasswordWithCode.mockResolvedValue({ ok: true });
    fillRedemption();
    fireEvent.press(screen.getByText("Cambiar contraseña"));

    await waitFor(() => expect(mockResetPasswordWithCode).toHaveBeenCalled());
    // The store flips the session and the ROUTE's redirect fires. An account that
    // recovered may still have no profile row, and `useGate` is what knows to
    // send it to `identidad-pendiente` rather than to a pet list.
    expect(screen.queryByText(/mis mascotas/i)).toBeNull();
  });

  it("clears the failed code but keeps the address when asking for another", async () => {
    renderScreen();
    await reachCodeStep("ana@example.com");
    fillRedemption({ code: "999999" });
    fireEvent.press(screen.getByText("Pedir otro código"));

    // Back on step one with the address intact — re-typing an e-mail is not part
    // of recovering from a mistyped digit.
    const emailField = screen.getByLabelText("Correo electrónico, obligatorio");
    expect(emailField.props.value).toBe("ana@example.com");

    await reachCodeStep("ana@example.com");
    // And the code box is empty: the one that was in it is the one that failed.
    expect(screen.getByLabelText("Código, obligatorio").props.value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The browser bridge
// ---------------------------------------------------------------------------

describe("the browser bridge", () => {
  it("offers the web page while the Supabase template gate is open", () => {
    renderScreen();
    expect(screen.getByText("¿El correo trae un enlace y no un código?")).toBeTruthy();
    fireEvent.press(screen.getByText("Seguir en el navegador"));

    // The WEB recovery page, on an https origin. A `mimar://` url here would be
    // an unverified scheme any installed app can claim, standing in front of
    // account recovery.
    expect(mockOpenURL).toHaveBeenCalledTimes(1);
    const opened = String(mockOpenURL.mock.calls[0]?.[0]);
    expect(opened).toMatch(/^https?:\/\//);
    expect(opened).toContain("/recuperar");
    expect(opened).not.toContain("mimar://");
  });

  it("offers a way back to sign-in without recovering", () => {
    const onGoToSignIn = jest.fn();
    renderScreen(onGoToSignIn);
    fireEvent.press(screen.getByText("Volver a iniciar sesión"));
    expect(onGoToSignIn).toHaveBeenCalledTimes(1);
  });
});

describe("the code input does not refuse a longer code (A1-refuter-M3)", () => {
  it("carries no maxLength, so a raised otp_length is not silently truncated", async () => {
    // `CODE_LENGTH`'s own docblock says the number is used "never to refuse a
    // code" — and a hard cap on the input is that refusal wearing a different
    // hat. GoTrue's `otp_length` is a dashboard setting; every shipped bundle
    // would start cutting the code it was sent, with no error anywhere.
    render(<RecuperarScreen onGoToSignIn={() => {}} />);
    await reachCodeStep();

    const field = screen.getByLabelText("Código, obligatorio");
    expect(field.props.maxLength).toBeUndefined();

    // And a longer code reaches the state, rather than being cut to six.
    fireEvent.changeText(field, "12345678");
    expect(screen.getByLabelText("Código, obligatorio").props.value).toBe("12345678");
  });
});
