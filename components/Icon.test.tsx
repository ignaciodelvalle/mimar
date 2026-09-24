// The shared icon table follows the WEB, and this is the leg that proves it.
//
// THREE COPIES, ONE VOCABULARY. `components/Icon.tsx`'s ICON_MAP is the
// authority; `packages/contract/src/icons/pet-profile-icons.ts` restates the
// pet-profile subset as strings (the contract package may not import lucide —
// scripts/check-contract-purity.ts); `apps/mobile/src/ui/Icon.tsx` resolves
// those strings against `lucide-react-native`. Two of the three legs were
// already fenced: the mobile Icon.test.tsx proves every table value resolves on
// the phone, and scripts/check-mobile-icon-vocabulary.ts proves the table's
// glyphs are meaningful and unique.
//
// THE UNFENCED LEG WAS THE ONE THE TABLE'S OWN HEADER NAMES. "Change a glyph
// THERE first — this table follows" was a sentence with nothing behind it: a
// web-only edit to ICON_MAP left the phone drawing the old picture and every
// gate green. On the day this file was written the parity was ALREADY broken,
// in the key column rather than the glyph one — `ocultar` was in the shared
// table and absent from the web map, so the header's "matches the web
// vocabulary verbatim" was false as it was being read.
//
// WHY A TEST AND NOT A FOURTH REGEX RULE in the mobile fence: this imports the
// real modules, so there is no parser to go blind and no second count to pin,
// and it compares component REFERENCES. A web-side alias rename
// (`AlertTriangle` → `TriangleAlert`, the same component) would read as a
// violation to a string comparison and correctly passes here.

import * as lucide from "lucide-react";
import { describe, expect, it } from "vitest";

import { PET_PROFILE_ICONS } from "@dim/contract/icons";

import { ICON_MAP } from "./Icon";

const entries = Object.entries(PET_PROFILE_ICONS);

describe("PET_PROFILE_ICONS follows the web ICON_MAP (components/Icon.tsx is the authority)", () => {
  it("has the profile's whole vocabulary on both sides (non-vacuity)", () => {
    // Floors, not exact counts: the shared table is pinned pair-by-pair in
    // scripts/check-mobile-icon-vocabulary.ts, and the web map grows with
    // every feature — pinning it here would make an unrelated web icon a
    // failure of this test. What this guards is the case where either import
    // resolves to something empty and every assertion below passes vacuously.
    expect(entries.length).toBeGreaterThanOrEqual(19);
    expect(Object.keys(ICON_MAP).length).toBeGreaterThanOrEqual(100);
  });

  it.each(entries)("%s exists in the web ICON_MAP", (name) => {
    expect(
      ICON_MAP[name],
      `\`${name}\` is in the shared table but not in the web ICON_MAP — add it to components/Icon.tsx first (the table follows the web), or rename the key`,
    ).toBeDefined();
  });

  it.each(entries)("%s → %s is the SAME glyph the web renders", (name, exportName) => {
    const webGlyph = ICON_MAP[name];
    const tableGlyph = (lucide as Record<string, unknown>)[exportName];
    expect(tableGlyph, `\`${exportName}\` is not a lucide-react export`).toBeDefined();
    expect(
      webGlyph,
      `web maps \`${name}\` to \`${webGlyph?.displayName}\`, the shared table says \`${exportName}\` — change the web first, then the table`,
    ).toBe(tableGlyph);
  });
});
