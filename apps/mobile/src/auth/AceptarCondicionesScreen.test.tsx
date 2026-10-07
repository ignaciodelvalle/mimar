// `AceptarCondicionesScreen` — an existing account accepts the current legal
// version (2026-10-07; legal review 2026-10-02 rows P10/P11; PO decision D2 = b).
//
// WHAT THESE HAVE TO PROVE
//   1. EACH OF THE THREE BOXES IS REQUIRED ON ITS OWN, and nothing is sent until
//      all three are ticked by the person — none starts ticked.
//   2. WHAT IS SENT is the three booleans and the version THIS bundle displays,
//      written out here so a bump is a deliberate edit.
//   3. A REFUSAL IS SHOWN, and the person can still leave: the data/deletion
//      page and sign-out are on the screen.
//   4. ONCE NOTHING IS OWED THE SCREEN GETS OUT OF THE WAY, to `next` when there
//      is one.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

const mockAccept = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSignOut = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockOpenURL = jest.fn();
const mockRedirect = jest.fn();

jest.mock("expo-linking", () => ({ openURL: (...args: unknown[]) => mockOpenURL(...args) }));
jest.mock("expo-router", () => ({
  Redirect: (props: { href: unknown }) => {
    mockRedirect(props.href);
    return null;
  },
}));
jest.mock("./session-store", () => ({
  acceptLegalTerms: (...args: unknown[]) => mockAccept(...args),
  signOut: (...args: unknown[]) => mockSignOut(...args),
}));

import { AceptarCondicionesScreen } from "./AceptarCondicionesScreen";

const TOS_LABEL =
  "Leí y acepto los Términos y condiciones y la Política de privacidad, obligatorio";
const TRANSFER_LABEL =
  "Acepto que mis datos se transfieran a proveedores en Brasil y en Estados Unidos, países que no figuran en la lista argentina de países con protección adecuada de datos personales, obligatorio";
const ADULT_LABEL = "Tengo 18 años o más, obligatorio";
const ALL = [TOS_LABEL, TRANSFER_LABEL, ADULT_LABEL];

beforeEach(() => {
  mockAccept.mockReset();
  mockSignOut.mockReset();
  mockSignOut.mockResolvedValue(undefined);
  mockOpenURL.mockReset();
  mockRedirect.mockReset();
});

describe("the three boxes", () => {
  it("start unticked", () => {
    render(<AceptarCondicionesScreen legalAcceptancePending />);
    for (const label of ALL) {
      expect(screen.getByLabelText(label).props.accessibilityState.checked).toBe(false);
    }
  });

  it.each([
    ["the Terms box", TOS_LABEL],
    ["the transfer box", TRANSFER_LABEL],
    ["the 18+ box", ADULT_LABEL],
  ])("leaving %s unticked sends nothing", (_name, missing) => {
    render(<AceptarCondicionesScreen legalAcceptancePending />);
    for (const label of ALL) if (label !== missing) fireEvent.press(screen.getByLabelText(label));
    fireEvent.press(screen.getByText("Aceptar y continuar"));
    expect(mockAccept).not.toHaveBeenCalled();
  });
});

describe("sending", () => {
  it("sends the three acceptances and the version this bundle displays", async () => {
    mockAccept.mockResolvedValue({ ok: true });
    render(<AceptarCondicionesScreen legalAcceptancePending />);
    for (const label of ALL) fireEvent.press(screen.getByLabelText(label));
    fireEvent.press(screen.getByText("Aceptar y continuar"));

    await waitFor(() => expect(mockAccept).toHaveBeenCalledTimes(1));
    expect(mockAccept.mock.calls[0]?.[0]).toEqual({
      tosAccepted: true,
      transferAccepted: true,
      adultDeclared: true,
      legalVersion: "2026-10-07",
    });
  });

  it("shows the store's refusal and keeps the boxes as the person left them", async () => {
    mockAccept.mockResolvedValue({ ok: false, message: "No pudimos guardar tu aceptación." });
    render(<AceptarCondicionesScreen legalAcceptancePending />);
    for (const label of ALL) fireEvent.press(screen.getByLabelText(label));
    fireEvent.press(screen.getByText("Aceptar y continuar"));

    await waitFor(() => expect(screen.getByText("No pudimos guardar tu aceptación.")).toBeTruthy());
    expect(screen.getByLabelText(TRANSFER_LABEL).props.accessibilityState.checked).toBe(true);
  });
});

describe("the way out", () => {
  it("offers the data and deletion page in the browser, and sign-out", () => {
    render(<AceptarCondicionesScreen legalAcceptancePending />);
    fireEvent.press(screen.getByText("Mis datos y eliminar mi cuenta"));
    expect(String(mockOpenURL.mock.calls[0]?.[0])).toContain("/cuenta/privacidad");

    fireEvent.press(screen.getByText("Cerrar sesión"));
    expect(mockSignOut).toHaveBeenCalledWith("/aceptar-condiciones");
  });
});

describe("once nothing is owed", () => {
  it("redirects to the pet list by default", () => {
    render(<AceptarCondicionesScreen legalAcceptancePending={false} />);
    expect(mockRedirect).toHaveBeenCalledWith("/mascotas");
  });

  it("redirects to the interrupted destination when there is one", () => {
    render(
      <AceptarCondicionesScreen legalAcceptancePending={false} next="/cuidado/GRT-ABCD-2345" />,
    );
    expect(mockRedirect).toHaveBeenCalledWith("/cuidado/GRT-ABCD-2345");
  });
});

describe("what changed", () => {
  it("lists every change since the version the account accepted", () => {
    render(<AceptarCondicionesScreen legalAcceptancePending acceptedLegalVersion="2026-07-23" />);
    expect(
      screen.getByText(
        "· La política de privacidad nombra a cada proveedor que procesa tus datos y en qué país está.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("· Te pedimos que confirmes que tenés 18 años o más.")).toBeTruthy();
  });

  it("lists only the newer changes for an account on the previous version", () => {
    render(<AceptarCondicionesScreen legalAcceptancePending acceptedLegalVersion="2026-09-24" />);
    expect(screen.queryByText(/nombra a cada proveedor/)).toBeNull();
    expect(screen.getByText("· Te pedimos que confirmes que tenés 18 años o más.")).toBeTruthy();
  });
});
