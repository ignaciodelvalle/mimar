// `IngresoScreen` — moved out of `app/ingreso.tsx` (F-5, 2026-09-24 review) so
// this app's login form can finally be render-tested. `app/` sits outside
// jest's `roots`, so this file is the first coverage this screen has ever had.
//
// WHAT THESE HAVE TO PROVE
// ---------------------------------------------------------------------------
//   1. THE SERVER'S SENTENCE IS RENDERED AS-IS on a failed sign-in — the
//      enumeration-safety property the screen's own header states.
//   2. A SUCCESSFUL SIGN-IN REDIRECTS via the session flipping to `signed-in`,
//      not via a destination this screen names itself.
//   3. THE SESSION-END REASON is shown when there is one, and NOT for a
//      deliberate sign-out (`reason: null`).

import type { SessionState } from "./session-store";

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockPush = jest.fn();
const mockSignIn = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("expo-router", () => ({
  Redirect: ({ href }: { href: string }) => `REDIRECT:${href}`,
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));

const mockSession: { state: SessionState } = {
  state: { phase: "signed-out", reason: "user_action" },
};

jest.mock("./useSession", () => ({ useSession: () => mockSession.state }));

jest.mock("./session-store", () => ({
  signIn: (...args: unknown[]) => mockSignIn(...args),
  sessionEndMessage: (reason: string) =>
    reason === "user_action" ? null : `sesión terminada: ${reason}`,
}));

import { IngresoScreen } from "./IngresoScreen";

beforeEach(() => {
  mockPush.mockReset();
  mockSignIn.mockReset();
  mockSession.state = { phase: "signed-out", reason: "user_action" };
});

describe("IngresoScreen", () => {
  it("uses the web's own copy for the heading and the CTA", () => {
    render(<IngresoScreen />);
    // "Iniciar sesión" names both the heading and the submit button — the
    // button is asserted by ROLE, same as every press below, so this stays
    // unambiguous.
    expect(screen.getAllByText("Iniciar sesión")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Iniciar sesión" })).toBeOnTheScreen();
    expect(screen.getByText("Hola de nuevo")).toBeOnTheScreen();
  });

  it("shows nothing for a deliberate sign-out — telling somebody who just pressed it is noise", () => {
    mockSession.state = { phase: "signed-out", reason: "user_action" };
    render(<IngresoScreen />);
    expect(screen.queryByText(/sesión terminada/)).toBeNull();
  });

  it("shows the session-end reason for an INVOLUNTARY end", () => {
    mockSession.state = { phase: "signed-out", reason: "auth_expired" };
    render(<IngresoScreen />);
    expect(screen.getByText("sesión terminada: auth_expired")).toBeOnTheScreen();
  });

  it("renders the server's failure sentence verbatim, and nothing of its own", async () => {
    mockSignIn.mockResolvedValue({ ok: false, message: "Revisá tu correo y tu contraseña." });
    render(<IngresoScreen />);

    fireEvent.changeText(
      screen.getByLabelText("Correo electrónico, obligatorio"),
      "ana@example.com",
    );
    fireEvent.changeText(screen.getByLabelText("Contraseña, obligatorio"), "hunter2");
    fireEvent.press(screen.getByRole("button", { name: "Iniciar sesión" }));

    await waitFor(() => expect(mockSignIn).toHaveBeenCalledWith("ana@example.com", "hunter2"));
    expect(await screen.findByText("Revisá tu correo y tu contraseña.")).toBeOnTheScreen();
  });

  it("does not route itself on success — the session flip is what redirects", async () => {
    mockSignIn.mockResolvedValue({ ok: true });
    render(<IngresoScreen />);

    fireEvent.changeText(
      screen.getByLabelText("Correo electrónico, obligatorio"),
      "ana@example.com",
    );
    fireEvent.changeText(screen.getByLabelText("Contraseña, obligatorio"), "hunter2");
    fireEvent.press(screen.getByRole("button", { name: "Iniciar sesión" }));

    await waitFor(() => expect(mockSignIn).toHaveBeenCalledTimes(1));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("a signed-in session redirects instead of showing the form", () => {
    mockSession.state = {
      phase: "signed-in",
      user: {
        id: "user-001",
        displayName: "Ana",
        role: "owner",
        accountType: "personal",
        profilePending: false,
      },
    } as SessionState;
    render(<IngresoScreen />);
    expect(screen.queryByText("Iniciar sesión")).toBeNull();
  });

  it("opens crear-cuenta and recuperar from their own links", () => {
    render(<IngresoScreen />);
    fireEvent.press(screen.getByText("¿Olvidaste tu contraseña?"));
    fireEvent.press(screen.getByText("Crear cuenta"));
    expect(mockPush).toHaveBeenCalledTimes(2);
  });

  it("shows the recovery link before anything is typed, and no email travels with it (U-3)", () => {
    render(<IngresoScreen />);
    expect(screen.getByText("¿Olvidaste tu contraseña?")).toBeOnTheScreen();
    fireEvent.press(screen.getByText("¿Olvidaste tu contraseña?"));
    expect(mockPush).toHaveBeenCalledWith("/recuperar");
  });

  it("carries the typed email into password recovery (U-3, PO decision 21A)", () => {
    render(<IngresoScreen />);
    fireEvent.changeText(
      screen.getByLabelText("Correo electrónico, obligatorio"),
      "ana@example.com",
    );
    fireEvent.press(screen.getByText("¿Olvidaste tu contraseña?"));
    expect(mockPush).toHaveBeenCalledWith("/recuperar?email=ana%40example.com");
  });
});
