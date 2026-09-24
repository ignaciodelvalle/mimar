// @vitest-environment jsdom
//
// RequestCapabilityForm's "reason" is a bare uncontrolled field — a
// rejected submit wipes it.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionMock = vi.fn();
vi.mock("@/src/modules/organizations/actions", () => ({
  requestCapabilityAction: (...args: unknown[]) => actionMock(...args),
}));

import { RequestCapabilityForm } from "./RequestCapabilityForm";

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<RequestCapabilityForm> — survives the React 19 post-error reset", () => {
  it("keeps the typed reason after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo enviar el pedido." });
    const { container } = render(
      <RequestCapabilityForm
        capability="bite_reports"
        label="Reportar mordeduras"
        orgToken="ORG-TEST-0001"
      />,
    );

    fireEvent.click(screen.getByText("Solicitar"));

    const reason = container.querySelector('textarea[name="reason"]') as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(reason, { target: { value: "Necesitamos registrar mordeduras del barrio." } });

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo enviar el pedido.");

    expect((container.querySelector('textarea[name="reason"]') as HTMLTextAreaElement).value).toBe(
      "Necesitamos registrar mordeduras del barrio.",
    );
  });
});
