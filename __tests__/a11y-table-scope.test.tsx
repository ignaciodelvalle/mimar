/**
 * A11y tests for dense operator tables (Wave 2 Item 11).
 *
 * Every <table> in the operator surfaces must have:
 *   - scope="col" on every <th> inside a <thead> row.
 *   - a <caption> element.
 *
 * These are WCAG 1.3.1 (Info and Relationships) requirements for data tables.
 *
 * Pattern: react-dom/server renderToStaticMarkup (repo convention — no jsdom).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OutbreakHistoryTable } from "@/app/gob/analytics/_components/OutbreakHistoryTable";
import { DiseaseSummaryTable } from "@/app/gob/vigilancia/_components/DiseaseSummaryTable";
import type { OutbreakHistoryRow } from "@/lib/analytics/govt-dashboards";
import type { DiseaseSummary } from "@/lib/analytics/govt-dashboards";

/** Assert every <th> in rendered HTML has scope="col" or scope="row". */
function assertThHaveScope(html: string) {
  // Match only <th ...> tags (not <thead>). The word boundary after "th" ensures
  // we don't accidentally match <thead class="..."> as a <th> variant.
  const thMatches = html.match(/<th(?:\s[^>]*)?>[\s\S]*?<\/th>/g) ?? [];
  expect(thMatches.length).toBeGreaterThan(0);
  for (const tag of thMatches) {
    // Extract the opening tag to check the scope attribute.
    const openTag = tag.match(/^<th[^>]*/)?.[0] ?? "";
    expect(
      openTag.includes('scope="col"') || openTag.includes('scope="row"'),
      `<th> is missing scope attribute: ${openTag}>`,
    ).toBe(true);
  }
}

/** Assert there is at least one <caption> element with non-empty text. */
function assertHasCaption(html: string) {
  expect(html).toContain("<caption");
  // The caption must have content between the tags.
  const captionMatch = html.match(/<caption[^>]*>([\s\S]*?)<\/caption>/);
  expect(captionMatch).not.toBeNull();
  expect(captionMatch?.[1].replace(/<[^>]*>/g, "").trim().length).toBeGreaterThan(0);
}

describe("OutbreakHistoryTable — a11y: scope + caption", () => {
  const rows: OutbreakHistoryRow[] = [
    {
      diseaseCode: "rabies",
      diseaseName: "Rabia",
      locality: "Palermo",
      province: "CABA",
      peakDate: "2024-03-15",
      totalSignals: 6,
      lastSeen: "2024-03-18",
    },
  ];

  it("has scope='col' on all header cells", () => {
    const html = renderToStaticMarkup(<OutbreakHistoryTable rows={rows} suppressedCount={0} />);
    assertThHaveScope(html);
  });

  it("has a <caption>", () => {
    const html = renderToStaticMarkup(<OutbreakHistoryTable rows={rows} suppressedCount={0} />);
    assertHasCaption(html);
  });
});

describe("DiseaseSummaryTable — a11y: scope + caption", () => {
  const summary: DiseaseSummary[] = [
    {
      diseaseCode: "rabies",
      diseaseName: "Rabia",
      count24h: 1,
      count7d: 2,
      count30d: 5,
    },
  ];

  it("has scope='col' on all header cells", () => {
    const html = renderToStaticMarkup(<DiseaseSummaryTable summary={summary} />);
    assertThHaveScope(html);
  });

  it("has a <caption>", () => {
    const html = renderToStaticMarkup(<DiseaseSummaryTable summary={summary} />);
    assertHasCaption(html);
  });
});
