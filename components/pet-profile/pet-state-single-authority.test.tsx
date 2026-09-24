// Fitness test — pet-state single authority (PO decision 2026-07-16).
//
// The PO found "Bajo custodia oficial" (and other states) repeated several
// times across the owner pet profile. The standard is now:
//
//   1. The MASTHEAD band chip (DocumentChrome) is the single textual carrier
//      of the pet's situation on the credential document.
//   2. At most ONE contextual action panel per state may name it again, and
//      only when it carries a unique action or datum (e.g. LostCaseBlock's
//      "Apareció" CTA). Those panels live in the alert strip, outside this
//      composition.
//
// This test renders the document composition the page actually mounts —
// DocumentChrome (masthead) wrapping CredentialFace (face body), both fed the
// SAME situation, exactly like FlipCard does — and asserts the state label
// appears EXACTLY ONCE. Before the standardization, CredentialFace rendered a
// second `.ln-sit` status line with the identical icon + label, so this
// composition produced the string twice; this guard keeps that disease from
// quietly returning.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { deriveComplianceState } from "@/lib/projections/pet-compliance";
import { PET_SITUATIONS } from "@/lib/ui/pet-situation";
import { situationLabelForSex } from "@/lib/utils/format";
import { CredentialFace } from "./CredentialFace";
import { DocumentChrome } from "./DocumentChrome";

const NOW = new Date("2026-07-16T12:00:00Z");

function complianceState() {
  return deriveComplianceState({
    now: NOW,
    events: [],
    rabiesReminder: null,
    reservedRabiesTurno: null,
    microchipCode: null,
    pppApplies: false,
  });
}

/** Renders the same document composition FlipCard mounts on the profile:
 *  the chrome (masthead band + chip) around the credential face, both fed
 *  the same situation — chrome label pre-gendered, as page.tsx does. */
function renderDocument(situationKey: "custodia-oficial" | "perdida", petSex: string) {
  const situation = PET_SITUATIONS[situationKey];
  const chromeSituation = {
    key: situation.key,
    tone: situation.tone,
    icon: situation.icon,
    label: situationLabelForSex(situation.label, petSex),
  };
  return renderToStaticMarkup(
    <DocumentChrome
      face="credencial"
      onFlip={() => {}}
      isLibretaActive={false}
      situation={chromeSituation}
    >
      <CredentialFace
        heroProps={{ name: "Pampa", breed: "Mestizo" }}
        complianceState={complianceState()}
        credentialUrl="https://www.mimar.com.ar/p/abc"
        publicHref="/p/abc"
        petPublicToken="abc"
        petSex={petSex}
        situation={situation}
      />
    </DocumentChrome>,
  );
}

function countOccurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("pet-state single authority — masthead is the only in-document carrier", () => {
  it("custody: 'Bajo custodia oficial' renders exactly once (the masthead chip)", () => {
    const html = renderDocument("custodia-oficial", "male");
    expect(countOccurrences(html, "Bajo custodia oficial")).toBe(1);
    // The chip is the masthead's, not a face-body repeat.
    expect(html).toContain('data-section="band-situation-chip"');
    // The face keeps its tint hook — color may repeat, text may not.
    expect(html).toContain('data-situation="custodia-oficial"');
  });

  it("lost: the 'Perdido/a' state string family renders exactly once", () => {
    const html = renderDocument("perdida", "female");
    expect(countOccurrences(html, "Perdida")).toBe(1);
    expect(html).toContain('data-section="band-situation-chip"');
  });
});

// Cumplimiento dedup (PO 2026-07-18): "estado de cumplimiento" / "Cumplimiento"
// and the "N de M al día" counter also repeated across the profile — divider,
// mobile disclosure-row title, AND the bare panel's own header (label + counter
// badge) all fired at once. The standard: the "Cumplimiento" divider is the ONE
// label surface, and each breakpoint variant carries the counter exactly once
// (desktop summary row / mobile disclosure row — both exist in the static
// markup, CSS shows one at a time).
describe("cumplimiento single authority — one label, one counter per variant", () => {
  it("renders the section label once and never the old 'Estado de cumplimiento' header", () => {
    const html = renderDocument("custodia-oficial", "male");
    expect(countOccurrences(html, "Cumplimiento")).toBe(1); // the divider label
    expect(countOccurrences(html, "Estado de cumplimiento")).toBe(0);
  });

  it("renders the 'N de M al día' counter once per breakpoint variant (2 in static markup)", () => {
    const state = complianceState();
    const html = renderDocument("custodia-oficial", "male");
    // Desktop summary row + mobile disclosure row — exactly one each; the bare
    // panel's third (header badge) copy must stay gone.
    expect(state.summary.label).toMatch(/\d+ de \d+ al día/);
    expect(countOccurrences(html, state.summary.label)).toBe(2);
  });
});
