/**
 * Structure test — voice dictation roadmap placeholder in CaptureBox.
 *
 * PO-approved pattern (visible, disabled, reads as "coming", never as
 * broken — precedent: "Informe de situación (en desarrollo)" in panorama's
 * SituationalMap). Pinned here so a future edit to CaptureBox's text-entry
 * surface can't silently drop the roadmap signal, and so the mic affordance
 * never regresses into something that submits the form or steals focus.
 *
 * Pattern: react-dom/server renderToStaticMarkup (repo convention — no
 * jsdom, see anotar/page.test.tsx).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/mis-mascotas/abc123/anotar",
}));

import { CaptureBox } from "./CaptureBox";

const MIC_LABEL = "Dictado por voz (próximamente)";

describe("<CaptureBox> — voice dictation roadmap placeholder", () => {
  it("renders a disabled mic affordance with the exact accessible name and tooltip", () => {
    const html = renderToStaticMarkup(<CaptureBox petPublicToken="abc123" petName="Firulais" />);
    expect(html).toContain(`aria-label="${MIC_LABEL}"`);
    expect(html).toContain(`title="${MIC_LABEL}"`);
    expect(html).toContain('aria-disabled="true"');
  });

  it('the mic button carries a disabled attribute and type="button" — never a submit control', () => {
    const html = renderToStaticMarkup(<CaptureBox petPublicToken="abc123" petName="Firulais" />);
    const micMatch = html.match(/<button\b[\s\S]*?aria-label="Dictado por voz[\s\S]*?<\/button>/);
    expect(micMatch).not.toBeNull();
    expect(micMatch?.[0]).toContain('type="button"');
    expect(micMatch?.[0]).toContain("disabled=");
  });

  it("the capture textarea and submit button still render alongside the mic placeholder (no interference)", () => {
    const html = renderToStaticMarkup(<CaptureBox petPublicToken="abc123" petName="Firulais" />);
    expect(html).toContain("capture-text");
    expect(html).toContain("Identificar");
  });
});

// medianos-sesión-2 finding #5 (verified against current code — not
// reproducible: the quick-capture chips already render icon-free, label-only
// links, so their text content IS their accessible name). Pinned here as a
// regression guard so a future edit can't split the icon and label into
// sibling elements again (the exact shape that produces a nameless link).
describe("<CaptureBox> — quick-action chips carry a real accessible name", () => {
  it("every quick-action chip is a link whose visible text is non-empty", () => {
    const html = renderToStaticMarkup(<CaptureBox petPublicToken="abc123" petName="Firulais" />);
    const chipLinks = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)];
    // The quick-action grid renders at least one chip in test env (registry-backed).
    expect(chipLinks.length).toBeGreaterThan(0);
    for (const [, inner] of chipLinks) {
      // Strip any nested tags (none expected — chips are icon-free label-only
      // links) and assert real, non-whitespace text remains as the accessible
      // name source.
      const text = inner.replace(/<[^>]*>/g, "").trim();
      expect(text.length).toBeGreaterThan(0);
    }
  });
});
