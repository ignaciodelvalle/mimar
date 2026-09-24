// @vitest-environment jsdom
//
// Regression test for the Ciudadano Cero QA (2026-07-08): "step 3 (map/address)
// and step 5 coexist on screen". Step 3 is deliberately kept MOUNTED across step
// transitions (its LocationFields inputs are uncontrolled and read via FormData
// at submit), so the gating must guarantee that when the wizard is NOT on step 3
// the step-3 subtree is visually hidden (offscreen + aria-hidden + inert) and
// exactly one step's content is on screen.
//
// This drives the real wizard from step 1 → step 5 and asserts single-step
// visibility. LocationFields (MapLibre) and the server action are stubbed so the
// test stays deterministic and DOM-only.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Stubbed LocationFields exposes a "mark point" button that fires
// onPointPresenceChange(true) — the wizard requires an exact map point before
// step 3 can advance (FIX #3A), so the test drives that signal explicitly.
vi.mock("@/components/LocationFields", () => ({
  LocationFields: ({
    onPointPresenceChange,
  }: {
    onPointPresenceChange?: (hasPoint: boolean) => void;
  }) => (
    <div data-testid="location-fields">
      <button type="button" data-testid="mark-point" onClick={() => onPointPresenceChange?.(true)}>
        mark point
      </button>
    </div>
  ),
}));

vi.mock("@/src/modules/welfare/actions", () => ({
  createWelfareReportAction: vi.fn(async () => ({ error: null })),
}));

vi.mock("@/lib/ui/use-idempotency-key", () => ({
  useIdempotencyKey: () => ({ key: "test-idempotency-key" }),
}));

vi.mock("@/lib/ui/denuncia-autosave", () => ({
  restoreDraft: () => null,
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
}));

import { DenunciaWizard } from "@/app/(public)/denuncias/nueva/DenunciaWizard";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function clickContinue() {
  fireEvent.click(screen.getByRole("button", { name: "Continuar →" }));
}

describe("DenunciaWizard — step gating (single step visible)", () => {
  it("hides step 3 offscreen when the wizard advances to step 5", () => {
    render(<DenunciaWizard />);

    // Step 1 — pick a kind, continue.
    fireEvent.click(document.querySelector('input[name="kindCard"][value="other"]')!);
    clickContinue();

    // Step 2 — pick a severity, continue.
    fireEvent.click(document.querySelector('input[name="severityCard"][value="moderado"]')!);
    clickContinue();

    // Step 3 — description (>= 20 chars) + when + an exact map point, continue.
    fireEvent.change(document.querySelector('textarea[name="description"]')!, {
      target: { value: "Perro sin agua bajo el sol intenso" },
    });
    fireEvent.click(document.querySelector('input[name="occurredAtOption"][value="now"]')!);
    fireEvent.click(screen.getByTestId("mark-point"));
    clickContinue();

    // Step 4 — optional, continue.
    clickContinue();

    // Now on step 5. Assert single-step visibility.
    const sendHeading = screen.getByText("¿Cómo querés enviarla?");
    expect(sendHeading.closest('[aria-hidden="true"]')).toBeNull();

    // Step 3 stays mounted (uncontrolled inputs) but is hidden: its heading lives
    // inside an aria-hidden + inert offscreen subtree.
    const whereHeading = screen.getByText("¿Dónde y cuándo?");
    const hiddenWrapper = whereHeading.closest('[aria-hidden="true"]');
    expect(hiddenWrapper).not.toBeNull();
    expect(hiddenWrapper).toHaveAttribute("inert");

    // Earlier steps are fully unmounted — not just hidden.
    expect(screen.queryByText("¿Qué pasó?")).toBeNull();
    expect(screen.queryByText("¿Qué tan grave es?")).toBeNull();
  });

  it("Q14: marks the kept-mounted step 3 inert BEFORE it is reached (step < 3), not only after", () => {
    render(<DenunciaWizard />);

    // On step 1 — step 3 is mounted (its uncontrolled inputs must persist) but is
    // display:none AND must be inert + aria-hidden so a snapshot/AT reader never
    // reaches the not-yet-visited step content (regression: inert applied only for
    // step > 3, leaving step < 3 hidden-but-reachable).
    const whereHeading = screen.getByText("¿Dónde y cuándo?");
    const hiddenWrapper = whereHeading.closest('[aria-hidden="true"]');
    expect(hiddenWrapper).not.toBeNull();
    expect(hiddenWrapper).toHaveAttribute("inert");
  });

  it("blocks advancing past step 3 until an exact map point is marked (FIX #3A)", () => {
    render(<DenunciaWizard />);

    // Step 1 → 2 → 3.
    fireEvent.click(document.querySelector('input[name="kindCard"][value="other"]')!);
    clickContinue();
    fireEvent.click(document.querySelector('input[name="severityCard"][value="moderado"]')!);
    clickContinue();

    // Step 3 — description + when, but NO map point yet.
    fireEvent.change(document.querySelector('textarea[name="description"]')!, {
      target: { value: "Perro sin agua bajo el sol intenso" },
    });
    fireEvent.click(document.querySelector('input[name="occurredAtOption"][value="now"]')!);
    clickContinue();

    // Still on step 3 — the point-required error is shown, step 4 not reached.
    expect(
      screen.getByText("Marcá el lugar exacto en el mapa para continuar."),
    ).toBeInTheDocument();
    expect(screen.getByText("¿Dónde y cuándo?").closest('[aria-hidden="true"]')).toBeNull();
    expect(screen.queryByText("¿Sobre quién?")).toBeNull();

    // Mark the point → now it advances to step 4.
    fireEvent.click(screen.getByTestId("mark-point"));
    clickContinue();
    expect(screen.getByText("¿Dónde y cuándo?").closest('[aria-hidden="true"]')).not.toBeNull();
  });
});
