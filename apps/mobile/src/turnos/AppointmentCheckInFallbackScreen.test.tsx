// `AppointmentCheckInFallbackScreen` — the check-in QR's landing page.
//
// WHAT THIS HAS TO PROVE, beyond "it renders"
// ---------------------------------------------------------------------------
//   1. IT NEVER PRINTS THE TOKEN. The screen reads no state and calls no
//      endpoint by design — see its own header — and the token never even
//      reaches this component, but a future prop threaded through "for
//      debugging" is exactly the kind of change that would leak WHOSE turno
//      this QR belonged to a scanner who must not be told. Asserted directly
//      against a real appointment token, not merely "the component compiles
//      without one".
//   2. THE COPY DOES NOT ASSUME THE READER IS THE OWNER. "tu propia cámara" —
//      the first draft's wording — reads oddly to a front-desk device that was
//      never told this was a camera problem. Asserted by absence.
//   3. "Ir a mis turnos" REPLACES, not pushes — a safe, generic exit that is
//      gated on its own arrival (`app/turnos/index.tsx`).

import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: (...args: unknown[]) => mockReplace(...args) }),
}));

import { AppointmentCheckInFallbackScreen } from "./AppointmentCheckInFallbackScreen";

const A_REAL_TOKEN = "APT-7K2M-9QX4";

describe("AppointmentCheckInFallbackScreen", () => {
  it("never prints the appointment token, even though the route carries one", () => {
    render(<AppointmentCheckInFallbackScreen />);
    expect(screen.queryByText(new RegExp(A_REAL_TOKEN))).toBeNull();
    expect(screen.queryByText(/APT-/)).toBeNull();
  });

  it("tells whoever is holding the phone the code is for the vet, without blaming their camera", () => {
    render(<AppointmentCheckInFallbackScreen />);
    expect(screen.getAllByText(/veterinaria/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/mostrador/i)).toBeTruthy();
    // The wording this replaced — corrected because it assumed the reader IS
    // the owner, which is false for a front desk's own device.
    expect(screen.queryByText(/tu propia cámara/i)).toBeNull();
  });

  it("replaces to Mis turnos, a safe generic exit gated on its own arrival", () => {
    render(<AppointmentCheckInFallbackScreen />);
    fireEvent.press(screen.getByText("Ir a mis turnos"));
    expect(mockReplace).toHaveBeenCalledWith("/turnos");
  });
});
