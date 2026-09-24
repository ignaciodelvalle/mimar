// @vitest-environment jsdom
// PrintExpedienteButton (Q6) — pins that the print trigger goes through
// deferPrint (never a direct window.print in the click handler; INP
// mitigation, lib/infra/defer-print.ts) and keeps the es-AR label.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const deferPrint = vi.fn();
vi.mock("@/lib/infra/defer-print", () => ({
  deferPrint: (...args: unknown[]) => deferPrint(...args),
}));

import { PrintExpedienteButton } from "./PrintExpedienteButton";

afterEach(() => {
  cleanup();
  deferPrint.mockClear();
});

describe("PrintExpedienteButton", () => {
  it("defers the print call on click", () => {
    render(<PrintExpedienteButton />);
    fireEvent.click(screen.getByRole("button", { name: "Imprimir" }));
    expect(deferPrint).toHaveBeenCalledTimes(1);
  });
});
