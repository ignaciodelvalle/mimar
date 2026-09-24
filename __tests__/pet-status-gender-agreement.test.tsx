/**
 * The pet-status flag must agree with the animal — everywhere, not just in the
 * primitive.
 *
 * critique-libreta 2026-07-27 finding #5: `flagConfig` carried a fixed
 * masculine "PERDIDO" beside a fixed feminine "REGISTRADA", so Luna — a female
 * dog — was flagged PERDIDO on the owner's list while her own credential badge
 * and her lost poster said PERDIDA. The credential had already been swept for
 * exactly this (QA histórico 2026-07-08 #2, which is where `registeredAdjective`
 * comes from). The list, and the landing's story rail, had not.
 *
 * `components/ui/StatusFlag.test.tsx` pins the primitive. This file pins the
 * WIRING, which is the half that actually reaches a screen: a gendered
 * component whose callers never pass a sex still renders the wrong word.
 *
 * Two of the four checks are source scans rather than renders, because the
 * owner home is a server component with DB access. Same style as
 * owned-pets-count-slot-signal.test.ts / owner-process-clarity-19.test.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LnHero } from "@/components/ui/Hero";
import { LnRegRow } from "@/components/ui/RegRow";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

// ---------------------------------------------------------------------------
// The primitives that own the chip must forward the sex they are given
// ---------------------------------------------------------------------------

describe("LnRegRow forwards the pet's sex to its status flag", () => {
  it("renders the feminine label for a female pet", () => {
    const html = renderToStaticMarkup(<LnRegRow name="Luna" status="lost" sex="female" />);
    expect(html).toContain("PERDIDA");
    expect(html).not.toMatch(/>PERDIDO</);
  });

  it("renders the masculine label for a male pet", () => {
    const html = renderToStaticMarkup(<LnRegRow name="Tobi" status="lost" sex="male" />);
    expect(html).toContain("PERDIDO");
  });

  it("falls back to the inclusive form when the row has no sex", () => {
    const html = renderToStaticMarkup(<LnRegRow name="Pelusa" status="lost" />);
    expect(html).toContain("PERDIDO/A");
  });
});

describe("LnHero forwards the pet's sex to its status flag", () => {
  it("renders the feminine label for a female pet", () => {
    const html = renderToStaticMarkup(<LnHero name="Luna" status="lost" sex="female" />);
    expect(html).toContain("PERDIDA");
    expect(html).not.toMatch(/>PERDIDO</);
  });
});

// ---------------------------------------------------------------------------
// The call sites must actually PASS a sex
// ---------------------------------------------------------------------------

describe("the owner's pet list passes the pet's sex", () => {
  const ownerHome = read("app", "(app)", "mis-mascotas", "page.tsx");

  it("hands pet.sex to LnRegRow", () => {
    // This is the exact screen the finding was filed against. Without this
    // prop the primitive is gendered and the screen is still wrong.
    expect(
      /<LnRegRow[\s\S]{0,600}?sex=\{pet\.sex\}/.test(ownerHome),
      "app/(app)/mis-mascotas/page.tsx must pass sex={pet.sex} to <LnRegRow>",
    ).toBe(true);
  });

  it("still builds the breed/sex line separately (the sex prop is not a rename)", () => {
    // Guard against a "fix" that repurposes the descriptive line instead of
    // feeding the chip — the two are different things on screen.
    expect(ownerHome).toContain('pet.sex === "male" ? "Macho" : "Hembra"');
  });
});

describe("the landing story passes Pampa's sex", () => {
  const content = read("components", "landing", "landing-content.ts");
  const rail = read("components", "landing", "StorySection.tsx");
  const screens = read("components", "landing", "story-screens.tsx");

  it("declares Pampa's sex in a form the components can inflect on", () => {
    // The display field is "Hembra", which normalizeSex() reads as unknown.
    expect(content).toContain('sex: "Hembra"');
    expect(content).toContain('sexEnum: "female"');
  });

  it("passes it wherever the flag can render a lost state", () => {
    // Pampa is the flagship pet and this is the first screen of the product,
    // so the misgendering was more visible here than on the list it was
    // reported against.
    expect(content).toContain('flag: "lost"');
    expect(rail).toMatch(/<LnStatusFlag[^>]*sex=\{PAMPA\.sexEnum\}/);
    expect(screens).toMatch(/<LnStatusFlag[^>]*sex=\{PAMPA\.sexEnum\}/);
  });
});
