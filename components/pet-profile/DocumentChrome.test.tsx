// Tests for <DocumentChrome> — pet-state-header: the masthead band is the
// carrier of the pet's SITUATION on both faces. The situation arrives as an
// explicit prop (server-derived, pre-gendered label) and stamps
// `data-situation` on `.ln-face`, so the CSS band variants reach the BACK face
// too (the old `:has(.ln-cred[data-situation])` scoping never matched it).
// Render via react-dom/server (repo convention — no jsdom).

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PET_SITUATIONS } from "@/lib/ui/pet-situation";
import { DocumentChrome } from "./DocumentChrome";
import { FlipCard } from "./FlipCard";

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal("window", {
    matchMedia: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

beforeEach(() => {
  stubMatchMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lostSituation = {
  key: PET_SITUATIONS.perdida.key,
  tone: PET_SITUATIONS.perdida.tone,
  // Pre-gendered by the caller (situationLabelForSex) — chrome stays dumb.
  label: "Perdido",
  icon: PET_SITUATIONS.perdida.icon,
};

describe("<DocumentChrome> — situation band", () => {
  it("stamps data-situation on .ln-face and renders the state chip (icon + label)", () => {
    const html = renderToStaticMarkup(
      <DocumentChrome
        face="credencial"
        onFlip={() => {}}
        isLibretaActive={false}
        situation={lostSituation}
      >
        <div>BODY</div>
      </DocumentChrome>,
    );
    expect(html).toContain('data-situation="perdida"');
    expect(html).toContain("ln-band-chip");
    expect(html).toContain("Perdido");
    // Icon = the non-color signal (WCAG: never color alone). The chip renders
    // an svg next to the label.
    expect(html).toMatch(/ln-band-chip[^>]*>\s*<svg/);
  });

  it("renders no chip and no data-situation when situation is null", () => {
    const html = renderToStaticMarkup(
      <DocumentChrome face="credencial" onFlip={() => {}} isLibretaActive={false} situation={null}>
        <div>BODY</div>
      </DocumentChrome>,
    );
    expect(html).not.toContain("data-situation");
    expect(html).not.toContain("ln-band-chip");
  });

  it("keeps the chip OUTSIDE the aria-hidden band wrapper (accessible text)", () => {
    const html = renderToStaticMarkup(
      <DocumentChrome
        face="libreta"
        onFlip={() => {}}
        isLibretaActive={true}
        situation={lostSituation}
      >
        <div>BODY</div>
      </DocumentChrome>,
    );
    // The aria-hidden band div must CLOSE before the chip opens — the chip is a
    // sibling overlay (same pattern as the turn button), not band content.
    const bandEnd = html.indexOf("</div>", html.indexOf("ln-band-title"));
    const chipAt = html.indexOf("ln-band-chip");
    expect(chipAt).toBeGreaterThan(bandEnd);
  });

  it("renders the band + chip on BOTH faces via FlipCard (flip never loses the state)", () => {
    const html = renderToStaticMarkup(
      <FlipCard
        front={<div>F</div>}
        back={<div>B</div>}
        activeFace="credencial"
        onFlip={() => {}}
        situation={lostSituation}
      />,
    );
    const occurrences = html.split('data-situation="perdida"').length - 1;
    expect(occurrences).toBe(2);
    const chips = html.split("ln-band-chip").length - 1;
    expect(chips).toBe(2);
  });

  it("defaults to no situation when FlipCard receives none (today's exact look)", () => {
    const html = renderToStaticMarkup(
      <FlipCard
        front={<div>F</div>}
        back={<div>B</div>}
        activeFace="credencial"
        onFlip={() => {}}
      />,
    );
    expect(html).not.toContain("data-situation");
    expect(html).not.toContain("ln-band-chip");
  });
});

// PO correction (2026-07-18): "El carousel lo quiero FUERA de la
// credencial." The carousel position dots (formerly the `bandDots` slot)
// were removed from the band — the credential is ONE pet's document;
// switching between pets is app-level navigation and now mounts ABOVE the
// card (PetSwitcherDots in page.tsx, see PetSwitcherDots.test.tsx), never
// inside DocumentChrome. This is a negative guard against the slot
// resurfacing: the band's only content is the state chip + the turn button.
describe("<DocumentChrome> — band renders no carousel dots (PO correction, dots moved above the card)", () => {
  it("never renders a band-dots slot, even though bandDots isn't a prop anymore", () => {
    const html = renderToStaticMarkup(
      <DocumentChrome
        face="credencial"
        onFlip={() => {}}
        isLibretaActive={false}
        situation={lostSituation}
      >
        <div>BODY</div>
      </DocumentChrome>,
    );
    expect(html).not.toContain('data-section="band-dots"');
    expect(html).not.toContain("ln-band-dots");
  });

  it("the band renders exactly the state chip and the turn button — no dots — on both FlipCard faces", () => {
    const html = renderToStaticMarkup(
      <FlipCard
        front={<div>F</div>}
        back={<div>B</div>}
        activeFace="credencial"
        onFlip={() => {}}
        situation={lostSituation}
      />,
    );
    expect(html).not.toContain('data-section="band-dots"');
    expect(html.split("ln-band-chip").length - 1).toBe(2);
    expect(html.split("ln-turn").length - 1).toBeGreaterThanOrEqual(2);
  });
});
