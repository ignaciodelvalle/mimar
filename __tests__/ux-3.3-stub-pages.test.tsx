/**
 * UX 3.3 — Stub pages / accessibility claim remediation tests.
 *
 * Covers:
 * 1. /accesibilidad no longer makes an unqualified WCAG-conformance claim.
 *    It uses honest "apuntando" / "no certificado" framing and does NOT say
 *    "está construido siguiendo las pautas WCAG 2.1" as a blanket claim.
 * 2. /accesibilidad includes the honest target framing (WCAG 2.1 AA) and the
 *    "no formal audit/certification" disclaimer.
 * 3. AppFooter DEFAULT_COLUMNS no longer contains a link to /sugerencias
 *    (hidden until a real feedback channel is implemented).
 * 4. AppFooter still contains links to the pages that now have real content
 *    (/acerca, /ayuda, /accesibilidad, /cookies).
 * 5. /accesibilidad page renders a single <h1> (no duplicate landmark-level
 *    headings at h1) and does NOT add a <main> (AppShell owns that).
 *
 * Pattern: react-dom/server renderToStaticMarkup (repo convention — no jsdom).
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// next/link — render as plain <a> for static markup tests
// ---------------------------------------------------------------------------

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
    target,
    rel,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    target?: string;
    rel?: string;
  }) => React.createElement("a", { href, className, target, rel }, children),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countMatches(html: string, pattern: RegExp): number {
  return (html.match(pattern) ?? []).length;
}

// ---------------------------------------------------------------------------
// 1–5: AccesibilidadPage
// ---------------------------------------------------------------------------

import AccesibilidadPage from "@/app/(public)/accesibilidad/page";

describe("AccesibilidadPage — honest accessibility statement (UX 3.3)", () => {
  let html: string;

  beforeAll(() => {
    html = renderToStaticMarkup(React.createElement(AccesibilidadPage));
  });

  it("does NOT make the old unqualified conformance claim", () => {
    // The old false claim was exactly:
    // "miMAR está construido siguiendo las pautas WCAG 2.1"
    expect(html).not.toContain("está construido siguiendo las pautas WCAG 2.1");
  });

  it("mentions WCAG 2.1 AA as the target (not a achieved conformance claim)", () => {
    expect(html).toContain("WCAG 2.1 AA");
  });

  it("includes an honest disclaimer about the lack of formal audit/certification", () => {
    // The page must say it's not certified / formally audited.
    // Accept either "no certificado" or "no contamos con una auditoría formal".
    const hasCertDisclaimer =
      html.includes("no contamos con una auditoría formal") ||
      html.includes("no certificad") ||
      html.includes("Sin auditoría independiente");
    expect(hasCertDisclaimer).toBe(true);
  });

  it("does not add a <main> element (AppShell citizen shell owns that)", () => {
    // Page content renders inside AppShell's <main id="main-content">.
    // The page component itself must NOT add another <main>.
    expect(html).not.toContain("<main");
  });

  it("renders exactly one <h1>", () => {
    expect(countMatches(html, /<h1[\s>]/g)).toBe(1);
  });

  it("includes a contact channel for accessibility issues", () => {
    // Must point users somewhere to report accessibility problems.
    expect(html).toContain("/sugerencias");
  });
});

// ---------------------------------------------------------------------------
// 6–8: AppFooter — /sugerencias link removed, real pages still linked
// ---------------------------------------------------------------------------

import { AppFooter } from "@/components/layout/AppFooter";

vi.mock("@/lib/ui/branding", () => ({
  BRANDING: {
    appName: "miMAR",
    appNameLong: "Mi Mascota Argentina",
    tagline: "Credencial digital sanitaria",
  },
}));

vi.mock("@/components/layout/GobStripe", () => ({
  GobStripe: () => React.createElement("div", { "data-testid": "gob-stripe" }),
}));

describe("AppFooter — /sugerencias hidden, real-content pages still linked (UX 3.3)", () => {
  let html: string;

  beforeAll(() => {
    html = renderToStaticMarkup(React.createElement(AppFooter));
  });

  it("does NOT link to /sugerencias", () => {
    expect(html).not.toContain('href="/sugerencias"');
  });

  it("still links to /accesibilidad (now has real content)", () => {
    expect(html).toContain('href="/accesibilidad"');
  });

  it("still links to /acerca (now has real content)", () => {
    expect(html).toContain('href="/acerca"');
  });

  it("still links to /ayuda (now has real content)", () => {
    expect(html).toContain('href="/ayuda"');
  });

  it("still links to /cookies (now has real content)", () => {
    expect(html).toContain('href="/cookies"');
  });
});
