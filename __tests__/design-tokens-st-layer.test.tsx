/**
 * Design-token semantic layer — st-* migration guard (design PR-1).
 *
 * Asserts that operator status components emit CSS custom-property references
 * for st-* tokens, NOT raw ln-op-ok/warn/danger/viol class utilities.
 *
 * Zero-visual-diff proof: because .op-surface remaps --color-st-* to the same
 * underlying ln-op-* hex values, the rendered color is identical. This test
 * guards against accidentally regressing the class strings back to the raw
 * utilities in a future refactor.
 *
 * Pattern: renderToStaticMarkup (repo convention — no jsdom, no DB).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CaseStatusBadge } from "@/components/ui/dashboard/CaseStatusBadge";
import { OpKpi } from "@/components/ui/dashboard/OpKpi";
import { OpPill } from "@/components/ui/dashboard/OpPill";
import { OpStateBadge } from "@/components/ui/dashboard/OpStateBadge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert that HTML contains a CSS variable reference for the given st-* token name. */
function expectStToken(html: string, tokenSuffix: string): void {
  const varRef = `var(--color-st-${tokenSuffix})`;
  expect(html, `expected st-* token reference: ${varRef}`).toContain(varRef);
}

/** Assert that HTML does NOT contain a raw ln-op-ok/warn/danger/viol class utility. */
function expectNoRawOpStatus(html: string): void {
  // These are the four raw utilities the st-* layer replaces.
  const banned = [
    "text-ln-op-ok",
    "text-ln-op-warn",
    "text-ln-op-danger",
    "text-ln-op-viol",
    "bg-ln-op-ok-bg",
    "bg-ln-op-warn-bg",
    "bg-ln-op-danger-bg",
    "bg-ln-op-viol-bg",
    "border-ln-op-ok-bd",
    "border-ln-op-warn-bd",
    "border-ln-op-danger-bd",
    "border-ln-op-viol-bd",
  ];
  for (const cls of banned) {
    expect(
      html,
      `raw ln-op status class found: "${cls}" — should be st-* token reference`,
    ).not.toContain(cls);
  }
}

// ---------------------------------------------------------------------------
// OpPill
// ---------------------------------------------------------------------------

describe("OpPill — emits st-* token references, not raw ln-op status classes", () => {
  it('tone="open" (warn) uses --color-st-warn-*', () => {
    const html = renderToStaticMarkup(<OpPill tone="open">Abierto</OpPill>);
    expectStToken(html, "warn-bg");
    expectStToken(html, "warn");
    expectNoRawOpStatus(html);
  });

  it('tone="escalated" (err) uses --color-st-err-*', () => {
    const html = renderToStaticMarkup(<OpPill tone="escalated">Escalado</OpPill>);
    expectStToken(html, "err-bg");
    expectStToken(html, "err");
    expectNoRawOpStatus(html);
  });

  it('tone="danger" (err) uses --color-st-err-*', () => {
    const html = renderToStaticMarkup(<OpPill tone="danger">Peligro</OpPill>);
    expectStToken(html, "err-bg");
    expectStToken(html, "err");
    expectNoRawOpStatus(html);
  });

  it('tone="progress" (info) uses --color-st-info-*', () => {
    const html = renderToStaticMarkup(<OpPill tone="progress">En curso</OpPill>);
    expectStToken(html, "info-bg");
    expectStToken(html, "info");
    expectNoRawOpStatus(html);
  });

  it('tone="closed" (ok) uses --color-st-ok-*', () => {
    const html = renderToStaticMarkup(<OpPill tone="closed">Cerrado</OpPill>);
    expectStToken(html, "ok-bg");
    expectStToken(html, "ok");
    expectNoRawOpStatus(html);
  });

  it('tone="ok" uses --color-st-ok-*', () => {
    const html = renderToStaticMarkup(<OpPill tone="ok">OK</OpPill>);
    expectStToken(html, "ok-bg");
    expectStToken(html, "ok");
    expectNoRawOpStatus(html);
  });

  it('tone="triaged" and "neutral" use non-status (ln-op-*) classes — no regression', () => {
    const triaged = renderToStaticMarkup(<OpPill tone="triaged">Triaged</OpPill>);
    expect(triaged).toContain("ln-op-blue-bg");
    const neutral = renderToStaticMarkup(<OpPill tone="neutral">Neutral</OpPill>);
    expect(neutral).toContain("ln-op-stripe");
  });
});

// ---------------------------------------------------------------------------
// OpStateBadge
// ---------------------------------------------------------------------------

describe("OpStateBadge — emits st-* token references, not raw ln-op status classes", () => {
  it('state="published" (ok) uses --color-st-ok-*', () => {
    const html = renderToStaticMarkup(<OpStateBadge state="published" />);
    expectStToken(html, "ok-bg");
    expectStToken(html, "ok");
    expectNoRawOpStatus(html);
  });

  it('state="paused" (warn) uses --color-st-warn-*', () => {
    const html = renderToStaticMarkup(<OpStateBadge state="paused" />);
    expectStToken(html, "warn-bg");
    expectStToken(html, "warn");
    expectNoRawOpStatus(html);
  });

  it('state="draft" uses non-status (ln-op-stripe) class — no regression', () => {
    const html = renderToStaticMarkup(<OpStateBadge state="draft" />);
    expect(html).toContain("ln-op-stripe");
  });

  it('state="adopted" (info) uses --color-st-info-*', () => {
    const html = renderToStaticMarkup(<OpStateBadge state="adopted" />);
    expectStToken(html, "info-bg");
    expectStToken(html, "info");
    expectNoRawOpStatus(html);
  });
});

// ---------------------------------------------------------------------------
// CaseStatusBadge
// ---------------------------------------------------------------------------

// F2 grammar fix: open→st-warn (amber/needs-action), escalated→st-err (red),
// closed→st-ok (green/resolved), merged→st-info (violet). Matches OpPill grammar.
describe("CaseStatusBadge — emits st-* token references, not raw ln-op status classes", () => {
  it('status="open" (warn) uses --color-st-warn-* (amber — needs action)', () => {
    const html = renderToStaticMarkup(<CaseStatusBadge status="open" />);
    expectStToken(html, "warn-bg");
    expectStToken(html, "warn");
    expectNoRawOpStatus(html);
  });

  it('status="escalated" (err) uses --color-st-err-*', () => {
    const html = renderToStaticMarkup(<CaseStatusBadge status="escalated" />);
    expectStToken(html, "err-bg");
    expectStToken(html, "err");
    expectNoRawOpStatus(html);
  });

  it('status="closed" (ok) uses --color-st-ok-* (green — resolved)', () => {
    const html = renderToStaticMarkup(<CaseStatusBadge status="closed" />);
    expectStToken(html, "ok-bg");
    expectStToken(html, "ok");
    expectNoRawOpStatus(html);
  });

  it('status="merged" (info) uses --color-st-info-*', () => {
    const html = renderToStaticMarkup(<CaseStatusBadge status="merged" />);
    expectStToken(html, "info-bg");
    expectStToken(html, "info");
    expectNoRawOpStatus(html);
  });
});

// ---------------------------------------------------------------------------
// OpKpi — toneCard / toneValue / delta classes
// ---------------------------------------------------------------------------

describe("OpKpi — emits st-* token references for status tones", () => {
  it('tone="danger" uses --color-st-err-* for card bg/border and value text', () => {
    const html = renderToStaticMarkup(<OpKpi label="Cobertura" value="9%" tone="danger" />);
    expectStToken(html, "err-bg");
    expectStToken(html, "err-bd");
    expectStToken(html, "err");
    expectNoRawOpStatus(html);
  });

  it('tone="warn" uses --color-st-warn-* for card bg/border and value text', () => {
    const html = renderToStaticMarkup(<OpKpi label="Ocupación" value="72%" tone="warn" />);
    expectStToken(html, "warn-bg");
    expectStToken(html, "warn-bd");
    expectStToken(html, "warn");
    expectNoRawOpStatus(html);
  });

  it('tone="ok" uses --color-st-ok-* for card bg/border and value text', () => {
    const html = renderToStaticMarkup(<OpKpi label="Vacunados" value="92%" tone="ok" />);
    expectStToken(html, "ok-bg");
    expectStToken(html, "ok-bd");
    expectStToken(html, "ok");
    expectNoRawOpStatus(html);
  });

  it('tone="neutral" uses ln-op-card / ln-op-line (non-status) — no regression', () => {
    const html = renderToStaticMarkup(<OpKpi label="Total" value={42} tone="neutral" />);
    expect(html).toContain("ln-op-card");
    expect(html).toContain("ln-op-line");
  });

  it("delta up uses --color-st-ok for the direction text", () => {
    const html = renderToStaticMarkup(
      <OpKpi label="Total" value={42} delta={{ text: "+5%", up: true }} />,
    );
    expectStToken(html, "ok");
    expectNoRawOpStatus(html);
  });

  it("delta down uses --color-st-err for the direction text", () => {
    const html = renderToStaticMarkup(
      <OpKpi label="Total" value={42} delta={{ text: "-3%", up: false }} />,
    );
    expectStToken(html, "err");
    expectNoRawOpStatus(html);
  });

  it("deltaV2 positive uses --color-st-ok", () => {
    const html = renderToStaticMarkup(
      <OpKpi label="Total" value={42} deltaV2={{ value: 12, period: "vs mes anterior" }} />,
    );
    expectStToken(html, "ok");
    expectNoRawOpStatus(html);
  });

  it("deltaV2 negative uses --color-st-err", () => {
    const html = renderToStaticMarkup(
      <OpKpi label="Total" value={42} deltaV2={{ value: -3, period: "vs mes anterior" }} />,
    );
    expectStToken(html, "err");
    expectNoRawOpStatus(html);
  });
});
