/**
 * <LnLedger> / <LnVaccineLedger> — the wrapper must SCROLL, never CLIP.
 *
 * The bug this pins: the wrapper carried `overflow-hidden`. It was there to
 * clip the table to the rounded border, and it did — along with the table.
 * Four columns of 16px-padded cells plus a 120px status column overrun a 390px
 * phone, so on the vaccination record the Profesional column and the right
 * edge of the Estado stamps were cut off with no scrollbar and nothing else to
 * say content was missing. A reader cannot distinguish a blank column from a
 * clipped one, which on a medical document is a correctness problem, not a
 * cosmetic one.
 *
 * The assertions below are written against the INVARIANT ("declares a
 * scrollable horizontal overflow, declares no clipping overflow") rather than
 * against one exact class string, so swapping `overflow-x-auto` for
 * `overflow-x-scroll` stays green while re-introducing `overflow-hidden` fails.
 *
 * Pattern: react-dom/server renderToStaticMarkup (repo convention — no jsdom).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LnLedger, LnVaccineLedger, type LnVaccineRow } from "./Ledger";

const ROWS: LnVaccineRow[] = [
  {
    id: "v1",
    name: "Antirrábica",
    dose: "Refuerzo anual",
    appliedAt: "12 mar 2026",
    nextDue: "12 mar 2027",
    status: "ok",
    vet: "M.V. Laura Giménez",
    vetLicense: "MP 12345",
  },
];

/** The class attribute of the outermost element (the scroll wrapper). */
function wrapperClasses(html: string): string[] {
  const match = /^<section class="([^"]*)"/.exec(html);
  if (!match) throw new Error(`no wrapper class attribute found in: ${html.slice(0, 200)}`);
  return match[1].split(/\s+/);
}

describe("<LnLedger> — horizontal overflow policy", () => {
  const html = renderToStaticMarkup(<LnVaccineLedger rows={ROWS} />);
  const classes = wrapperClasses(html);

  it("declares a SCROLLABLE horizontal overflow on the table wrapper", () => {
    expect(
      classes.some((c) => c === "overflow-x-auto" || c === "overflow-x-scroll"),
      `the wrapper must let the table scroll horizontally; classes were: ${classes.join(" ")}`,
    ).toBe(true);
  });

  it("declares NO clipping overflow on the table wrapper", () => {
    // `overflow-hidden` and `overflow-x-hidden` both make the overrun
    // unreachable. This is the exact regression: the wrapper clipped at 390px.
    const clipping = classes.filter((c) => c === "overflow-hidden" || c === "overflow-x-hidden");
    expect(
      clipping,
      "a clipping overflow on the wrapper silently truncates the ledger on a phone",
    ).toEqual([]);
  });

  it("keeps the rounded border the wrapper exists for", () => {
    // Guard against "fixing" the clip by deleting the wrapper's own styling.
    expect(classes).toContain("rounded-[var(--radius-sm)]");
    expect(classes.some((c) => c.startsWith("border"))).toBe(true);
  });

  it("makes the scroll region operable by keyboard (WCAG 2.1.1)", () => {
    // A scroll container with no tab stop can be read by a keyboard user down
    // the rows but never scrolled across to the off-screen columns.
    expect(html).toContain('tabindex="0"');
    // A NAMED <section> is a `region` landmark on its own — no explicit role
    // needed, and biome's useSemanticElements rejects role="region" on a div in
    // favour of exactly this element.
    expect(html).toMatch(/^<section\b/);
  });

  it("names the scroll region and the table for assistive tech", () => {
    // An unnamed `role="region"` is a landmark that announces nothing.
    expect(html).toMatch(/aria-label="Registro de vacunación[^"]*"/);
    expect(html).toContain("<caption");
  });

  it("marks every header as a column header", () => {
    const headers = [...html.matchAll(/<th\b[^>]*>/g)].map((m) => m[0]);
    expect(headers.length).toBe(4);
    for (const th of headers) expect(th, `<th> without scope: ${th}`).toContain('scope="col"');
  });
});

describe("<LnVaccineLedger> — no column is dropped", () => {
  it("renders content from all four columns, including the rightmost one", () => {
    // The clipped columns were the right-hand ones, so a test that only checks
    // the vaccine name would have stayed green through the whole bug.
    const html = renderToStaticMarkup(<LnVaccineLedger rows={ROWS} />);
    expect(html).toContain("Antirrábica"); // col 1
    expect(html).toContain("12 mar 2026"); // col 2
    expect(html).toContain("VIGENTE"); // col 3
    expect(html).toContain("M.V. Laura Giménez"); // col 4 — the one that was cut off
    expect(html).toContain("MP 12345");
  });
});

describe("<LnLedger> — caption is optional", () => {
  it("omits the caption and the aria-label when no caption is given", () => {
    const html = renderToStaticMarkup(
      <LnLedger
        columns={[{ key: "a", header: "A", render: () => "x" }]}
        rows={[{ id: "1" }]}
        rowKey={(r) => r.id}
      />,
    );
    expect(html).not.toContain("<caption");
    expect(html).not.toContain("aria-label");
    // …but the scroll policy is a property of the primitive, not of the caption.
    expect(wrapperClasses(html)).toContain("overflow-x-auto");
  });
});
