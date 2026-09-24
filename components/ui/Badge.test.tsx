// Smoke tests for <LnBadge>.
// Pattern: renderToStaticMarkup (server-only, no React DOM needed).

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LnBadge } from "./Badge";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("<LnBadge>", () => {
  it("renders children as a <span>", () => {
    const html = render(<LnBadge>AL DÍA</LnBadge>);
    expect(html).toMatch(/<span[^>]*>/);
    expect(html).toContain("AL DÍA");
  });

  it("applies aria-label when provided", () => {
    const html = render(<LnBadge icon="info" aria-label="Informativo" />);
    expect(html).toContain('aria-label="Informativo"');
  });

  it("neutral variant contains an ln-* token (no raw palette or gob-*)", () => {
    const html = render(<LnBadge variant="neutral">NEUTRAL</LnBadge>);
    expect(html).toMatch(/--color-ln-/);
    expect(html).not.toMatch(/\bgob-/);
  });

  it("info variant contains ln-azul token", () => {
    const html = render(<LnBadge variant="info">INFO</LnBadge>);
    expect(html).toContain("color-ln-azul");
    expect(html).not.toMatch(/\bgob-/);
  });

  it("success variant contains ln-ok token", () => {
    const html = render(<LnBadge variant="success">OK</LnBadge>);
    expect(html).toContain("color-ln-ok");
    expect(html).not.toMatch(/\bgob-/);
  });

  it("warning variant contains ln-warn token", () => {
    const html = render(<LnBadge variant="warning">WARN</LnBadge>);
    expect(html).toContain("color-ln-warn");
    expect(html).not.toMatch(/\bgob-/);
  });

  it("danger variant contains ln-err token", () => {
    const html = render(<LnBadge variant="danger">PELIGRO</LnBadge>);
    expect(html).toContain("color-ln-err");
    expect(html).not.toMatch(/\bgob-/);
  });

  it("zero gob-* substrings across all variants", () => {
    const variants = ["info", "success", "warning", "danger", "neutral"] as const;
    for (const v of variants) {
      const html = render(<LnBadge variant={v}>test</LnBadge>);
      expect(html, `variant=${v} must not contain gob-`).not.toMatch(/\bgob-/);
    }
  });
});
