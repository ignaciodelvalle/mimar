// @vitest-environment jsdom
//
// PhysicalCredentialChannelsForm's printableQr and both channels' `enabled`
// checkboxes were controlled with checked=/onChange= — the exact pair
// react19-form-reset-contract.test.tsx measures as vulnerable regardless
// (falls back to its MOUNT value). `notes` had a STATIC defaultValue.
//
// Real submit via `form.requestSubmit()` — see that file for why a
// dispatched event does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actionMock = vi.fn();
vi.mock("@/app/actions/business-rules", () => ({
  createBusinessRuleAction: (...args: unknown[]) => actionMock(...args),
  updateBusinessRuleAction: Object.assign(vi.fn(), {
    bind:
      (_thisArg: unknown, ruleId: string) =>
      (...args: unknown[]) =>
        actionMock(ruleId, ...args),
  }),
}));

vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: vi.fn(),
}));

import { PhysicalCredentialChannelsForm } from "./PhysicalCredentialChannelsForm";

const BASE_PROPS = {
  mode: "create" as const,
  country: "AR",
  province: "AR-C",
  locality: "belgrano",
  base: "/gob" as const,
  initialPrintableQr: false,
  initialEngravedPlate: { enabled: false },
  initialNfcTag: { enabled: false },
  initialNotes: "",
};

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<PhysicalCredentialChannelsForm> — survives the React 19 post-error reset", () => {
  it("keeps a ticked channel checkbox and the notes after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo guardar la regla." });
    const { container } = render(<PhysicalCredentialChannelsForm {...BASE_PROPS} />);

    const printableQr = container.querySelector('input[name="printable_qr"]') as HTMLInputElement;
    const notes = container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.click(printableQr);
    expect(printableQr.checked).toBe(true);
    fireEvent.change(notes, { target: { value: "Habilitado tras acuerdo con el municipio." } });

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo guardar la regla.");

    expect(
      (container.querySelector('input[name="printable_qr"]') as HTMLInputElement).checked,
    ).toBe(true);
    expect((container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement).value).toBe(
      "Habilitado tras acuerdo con el municipio.",
    );
  });
});
