// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { HoverTip } from "./HoverTip";

afterEach(cleanup);

describe("HoverTip — accessible hover/focus tooltip", () => {
  it("renders the trigger and NO tooltip in the closed (SSR) state", () => {
    const html = renderToStaticMarkup(
      <HoverTip content="Enfermedades de Notificación Obligatoria">ENO</HoverTip>,
    );
    expect(html).toContain("ENO");
    expect(html).not.toContain('role="tooltip"');
    expect(html).not.toContain("Enfermedades de Notificación Obligatoria");
  });

  it("reveals the tip on focus and hides it on Escape (keyboard path)", () => {
    render(<HoverTip content="Enfermedades de Notificación Obligatoria">ENO</HoverTip>);
    const trigger = screen.getByText("ENO").closest("span")!;

    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focus(trigger);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Enfermedades de Notificación Obligatoria");
    // While open, the trigger describes itself via the tip (a11y).
    expect(trigger).toHaveAttribute("aria-describedby", tip.id);

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("reveals on mouse enter and hides on mouse leave (pointer path)", () => {
    render(<HoverTip content="def">term</HoverTip>);
    const trigger = screen.getByText("term").closest("span")!;

    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
