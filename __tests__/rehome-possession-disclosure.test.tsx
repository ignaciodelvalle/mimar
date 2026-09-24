// Org-facing possession disclosure (rehome-by-titular, spec REQ-11; design
// WU6). The PO's condition for accepting the "custodia means two things"
// overload was exactly this: every org screen that lets a member act on a
// sponsored pet says, persistently, that the animal is NOT in the org's
// possession — "{Pet} vive con su familia; {Org} acompaña la adopción".
//
// Two layers:
//   1. The sentence itself — one component, rendered here, so the words are
//      pinned in one place and every screen says the same thing.
//   2. Source pins on each org screen the spec names (case detail, the
//      applications queue and its row, applicant review, the org's pet ficha,
//      the finalize page) plus the org case queue's legend: each one renders
//      the component (or carries the legend). A screen that stops rendering it
//      fails here, not in a QA walk.
//
// Pattern: react-dom/server renderToStaticMarkup (repo convention — no jsdom).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SponsorshipPossessionNotice } from "@/components/adoption/SponsorshipPossessionNotice";

const REPO_ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

describe("SponsorshipPossessionNotice — the sentence every org screen repeats", () => {
  it("names the pet, the family and the org, and says the org does not hold the animal", () => {
    const html = renderToStaticMarkup(
      <SponsorshipPossessionNotice petName="Tango" orgDisplayName="Refugio Padrino" surface="op" />,
    );
    expect(html).toContain("Tango vive con su familia; Refugio Padrino acompaña la adopción.");
    expect(html).toContain("No está en poder de Refugio Padrino");
    expect(html).toContain("sigue en la casa de su titular hasta que se concrete la adopción");
    expect(html).toContain("Solo el titular puede dar de baja el acompañamiento.");
    expect(html).toContain('role="note"');
  });

  it("the citizen-chrome surface says the same words", () => {
    const op = renderToStaticMarkup(
      <SponsorshipPossessionNotice petName="Tango" orgDisplayName="Refugio Padrino" surface="op" />,
    );
    const ln = renderToStaticMarkup(
      <SponsorshipPossessionNotice petName="Tango" orgDisplayName="Refugio Padrino" surface="ln" />,
    );
    const text = (h: string) =>
      h
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    expect(text(ln)).toBe(text(op));
  });
});

describe("every org screen that acts on a sponsored pet renders the disclosure (REQ-11)", () => {
  const SCREENS = [
    "components/casos/CaseDetailView.tsx",
    "app/org/[orgToken]/adopciones/page.tsx",
    "app/org/[orgToken]/adopciones/[appEventId]/page.tsx",
    "app/org/[orgToken]/mascotas/[publicToken]/page.tsx",
    "app/org/[orgToken]/mascotas/[publicToken]/adoption/page.tsx",
  ] as const;

  for (const rel of SCREENS) {
    it(`${rel} imports and renders <SponsorshipPossessionNotice`, () => {
      const src = read(rel);
      expect(src).toMatch(/from "@\/components\/adoption\/SponsorshipPossessionNotice"/);
      expect(src).toMatch(/<SponsorshipPossessionNotice/);
    });
  }

  it("every screen decides 'sponsored' on the SPINE (findOpenSponsorship / listOpenSponsorshipPetIds), never on the ownership shape", () => {
    for (const rel of SCREENS) {
      const src = read(rel);
      expect(src, rel).toMatch(/findOpenSponsorship\(|listOpenSponsorshipPetIds\(/);
    }
  });

  it("the applications queue row carries the flag and says it", () => {
    const list = read("components/AdoptionQueueList.tsx");
    expect(list).toMatch(/livesWithFamily: boolean/);
    expect(list).toContain("Vive con su familia");
  });

  it("the org case queue explains what a 'Solicitud de nuevo hogar' row is", () => {
    const page = read("app/org/[orgToken]/casos/page.tsx");
    expect(page).toContain("el animal vive con su familia");
    expect(page).toContain("no lo tiene en su poder");
  });
});

// WU6/7 review (L-1): the public ficha required the open sponsorship to belong
// to the custodian org; the catalog card only asked whether ANY open
// sponsorship existed. Two predicates for one fact is the drift design R5
// forbids — and the looser one would put "vive con su familia" on an animal a
// different org took in after a stale started event. One helper, the stricter
// semantics (src/modules/adoption/domain/listing-rules.ts), both surfaces.
describe("REQ-12 — where the animal lives is ONE predicate (design R5)", () => {
  for (const rel of [
    "app/(public)/adoptar/[petToken]/page.tsx",
    "src/modules/adoption/infrastructure/adoption-listing-read.ts",
  ]) {
    it(`${rel} decides livesWithFamily through livesWithFamilyUnder, never inline`, () => {
      const src = read(rel);
      expect(src).toMatch(/livesWithFamilyUnder\(/);
      expect(src).not.toMatch(/sponsoringOrganizationId\s*===/);
      expect(src).not.toMatch(/livesWithFamily:\s*sponsored\.has\(/);
    });
  }
});
