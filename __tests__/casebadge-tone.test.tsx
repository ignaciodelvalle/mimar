/**
 * CaseBadge — st-* tone migration guard (F2 holdout).
 *
 * `components/CaseBadge.tsx` is the inline chip used in pet-profile lists and
 * case index pages (/admin/casos, /gob/casos, /gob, pet profile). It carried
 * its OWN hardcoded STATUS_STYLES map and was the 5th status component left
 * outside the OpStatusPill/st-* grammar — it rendered "Abierto" in green
 * (ln-ok) instead of the canonical amber (needs-action).
 *
 * This test pins the canonical F2 grammar for CaseBadge and guards against a
 * regression back to the raw ln-* citizen utilities:
 *   open→st-warn (amber) · escalated→st-err (red) · closed→st-ok (green) ·
 *   merged→st-info (violet).
 *
 * Pattern: renderToStaticMarkup (repo convention — no jsdom, no DB).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CaseBadge } from "@/components/CaseBadge";
import type { CaseStatus } from "@/db";

/** Assert that HTML contains a CSS variable reference for the given st-* token. */
function expectStToken(html: string, tokenSuffix: string): void {
  const varRef = `var(--color-st-${tokenSuffix})`;
  expect(html, `expected st-* token reference: ${varRef}`).toContain(varRef);
}

/**
 * The raw citizen-skin status utilities the st-* layer replaces. The original
 * CaseBadge used ln-ok/ln-warn for the status pill; if any of these reappear
 * the per-skin auto-remap is broken and "Abierto" goes green again.
 */
function expectNoRawLnStatus(html: string): void {
  const banned = [
    "text-ln-ok",
    "text-ln-warn",
    "var(--color-ln-ok-050)",
    "var(--color-ln-warn-050)",
  ];
  for (const cls of banned) {
    expect(html, `raw ln status utility found: "${cls}"`).not.toContain(cls);
  }
}

const TONES: Array<{
  status: CaseStatus;
  label: string;
  suffix: string;
}> = [
  { status: "open", label: "Abierto", suffix: "warn" },
  { status: "escalated", label: "Escalado", suffix: "err" },
  { status: "closed", label: "Cerrado", suffix: "ok" },
  { status: "merged", label: "Fusionado", suffix: "info" },
];

describe("CaseBadge — canonical F2 tones via the st-* indirection layer", () => {
  for (const { status, label, suffix } of TONES) {
    it(`status="${status}" renders "${label}" with st-${suffix}`, () => {
      const html = renderToStaticMarkup(
        <CaseBadge publicCode="CAS-TEST-0001" caseKind="bite_incident" status={status} />,
      );
      expect(html).toContain(label);
      expectStToken(html, `${suffix}-bg`);
      expectStToken(html, suffix);
    });
  }

  it('status="open" is amber (st-warn), NOT green (ln-ok) — the holdout regression', () => {
    const html = renderToStaticMarkup(
      <CaseBadge publicCode="CAS-TEST-0001" caseKind="bite_incident" status="open" />,
    );
    expectStToken(html, "warn");
    expectNoRawLnStatus(html);
  });

  it("links to the public case route", () => {
    const html = renderToStaticMarkup(
      <CaseBadge publicCode="CAS-TEST-0001" caseKind="bite_incident" status="open" />,
    );
    expect(html).toContain("/casos/CAS-TEST-0001");
  });
});
