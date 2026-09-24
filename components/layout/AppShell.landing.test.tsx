// Phase C render test — landing + citizen shells expose exactly one
// #main-content landmark and no duplicate <main> (D11 / a11y).
//
// Pattern: renderToStaticMarkup (server-only) — AppShell is a server component,
// so no jsdom or next/navigation mock is needed. We render it the same way the
// migrated /libreta/compartir + /p landing layouts and the citizen layouts do,
// and count the structural landmarks.

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppShell } from "./AppShell";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

function countMatches(html: string, re: RegExp): number {
  return (html.match(re) ?? []).length;
}

describe("AppShell variant=landing — single main-content landmark", () => {
  it("renders exactly one #main-content and one <main>", () => {
    const html = render(
      <AppShell variant="landing">
        {/* The migrated page body is a plain <div>, NOT its own <main>. */}
        <div data-testid="page-body">Credencial</div>
      </AppShell>,
    );
    expect(countMatches(html, /id="main-content"/g)).toBe(1);
    expect(countMatches(html, /<main\b/g)).toBe(1);
    expect(html).toContain("Credencial registrada en miMAR");
    expect(html).toContain("page-body");
  });

  it("renders the discreet return slot only when provided (logged-in viewer)", () => {
    const withReturn = render(
      <AppShell variant="landing" returnSlot={<a href="/inicio">← Volver a mi app</a>}>
        <div>x</div>
      </AppShell>,
    );
    expect(withReturn).toContain("← Volver a mi app");

    const anon = render(
      <AppShell variant="landing">
        <div>x</div>
      </AppShell>,
    );
    expect(anon).not.toContain("Volver a mi app");
    // Still exactly one main-content for the anonymous landing.
    expect(countMatches(anon, /id="main-content"/g)).toBe(1);
  });

  // PO interview 2026-07-23, item 1: the demo banner must be inescapable on
  // EVERY surface, including the token-landing (QR-scan) shell — the most
  // public surface of all. LandingShell had no banner slot before this.
  it("renders an optional banner above the trust header (demo-mode banner slot)", () => {
    const withBanner = render(
      <AppShell variant="landing" banner={<div data-testid="demo-banner">DEMO</div>}>
        <div>x</div>
      </AppShell>,
    );
    expect(withBanner).toContain("demo-banner");
    expect(withBanner.indexOf("demo-banner")).toBeLessThan(
      withBanner.indexOf("Credencial registrada en miMAR"),
    );

    const withoutBanner = render(
      <AppShell variant="landing">
        <div>x</div>
      </AppShell>,
    );
    expect(withoutBanner).not.toContain("demo-banner");
  });
});

describe("AppShell variant=citizen — single main-content landmark", () => {
  it("renders exactly one #main-content and one <main> around a plain page body", () => {
    const html = render(
      <AppShell variant="citizen" masthead={<header data-testid="masthead">nav</header>}>
        <div data-testid="page-body">contenido</div>
      </AppShell>,
    );
    // The page body must NOT carry its own <main>; the shell owns it.
    expect(countMatches(html, /id="main-content"/g)).toBe(1);
    expect(countMatches(html, /<main\b/g)).toBe(1);
    expect(html).toContain("page-body");
  });
});
