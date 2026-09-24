// Smoke tests for <ErrorBoundary>.
//
// Render via react-dom/server → HTML string (same pattern as Badge.test.tsx /
// Checkbox.test.tsx). ErrorBoundary is a client component but uses only
// useEffect (no-op in SSR) and next/link (mocked below), so renderToStaticMarkup
// succeeds cleanly.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Mock next/link — server render requires an href-only anchor.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

import { ErrorBoundary } from "./ErrorBoundary";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const fakeError = Object.assign(new Error("algo explotó"), { digest: "d-abc123" });
const resetFn = vi.fn();

describe("<ErrorBoundary>", () => {
  it("renders without crashing", () => {
    const html = render(<ErrorBoundary error={fakeError} reset={resetFn} />);
    expect(html.length).toBeGreaterThan(0);
  });

  it("renders the heading 'Algo salió mal'", () => {
    const html = render(<ErrorBoundary error={fakeError} reset={resetFn} />);
    expect(html).toContain("Algo salió mal");
  });

  it("renders the digest instead of message", () => {
    const html = render(<ErrorBoundary error={fakeError} reset={resetFn} />);
    expect(html).toContain("d-abc123");
  });

  it("renders the default home link to '/'", () => {
    const html = render(<ErrorBoundary error={fakeError} reset={resetFn} />);
    expect(html).toContain('href="/"');
    expect(html).toContain("Volver al inicio");
  });

  it("renders a custom homeHref and homeLabel", () => {
    const html = render(
      <ErrorBoundary error={fakeError} reset={resetFn} homeHref="/inicio" homeLabel="Inicio" />,
    );
    expect(html).toContain('href="/inicio"');
    expect(html).toContain("Inicio");
  });

  it("contains ln-* token classes and zero gob-* substrings", () => {
    const html = render(<ErrorBoundary error={fakeError} reset={resetFn} />);
    expect(html).toMatch(/color-ln-/);
    expect(html).not.toMatch(/\bgob-/);
  });

  it("renders a Reintentar button", () => {
    const html = render(<ErrorBoundary error={fakeError} reset={resetFn} />);
    expect(html).toContain("Reintentar");
  });
});
