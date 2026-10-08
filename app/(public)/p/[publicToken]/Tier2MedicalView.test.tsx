// @vitest-environment jsdom
//
// Tier2MedicalView — the active-medication list keeps its list semantics
// (native review C-3). The <ul> is styled `list-style: none`, which makes
// WebKit/VoiceOver drop the implicit list role and with it the item count; an
// explicit role="list" puts it back. Guarded here because the linter calls that
// role redundant and would happily remove it.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Tier2MedicalView } from "./Tier2MedicalView";

afterEach(() => {
  cleanup();
});

describe("<Tier2MedicalView> — active medications", () => {
  it("renders them as an explicit list, one item per drug", () => {
    render(
      <Tier2MedicalView
        enabledUntil={null}
        vaccineSummary={{ active: 1, expired: 0, dueSoon: 0, missing: 0 }}
        hasVaccineRecords
        isSterilized={false}
        sex="female"
        activeMedications={["Meloxicam", "Omeprazol"]}
        permanentConditions={[]}
        permanentConditionsOther={null}
      />,
    );

    const list = screen.getByRole("list");
    expect(list).toHaveAttribute("role", "list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });
});

describe("<Tier2MedicalView> — a declared dose is not 'vigente' (QA v14 review)", () => {
  const base = {
    enabledUntil: null,
    hasVaccineRecords: true,
    isSterilized: false,
    sex: "female",
    activeMedications: [],
    permanentConditions: [],
    permanentConditionsOther: null,
  };

  it("an owner-declared current dose reads '1 declarada', never '1 vigente'", () => {
    const { container } = render(
      <Tier2MedicalView
        {...base}
        vaccineSummary={{ active: 1, expired: 0, dueSoon: 0, missing: 0, declared: 1 }}
      />,
    );
    expect(container).toHaveTextContent("1 declarada");
    expect(container).not.toHaveTextContent(/vigente/);
  });

  it("a signed and a declared dose say both", () => {
    const { container } = render(
      <Tier2MedicalView
        {...base}
        vaccineSummary={{ active: 2, expired: 0, dueSoon: 0, missing: 0, declared: 1 }}
      />,
    );
    expect(container).toHaveTextContent("1 vigente · 1 declarada");
  });
});

describe("<Tier2MedicalView> — the owner's consent is visible text", () => {
  const props = {
    vaccineSummary: { active: 1, expired: 0, dueSoon: 0, missing: 0 },
    hasVaccineRecords: true,
    isSterilized: false,
    sex: "female",
    activeMedications: [],
    permanentConditions: [],
    permanentConditionsOther: null,
  };

  it("says 'Habilitada por el dueño · Siempre visible' for the permanent option", () => {
    const { container } = render(<Tier2MedicalView {...props} enabledUntil={null} />);
    const line = container.querySelector('[data-section="tier2-consent"]');
    expect(line).toHaveTextContent(/^Habilitada por el dueño · Siempre visible$/);
  });

  it("says 'Habilitada por el dueño · Visible hasta el …' for a bounded window", () => {
    const { container } = render(
      <Tier2MedicalView {...props} enabledUntil={new Date("2026-10-20T18:30:00Z")} />,
    );
    const line = container.querySelector('[data-section="tier2-consent"]');
    expect(line).toHaveTextContent(/^Habilitada por el dueño · Visible hasta el .*20.*15:30\.$/);
    expect(line).not.toHaveTextContent("Siempre visible");
  });
});

// axe `definition-list` (serious) on /p/DIM-PAMP-0001, browser QA 2026-10-06:
// the grid was a <dl> whose children were div > span + dt + dd + p. Every <dl>
// here may hold only <dt>/<dd> — or <div> wrappers holding only <dt>/<dd>.
describe("<Tier2MedicalView> — definition lists are well formed", () => {
  it("every <dl> holds only dt/dd (or div wrappers of dt/dd), and each term has its value", () => {
    const { container } = render(
      <Tier2MedicalView
        enabledUntil={null}
        vaccineSummary={{ active: 1, expired: 0, dueSoon: 0, missing: 0 }}
        hasVaccineRecords
        isSterilized
        sex="female"
        activeMedications={[]}
        permanentConditions={[]}
        permanentConditionsOther={null}
      />,
    );
    const lists = [...container.querySelectorAll("dl")];
    expect(lists.length).toBeGreaterThanOrEqual(2);
    const allowed = (el: Element) => el.tagName === "DT" || el.tagName === "DD";
    for (const dl of lists) {
      for (const child of [...dl.children]) {
        const ok =
          allowed(child) || (child.tagName === "DIV" && [...child.children].every(allowed));
        expect(ok, `<dl> child <${child.tagName.toLowerCase()} class="${child.className}">`).toBe(
          true,
        );
      }
    }
    const vacuna = screen.getByText("Vacunación");
    expect(vacuna.tagName).toBe("DT");
    expect(vacuna.parentElement?.querySelector("dd")?.textContent).toBe("1");
    expect(screen.getByText("1 vigente").tagName).toBe("DD");
  });
});
