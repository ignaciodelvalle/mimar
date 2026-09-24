// @vitest-environment jsdom
//
// SolicitarAccesoForm's "email" is a bare uncontrolled field — the action
// never redirects (it always shows the same message and stays on the form,
// by design: the response is identical whether or not the email matched),
// so the typed address gets wiped on every submit.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionMock = vi.fn();
vi.mock("./actions", () => ({
  solicitarAccesoDenunciaAction: (...args: unknown[]) => actionMock(...args),
}));

import { SolicitarAccesoForm } from "./SolicitarAccesoForm";

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<SolicitarAccesoForm> — survives the React 19 post-error reset", () => {
  it("keeps the typed email after the response settles", async () => {
    actionMock.mockResolvedValue({
      message: "Si el email coincide con el de la denuncia, te mandamos un enlace.",
    });
    const { container } = render(<SolicitarAccesoForm code="DEN-TEST-0001" />);

    const email = container.querySelector('input[name="email"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(email, { target: { value: "reportante@example.com" } });

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await waitFor(() =>
      expect((container.querySelector('input[name="email"]') as HTMLInputElement).value).toBe(
        "reportante@example.com",
      ),
    );
  });
});
