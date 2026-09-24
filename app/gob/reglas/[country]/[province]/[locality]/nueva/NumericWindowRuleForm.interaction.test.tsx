// @vitest-environment jsdom
//
// Interaction test for the Fix 3 router-drop cure (verify-report #650
// WARNING-1). Unlike NumericWindowRuleForm.test.tsx (structural smoke tests
// with useActionState/useState stubbed via renderToStaticMarkup), this file
// exercises the REAL useActionState hook end-to-end via RTL + jsdom: submit
// the form, let the mocked server action resolve, and assert the resulting
// state drives a full document navigation via
// lib/ui/full-page-action-nav.ts's navigateAfterActionSuccess — NOT
// next/navigation's redirect()/router transition, which Next 15.5.x's App
// Router can silently drop in production (engram #621/#622).
//
// Pattern follows PetDetailTabsPanel.interaction.test.tsx (RTL + jsdom,
// real hooks, waitFor for the async action → state → effect chain).

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

import { LongStayDaysForm } from "./NumericWindowRuleForm";

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
  province: null,
  locality: null,
  base: "/gob" as const,
  initialValue: 60,
  initialNotes: "",
};

describe("<LongStayDaysForm> — router-drop cure (Fix 3, verify-report #650 WARNING-1)", () => {
  it("calls navigateAfterActionSuccess with redirectTo on a successful submit", async () => {
    createActionMock.mockResolvedValue({ error: null, redirectTo: "/gob/reglas/AR/_/_" });

    render(<LongStayDaysForm {...BASE_PROPS} />);

    fireEvent.click(screen.getByRole("button", { name: "Crear regla" }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith("/gob/reglas/AR/_/_");
    });
    expect(navigateMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT navigate when the action returns an error (no redirectTo)", async () => {
    createActionMock.mockResolvedValue({ error: "Rule type inválido" });

    render(<LongStayDaysForm {...BASE_PROPS} />);

    fireEvent.click(screen.getByRole("button", { name: "Crear regla" }));

    await waitFor(() => {
      expect(screen.getByText("Rule type inválido")).toBeInTheDocument();
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("does NOT navigate when the action returns a no-op warning (no redirectTo)", async () => {
    createActionMock.mockResolvedValue({
      error: null,
      warning: "Esta configuración es idéntica al default — no se requiere override.",
    });

    render(<LongStayDaysForm {...BASE_PROPS} />);

    fireEvent.click(screen.getByRole("button", { name: "Crear regla" }));

    await waitFor(() => {
      expect(screen.getByText(/idéntica al default/)).toBeInTheDocument();
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("edit mode calls updateBusinessRuleAction bound to ruleId and navigates on success", async () => {
    updateActionMock.mockResolvedValue({ error: null, redirectTo: "/gob/reglas/AR/_/_" });

    render(<LongStayDaysForm {...BASE_PROPS} mode="edit" ruleId="rule-123" />);

    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith("/gob/reglas/AR/_/_");
    });
    expect(updateActionMock).toHaveBeenCalledWith("rule-123", expect.anything(), expect.anything());
  });
});
