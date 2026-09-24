// @vitest-environment jsdom
//
// Smoke test for <OpButton>'s pressed-state parity with LnButton
// (audit-3-feedback §C4, 2026-07-21): OpButton previously mirrored
// LnButton's hover/focus-visible/disabled/loading states but NOT its
// `active:scale`/`active:opacity` pressed feedback (Button.tsx:56-58) — a
// real citizen-vs-operator touch-feedback parity gap. This pins that the
// same classes now appear on OpButton's base.

import "@testing-library/jest-dom/vitest";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OpButton } from "./OpButton";

describe("<OpButton> pressed state", () => {
  it("carries the same active:scale/active:opacity pressed feedback as LnButton", () => {
    render(<OpButton>Confirmar</OpButton>);

    const button = screen.getByRole("button", { name: "Confirmar" });
    expect(button).toHaveClass("active:scale-[0.98]");
    expect(button).toHaveClass("active:opacity-90");
  });
});
