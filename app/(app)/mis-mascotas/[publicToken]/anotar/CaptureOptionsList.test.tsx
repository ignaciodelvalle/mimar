/**
 * <CaptureOptionsList> — accessible-name regression guard + QA A9 gating.
 *
 * medianos-sesión-2 finding #5 (verified against current code — not
 * reproducible: every row already renders its label as visible <span> text
 * inside the <Link>, so the link's text content IS its accessible name; the
 * trailing "→" glyph is additional visible text, never the ONLY content).
 * Pinned here so a future edit can't turn a row into an icon-only link with
 * no accessible name.
 *
 * QA A9: the "Check-in post-adopción" entry (and its "Adopción" section
 * header) render ONLY when showCheckinOption is true — for everyone else the
 * target page 404s, so the entry must not exist.
 *
 * `showPregnancyStartOption` is the second conditional row and is held FALSE
 * throughout this file on purpose: these cases are about the check-in gate and
 * the accessible names of the unconditional rows. The pregnancy gate has its
 * own file, __tests__/pregnancy-start-discoverability.test.tsx, which exercises
 * both of its directions.
 *
 * Pattern: react-dom/server renderToStaticMarkup (repo convention — no
 * jsdom, see anotar/page.test.tsx / CaptureBox.test.tsx).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CaptureOptionsList } from "./CaptureOptionsList";

describe("<CaptureOptionsList> — every row link carries a real accessible name", () => {
  it("every option link's visible text is non-empty", () => {
    const html = renderToStaticMarkup(
      <CaptureOptionsList
        petPublicToken="DIM-TEST-0001"
        showCheckinOption={false}
        showPregnancyStartOption={false}
      />,
    );
    const links = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const [, inner] of links) {
      const text = inner.replace(/<[^>]*>/g, "").trim();
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("renders the known category labels as real link text, not just the trailing arrow", () => {
    const html = renderToStaticMarkup(
      <CaptureOptionsList
        petPublicToken="DIM-TEST-0001"
        showCheckinOption={false}
        showPregnancyStartOption={false}
      />,
    );
    expect(html).toContain("Registrar vacuna");
    expect(html).toContain("Marcar como perdida");
  });
});

describe("<CaptureOptionsList> — QA A9 check-in gating", () => {
  it("hides the check-in entry AND its emptied 'Adopción' header for non-adopters", () => {
    const html = renderToStaticMarkup(
      <CaptureOptionsList
        petPublicToken="DIM-TEST-0001"
        showCheckinOption={false}
        showPregnancyStartOption={false}
      />,
    );
    expect(html).not.toContain("Check-in post-adopción");
    expect(html).not.toContain("Adopción");
  });

  it("renders the check-in entry for the registered adopter", () => {
    const html = renderToStaticMarkup(
      <CaptureOptionsList
        petPublicToken="DIM-TEST-0001"
        showCheckinOption={true}
        showPregnancyStartOption={false}
      />,
    );
    expect(html).toContain("Check-in post-adopción");
    expect(html).toContain("Adopción");
  });
});
