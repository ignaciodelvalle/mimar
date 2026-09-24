// @vitest-environment jsdom
//
// The screen a caretaker gets instead of a 404 on a case they cannot read.
//
// v1 non-capability, accepted by the PO (design F2): `can_read_case` grants the
// subject-pet branch to `role='owner'` only, and widening a SECURITY DEFINER
// function that also governs welfare denuncias is a separate decision with its
// own review. The spec's requirement is not that a caretaker CAN read the case
// — it is that the limitation is stated, "never a 404 a person discovers by
// clicking".
//
// So this screen has one job with three parts: say the case exists, say why it
// is not for them, and point at the person who CAN act on it.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CaseNotForCaretaker } from "./CaseNotForCaretaker";

afterEach(() => cleanup());

describe("CaseNotForCaretaker", () => {
  it("does not pretend the case is missing", () => {
    render(<CaseNotForCaretaker petPublicToken="DIM-TEST-0001" petName="Pampa" />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/no existe|no encontrad/i);
  });

  it("names the limitation in the spec's own words", () => {
    render(<CaseNotForCaretaker petPublicToken="DIM-TEST-0001" petName="Pampa" />);
    expect(screen.getByText(/no disponible para cuidadores/i)).toBeInTheDocument();
  });

  it("points at who can act on it — a refusal with no next step is a dead end", () => {
    render(<CaseNotForCaretaker petPublicToken="DIM-TEST-0001" petName="Pampa" />);
    expect(screen.getByText(/titular/i)).toBeInTheDocument();
  });

  it("leaves a way back to the pet they ARE caring for", () => {
    render(<CaseNotForCaretaker petPublicToken="DIM-TEST-0001" petName="Pampa" />);
    expect(screen.getByRole("link", { name: /Pampa/ })).toHaveAttribute(
      "href",
      "/mis-mascotas/DIM-TEST-0001",
    );
  });

  it("still works when the case has no subject pet to link back to", () => {
    render(<CaseNotForCaretaker petPublicToken={null} petName={null} />);
    expect(screen.getByText(/no disponible para cuidadores/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /mis-mascotas/ })).not.toBeInTheDocument();
  });
});
