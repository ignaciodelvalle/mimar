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
