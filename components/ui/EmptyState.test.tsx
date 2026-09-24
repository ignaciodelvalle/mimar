// Smoke tests for <LnEmptyState>.
// Pattern: renderToStaticMarkup.

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LnEmptyState } from "./EmptyState";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("<LnEmptyState>", () => {
  it("renders title", () => {
    const html = render(<LnEmptyState title="Sin resultados" />);
    expect(html).toContain("Sin resultados");
  });

  it("renders description when provided", () => {
    const html = render(
      <LnEmptyState title="Sin mascotas" description="Registrá tu primera mascota." />,
    );
    expect(html).toContain("Registrá tu primera mascota.");
  });

  it("does NOT render description element when omitted", () => {
    const html = render(<LnEmptyState title="Vacío" />);
    // Only one <p> — the title
    const pMatches = html.match(/<p[^>]*>/g) ?? [];
    expect(pMatches).toHaveLength(1);
  });

  it("renders action slot when provided", () => {
    const html = render(
      <LnEmptyState title="Nada" action={<button type="button">Crear</button>} />,
    );
    expect(html).toContain("Crear");
    expect(html).toMatch(/<button[^>]*type="button"/);
  });

  it("contains only skin-aware sk-*/st-* tokens — zero gob-* and zero hardcoded ln-*", () => {
    const html = render(<LnEmptyState title="Vacío" description="Sin datos." />);
    // sk-* resolves per skin (citizen ln-* / operator ln-op-*) — the component
    // renders on both, so it must never pin a citizen value (token audit
    // 2026-08-06: the old ln-* neutrals leaked onto 41 operator screens).
    expect(html).toMatch(/--color-sk-/);
    expect(html).not.toMatch(/\bgob-/);
    expect(html).not.toMatch(/color-ln-(?!op-)/);
  });

  it("uses sk-ink token for title and sk-mute/sk-faint token for description/icon area", () => {
    const html = render(<LnEmptyState title="Test" description="Desc" />);
    expect(html).toContain("color-sk-ink");
    expect(html).toMatch(/color-sk-mute|color-sk-faint/);
  });
});

// ---------------------------------------------------------------------------
// Epistemic nature (C4, 2026-07-22) — measured-zero vs no-signal
// ---------------------------------------------------------------------------

describe("<LnEmptyState> — epistemic nature", () => {
  it('omitting `nature` keeps today\'s look — no warn tint, no role="status"', () => {
    const html = render(<LnEmptyState title="Sin resultados" />);
    expect(html).not.toMatch(/st-warn|sk-warn/);
    expect(html).not.toContain('role="status"');
    expect(html).toContain("color-sk-ink");
  });

  it('nature="measured-zero" renders identically to the default (a real, verified zero)', () => {
    const withNature = render(<LnEmptyState title="Sin resultados" nature="measured-zero" />);
    const withoutNature = render(<LnEmptyState title="Sin resultados" />);
    expect(withNature).toBe(withoutNature);
  });

  it('nature="no-signal" renders a muted-warn treatment, never the neutral/ok look', () => {
    const html = render(
      <LnEmptyState
        title="Sin señales registradas en miMAR"
        description="La ausencia de señales no implica ausencia de enfermedad."
        nature="no-signal"
      />,
    );
    expect(html).toMatch(/st-warn|sk-warn/);
    expect(html).not.toContain("color-sk-ink");
    // Never a success/ok tone — the whole point is "blind", not "all clear".
    expect(html).not.toMatch(/st-ok\b|ln-ok\b/);
  });

  it('nature="no-signal" sets role="status" (operator should notice this, not decorative chrome)', () => {
    const html = render(
      <LnEmptyState title="Sin señales registradas en miMAR" nature="no-signal" />,
    );
    expect(html).toContain('role="status"');
  });

  it('nature="no-signal" tints the icon with the warn token, not the default faint token', () => {
    const html = render(<LnEmptyState title="Sin señales" nature="no-signal" icon="eye-off" />);
    expect(html).toContain("color-st-warn");
    expect(html).not.toContain("color-sk-faint");
  });

  it("the blind-not-calm copy pattern never reads as success/ok", () => {
    const html = render(
      <LnEmptyState
        title="Sin observaciones registradas en miMAR"
        description="La ausencia de observaciones no implica ausencia de casos por escalar."
        nature="no-signal"
      />,
    );
    expect(html).toContain("no implica ausencia de");
    expect(html).not.toMatch(/todo tranquilo|bajo control|sin problemas/i);
  });
});
