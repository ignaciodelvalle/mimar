// @vitest-environment jsdom
//
// DegradedFallback — timed loading escalation (degraded-states 2026-08-06).
//
// The escalation contract is PURE CSS (animation-delay, no JS timers), so
// these tests assert the MECHANISM, not wall-clock time:
//   1. no false-degraded flash — both degraded blocks are gated behind
//      `.degraded-reveal` + an inline animation-delay, so a fast load only
//      ever shows the base skeleton;
//   2. delays come from lib/ui/degraded-states.ts constants, never hardcoded;
//   3. the card is LnEmptyState anatomy WITHOUT the forbidden nature+action
//      pairing;
//   4. "Seguir esperando" bumps the card wrapper's key (restarting the CSS
//      cycle) without any navigation;
//   5. SSR baseline — the fallback HTML is non-blank with zero JS/hydration
//      (and the JS-only affordance is absent from server markup);
//   6. reduced-motion coupling — the global rule zeroes animation-duration
//      but NOT animation-delay (guard at BOTH ends: this test + the comment
//      in app/globals.css).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { DEGRADED_CARD_MS, DEGRADED_COPY, DEGRADED_TEXT_MS } from "@/lib/ui/degraded-states";
import { DegradedFallback } from "./DegradedFallback";

// Vitest's cwd is the repo root (vitest.config.ts lives there).
const GLOBALS_CSS_PATH = resolve(process.cwd(), "app/globals.css");

afterEach(() => {
  cleanup();
});

function ssr(): string {
  return renderToStaticMarkup(
    <DegradedFallback>
      <div data-testid="skeleton">skeleton-content</div>
    </DegradedFallback>,
  );
}

describe("<DegradedFallback> — escalation mechanism", () => {
  it("gates BOTH degraded blocks behind .degraded-reveal with an inline delay (no false-degraded flash on fast loads)", () => {
    const html = ssr();
    const reveals = html.match(/degraded-reveal/g) ?? [];
    // Card wrapper + waiting text — each hidden until its animation-delay.
    expect(reveals.length).toBe(2);
    expect(html).toContain("animation-delay");
    // The skeleton children render immediately, un-gated.
    expect(html).toContain("skeleton-content");
  });

  it("sources its delays from lib/ui/degraded-states.ts constants, not hardcoded values", () => {
    const html = ssr();
    expect(html).toContain(`animation-delay:${DEGRADED_TEXT_MS}ms`);
    expect(html).toContain(`animation-delay:${DEGRADED_CARD_MS}ms`);
  });

  it("renders the LnEmptyState card anatomy with the spec copy", () => {
    const html = ssr();
    expect(html).toContain(DEGRADED_COPY.cardTitle);
    expect(html).toContain(DEGRADED_COPY.cardDescription);
    expect(html).toContain(DEGRADED_COPY.retry);
    expect(html).toContain(DEGRADED_COPY.slowText);
  });

  it("never pairs the card's action with an epistemic nature (LnEmptyState contract)", () => {
    const html = ssr();
    // A no-signal/protected nature would add role="status" + the warn
    // treatment; this card is a load failure, not an epistemic gap.
    expect(html).not.toContain('role="status"');
    expect(html).not.toMatch(/st-warn/);
  });

  it('makes "Reintentar" a plain full-document anchor, not a router action', () => {
    const html = ssr();
    expect(html).toMatch(/<a[^>]*href=""/);
  });
});

describe("<DegradedFallback> — SSR baseline (hydration never completes)", () => {
  it("renders a non-blank fallback without JS", () => {
    const html = ssr();
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("skeleton-content");
  });

  it('keeps the JS-only "Seguir esperando" out of server markup (hydration-gated)', () => {
    const html = ssr();
    expect(html).not.toContain(DEGRADED_COPY.keepWaiting);
  });
});

describe('<DegradedFallback> — "Seguir esperando" key bump', () => {
  it("restarts the CSS cycle by remounting the card wrapper, without navigating", () => {
    const { container } = render(
      <DegradedFallback>
        <div>skeleton</div>
      </DegradedFallback>,
    );
    const before = container.querySelector("[data-degraded-cycle]");
    expect(before).toHaveAttribute("data-degraded-cycle", "0");

    const hrefBefore = window.location.href;
    fireEvent.click(screen.getByRole("button", { name: DEGRADED_COPY.keepWaiting }));

    const after = container.querySelector("[data-degraded-cycle]");
    expect(after).toHaveAttribute("data-degraded-cycle", "1");
    // Remount = a fresh element = animation-delay counts again from zero.
    expect(after).not.toBe(before);
    // No forced navigation — the in-flight fetch keeps streaming.
    expect(window.location.href).toBe(hrefBefore);
  });
});

describe("<DegradedFallback> — unmount at the escalation boundary", () => {
  // Suspense resolving IS an unmount of the whole fallback tree, and it lands
  // at an arbitrary point in the escalation — possibly mid-reveal. Today that
  // is free: the schedule is CSS animation-delay, so there is nothing to clean
  // up. This test pins that. If someone ever reintroduces a JS timer, the
  // pending setState after unmount surfaces here as a React console error
  // instead of as a silent leak in production.
  it("unmounts mid-escalation with no pending work and no state update after unmount", () => {
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const { unmount } = render(
        <DegradedFallback>
          <div data-testid="skeleton">skeleton-content</div>
        </DegradedFallback>,
      );
      // Hydration-gated affordance is mounted: the component has run its
      // effect, so an unmount now is the "late arrival" shape.
      expect(screen.getByRole("button", { name: DEGRADED_COPY.keepWaiting })).toBeInTheDocument();
      // Bump the cycle first — a remounted card wrapper is the state most
      // likely to hold a handle in a timer-based rewrite.
      fireEvent.click(screen.getByRole("button", { name: DEGRADED_COPY.keepWaiting }));

      expect(() => unmount()).not.toThrow();
      expect(document.body.textContent).not.toContain(DEGRADED_COPY.slowText);
    } finally {
      console.error = originalError;
    }

    expect(
      errors,
      `React logged during unmount: ${errors.map((a) => String(a[0])).join(" | ")}`,
    ).toEqual([]);
  });
});

describe("reduced-motion coupling (app/globals.css — both ends)", () => {
  const css = readFileSync(GLOBALS_CSS_PATH, "utf8");

  function reducedMotionUniversalBlock(): string {
    // First `@media (prefers-reduced-motion: reduce)` block in the sheet is
    // the global kill switch ("Utilidades de movimiento"). Brace-scan to its
    // matching close so trailing comments never leak into the assertion.
    const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") {
        depth -= 1;
        if (depth === 0) return css.slice(start, i + 1);
      }
    }
    throw new Error("unbalanced reduced-motion block");
  }

  it("the global rule zeroes animation-duration but NOT animation-delay (the reveal must still wait)", () => {
    const block = reducedMotionUniversalBlock();
    expect(block).toContain("animation-duration");
    expect(block).not.toContain("animation-delay");
  });

  it("`.degraded-reveal` keeps its hidden `from` frame during the delay (backwards fill + visibility)", () => {
    expect(css).toMatch(/@keyframes degraded-reveal[\s\S]*?visibility:\s*hidden/);
    expect(css).toMatch(/\.degraded-reveal\s*\{[\s\S]*?backwards/);
  });

  it("timing lives inline (component), so reduced-motion's duration kill cannot zero it", () => {
    // The stylesheet never sets animation-delay for .degraded-reveal — the
    // delay ships inline from the constants (asserted in the SSR tests above).
    const revealRule = css.match(/\.degraded-reveal\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(revealRule).not.toMatch(/animation-delay\s*:/);
  });
});
