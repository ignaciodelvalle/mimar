// @vitest-environment jsdom
//
// MpfExportFormatForm — jurisdiction-compliance (2026-07-22 "MPF export
// format cascade"). Pins that the form renders, submits the right FormData
// shape (ruleType + format via the select), and navigates on success — same
// router-drop-cure pattern as MicrochipRequiredForm.test.tsx.

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

import { MpfExportFormatForm } from "./MpfExportFormatForm";

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
  initialFormat: "estandar_nacional" as const,
  initialNotes: "",
};

describe("<MpfExportFormatForm>", () => {
  it("submits ruleType=mpf_export_format with format=estandar_nacional by default", async () => {
    createActionMock.mockResolvedValue({ error: null, redirectTo: "/gob/reglas/AR/Chaco/_" });

    render(<MpfExportFormatForm {...BASE_PROPS} />);

    expect(screen.getByRole("combobox", { name: /Formato del export/ })).toHaveValue(
      "estandar_nacional",
    );

    fireEvent.click(screen.getByRole("button", { name: "Crear regla" }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith("/gob/reglas/AR/Chaco/_");
    });
    const formData = createActionMock.mock.calls[0][1] as FormData;
    expect(formData.get("ruleType")).toBe("mpf_export_format");
    expect(formData.get("format")).toBe("estandar_nacional");
    expect(formData.get("jurisdictionProvince")).toBe("Chaco");
  });

  it("edit mode calls updateBusinessRuleAction bound to ruleId", async () => {
    updateActionMock.mockResolvedValue({ error: null, redirectTo: "/gob/reglas/AR/Chaco/_" });

    render(<MpfExportFormatForm {...BASE_PROPS} mode="edit" ruleId="rule-mpf-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalled();
    });
    expect(updateActionMock).toHaveBeenCalledWith(
      "rule-mpf-1",
      expect.anything(),
      expect.anything(),
    );
  });

  it("does NOT navigate when the action returns an error", async () => {
    createActionMock.mockResolvedValue({ error: "Rule type inválido" });

    render(<MpfExportFormatForm {...BASE_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Crear regla" }));

    await waitFor(() => {
      expect(screen.getByText("Rule type inválido")).toBeInTheDocument();
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
