// @vitest-environment jsdom
//
// MpfExportFormatForm's "format" select was genuinely controlled
// (`value=`+`onChange=`) — the exact shape react19-form-reset-contract.test.tsx
// measures as unsafe regardless: a rejected submit falls a controlled select
// back to its first option. Fixed the same way (defaultValue + a key from
// kept()), but NOT mutation-tested here: MPF_EXPORT_FORMATS has exactly one
// value today (lib/domain/business-rules-defaults.ts), so "falls back to the
// first option" is unobservable until a second format exists — the fix is
// forward-looking, per the file's own docblock. `notes` had a STATIC
// defaultValue and IS observably, mutation-provenly broken; this test covers
// that.
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

import { MpfExportFormatForm } from "./MpfExportFormatForm";

const BASE_PROPS = {
  mode: "create" as const,
  country: "AR",
  province: "AR-C",
  locality: "belgrano",
  base: "/gob" as const,
  initialFormat: "estandar_nacional" as const,
  initialNotes: "",
};

beforeEach(() => {
  actionMock.mockReset();
});

afterEach(cleanup);

describe("<MpfExportFormatForm> — survives the React 19 post-error reset", () => {
  it("keeps the typed notes after a rejected submit", async () => {
    actionMock.mockResolvedValue({ error: "No se pudo guardar la regla." });
    const { container } = render(<MpfExportFormatForm {...BASE_PROPS} />);

    const notes = container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(notes, { target: { value: "A la espera de la segunda variante." } });

    form.requestSubmit();
    await waitFor(() => expect(actionMock).toHaveBeenCalled());
    await screen.findByText("No se pudo guardar la regla.");

    expect((container.querySelector('textarea[name="notes"]') as HTMLTextAreaElement).value).toBe(
      "A la espera de la segunda variante.",
    );
  });
});
