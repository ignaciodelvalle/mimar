// Regression — QA round 2 finding #0 (North-Star-breaking).
//
// The lost credential renders photos via <Image fill>, which emits
// position:absolute. A fill image whose wrapper has NO `relative` escapes to
// the VIEWPORT as its containing block and paints full-bleed ON TOP of every
// finder CTA — a finder scanning the QR of a photographed lost pet could not
// tap "Llamar", "La tengo conmigo" or "La vi cerca de acá"
// (document.elementFromPoint returned the IMG at all three CTA centers;
// repro: /p/DIM-4SUZ-U2HT).
//
// pet-state-header retired the LostPublicCredential full-page takeover: the
// pet photo is now the card-owned width/height <Image> in page.tsx, and the
// remaining <Image fill> on the lost path is the TATTOO photo inside
// PublicLostSections. The same two invariants apply to it:
//   1. the <Image fill> wrapper is a positioned ancestor (`relative`), so the
//      photo is contained inside its section;
//   2. the decorative photo carries `pointer-events-none`, so even if stacking
//      ever regresses it can never intercept a tap.
//
// Rendering strategy mirrors public-token-landing-structure.test.tsx:
// react-dom/server → static HTML string, next/dynamic + next/link mocked.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// next/dynamic — the component lazy-loads the MapLibre mini-map. Render a
// no-op so the tree resolves synchronously to static markup.
vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

import { PublicLostSections } from "@/components/pet-profile/PublicLostSections";

function renderSectionsWithTattooPhoto(): string {
  return renderToStaticMarkup(
    <PublicLostSections
      petName="Michi"
      petSex="female"
      identityLine="Felino · gris"
      ownerFirstName="Lucía"
      ownerPhoneE164="+5491155551234"
      lastSeenPlaceName="Plaza Irlanda"
      lastSeenLocality="Caballito, CABA"
      distinguishingFeatures="Collar rojo"
      finderFormHref="/p/DIM-TEST-0001/encontre"
      sightingFormHref="/p/DIM-TEST-0001/sighting"
      lostSince={new Date("2026-07-01T12:00:00Z")}
      tattooCode="FCA-1234"
      tattooLocation={null}
      tattooDescription={null}
      tattooPhotoUrl="https://example.test/storage/pets/michi-tattoo.jpg"
    />,
  );
}

/** The tattoo <img> tag (first and only <img> — the map is mocked away). */
function extractTattooImgTag(html: string): { tag: string; index: number } {
  const index = html.indexOf("<img");
  expect(index).toBeGreaterThan(-1);
  const end = html.indexOf(">", index);
  return { tag: html.slice(index, end + 1), index };
}

/** Class attribute of the innermost element wrapper before the given offset. */
function enclosingWrapperClass(html: string, offset: number): string {
  const before = html.slice(0, offset);
  const wrapperStart = Math.max(before.lastIndexOf("<div"), before.lastIndexOf("<span"));
  expect(wrapperStart).toBeGreaterThan(-1);
  const wrapperTag = before.slice(wrapperStart, before.indexOf(">", wrapperStart) + 1 || undefined);
  const match = /class="([^"]*)"/.exec(wrapperTag);
  return match?.[1] ?? "";
}

describe("PublicLostSections — fill photo containment (QA round 2 #0)", () => {
  it("contains the fill tattoo photo inside a positioned wrapper", () => {
    const html = renderSectionsWithTattooPhoto();
    const { index } = extractTattooImgTag(html);
    // <Image fill> contract: the parent MUST be a positioned ancestor,
    // otherwise the img paints full-viewport over the CTAs.
    const wrapperClass = enclosingWrapperClass(html, index);
    expect(wrapperClass.split(/\s+/)).toContain("relative");
  });

  it("marks the decorative photo pointer-events-none so it can never swallow a tap", () => {
    const html = renderSectionsWithTattooPhoto();
    const { tag } = extractTattooImgTag(html);
    expect(tag).toMatch(/pointer-events-none/);
  });

  it("does not put finder verbs on the paper next to the tattoo photo", () => {
    const html = renderSectionsWithTattooPhoto();
    expect(html).not.toContain('href="tel:+5491155551234"');
    expect(html).not.toContain('href="/p/DIM-TEST-0001/encontre"');
    expect(html).not.toContain('href="/p/DIM-TEST-0001/sighting"');
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("no tiene canales de contacto");
  });

  it("still hides the last-seen empty-state when no place was published", () => {
    const noChannels = renderToStaticMarkup(
      <PublicLostSections
        petName="Michi"
        petSex="female"
        identityLine="Felino · gris"
        ownerFirstName={null}
        ownerPhoneE164={null}
        lastSeenPlaceName={null}
        lastSeenLocality={null}
        distinguishingFeatures={null}
        finderFormHref={null}
        sightingFormHref={null}
        lostSince={new Date("2026-07-01T12:00:00Z")}
      />,
    );
    expect(noChannels).not.toContain("Sin ubicación de avistaje registrada");
    expect(noChannels).not.toContain("Última vez vista");
  });
});

// The paper no longer carries finder verbs or the phone-privacy note
// (PO 2026-10-03). Those live under the card in PublicCredentialActions.
describe("PublicLostSections — no contact verbs on the paper", () => {
  const PRIVACY_LINE = "Por privacidad no mostramos el teléfono del dueño";

  function render(props: Partial<React.ComponentProps<typeof PublicLostSections>>): string {
    return renderToStaticMarkup(
      <PublicLostSections
        petName="Michi"
        petSex="female"
        identityLine="Felino · gris"
        ownerFirstName={null}
        ownerPhoneE164={null}
        lastSeenPlaceName={null}
        lastSeenLocality={null}
        distinguishingFeatures={null}
        finderFormHref={null}
        sightingFormHref={null}
        lostSince={new Date("2026-07-01T12:00:00Z")}
        {...props}
      />,
    );
  }

  it("does not draw tel/mailto/aviso CTAs or the old privacy note", () => {
    const html = render({
      ownerPhoneE164: "+5491155551234",
      ownerEmail: "lucia@example.test",
      finderFormHref: "/p/DIM-TEST-0001/encontre",
      sightingFormHref: "/p/DIM-TEST-0001/sighting",
    });
    expect(html).not.toContain(PRIVACY_LINE);
    expect(html).not.toContain('href="tel:');
    expect(html).not.toContain('href="mailto:');
    expect(html).not.toContain("no tiene canales de contacto");
  });
});
