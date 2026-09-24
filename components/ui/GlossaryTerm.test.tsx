// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { GlossaryTerm } from "./GlossaryTerm";

afterEach(cleanup);

describe("GlossaryTerm", () => {
  it("shows a known acronym's definition on hover", () => {
    render(<GlossaryTerm term="ENO" />);
    const term = screen.getByText("ENO");
    expect(term).toBeInTheDocument();

    fireEvent.mouseEnter(term.closest("span")!);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Enfermedades de Notificación Obligatoria",
    );
  });

  it("resolves case-insensitively", () => {
    render(<GlossaryTerm term="pii" />);
    fireEvent.mouseEnter(screen.getByText("pii").closest("span")!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Información Personal Identificable");
  });

  it("renders an unknown term plainly — no tooltip, no dotted underline", () => {
    render(<GlossaryTerm term="XYZ" />);
    const term = screen.getByText("XYZ");
    // No focusable HoverTip wrapper, no dotted border.
    fireEvent.mouseEnter(term);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(term.className).not.toContain("border-dotted");
  });

  it("uses a distinct visible label when children are provided", () => {
    render(<GlossaryTerm term="SLA">SLA ENO</GlossaryTerm>);
    expect(screen.getByText("SLA ENO")).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByText("SLA ENO").closest("span")!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Acuerdo de Nivel de Servicio");
  });
});
