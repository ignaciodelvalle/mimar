// Smoke tests for <LnAlert>.
// Pattern: renderToStaticMarkup (server-only, no React DOM needed).
// Note: LnAlert is "use client" but renderToStaticMarkup works fine here —
// no hooks are exercised during server render of the base markup.

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LnAlert } from "./Alert";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("<LnAlert>", () => {
  it("renders role=alert", () => {
    const html = render(<LnAlert>Content</LnAlert>);
    expect(html).toContain('role="alert"');
  });

  it("renders children", () => {
    const html = render(<LnAlert>Something went wrong</LnAlert>);
    expect(html).toContain("Something went wrong");
  });

  it("renders title when provided", () => {
    const html = render(<LnAlert title="Atención">Body text</LnAlert>);
    expect(html).toContain("Atención");
    expect(html).toContain("Body text");
  });

  it("renders dismiss button with aria-label=Cerrar when onDismiss is provided", () => {
    const html = render(<LnAlert onDismiss={() => {}}>Dismissable</LnAlert>);
    expect(html).toContain('aria-label="Cerrar"');
    expect(html).toMatch(/<button[^>]*type="button"/);
  });

  it("does NOT render dismiss button when onDismiss is absent", () => {
    const html = render(<LnAlert>No dismiss</LnAlert>);
    expect(html).not.toContain('aria-label="Cerrar"');
  });

  it("info variant contains an ln-* token and zero gob-*", () => {
    const html = render(<LnAlert variant="info">Info</LnAlert>);
    expect(html).toMatch(/--color-ln-/);
    expect(html).not.toMatch(/\bgob-/);
  });

  it("success variant contains ln-ok token", () => {
    const html = render(<LnAlert variant="success">OK</LnAlert>);
    expect(html).toContain("color-ln-ok");
    expect(html).not.toMatch(/\bgob-/);
  });

  it("warning variant contains ln-warn token", () => {
    const html = render(<LnAlert variant="warning">Warn</LnAlert>);
    expect(html).toContain("color-ln-warn");
    expect(html).not.toMatch(/\bgob-/);
  });

  it("danger variant contains ln-err token", () => {
    const html = render(<LnAlert variant="danger">Error</LnAlert>);
    expect(html).toContain("color-ln-err");
    expect(html).not.toMatch(/\bgob-/);
  });

  it("zero gob-* across all variants", () => {
    const variants = ["info", "success", "warning", "danger"] as const;
    for (const v of variants) {
      const html = render(<LnAlert variant={v}>test</LnAlert>);
      expect(html, `variant=${v} must not contain gob-`).not.toMatch(/\bgob-/);
    }
  });
});
