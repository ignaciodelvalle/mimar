// @vitest-environment jsdom
//
// DniVerifyForm's "dni" field had NO defaultValue at all — a rejected
// submit (a bad checksum, a number already declared elsewhere) wiped
// whatever the person had typed. Lifted to local React state (a controlled
// input survives the React 19 post-action reset on its own, per
// react19-form-reset-contract.test.tsx).
//
// Real submit via `form.requestSubmit()` — see that file for why a
// dispatched event does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const actionMock = vi.fn();
vi.mock("@/app/actions/dni-verification", () => ({
  verifyDniAction: (...args: unknown[]) => actionMock(...args),
}));

import { DniVerifyForm } from "./DniVerifyForm";

afterEach(cleanup);

describe("<DniVerifyForm> — survives the React 19 post-error reset", () => {
  it("keeps the typed DNI after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "Ese DNI ya está declarado en otra cuenta." });
    const { container } = render(<DniVerifyForm next="/cuenta" />);

    const dni = container.querySelector('input[name="dni"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(dni, { target: { value: "34567890" } });

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("Ese DNI ya está declarado en otra cuenta.");

    expect(dni.value).toBe("34567890");
  });
});
