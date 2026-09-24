// @vitest-environment jsdom
//
// Smoke tests for <LnButton> — button mode (default) vs anchor mode (href).
// Anchor mode renders a next/link <Link> instead of a <button>, sharing the
// exact same class output via the shared lnButtonClasses() helper (see
// Button.tsx's anchor-mode doc comment) — these tests pin that parity.

import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LnButton } from "./Button";

describe("<LnButton>", () => {
  it("renders a <button> by default (no href)", () => {
    render(<LnButton>Guardar</LnButton>);

    const button = screen.getByRole("button", { name: "Guardar" });
    expect(button.tagName).toBe("BUTTON");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders an <a> when href is passed, with the same variant-derived classes as button mode", () => {
    render(<LnButton href="/mis-mascotas">Ver mascotas</LnButton>);

    const link = screen.getByRole("link", { name: "Ver mascotas" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/mis-mascotas");
    // Same primary-variant + base classes LnButton (button mode) would apply.
    expect(link).toHaveClass("bg-[var(--color-ln-azul)]");
    expect(link).toHaveClass("text-white");
    // The radius comes from the token, not a literal. This assertion used to
    // read `rounded-[3px]` and it did its job: it went red the moment the
    // citizen radius moved to the pill (D.1). But pinning the VALUE here made
    // this test a second, redundant home for a rule that has exactly one — so
    // it now pins the SHAPE OF THE RULE (a --radius-* token) and leaves the
    // value to Button.tsx, which is where the fence expects to find it.
    expect(link.className).toMatch(/rounded-\[var\(--radius-[a-z-]+\)\]/);
  });

  it("keeps an existing button-mode prop combo (variant + disabled) rendering a <button>", () => {
    render(
      <LnButton variant="primary" disabled>
        Enviar
      </LnButton>,
    );

    const button = screen.getByRole("button", { name: "Enviar" });
    expect(button.tagName).toBe("BUTTON");
    expect(button).toBeDisabled();
    expect(button).toHaveClass("bg-[var(--color-ln-azul)]");
  });
});
