// The skip link's target must exist on the 404 — and exactly once (S6-F05).
//
// app/layout.tsx renders "Ir al contenido principal" on EVERY page, pointing at
// #main-content. The root not-found is the one page that renders with no shell
// above it (an unmatched URL bypasses the route groups), so it had no landmark
// and the skip link resolved to nothing.
//
// The pairing matters more than either assertion alone: the obvious fix is to
// put the <main> inside the shared BrandedNotFound, which would give the four
// SHELLED not-found pages a second <main> and a duplicate id. So this file
// asserts both directions — the root page HAS the landmark, the shared
// component does NOT bring its own.

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import RootNotFound from "@/app/not-found";
import { BrandedNotFound } from "@/components/BrandedNotFound";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

function countMatches(html: string, re: RegExp): number {
  return (html.match(re) ?? []).length;
}

describe("root not-found — the skip link has somewhere to go", () => {
  it("renders exactly one <main id='main-content'>", () => {
    const html = render(<RootNotFound />);
    expect(countMatches(html, /id="main-content"/g)).toBe(1);
    expect(countMatches(html, /<main\b/g)).toBe(1);
  });

  it("still renders the branded 404 body inside it", () => {
    // Non-vacuity: a bare <main> with the content dropped would satisfy the
    // landmark count above while shipping an empty page.
    const html = render(<RootNotFound />);
    expect(html).toContain("branded-not-found");
    expect(html).toContain("No encontramos esta página");
  });
});

describe("BrandedNotFound — brings no landmark of its own", () => {
  it("renders no <main>, so the shelled not-found pages keep exactly one", () => {
    // (app), admin, gob and (public) render their not-found INSIDE their
    // group's AppShell, which already owns the single #main-content.
    const html = render(<BrandedNotFound />);
    expect(countMatches(html, /<main\b/g)).toBe(0);
    expect(countMatches(html, /id="main-content"/g)).toBe(0);
  });
});
