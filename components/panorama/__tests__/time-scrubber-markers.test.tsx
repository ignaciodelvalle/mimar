// @vitest-environment jsdom
//
// TimeScrubber — rule-change markers (política → resultado on the timeline,
// research-locked design 2026-08-02) + the Q3 keyboard shortcuts. Regression
// tests: every assertion here fails against the pre-marker scrubber.
//
// The marker card content is asserted WITHOUT toggling the disclosure —
// OverlayDisclosure renders its panel eagerly (native <details> semantics,
// same testing approach as LegendPill.test.tsx).

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TimeScrubber } from "@/components/panorama/TimeScrubber";
import type { RuleChangeMarkerDatum } from "@/components/panorama/rule-change-markers";

afterEach(() => {
  cleanup();
});

const SINCE = new Date("2026-06-01T00:00:00Z");
const UNTIL = new Date("2026-07-01T00:00:00Z");

function marker(overrides: Partial<RuleChangeMarkerDatum> = {}): RuleChangeMarkerDatum {
  return {
    auditId: "audit-1",
    action: "govt_business_rule_updated",
    ruleType: "microchip_required",
    province: "Salta",
    locality: null,
    changedAt: "2026-06-15T12:00:00Z",
    ...overrides,
  };
}

function renderScrubber(props: Partial<React.ComponentProps<typeof TimeScrubber>> = {}) {
  return render(
    <TimeScrubber
      since={SINCE}
      until={UNTIL}
      onChange={vi.fn()}
      basis="valid"
      onBasisChange={vi.fn()}
      {...props}
    />,
  );
}

describe("TimeScrubber — rule-change markers (Detalle only)", () => {
  it("Simple mode stays clean: no marker chip, no caveat", () => {
    renderScrubber({ ruleChangeMarkers: [marker()] }); // scrubDetail defaults to false
    expect(screen.queryByTestId(/rule-change-marker-/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Correlación temporal/)).not.toBeInTheDocument();
  });

  it("Detalle renders the marker with the inteligencia vocabulary + the traveling caveat", () => {
    renderScrubber({ scrubDetail: true, ruleChangeMarkers: [marker()] });
    // Rule label + action + jurisdiction (RULE_TYPE_REGISTRY / ACTION_LABELS /
    // ruleScopeLabel vocabulary — no deltas, no numbers).
    expect(screen.getByText("Microchip obligatorio")).toBeInTheDocument();
    expect(screen.getByText("(regla modificada)")).toBeInTheDocument();
    expect(screen.getByText("Salta")).toBeInTheDocument();
    // The caveat travels with the marker layer.
    expect(screen.getByText(/Correlación temporal, no atribución\./)).toBeInTheDocument();
  });

  it("pins the TRANSACTION-basis label — 'Cambio registrado el', never 'vigente desde', even with basis=transaction", () => {
    renderScrubber({
      scrubDetail: true,
      basis: "transaction",
      ruleChangeMarkers: [marker({ changedAt: "2026-06-15T12:00:00Z" })],
    });
    expect(screen.getByText(/Cambio registrado el 15 de junio de 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/vigente desde/i)).not.toBeInTheDocument();
  });

  it("merges two changes on the same day into an 'N cambios' chip listing both", () => {
    renderScrubber({
      scrubDetail: true,
      ruleChangeMarkers: [
        marker({ auditId: "a1", ruleType: "microchip_required" }),
        marker({
          auditId: "a2",
          ruleType: "due_soon_window",
          action: "govt_business_rule_created",
          changedAt: "2026-06-15T18:00:00Z",
        }),
      ],
    });
    expect(screen.getByText("2 cambios")).toBeInTheDocument();
    // One merged card carries BOTH changes.
    expect(screen.getByText("Microchip obligatorio")).toBeInTheDocument();
    expect(screen.getByText("Ventana 'próximo a vencer'")).toBeInTheDocument();
  });

  it("drops markers outside the active window (no edge-clamped ghosts)", () => {
    renderScrubber({
      scrubDetail: true,
      ruleChangeMarkers: [marker({ changedAt: "2026-01-01T00:00:00Z" })],
    });
    expect(screen.queryByTestId(/rule-change-marker-/)).not.toBeInTheDocument();
  });

  it("renders the single link out only when a detail href is provided (admin surface)", () => {
    const { unmount } = renderScrubber({
      scrubDetail: true,
      ruleChangeMarkers: [marker()],
      ruleChangeDetailHref: "/admin/inteligencia",
    });
    const link = screen.getByRole("link", { name: /Ver análisis en Inteligencia/ });
    expect(link).toHaveAttribute("href", "/admin/inteligencia");
    unmount();

    // gob surface: no href → no dead link into an admin-only page.
    renderScrubber({ scrubDetail: true, ruleChangeMarkers: [marker()] });
    expect(
      screen.queryByRole("link", { name: /Ver análisis en Inteligencia/ }),
    ).not.toBeInTheDocument();
  });
});

describe("TimeScrubber — Q3 keyboard shortcuts", () => {
  it("Espacio toggles play/pausa while focus is on the slider (within the scrubber region)", () => {
    renderScrubber();
    const slider = screen.getByRole("slider");
    slider.focus();
    fireEvent.keyDown(slider, { key: " " });
    expect(screen.getByRole("button", { name: "Pausar reproducción" })).toBeInTheDocument();
    fireEvent.keyDown(slider, { key: " " });
    expect(
      screen.getByRole("button", { name: "Reproducir la formación de la situación" }),
    ).toBeInTheDocument();
  });

  it("Espacio on a focused button is left to the browser (no double-toggle from the shortcut)", () => {
    renderScrubber();
    const chip = screen.getByRole("button", { name: "↺ última semana" });
    chip.focus();
    fireEvent.keyDown(chip, { key: " " });
    // The shortcut handler skipped it — playback did not start.
    expect(
      screen.getByRole("button", { name: "Reproducir la formación de la situación" }),
    ).toBeInTheDocument();
  });

  it("declares the shortcut: aria-keyshortcuts='Space' on the play button", () => {
    renderScrubber();
    expect(
      screen.getByRole("button", { name: "Reproducir la formación de la situación" }),
    ).toHaveAttribute("aria-keyshortcuts", "Space");
  });

  it("←/→ stay NATIVE range arrows: the slider steps whole days (step=1 over 0..steps)", () => {
    renderScrubber();
    const slider = screen.getByRole("slider") as HTMLInputElement;
    expect(slider).toHaveAttribute("step", "1");
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "30"); // 30 whole days in June's window
  });
});
