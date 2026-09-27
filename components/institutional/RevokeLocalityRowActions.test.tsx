// @vitest-environment jsdom
//
// RevokeLocalityRowActions — the "Evidencia" file input must be labelled PER ROW.
//
// `app/admin/govts/[userId]/page.tsx` renders one of these per locality
// assignment, inside a `.map()`. The component used to hardcode
// `htmlFor="revoke-locality-evidence"` / `id="revoke-locality-evidence"`, so with
// N assignments the document carried N labels and N inputs sharing ONE id and
// `label.control` resolved to the FIRST input for every row.
//
// Worse than the sibling defect it mirrors (RevokeTagDialog, 1861c614c) for two
// reasons. The control is the MANDATORY EVIDENCE of an audited, destructive
// action — revoking a government official's locality. And unlike TagList, which
// owns a single `activeSerial` so only one panel is ever open, each row here owns
// its own `mode` with no single-open guard: two panels can be expanded at once,
// and then clicking row 2's "Evidencia" label opens the picker bound to row 1's
// input. The file lands in the wrong form — a wrong-target attachment on a
// revocation, not merely an accessibility defect.
//
// Third instance of the same class in this repo (components/MotivoField.tsx was
// the first). The rule this test exists to hold: a control inside a repeated row
// never carries a literal id.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/admin-revocations", () => ({
  revokeGovtLocalityAction: vi.fn(),
}));

import { RevokeLocalityRowActions } from "./RevokeLocalityRowActions";

afterEach(() => {
  cleanup();
});

/** Two assignments with BOTH panels expanded — the state the bug needs. */
function renderTwoExpandedRows() {
  const view = render(
    <>
      <RevokeLocalityRowActions assignmentId="assign-1" localityLabel="CABA / Palermo" />
      <RevokeLocalityRowActions assignmentId="assign-2" localityLabel="Buenos Aires / La Plata" />
    </>,
  );
  // Each row starts collapsed and owns its own mode — open both, which is
  // exactly what the missing single-open guard permits.
  // fireEvent, not a raw .click(): the raw call does not run inside React's
  // act(), so the state update never flushes and both panels stay collapsed.
  for (const button of screen.getAllByRole("button", { name: /^revocar$/i })) {
    fireEvent.click(button);
  }
  return view;
}

function evidenceInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));
}

describe("RevokeLocalityRowActions — evidence label is per row", () => {
  it("renders one expanded form per assignment", () => {
    renderTwoExpandedRows();
    expect(evidenceInputs()).toHaveLength(2);
  });

  it("gives every row's evidence input its OWN label", () => {
    renderTwoExpandedRows();
    for (const input of evidenceInputs()) {
      expect(input.labels).toHaveLength(1);
      expect(input.labels?.[0]).toHaveTextContent(/evidencia/i);
    }
  });

  it("does not reuse one DOM id across rows", () => {
    renderTwoExpandedRows();
    const ids = evidenceInputs().map((i) => i.id);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves the label to the input in ITS OWN row, not the first one", () => {
    renderTwoExpandedRows();
    const inputs = evidenceInputs();
    for (const input of inputs) {
      const row = input.closest("div.space-y-1");
      expect(row, "the input sits inside its own field wrapper").not.toBeNull();
      // getByLabelText resolves through element.labels — the same lookup
      // Playwright's getByLabel uses, and the one the duplicate id defeated.
      const found = within(row as HTMLElement).getByLabelText(/evidencia/i);
      expect(found).toBe(input);
    }
  });
});
