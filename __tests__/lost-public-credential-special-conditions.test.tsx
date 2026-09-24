// PO QA regression — a pet with permanentConditions (e.g. blindness) +
// discloseConditionsPublicly=true shows those conditions on the normal
// credential and the Tier-2 medical view, but the lost credential rendered
// NO conditions section at all — so a finder of a LOST blind/special-needs
// pet was never told. This is a welfare-safety disclosure: a finder handling
// a blind, deaf, or medicated pet must know before they act.
//
// pet-state-header retired the LostPublicCredential full-page takeover; the
// same behavioral contract now lives in PublicLostSections (the lost body of
// the single public card). page.tsx still resolves `specialConditions`
// server-side via resolveLostSpecialConditions (see
// __tests__/permanent-conditions.test.ts for the gating logic itself) and
// passes only what's disclosable — this test proves the component renders
// that prop correctly.
//
// Rendering strategy mirrors lost-public-credential-photo-overlay.test.tsx:
// react-dom/server → static HTML string, next/dynamic + next/link mocked.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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

const BASE_PROPS = {
  petName: "Michi",
  petSex: "female" as const,
  identityLine: "Felino · gris",
  ownerFirstName: "Lucía",
  ownerPhoneE164: "+5491155551234",
  lastSeenPlaceName: null,
  lastSeenLocality: null,
  distinguishingFeatures: null,
  finderFormHref: "/p/DIM-TEST-0001/encontre",
  lostSince: new Date("2026-07-01T12:00:00Z"),
};

describe("PublicLostSections — special-conditions welfare disclosure", () => {
  it("(a) renders condition labels and free-text 'other' when disclosed", () => {
    const html = renderToStaticMarkup(
      <PublicLostSections
        {...BASE_PROPS}
        specialConditions={{ labels: ["Ciego/a", "Sordo/a"], other: null }}
      />,
    );
    expect(html).toContain('data-section="special-conditions"');
    expect(html).toContain("Necesita cuidados especiales");
    expect(html).toContain("Ciego/a");
    expect(html).toContain("Sordo/a");
  });

  it("(a) renders the free-text 'otra' detail alongside catalog labels", () => {
    const html = renderToStaticMarkup(
      <PublicLostSections
        {...BASE_PROPS}
        specialConditions={{ labels: ["Diabetes"], other: "Necesita insulina 2x/día" }}
      />,
    );
    expect(html).toContain("Diabetes");
    expect(html).toContain("Necesita insulina 2x/día");
  });

  it("(b) renders no special-conditions section when specialConditions is null (discloseConditionsPublicly=false)", () => {
    const html = renderToStaticMarkup(
      <PublicLostSections {...BASE_PROPS} specialConditions={null} />,
    );
    expect(html).not.toContain('data-section="special-conditions"');
    expect(html).not.toContain("Necesita cuidados especiales");
  });

  it("(c) renders no special-conditions section when the pet has no conditions (prop omitted)", () => {
    const html = renderToStaticMarkup(<PublicLostSections {...BASE_PROPS} />);
    expect(html).not.toContain('data-section="special-conditions"');
  });

  it("(c) renders no section for an empty labels/other shape (defensive)", () => {
    const html = renderToStaticMarkup(
      <PublicLostSections {...BASE_PROPS} specialConditions={{ labels: [], other: null }} />,
    );
    expect(html).not.toContain('data-section="special-conditions"');
  });
});
