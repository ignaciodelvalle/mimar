// @vitest-environment jsdom
//
// The titular's two levers over a live arrangement.
//
// "Finalizar ahora" is the spec's instant revocation: it takes access away from
// another person without their consent, immediately. That is exactly the class
// of action that must not fire on one tap, and exactly the class whose
// confirmation copy must say what actually happens — the caretaker loses
// access, and the ANIMAL does not teleport home.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const revokeAction = vi.fn();
const cancelAction = vi.fn();
vi.mock("@/src/modules/caretakers/actions", () => ({
  revokeCaretakerGrantAction: (...args: unknown[]) => revokeAction(...args),
  cancelCaretakerGrantAction: (...args: unknown[]) => cancelAction(...args),
}));

const navigateAfterActionSuccess = vi.fn();
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: (...args: unknown[]) => navigateAfterActionSuccess(...args),
}));

import { CaretakerGrantControls } from "./CaretakerGrantControls";

const BASE = {
  petPublicToken: "DIM-TEST-0001",
  petName: "Pampa",
  grantToken: "CG-abc123",
  caretakerLabel: "Ana",
};

beforeEach(() => {
  revokeAction.mockReset().mockResolvedValue({ ok: true });
  cancelAction.mockReset().mockResolvedValue({ ok: true });
  navigateAfterActionSuccess.mockReset();
});

afterEach(() => cleanup());

describe("ending an ACTIVE arrangement", () => {
  it("does not fire on the first tap", () => {
    render(<CaretakerGrantControls {...BASE} kind="active" />);
    fireEvent.click(screen.getByRole("button", { name: "Finalizar el cuidado ahora" }));
    expect(revokeAction).not.toHaveBeenCalled();
  });

  it("warns that access ends and possession does not follow", () => {
    render(<CaretakerGrantControls {...BASE} kind="active" />);
    fireEvent.click(screen.getByRole("button", { name: "Finalizar el cuidado ahora" }));
    // The whole termination design exists so this distinction survives contact
    // with a real screen.
    expect(screen.getByText(/Ana pierde el acceso/)).toBeInTheDocument();
    expect(screen.getByText(/coordinar la devolución/)).toBeInTheDocument();
  });

  it("revokes on confirmation and reloads the page's SSR state", async () => {
    render(<CaretakerGrantControls {...BASE} kind="active" />);
    fireEvent.click(screen.getByRole("button", { name: "Finalizar el cuidado ahora" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar la finalización" }));
    await waitFor(() =>
      expect(revokeAction).toHaveBeenCalledWith({
        petPublicToken: "DIM-TEST-0001",
        grantToken: "CG-abc123",
      }),
    );
    await waitFor(() => expect(navigateAfterActionSuccess).toHaveBeenCalled());
  });

  it("surfaces a refusal instead of reloading over it", async () => {
    revokeAction.mockResolvedValue({ error: "El cuidado ya fue finalizado por otra acción." });
    render(<CaretakerGrantControls {...BASE} kind="active" />);
    fireEvent.click(screen.getByRole("button", { name: "Finalizar el cuidado ahora" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar la finalización" }));
    await waitFor(() =>
      expect(screen.getByText("El cuidado ya fue finalizado por otra acción.")).toBeInTheDocument(),
    );
    expect(navigateAfterActionSuccess).not.toHaveBeenCalled();
  });
});

describe("withdrawing a PENDING invitation", () => {
  it("uses the cancel action, not the revoke one — they are different facts", async () => {
    render(<CaretakerGrantControls {...BASE} kind="pending" />);
    fireEvent.click(screen.getByRole("button", { name: "Retirar la invitación" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar el retiro" }));
    await waitFor(() =>
      expect(cancelAction).toHaveBeenCalledWith({
        petPublicToken: "DIM-TEST-0001",
        grantToken: "CG-abc123",
      }),
    );
    expect(revokeAction).not.toHaveBeenCalled();
  });

  it("never offers 'finalizar' for something that never started", () => {
    render(<CaretakerGrantControls {...BASE} kind="pending" />);
    expect(
      screen.queryByRole("button", { name: "Finalizar el cuidado ahora" }),
    ).not.toBeInTheDocument();
  });
});
