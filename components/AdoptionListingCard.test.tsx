// AdoptionListingCard — possession-conditioned line (rehome-by-titular,
// spec REQ-12; design WU6 "the catalog card").
//
// The card's "Publica: {org}" footer is honest for a sponsored pet — the org
// DOES publish — but a prospective adopter browsing /adoptar also reads the
// card as "this animal is at that refugio". When the listing is a rehome
// sponsorship the animal lives with its current family and the org runs the
// evaluation; the card says so, in one line, only then. A surrendered pet's
// card is unchanged.
//
// Pattern: react-dom/server renderToStaticMarkup (repo convention — no jsdom).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { AdoptionListingCard, type AdoptionListingItem } from "./AdoptionListingCard";

const BASE: AdoptionListingItem = {
  petId: "pet-uuid-0001",
  petPublicToken: "PET-0001",
  orgPublicToken: "ORG-0001",
  orgId: "org-uuid-0001",
  orgAvatarUrl: null,
  name: "Luna",
  species: "dog",
  breed: "Mestiza",
  sex: "female",
  color: null,
  primaryPhotoId: null,
  primaryPhotoStoragePath: null,
  isSterilized: true,
  hasMicrochip: false,
  adoptionStory: null,
  adoptionRequirements: null,
  adoptionListedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
  adoptionAgeBucket: "adult",
  adoptionSizeEstimate: "medium",
  adoptionEnergyLevel: "medium",
  adoptionGoodWithKids: null,
  adoptionGoodWithDogs: null,
  adoptionGoodWithCats: null,
  adoptionNeedsYard: null,
  adoptionFeeArs: null,
  jurisdictionProvince: "Buenos Aires",
  jurisdictionLocality: "La Plata",
  orgDisplayName: "Refugio ABC",
  livesWithFamily: false,
};

describe("AdoptionListingCard — where the animal lives (REQ-12)", () => {
  it("a sponsored listing says the animal lives with its family and the org accompanies", () => {
    const html = renderToStaticMarkup(
      <AdoptionListingCard item={{ ...BASE, livesWithFamily: true }} />,
    );
    expect(html).toContain("Vive con su familia; Refugio ABC acompaña la adopción.");
    // The publisher footer stays — the org does publish.
    expect(html).toContain("Publica:");
  });

  it("a surrendered listing carries no such line", () => {
    const html = renderToStaticMarkup(<AdoptionListingCard item={BASE} />);
    expect(html).not.toContain("Vive con su familia");
    expect(html).toContain("Publica:");
  });

  it("the line is inside the pet link — one tap, no nested anchor", () => {
    const html = renderToStaticMarkup(
      <AdoptionListingCard item={{ ...BASE, livesWithFamily: true }} />,
    );
    const anchors = html.match(/<a /g) ?? [];
    expect(anchors.length).toBe(2);
  });
});
