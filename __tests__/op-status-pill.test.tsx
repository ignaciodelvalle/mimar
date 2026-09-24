/**
 * Tests for OpStatusPill primitive and the grammar contract across wrappers.
 *
 * Coverage:
 *  1. OpStatusPill: each tone emits the correct st-* CSS variable references.
 *  2. CaseStatusBadge: label + tone per status (canonical F2 grammar).
 *  3. OpStateBadge: label + tone per state (domain enum — unchanged from PR-1).
 *  4. OpPill: tone per tone enum value.
 *  5. Cross-component grammar invariant: same semantic term → same resolved
 *     color token in CaseStatusBadge and OpPill ("open" → st-warn in both).
 *
 * Pattern: renderToStaticMarkup (repo convention — no jsdom, no DB).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CaseBadge } from "@/components/CaseBadge";
import { CaseStatusBadge } from "@/components/ui/dashboard/CaseStatusBadge";
import { OpPill } from "@/components/ui/dashboard/OpPill";
import { OpStateBadge } from "@/components/ui/dashboard/OpStateBadge";
import { OpStatusPill } from "@/components/ui/dashboard/OpStatusPill";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectStToken(html: string, tokenSuffix: string): void {
  const varRef = `var(--color-st-${tokenSuffix})`;
  expect(html, `expected st-* token: ${varRef}`).toContain(varRef);
}

function expectNoRawStatus(html: string): void {
  const banned = [
    "text-ln-op-ok",
    "text-ln-op-warn",
    "text-ln-op-danger",
    "text-ln-op-viol",
    "bg-ln-op-ok-bg",
    "bg-ln-op-warn-bg",
    "bg-ln-op-danger-bg",
    "bg-ln-op-viol-bg",
  ];
  for (const cls of banned) {
    expect(html, `raw ln-op status class found: "${cls}"`).not.toContain(cls);
  }
}

/** Extract the first bg CSS variable reference from an HTML string. */
function extractBgToken(html: string): string | null {
  const match = html.match(/bg-\[var\((--color-[^)]+)\)\]/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// 1. OpStatusPill — primitive tone rendering
// ---------------------------------------------------------------------------

describe("OpStatusPill — tone → CSS variable mapping", () => {
  it('tone="st-ok" emits --color-st-ok-* references', () => {
    const html = renderToStaticMarkup(<OpStatusPill tone="st-ok">Cerrado</OpStatusPill>);
    expectStToken(html, "ok-bg");
    expectStToken(html, "ok");
    expectNoRawStatus(html);
  });

  it('tone="st-warn" emits --color-st-warn-* references', () => {
    const html = renderToStaticMarkup(<OpStatusPill tone="st-warn">Abierto</OpStatusPill>);
    expectStToken(html, "warn-bg");
    expectStToken(html, "warn");
    expectNoRawStatus(html);
  });

  it('tone="st-err" emits --color-st-err-* references', () => {
    const html = renderToStaticMarkup(<OpStatusPill tone="st-err">Escalado</OpStatusPill>);
    expectStToken(html, "err-bg");
    expectStToken(html, "err");
    expectNoRawStatus(html);
  });

  it('tone="st-info" emits --color-st-info-* references', () => {
    const html = renderToStaticMarkup(<OpStatusPill tone="st-info">Fusionado</OpStatusPill>);
    expectStToken(html, "info-bg");
    expectStToken(html, "info");
    expectNoRawStatus(html);
  });

  it('tone="neutral" emits ln-op-stripe (non-status) — no regression', () => {
    const html = renderToStaticMarkup(<OpStatusPill tone="neutral">Borrador</OpStatusPill>);
    expect(html).toContain("ln-op-stripe");
  });

  it("renders icon as aria-hidden when provided", () => {
    const html = renderToStaticMarkup(
      <OpStatusPill tone="st-ok" icon="●">
        Publicado
      </OpStatusPill>,
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("●");
    expect(html).toContain("Publicado");
  });

  it("renders children as accessible label", () => {
    const html = renderToStaticMarkup(<OpStatusPill tone="st-warn">Pendiente</OpStatusPill>);
    expect(html).toContain("Pendiente");
  });

  it("uses the unified operator-chip geometry, from the token", () => {
    // E-2 (2026-08-10): el valor no cambió, cambió de dónde sale. Cuatro sitios
    // tipeaban `rounded-[3px]` por separado; ahora los cuatro leen
    // --radius-op-chip. La aserción sigue al token, y
    // __tests__/chip-radius-doctrine.test.ts ancla que ese token siga valiendo
    // 3px — sin ese ancla, esto pasaría aunque alguien lo moviera a 16px.
    const html = renderToStaticMarkup(<OpStatusPill tone="st-ok">Label</OpStatusPill>);
    expect(html).toContain("rounded-[var(--radius-op-chip)]");
  });

  it("uses font-ln-mono typography", () => {
    const html = renderToStaticMarkup(<OpStatusPill tone="st-ok">Label</OpStatusPill>);
    expect(html).toContain("font-ln-mono");
  });
});

// ---------------------------------------------------------------------------
// 2. CaseStatusBadge — label + tone (F2 canonical grammar)
// ---------------------------------------------------------------------------

describe("CaseStatusBadge — canonical F2 grammar (label + tone)", () => {
  it('status="open" renders "Abierto" with st-warn (amber)', () => {
    const html = renderToStaticMarkup(<CaseStatusBadge status="open" />);
    expect(html).toContain("Abierto");
    expectStToken(html, "warn-bg");
    expectStToken(html, "warn");
  });

  it('status="escalated" renders "Escalado" with st-err (red)', () => {
    const html = renderToStaticMarkup(<CaseStatusBadge status="escalated" />);
    expect(html).toContain("Escalado");
    expectStToken(html, "err-bg");
    expectStToken(html, "err");
  });

  it('status="closed" renders "Cerrado" with st-ok (green)', () => {
    const html = renderToStaticMarkup(<CaseStatusBadge status="closed" />);
    expect(html).toContain("Cerrado");
    expectStToken(html, "ok-bg");
    expectStToken(html, "ok");
  });

  it('status="merged" renders "Fusionado" with st-info (violet)', () => {
    const html = renderToStaticMarkup(<CaseStatusBadge status="merged" />);
    expect(html).toContain("Fusionado");
    expectStToken(html, "info-bg");
    expectStToken(html, "info");
  });

  it("renders a custom label override when provided", () => {
    const html = renderToStaticMarkup(<CaseStatusBadge status="open" label="En revisión" />);
    expect(html).toContain("En revisión");
    expect(html).not.toContain("Abierto");
  });
});

// ---------------------------------------------------------------------------
// 3. OpStateBadge — label + tone (domain enum, unchanged from PR-1)
// ---------------------------------------------------------------------------

describe("OpStateBadge — domain enum label + tone", () => {
  it('state="published" renders "Publicado" with st-ok', () => {
    const html = renderToStaticMarkup(<OpStateBadge state="published" />);
    expect(html).toContain("Publicado");
    expectStToken(html, "ok-bg");
  });

  it('state="paused" renders "Pausado" with st-warn', () => {
    const html = renderToStaticMarkup(<OpStateBadge state="paused" />);
    expect(html).toContain("Pausado");
    expectStToken(html, "warn-bg");
  });

  it('state="draft" renders "Borrador" with neutral tone', () => {
    const html = renderToStaticMarkup(<OpStateBadge state="draft" />);
    expect(html).toContain("Borrador");
    expect(html).toContain("ln-op-stripe");
  });

  it('state="adopted" renders "Adoptado" with st-info', () => {
    const html = renderToStaticMarkup(<OpStateBadge state="adopted" />);
    expect(html).toContain("Adoptado");
    expectStToken(html, "info-bg");
  });

  it("renders icon as aria-hidden for all states", () => {
    for (const state of ["published", "paused", "draft", "adopted"] as const) {
      const html = renderToStaticMarkup(<OpStateBadge state={state} />);
      expect(html, `state=${state} should have aria-hidden icon`).toContain('aria-hidden="true"');
    }
  });

  it("renders a custom label override when provided", () => {
    const html = renderToStaticMarkup(<OpStateBadge state="published" label="Activo" />);
    expect(html).toContain("Activo");
    expect(html).not.toContain("Publicado");
  });
});

// ---------------------------------------------------------------------------
// 4. OpPill — tone enum → st-* mapping
// ---------------------------------------------------------------------------

describe("OpPill — tone → st-* mapping", () => {
  it('tone="open" uses st-warn', () => {
    const html = renderToStaticMarkup(<OpPill tone="open">Abierto</OpPill>);
    expectStToken(html, "warn-bg");
    expectStToken(html, "warn");
  });

  it('tone="escalated" uses st-err', () => {
    const html = renderToStaticMarkup(<OpPill tone="escalated">Escalado</OpPill>);
    expectStToken(html, "err-bg");
    expectStToken(html, "err");
  });

  it('tone="danger" uses st-err', () => {
    const html = renderToStaticMarkup(<OpPill tone="danger">Peligro</OpPill>);
    expectStToken(html, "err-bg");
    expectStToken(html, "err");
  });

  it('tone="closed" uses st-ok', () => {
    const html = renderToStaticMarkup(<OpPill tone="closed">Cerrado</OpPill>);
    expectStToken(html, "ok-bg");
    expectStToken(html, "ok");
  });

  it('tone="ok" uses st-ok', () => {
    const html = renderToStaticMarkup(<OpPill tone="ok">OK</OpPill>);
    expectStToken(html, "ok-bg");
    expectStToken(html, "ok");
  });

  it('tone="progress" uses st-info', () => {
    const html = renderToStaticMarkup(<OpPill tone="progress">En curso</OpPill>);
    expectStToken(html, "info-bg");
    expectStToken(html, "info");
  });

  it('tone="neutral" uses neutral (ln-op-stripe)', () => {
    const html = renderToStaticMarkup(<OpPill tone="neutral">Neutro</OpPill>);
    expect(html).toContain("ln-op-stripe");
  });

  it('tone="triaged" uses ln-op-blue-* (non-status passthrough)', () => {
    const html = renderToStaticMarkup(<OpPill tone="triaged">Triaged</OpPill>);
    expect(html).toContain("ln-op-blue-bg");
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-component grammar invariant: same term → same tone
// ---------------------------------------------------------------------------

describe("Cross-component grammar invariant — same term, same resolved color token", () => {
  /** First bg-[var(...)] token of the CaseBadge status pill for a given status. */
  function caseBadgeBg(status: "open" | "escalated" | "closed" | "merged"): string | null {
    const html = renderToStaticMarkup(
      <CaseBadge publicCode="CAS-TEST-0001" caseKind="bite_incident" status={status} />,
    );
    return extractBgToken(html);
  }

  it('"open" → st-warn in CaseStatusBadge, OpPill and CaseBadge', () => {
    const caseHtml = renderToStaticMarkup(<CaseStatusBadge status="open" />);
    const pillHtml = renderToStaticMarkup(<OpPill tone="open">Abierto</OpPill>);

    const caseBg = extractBgToken(caseHtml);
    const pillBg = extractBgToken(pillHtml);

    expect(caseBg).toBe("--color-st-warn-bg");
    expect(pillBg).toBe("--color-st-warn-bg");
    expect(caseBadgeBg("open")).toBe("--color-st-warn-bg");
    expect(caseBg).toBe(pillBg);
  });

  it('"escalated" → st-err in CaseStatusBadge, OpPill and CaseBadge', () => {
    const caseHtml = renderToStaticMarkup(<CaseStatusBadge status="escalated" />);
    const pillHtml = renderToStaticMarkup(<OpPill tone="escalated">Escalado</OpPill>);

    const caseBg = extractBgToken(caseHtml);
    const pillBg = extractBgToken(pillHtml);

    expect(caseBg).toBe("--color-st-err-bg");
    expect(pillBg).toBe("--color-st-err-bg");
    expect(caseBadgeBg("escalated")).toBe("--color-st-err-bg");
    expect(caseBg).toBe(pillBg);
  });

  it('"closed" → st-ok in CaseStatusBadge, OpPill and CaseBadge', () => {
    const caseHtml = renderToStaticMarkup(<CaseStatusBadge status="closed" />);
    const pillHtml = renderToStaticMarkup(<OpPill tone="closed">Cerrado</OpPill>);

    const caseBg = extractBgToken(caseHtml);
    const pillBg = extractBgToken(pillHtml);

    expect(caseBg).toBe("--color-st-ok-bg");
    expect(pillBg).toBe("--color-st-ok-bg");
    expect(caseBadgeBg("closed")).toBe("--color-st-ok-bg");
    expect(caseBg).toBe(pillBg);
  });

  it('"merged/progress" → st-info in CaseStatusBadge, OpPill and CaseBadge', () => {
    const caseHtml = renderToStaticMarkup(<CaseStatusBadge status="merged" />);
    const pillHtml = renderToStaticMarkup(<OpPill tone="progress">En curso</OpPill>);

    const caseBg = extractBgToken(caseHtml);
    const pillBg = extractBgToken(pillHtml);

    expect(caseBg).toBe("--color-st-info-bg");
    expect(pillBg).toBe("--color-st-info-bg");
    expect(caseBadgeBg("merged")).toBe("--color-st-info-bg");
    expect(caseBg).toBe(pillBg);
  });
});
