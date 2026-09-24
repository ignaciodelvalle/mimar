// @vitest-environment jsdom
//
// ExportFormClient's "slice" and "format" are uncontrolled checkbox/radio
// groups whose defaultChecked (bare boolean or absent) is STATIC — a
// rejected submit falls each back to that fixed value, discarding whichever
// slices/format were actually picked.
//
// Real submit via `form.requestSubmit()` — see
// __tests__/react19-form-reset-contract.test.tsx for why a dispatched event
// does not exercise React 19's reset.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateExportMock = vi.fn();
vi.mock("./actions", () => ({
  generateExportAction: (...args: unknown[]) => generateExportMock(...args),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/gob/PeriodPicker", () => ({
  PeriodPicker: () => null,
}));

vi.mock("@/components/gob/JurisdictionSwitcher", () => ({
  JurisdictionSwitcher: () => null,
}));

import { ExportFormClient } from "./ExportFormClient";

beforeEach(() => {
  generateExportMock.mockReset();
});

afterEach(cleanup);

describe("<ExportFormClient> — survives the React 19 post-error reset", () => {
  it("keeps the picked slices and format after a rejected submit", async () => {
    generateExportMock.mockResolvedValue({
      ok: false,
      error: "No se pudo generar la exportación.",
    });
    const { container } = render(
      <ExportFormClient
        allowedProvinces={[]}
        localities={[]}
        period="30d"
        from=""
        to=""
        province=""
        locality=""
      />,
    );

    const events = container.querySelector(
      'input[name="slice"][value="events"]',
    ) as HTMLInputElement;
    const jsonFormat = container.querySelector(
      'input[name="format"][value="json"]',
    ) as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.click(events);
    fireEvent.click(jsonFormat);
    expect(events.checked).toBe(true);
    expect(jsonFormat.checked).toBe(true);

    form.requestSubmit();
    await waitFor(() => expect(generateExportMock).toHaveBeenCalled());
    await screen.findByText("No se pudo generar la exportación.");

    expect(
      (container.querySelector('input[name="slice"][value="events"]') as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (container.querySelector('input[name="format"][value="json"]') as HTMLInputElement).checked,
    ).toBe(true);
  });
});
