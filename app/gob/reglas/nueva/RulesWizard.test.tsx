// @vitest-environment jsdom
//
// RulesWizard — step-flow test (PO redesign 2026-07-23). Pins that walking
// provincia -> "toda la provincia" -> tipo de regla mounts the RIGHT existing
// per-kind form (MicrochipRequiredForm) as step 4's body, with the wizard
// never reimplementing a rule-type config UI of its own.
//
// Every step's <section> stays mounted (sr-only + inert when inactive — the
// LnWizardShell a11y convention), so a bare `getByRole("button", { name:
// "Continuar" })` would match THREE elements at once (one per step 1-3).
// `within(activeSection())` scopes every step-specific query to the one
// <section> whose `aria-hidden` is literally "false" (React renders the
// boolean prop as that string, never omits it), avoiding ambiguity without
// depending on whether this testing-library version treats `inert` as
// hiding descendants from role queries.
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

// Same mocks MicrochipRequiredForm.test.tsx uses — step 4 mounts that REAL
// component, so its own action/nav dependencies must be stubbed here too.
const createActionMock = vi.fn();
vi.mock("@/app/actions/business-rules", () => ({
  createBusinessRuleAction: (...args: unknown[]) => createActionMock(...args),
  updateBusinessRuleAction: vi.fn(),
}));

vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: vi.fn(),
}));

// The locality picker is the other writer's component; here it is a stub that
// picks Mechita of partido Bragado — a homonym only its INDEC id tells apart.
vi.mock("@/components/LocalityPickerAcross", () => ({
  LocalityPickerAcross: (props: {
    onSelect?: (r: { localityName: string; indecId: string } | null) => void;
  }) => (
    // An input of type button: lint:ui counts raw button tags on operator pages.
    <input
      type="button"
      value="Elegir Mechita (Bragado)"
      onClick={() => props.onSelect?.({ localityName: "Mechita", indecId: "06112080" })}
    />
  ),
}));

import { RulesWizard } from "./RulesWizard";

function activeSection(): HTMLElement {
  const el = document.querySelector('section[aria-hidden="false"]');
  if (!el) throw new Error("no active (aria-hidden=false) wizard section found");
  return el as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("<RulesWizard> — step flow", () => {
  it("provincia -> toda la provincia -> tipo de regla renders the matching per-kind form at step 4", () => {
    render(<RulesWizard base="/gob" />);

    // Step 1 — Provincia
    expect(screen.getByText("Paso 1 de 4")).toBeInTheDocument();
    expect(within(activeSection()).getByRole("button", { name: "Continuar" })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Provincia" }), {
      target: { value: "AR-H" }, // Chaco
    });
    expect(within(activeSection()).getByRole("button", { name: "Continuar" })).toBeEnabled();
    fireEvent.click(within(activeSection()).getByRole("button", { name: "Continuar" }));

    // Step 2 — Localidad, o "toda la provincia"
    expect(screen.getByText("Paso 2 de 4")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Aplica a toda la provincia (sin localidad específica)",
      }),
    );
    fireEvent.click(within(activeSection()).getByRole("button", { name: "Continuar" }));

    // Step 3 — Tipo de regla
    expect(screen.getByText("Paso 3 de 4")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Microchip obligatorio"));
    fireEvent.click(within(activeSection()).getByRole("button", { name: "Continuar" }));

    // Step 4 — Configuración específica: the REAL MicrochipRequiredForm, not
    // a wizard-owned reimplementation. Since migration 0183 (WU1) the form's
    // primary control is the requirement-tier select; since RG2's ratification
    // (2026-08-16) the create default is "No regulado" (not_regulated) — an
    // admin claims `mandatory` actively, the form never pre-claims it.
    expect(screen.getByText("Paso 4 de 4")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Nivel de exigencia/ })).toHaveValue(
      "not_regulated",
    );
    expect(screen.getByRole("button", { name: "Crear regla" })).toBeInTheDocument();
  });

  it("step 2's Continuar stays disabled until either a locality is picked or 'toda la provincia' is checked", () => {
    render(<RulesWizard base="/gob" />);
    fireEvent.change(screen.getByRole("combobox", { name: "Provincia" }), {
      target: { value: "AR-H" },
    });
    fireEvent.click(within(activeSection()).getByRole("button", { name: "Continuar" }));

    expect(screen.getByText("Paso 2 de 4")).toBeInTheDocument();
    expect(within(activeSection()).getByRole("button", { name: "Continuar" })).toBeDisabled();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Aplica a toda la provincia (sin localidad específica)",
      }),
    );
    expect(within(activeSection()).getByRole("button", { name: "Continuar" })).toBeEnabled();
  });

  // localidades-por-id D4: the rule is keyed on the row the person picked, so
  // a homonym is no longer refused — the form carries the row's INDEC id.
  it("a picked locality travels to the rule form as its INDEC id", () => {
    const { container } = render(<RulesWizard base="/gob" />);
    fireEvent.change(screen.getByRole("combobox", { name: "Provincia" }), {
      target: { value: "AR-B" },
    });
    fireEvent.click(within(activeSection()).getByRole("button", { name: "Continuar" }));
    fireEvent.click(screen.getByRole("button", { name: "Elegir Mechita (Bragado)" }));
    fireEvent.click(within(activeSection()).getByRole("button", { name: "Continuar" }));
    fireEvent.click(screen.getByText("Microchip obligatorio"));
    fireEvent.click(within(activeSection()).getByRole("button", { name: "Continuar" }));

    const field = container.querySelector('input[name="jurisdictionLocalityIndecId"]');
    expect(field).toHaveValue("06112080");
    expect(container.querySelector('input[name="jurisdictionLocality"]')).toHaveValue("Mechita");
  });

  it("a confirmed authority unit of the province can key the rule instead of a locality", () => {
    const units = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Municipio de Bragado",
        provinceCode: "AR-B",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Municipio de Rosario",
        provinceCode: "AR-S",
      },
    ];
    const { container } = render(<RulesWizard base="/gob" units={units} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Provincia" }), {
      target: { value: "AR-B" },
    });
    fireEvent.click(within(activeSection()).getByRole("button", { name: "Continuar" }));
    const unitSelect = screen.getByRole("combobox", {
      name: "O una unidad de autoridad confirmada",
    });
    // Only the chosen province's units are offered.
    expect(within(unitSelect).queryByText("Municipio de Rosario")).toBeNull();
    fireEvent.change(unitSelect, { target: { value: units[0]?.id } });
    fireEvent.click(within(activeSection()).getByRole("button", { name: "Continuar" }));
    fireEvent.click(screen.getByText("Microchip obligatorio"));
    fireEvent.click(within(activeSection()).getByRole("button", { name: "Continuar" }));

    expect(container.querySelector('input[name="jurisdictionUnitId"]')).toHaveValue(units[0]?.id);
    expect(container.querySelector('input[name="jurisdictionLocalityIndecId"]')).toBeNull();
  });
});
