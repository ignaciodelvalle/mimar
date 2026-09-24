// @vitest-environment jsdom
//
// MicrochipRequiredForm — E5 (2026-07-21 facades harvest). The
// microchip_required rule type had a validator/default/RULE_TYPE_REGISTRY
// entry and a live migration (0150) but no write-side form, so no
// jurisdiction could ever override the hardcoded "required: true" default.
// This pins that the form renders, submits the right FormData shape, and
// navigates on success — same router-drop-cure pattern as
// NumericWindowRuleForm.interaction.test.tsx.
//
// Migration 0183 (jurisdiction-compliance WU1, spec OR5): the checkbox became
// a requirement-tier select that writes BOTH requirement_level AND the hidden
// payload.required boolean (required = tier === "mandatory") — the write-both
// contract these tests now pin.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createActionMock = vi.fn();
const updateActionMock = vi.fn();

vi.mock("@/app/actions/business-rules", () => ({
  createBusinessRuleAction: (...args: unknown[]) => createActionMock(...args),
  updateBusinessRuleAction: Object.assign((...args: unknown[]) => updateActionMock(...args), {
    bind:
      (_thisArg: unknown, ruleId: string) =>
      (...args: unknown[]) =>
        updateActionMock(ruleId, ...args),
  }),
}));

const navigateMock = vi.fn();
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: (url: string) => navigateMock(url),
}));

import { MicrochipRequiredForm } from "./MicrochipRequiredForm";

beforeEach(() => {
  createActionMock.mockReset();
  updateActionMock.mockReset();
  navigateMock.mockReset();
});

afterEach(() => {
  cleanup();
});

const BASE_PROPS = {
  mode: "create" as const,
  country: "AR",
  province: "Chaco",
  locality: null,
  base: "/gob" as const,
  initialRequired: true,
  initialNotes: "",
};

describe("<MicrochipRequiredForm>", () => {
  it("submits ruleType=microchip_required with requirement_level=mandatory AND required=on by default (write-both, initialRequired=true)", async () => {
    createActionMock.mockResolvedValue({ error: null, redirectTo: "/gob/reglas/AR/Chaco/_" });

    render(<MicrochipRequiredForm {...BASE_PROPS} />);

    expect(screen.getByRole("combobox", { name: /Nivel de exigencia/ })).toHaveValue("mandatory");

    fireEvent.click(screen.getByRole("button", { name: "Crear regla" }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith("/gob/reglas/AR/Chaco/_");
    });
    const formData = createActionMock.mock.calls[0][1] as FormData;
    expect(formData.get("ruleType")).toBe("microchip_required");
    expect(formData.get("requirement_level")).toBe("mandatory");
    expect(formData.get("required")).toBe("on");
  });

  it("selecting 'No regulado' submits required=off (parseFromForm reads that as false) — the select drives the hidden boolean", async () => {
    createActionMock.mockResolvedValue({ error: null, redirectTo: "/gob/reglas/AR/Chaco/_" });

    render(<MicrochipRequiredForm {...BASE_PROPS} />);

    fireEvent.change(screen.getByRole("combobox", { name: /Nivel de exigencia/ }), {
      target: { value: "not_regulated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear regla" }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalled();
    });
    const formData = createActionMock.mock.calls[0][1] as FormData;
    expect(formData.get("requirement_level")).toBe("not_regulated");
    expect(formData.get("required")).toBe("off");
  });

  it("derives the initial tier from the boolean for pre-0183 rows (initialRequired=false → not_regulated, required=off)", async () => {
    createActionMock.mockResolvedValue({ error: null, redirectTo: "/gob/reglas/AR/Chaco/_" });

    render(<MicrochipRequiredForm {...BASE_PROPS} initialRequired={false} />);

    expect(screen.getByRole("combobox", { name: /Nivel de exigencia/ })).toHaveValue(
      "not_regulated",
    );

    fireEvent.click(screen.getByRole("button", { name: "Crear regla" }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalled();
    });
    const formData = createActionMock.mock.calls[0][1] as FormData;
    expect(formData.get("required")).toBe("off");
  });

  it("edit mode calls updateBusinessRuleAction bound to ruleId", async () => {
    updateActionMock.mockResolvedValue({ error: null, redirectTo: "/gob/reglas/AR/Chaco/_" });

    render(<MicrochipRequiredForm {...BASE_PROPS} mode="edit" ruleId="rule-mc-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalled();
    });
    expect(updateActionMock).toHaveBeenCalledWith(
      "rule-mc-1",
      expect.anything(),
      expect.anything(),
    );
  });

  it("does NOT navigate when the action returns an error", async () => {
    createActionMock.mockResolvedValue({ error: "Rule type inválido" });

    render(<MicrochipRequiredForm {...BASE_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Crear regla" }));

    await waitFor(() => {
      expect(screen.getByText("Rule type inválido")).toBeInTheDocument();
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
