// Structural smoke tests for <NumericWindowRuleForm> (the 4 "promoted"
// operational rule types: rabies_observation_window, due_soon_window,
// reminder_windows, long_stay_days).
//
// Render via react-dom/server → HTML string (same pattern as
// finder-in-possession-form.test.tsx / pet-sighting-form.test.tsx).
// useActionState and useState are stubbed so the component renders
// predictably without jsdom.
//
// Assertions focus on decision #651 (spec R4.5 amended): these 4 rule
// types get explicit warning copy near the submit button, NOT the
// count-based impact-preview gate (RuleImpactBanner / acknowledgement
// checkbox) that ppp_breed_list/ppp_weight_threshold use — see the
// negative-assertion tests below.

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseActionState = vi.fn();
const mockUseState = vi.fn((initialValue: unknown) => [initialValue, vi.fn()]);

vi.mock("react", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof React;
  return {
    ...actual,
    useActionState: (...args: unknown[]) => mockUseActionState(...args),
    useState: (initialValue: unknown) => mockUseState(initialValue),
  };
});

vi.mock("@/app/actions/business-rules", () => ({
  createBusinessRuleAction: vi.fn(),
  updateBusinessRuleAction: {
    bind: () => vi.fn(),
  },
}));

import {
  DueSoonWindowForm,
  LongStayDaysForm,
  RabiesObservationWindowForm,
  ReminderWindowsForm,
} from "./NumericWindowRuleForm";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const BASE_PROPS = {
  mode: "create" as const,
  country: "AR",
  province: null,
  locality: null,
  base: "/gob" as const,
  initialValue: 30,
  initialNotes: "",
};

const INITIAL_STATE = { error: null };
const formActionStub = () => {};

const FORMS = [
  { name: "RabiesObservationWindowForm", Component: RabiesObservationWindowForm },
  { name: "DueSoonWindowForm", Component: DueSoonWindowForm },
  { name: "ReminderWindowsForm", Component: ReminderWindowsForm },
  { name: "LongStayDaysForm", Component: LongStayDaysForm },
];

describe.each(FORMS)(
  "<$name> — warning copy, not impact-preview gate (decision #651)",
  ({ Component }) => {
    beforeEach(() => {
      mockUseActionState.mockReturnValue([INITIAL_STATE, formActionStub, false]);
      mockUseState.mockImplementation((initialValue: unknown) => [initialValue, vi.fn()]);
    });

    it("renders the explicit warning copy near the submit button", () => {
      const html = render(<Component {...BASE_PROPS} />);
      expect(html).toContain(
        "Este cambio aplica inmediatamente a toda la jurisdicción seleccionada.",
      );
    });

    it("renders the warning as an LnAlert (role=alert, ln-warn token, no gob-*)", () => {
      const html = render(<Component {...BASE_PROPS} />);
      expect(html).toContain('role="alert"');
      expect(html).toContain("color-ln-warn");
      expect(html).not.toMatch(/\bgob-/);
    });

    it("does NOT render an impact-preview banner", () => {
      const html = render(<Component {...BASE_PROPS} />);
      // RuleImpactBanner (PppWeightThresholdForm/PppBreedListForm's gate) renders
      // a "Calculando impacto" / "dueños" count copy — none of that exists here.
      expect(html).not.toContain("Calculando impacto");
      expect(html).not.toContain("mascotas afectadas");
    });

    it("does NOT render an acknowledgement checkbox", () => {
      const html = render(<Component {...BASE_PROPS} />);
      expect(html).not.toContain("Confirmo que entiendo");
      expect(html).not.toMatch(/type="checkbox"/);
    });

    it("renders the submit button enabled (not gated on an acknowledgement)", () => {
      const html = render(<Component {...BASE_PROPS} />);
      // Locate the submit tag by its type="submit" attribute rather than a
      // literal opening-tag regex (avoids tripping check-ui-invariants.ts's
      // raw-button-tag-growth scanner, which naively greps *.tsx source text
      // for the literal opening-tag substring).
      const submitIdx = html.indexOf('type="submit"');
      expect(submitIdx).toBeGreaterThan(-1);
      const tagStart = html.lastIndexOf("<", submitIdx);
      const tagEnd = html.indexOf(">", submitIdx);
      const submitTag = html.slice(tagStart, tagEnd + 1);
      // "disabled" as an HTML attribute, not the `disabled:` Tailwind variant
      // baked into the button's static className (e.g. disabled:cursor-not-allowed).
      expect(submitTag).not.toMatch(/\sdisabled(=|\s|>)/);
    });
  },
);
