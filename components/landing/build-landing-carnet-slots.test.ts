import { chromeForSurface, mayAnnounceSituation } from "@dim/contract/credential";
import { describe, expect, it } from "vitest";

import { buildLandingCarnetSlots, landingHeroSituationKey } from "./build-landing-carnet-slots";
import { HERO_CREDENTIAL_FIELDS, PAMPA } from "./landing-content";

describe("buildLandingCarnetSlots", () => {
  it("is a carnet with landing chrome, Pampa's name, and the seed fields", () => {
    const slots = buildLandingCarnetSlots({
      face: "front",
      publicToken: "DIM-PAMP-0001",
      publicHref: "/p/DIM-PAMP-0001",
      heroStateKey: "perdida",
      contextWord: "Perdida",
      contextRow: "Llamar al dueño",
    });
    expect(slots.variant).toBe("carnet");
    expect(slots.chrome).toEqual(chromeForSurface("landing"));
    expect(slots.identity.name).toBe(PAMPA.name);
    expect(slots.fields).toEqual(HERO_CREDENTIAL_FIELDS);
    expect(slots.mrz).not.toBeNull();
    expect(slots.back?.rows.length).toBeGreaterThan(0);
    expect(slots.situation?.key).toBe("perdida");
  });

  it("maps the hero cycle onto landing-safe situation keys", () => {
    expect(landingHeroSituationKey("aldia")).toBe("al-dia");
    expect(landingHeroSituationKey("tratamiento")).toBe("en-tratamiento");
    expect(mayAnnounceSituation("landing", landingHeroSituationKey("tratamiento"))).toBe(true);
    expect(mayAnnounceSituation("public", landingHeroSituationKey("tratamiento"))).toBe(false);
  });
});
