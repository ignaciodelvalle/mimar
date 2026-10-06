// Tests for <DocumentChrome> — pet-state-header: the masthead band is the
// carrier of the pet's SITUATION on both faces. The situation arrives as an
// explicit prop (server-derived, pre-gendered label) and stamps
// `data-situation` on `.ln-face`, so the CSS band variants reach the BACK face
// too (the old `:has(.ln-cred[data-situation])` scoping never matched it).
// Render via react-dom/server (repo convention — no jsdom).

import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  it("stamps data-situation and the paper subtitle; the front chip is not here", () => {
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
    expect(html).toContain('data-face="front"');
    expect(html).toContain("pc-band-mark");
    expect(html).toContain("pc-band-mark-hit");
    expect(html).toContain("pc-band-balance");
    expect(html).toContain("Credencial · frente");
    // Both band corners turn the card, but they are two controls with two
    // names: the flip owns "Girar a …" and the toggle state, the mark says
    // what it is. One name on two buttons reads as one control listed twice.
    expect(html.match(/aria-label="Girar a Libreta"/g)?.length).toBe(1);
    expect(html.match(/aria-pressed=/g)?.length).toBe(1);
    expect(html).toMatch(
      /class="pc-band-flip"[^>]*aria-label="Girar a Libreta"[^>]*aria-pressed="false"/,
    );
    expect(html).toMatch(
      /class="pc-band-mark-hit"[^>]*aria-label="Marca miMAR: mostrar la libreta"/,
    );
    // The front label lives under the name, in CredentialFace. Repeating it
    // in this chrome would put the state on the page twice.
    expect(html).not.toContain("band-situation-chip");
    expect(html).not.toContain("Perdido");
  });

  it("renders no chip and no data-situation when situation is null", () => {
    const html = renderToStaticMarkup(
      <DocumentChrome face="credencial" onFlip={() => {}} isLibretaActive={false} situation={null}>
        <div>BODY</div>
      </DocumentChrome>,
    );
    expect(html).not.toContain("data-situation");
    expect(html).not.toContain("band-situation-chip");
  });

  it("the libreta face carries the chip, outside the band, with its icon", () => {
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
    expect(html).toContain('data-face="back"');
    expect(html).toContain("Libreta · dorso");
    expect(html).toContain("pc-band-mark-hit");
    expect(html.match(/aria-label="Girar a Credencial"/g)?.length).toBe(1);
    expect(html).toMatch(
      /class="pc-band-flip"[^>]*aria-label="Girar a Credencial"[^>]*aria-pressed="true"/,
    );
    expect(html).toContain('aria-label="Marca miMAR: mostrar la credencial"');
    expect(html).toContain("Perdido");
    const chipAt = html.indexOf("band-situation-chip");
    const bodyAt = html.indexOf(">BODY<");
    expect(chipAt).toBeGreaterThan(html.indexOf("pc-band"));
    expect(chipAt).toBeLessThan(bodyAt);
    expect(html).toMatch(/band-situation-chip[^>]*>\s*<svg/);
  });

  // Browser QA 2026-10-06 (390px): the dorso chip was `position: absolute`
  // (.ln-band-chip, top: 82px) and landed 11-40px over "Estado de vacunación"
  // on every pet with a situation. It now sits in normal flow, in its own row
  // under the band — the native app's layout — so it reserves its own space.
  it("the dorso chip is in normal flow, never absolutely positioned over the body", () => {
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
    const chip = /<span class="([^"]*)" data-section="band-situation-chip"/.exec(html);
    expect(chip?.[1]).toBe("pc-sit-chip");
    // Its row is a sibling between the band and the body, not inside either.
    expect(html).toMatch(
      /<\/div><div class="pc-chips"><span class="pc-sit-chip"[\s\S]*?<\/div><div class="ln-body">/,
    );

    const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    // No rule that can reach the chip or its row positions it out of flow.
    const reaching = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) =>
      /\.pc-sit-chip(?![\w-])|\.pc-chips(?![\w-])|band-situation-chip/.test(selector ?? ""),
    );
    expect(reaching.length).toBeGreaterThan(0);
    for (const [, selector, body] of reaching) {
      expect(`${selector?.trim()} → ${body}`).not.toMatch(/position\s*:\s*(absolute|fixed)/);
    }
    expect(css).not.toContain(".ln-band-chip");
  });

  // Keyboard order = visual order (browser QA 2026-10-06): the dorso shows the
  // flip on the left and the mark on the right, so the DOM says so too.
  it.each([
    ["credencial", "pc-band-mark-hit", "pc-band-flip"],
    ["libreta", "pc-band-flip", "pc-band-mark-hit"],
  ] as const)("on the %s face the DOM order is the visual order", (face, first, second) => {
    const html = renderToStaticMarkup(
      <DocumentChrome
        face={face}
        onFlip={() => {}}
        isLibretaActive={face === "libreta"}
        situation={null}
      >
        <div>BODY</div>
      </DocumentChrome>,
    );
    const firstAt = html.indexOf(`class="${first}"`);
    const secondAt = html.indexOf(`class="${second}"`);
    expect(firstAt).toBeGreaterThan(-1);
    expect(secondAt).toBeGreaterThan(firstAt);
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
    // Front content in this fixture is a plain div, so the only chip is the
    // libreta face's. The real front paints its own, inside CredentialFace.
    const chips = html.split("band-situation-chip").length - 1;
    expect(chips).toBe(1);
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
    expect(html).not.toContain("band-situation-chip");
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
    expect(html.split("band-situation-chip").length - 1).toBe(1);
    // Flip control + brand mark hit, on both FlipCard faces.
    expect(html.split("pc-band-flip").length - 1).toBeGreaterThanOrEqual(2);
    expect(html.split("pc-band-mark-hit").length - 1).toBeGreaterThanOrEqual(2);
  });
});
