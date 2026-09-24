// Structure tests — public landing ("una mascota, muchas manos").
//
// Guards the PO-locked decisions of the 2026-07-04 landing handoff:
//   1. Cast variant = CastFila (Pampa + 4 hands; the orbit was NOT built)
//   2. Public lookup = DIM public token / DEN denuncia code ONLY (no ISO chip)
//   3. Beta = subtle chip in the trust row (NOT a full-width banner)
//   4. Hero triad copy EXACT: "Gratis para siempre. Sin papeleo. Datos abiertos."
//   5. Estado map = silhouette cartogram tinted celeste (single hue steps)
// Plus structural invariants: 6 chapters + scroll-spy rail, 5 FAQ objections,
// Empezar has EXACTLY 2 doors (no government door), real scannable QR.
//
// Rendering strategy mirrors the repo's other structure tests: components →
// react-dom/server static HTML, no jsdom.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
    className?: string;
    dangerouslySetInnerHTML?: { __html: string };
  }) => React.createElement("a", { href, className, ...rest }, children),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })),
  usePathname: vi.fn(() => "/"),
}));

import { CrisisBand } from "@/components/landing/CrisisBand";
import { EmpezarSection } from "@/components/landing/EmpezarSection";
import { FaqSection } from "@/components/landing/FaqSection";
import { FeaturesSection } from "@/components/landing/FeaturesSection";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingHero } from "@/components/landing/LandingHero";
import { StorySection } from "@/components/landing/StorySection";
import { CHAPTERS } from "@/components/landing/landing-content";

const QR_SVG = '<svg data-qr="demo"><path d="M0 0h1v1H0z"/></svg>';
// A render fixture, not a seed dependency: nothing here touches a database.
// app/page.tsx decides at request time whether a real token exists at all
// (components/landing/demo-pet.ts) — see the no-demo-pet cases below.
const DEMO_TOKEN = "DIM-PAMP-0001";

function renderHero(): string {
  return renderToStaticMarkup(
    <LandingHero qrSvg={QR_SVG} publicHref={`/p/${DEMO_TOKEN}`} publicToken={DEMO_TOKEN} />,
  );
}

/** The hero as a deployment with no demo furniture renders it. */
function renderHeroWithoutDemoPet(): string {
  return renderToStaticMarkup(<LandingHero qrSvg={null} publicHref={null} publicToken={null} />);
}

describe("landing hero — credential + lost demo", () => {
  it("renders the EXACT PO-locked triad copy", () => {
    const html = renderHero();
    expect(html).toContain("Gratis para siempre.");
    expect(html).toContain("Sin papeleo. Datos abiertos.");
    // The old P4-1 variant must not resurface.
    expect(html).not.toContain("Tarda menos de un minuto");
  });

  it("embeds the real QR SVG linking to the seeded demo credential", () => {
    const html = renderHero();
    expect(html).toContain('data-qr="demo"');
    expect(html).toContain(`href="/p/${DEMO_TOKEN}"`);
    // The visible mono token matches what the QR resolves to.
    expect(html).toContain(DEMO_TOKEN);
  });

  // RA-6 finding 1 — the hero used to hardcode a token that only
  // scripts/seed-flagship-pampa.ts writes, so on any deployment provisioned per
  // dim-interno:docs/ops/cutover-playbook.md ("no seed pets") the QR scanned straight into
  // /p's notFound(). A 404 QR on a government front door is worse than no QR.
  it("promises NOTHING scannable when there is no demo pet to resolve", () => {
    const html = renderHeroWithoutDemoPet();
    // No link to a credential that does not exist…
    expect(html).not.toContain('href="/p/');
    // …and no invitation to scan an inert glyph.
    expect(html).not.toContain("Escanealo para ver más");
    expect(html).not.toContain("Ver la credencial pública de demostración");
    // No token is displayed as if it resolved.
    expect(html).not.toContain("DIM-PAMP-");
  });

  it("still renders a complete, presentable credential without a demo pet", () => {
    const html = renderHeroWithoutDemoPet();
    // Degraded ≠ broken: the card, its resting state and the hero copy all stand.
    expect(html).toContain("lp-hcard");
    expect(html).toContain("AL DÍA");
    expect(html).toContain("Gratis para siempre.");
    // Honest microcopy in place of the scan invitation.
    expect(html).toContain("Cada mascota registrada tiene su credencial pública con QR");
  });

  it("renders the credential resting on AL DÍA at SSR (state cycle is client-only)", () => {
    const html = renderHero();
    // The hero is the "credencial viva" card (front credential + back libreta).
    expect(html).toContain("lp-hcard");
    expect(html).toContain("lp-hcard-badge");
    // SSR / no-JS / reduced-motion rest on the first state — "al día".
    expect(html).toContain("AL DÍA");
    // The al-día contextual row is the one painted at rest.
    expect(html).toContain("Vacunas firmadas");
    // Later-state contextual rows only appear via client-side cycling — never in
    // SSR HTML (the per-state row is keyed to the current index; dot aria-labels
    // carry the badge strings, so absence is asserted on the row copy instead).
    expect(html).not.toContain("Requisito jurisdiccional");
    expect(html).not.toContain("Cierra sola en 8 días");
  });
});

describe("crisis band — three doors, no account", () => {
  it("renders all three crisis doors", () => {
    const html = renderToStaticMarkup(<CrisisBand />);
    expect(html).toContain("Perdí una mascota");
    expect(html).toContain("Encontré una mascota");
    // Third door, added 2026-08-19. The band already accepted DEN- tracking
    // codes while the entry to MAKING a denuncia sat in the footer — it
    // offered the follow-up to a thing it gave you no way to start.
    expect(html).toContain("Vi un caso de maltrato");
    expect(html).toContain("/denuncias/nueva");
  });

  it("promises registration and a code — never intervention", () => {
    // A denuncia is registered and issued a tracking code. It is NOT dispatched
    // to an organism yet (the Ley 14.346 integration is still in development,
    // disclosed in the wizard's last step and on /denuncias/seguimiento). The
    // blind QA run found that the moment of "success" already oversells this;
    // the landing must not be the place that oversells it first.
    const html = renderToStaticMarkup(<CrisisBand />);
    expect(html).toContain("código para seguirla");
    expect(html).not.toMatch(/avisá a la autoridad|intervención|denuncia enviada/i);
  });

  it("carries no typed code lookup — the band is doors only", () => {
    // PO decision 2026-08-19: the code lookup left the landing. Both of its
    // jobs have a better-labelled door (/denuncias/buscar explains the DEN case
    // in a sentence; the "Encontré" card is the finder's path) and it occupied
    // the widest column of the highest-traffic page in the product.
    const html = renderToStaticMarkup(<CrisisBand />);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("¿Tenés un código?");
  });
});

describe("denuncia code lookup — PO-locked decision #2 (no 15-digit ISO chip)", () => {
  // SCOPE, stated exactly, because the first version of this block overclaimed
  // it (caught in the pre-push review, 2026-08-19): this covers the CODE
  // LOOKUP controls — the landing band, which no longer has one, and
  // /denuncias/buscar, which does. It does NOT cover every public input that
  // accepts a chip number.
  //
  // The one that is deliberately out of scope: Step4Subject in the denuncia
  // wizard offers "Código miMAR o microchip" to an anonymous reporter and
  // feeds it to lookupPetForDenunciaAction. That is a different feature —
  // identifying the animal you are denouncing, not looking up a code — and it
  // is privacy-reviewed on its own terms: rate-limited, and it returns only
  // petName + petStatus with NO join to the owner, so the property is
  // structural rather than a field somebody remembered to drop. Whether
  // decision #2 was ever meant to reach it is a PO question, not something
  // this test should decide by widening quietly.
  const SEARCH_FORM = readFileSync(
    join(process.cwd(), "app", "(public)", "denuncias", "buscar", "SearchForm.tsx"),
    "utf8",
  );

  it("the denuncia lookup accepts the DEN reference format and nothing else", () => {
    expect(SEARCH_FORM).toContain("isValidReferenceCodeFormat");
    expect(SEARCH_FORM).toContain("DEN-XXXX-XXXX");
  });

  it("no public lookup advertises a chip number", () => {
    expect(SEARCH_FORM).not.toMatch(/chip iso|15 dígitos|\d{15}/i);
    expect(renderToStaticMarkup(<CrisisBand />)).not.toMatch(/chip iso|15 dígitos/i);
  });
});

describe("story — CastFila + 6 chapters + rail", () => {
  it("renders the CastFila variant with Pampa and the 4 hands", () => {
    const html = renderToStaticMarkup(<StorySection />);
    expect(html).toContain('data-section="cast-fila"');
    // Roles are one word each (PO landing feedback #8 — no "el"/"la").
    expect(html).toContain("Dueño");
    expect(html).toContain("Veterinario");
    expect(html).toContain("Organización");
    expect(html).toContain("Estado");
    // The orbit variant is explicitly NOT built (PO decision #1).
    expect(html).not.toContain("orbit");
  });

  it("renders the 6 chapter anchors and the scroll-spy rail", () => {
    const html = renderToStaticMarkup(<StorySection />);
    for (const c of CHAPTERS) {
      expect(html).toContain(`id="cap-${c.key}"`);
    }
    expect(html).toContain('data-section="story-rail"');
    // The anon chapter drives the red rail state via data-s="lost".
    expect(html).toContain('data-s="lost"');
  });

  it("estado console renders the celeste silhouette cartogram (24 tiles, single hue)", () => {
    const html = renderToStaticMarkup(<StorySection />);
    expect(html).toContain('data-section="estado-console"');
    const tiles = html.match(/class="lp-mtile"/g) ?? [];
    expect(tiles.length).toBe(24);
    // Tint steps are data-q 0..4 — no multi-color q-class scheme.
    expect(html).toContain('data-q="4"');
    expect(html).toContain('data-q="0"');
  });

  it("libreta screen shows real system event types (es-AR labels), append-only footer", () => {
    const html = renderToStaticMarkup(<StorySection />);
    // Event types are the REAL system event types (landing-content.ts), but
    // rendered through eventTypeLabel() — raw snake_case must never leak to
    // the public landing (review 19-i18n, item #3).
    expect(html).toContain("Mascota registrada");
    expect(html).toContain("Vacuna administrada");
    expect(html).toContain("Ingreso al refugio");
    expect(html).not.toContain("pet_registered");
    expect(html).not.toContain("vaccination_administered");
    expect(html).not.toContain("shelter_intake_recorded");
    expect(html).toContain("append-only — nada se edita, nada se borra");
  });
});

describe("life moments + FAQ + trust row", () => {
  it("renders the 6 life-moment cards without law citations", () => {
    const html = renderToStaticMarkup(<FeaturesSection />);
    expect(html).toContain("Vi un caso de maltrato");
    expect(html).toContain("Mi perro mordió a alguien");
    expect(html).toContain("Quiero adoptar");
    // No law citations in feature copy (README §6).
    expect(html).not.toMatch(/Ley\s+\d/);
  });

  it("renders 5 objection <details> and the trust row with a subtle beta chip", () => {
    const html = renderToStaticMarkup(<FaqSection />);
    const details = html.match(/<details/g) ?? [];
    expect(details.length).toBe(5);
    expect(html).toContain("¿Cuánto cuesta?");
    expect(html).toContain('data-section="trust-row"');
    expect(html).toContain("Datos abiertos");
    expect(html).toContain(">beta<");
    // Copy-trim decision (2026-07-21): "Ley 25.326" lives ONLY in the footer
    // legal line now — the trust row's repeat of it was removed. Likewise
    // "Gratis para siempre" stays in the hero + this section's cost FAQ
    // answer only, not as a third badge here.
    expect(html).not.toContain("Ley 25.326");
    expect(html).not.toContain("Gratis para siempre");
  });
});

describe("empezar — two doors only", () => {
  it("renders EXACTLY 2 role cards: dueño (primary) + organización — no government door", () => {
    const html = renderToStaticMarkup(<EmpezarSection />);
    // The cards carry entrance-choreography classes (lp-reveal + data-d) since
    // 2026-08-02, so match on the class NAME, not the exact attribute value.
    const cards = html.match(/class="lp-role-card[^"]*"/g) ?? [];
    expect(cards.length).toBe(2);
    expect(html).toContain("Soy dueño");
    expect(html).toContain("Soy organización");
    expect(html).not.toContain("Soy gobierno");
    expect(html).toContain('href="/registro"');
  });
});

describe("footer", () => {
  it("renders brand + 3 nav columns + legal line", () => {
    const html = renderToStaticMarkup(<LandingFooter />);
    expect(html).toContain("miMAR");
    expect(html).toContain("Ciudadanía");
    expect(html).toContain("Operadores");
    expect(html).toContain("Institucional");
    expect(html).toContain("Ley 25.326");
    expect(html).toContain('href="/perdidas"');
    expect(html).toContain('href="/accesibilidad"');
  });
});
