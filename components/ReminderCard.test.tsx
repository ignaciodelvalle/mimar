// Smoke tests for <ReminderCard>.
//
// Render via react-dom/server → HTML string (same pattern as Badge.test.tsx).
// ReminderCard uses useId() (deterministic in SSR) and no browser-only APIs,
// so renderToStaticMarkup succeeds cleanly.

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReminderCard } from "./ReminderCard";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("<ReminderCard>", () => {
  it("renders without crashing", () => {
    const html = render(
      <ReminderCard
        variant="upcoming"
        title="Antirrábica"
        petName="Fausto"
        statusText="Vence en 10 días"
      />,
    );
    expect(html.length).toBeGreaterThan(0);
  });

  it("renders title and petName in header", () => {
    const html = render(
      <ReminderCard
        variant="upcoming"
        title="Antirrábica"
        petName="Fausto"
        statusText="Vence en 10 días"
      />,
    );
    expect(html).toContain("Antirrábica");
    expect(html).toContain("Fausto");
  });

  it("renders statusText as badge content", () => {
    const html = render(
      <ReminderCard
        variant="due_soon"
        title="Vacuna múltiple"
        petName="Lola"
        statusText="Vence en 3 días"
      />,
    );
    expect(html).toContain("Vence en 3 días");
  });

  it("renders dueAt when provided", () => {
    const html = render(
      <ReminderCard
        variant="overdue"
        title="Antirrábica"
        petName="Rex"
        statusText="Vencida hace 5 días"
        dueAt="15 de mayo de 2026"
      />,
    );
    expect(html).toContain("15 de mayo de 2026");
  });

  it("renders actions slot when provided", () => {
    const html = render(
      <ReminderCard
        variant="upcoming"
        title="Antirrábica"
        petName="Fausto"
        statusText="Vence en 10 días"
        actions={<button type="button">Registrar</button>}
      />,
    );
    expect(html).toContain("Registrar");
  });

  it("adds role=alert for overdue_critical variant", () => {
    const html = render(
      <ReminderCard
        variant="overdue_critical"
        title="Antirrábica"
        petName="Rex"
        statusText="Vencida hace 45 días"
      />,
    );
    expect(html).toContain('role="alert"');
  });

  it("does NOT add role=alert for non-critical variants", () => {
    const html = render(
      <ReminderCard
        variant="overdue"
        title="Antirrábica"
        petName="Rex"
        statusText="Vencida hace 5 días"
      />,
    );
    expect(html).not.toContain('role="alert"');
  });

  it("contains ln-* token classes and zero gob-* substrings", () => {
    const variants = ["upcoming", "due_soon", "overdue", "overdue_critical", "success"] as const;
    for (const variant of variants) {
      const html = render(
        <ReminderCard variant={variant} title="Antirrábica" petName="Fausto" statusText="test" />,
      );
      expect(html, `variant=${variant} must contain ln-* token`).toMatch(/color-ln-|ln-/);
      expect(html, `variant=${variant} must not contain gob-`).not.toMatch(/\bgob-/);
    }
  });

  it("wraps content in an <article> element", () => {
    const html = render(
      <ReminderCard
        variant="success"
        title="Antirrábica"
        petName="Fausto"
        statusText="Registrada"
      />,
    );
    expect(html).toMatch(/<article[^>]*>/);
  });
});
