// Structure tests — public landing ("una mascota, muchas manos").
//
// Guards the PO-locked decisions of the 2026-07-04 landing handoff:
//   1. Cast variant = CastFila (Pampa + 4 hands; the orbit was NOT built)
//   2. Public lookup = DIM public token / DEN denuncia code ONLY (no ISO chip)
//   3. Beta = subtle chip in the trust row (NOT a full-width banner)
//   4. Hero triad copy EXACT: "Gratis para siempre. Sin papeleo. Estadísticas
//      abiertas, sin datos personales." (PO revision 2026-09-29, critique M3)
//   5. Estado map = silhouette cartogram tinted celeste (single hue steps)
// Plus structural invariants: 6 chapters + scroll-spy rail, 5 FAQ objections,
// Empezar has 3 equal doors (the municipio one is an information page, never a
// government sign-up), real scannable QR.
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

import { ICON_MAP } from "@/components/Icon";
import { EmpezarSection } from "@/components/landing/EmpezarSection";
import { FaqSection } from "@/components/landing/FaqSection";
import { FeaturesSection } from "@/components/landing/FeaturesSection";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingHero } from "@/components/landing/LandingHero";
import { StorySection } from "@/components/landing/StorySection";
import {
  ACTORS,
  CHAPTERS,
  HERO_MRZ_WIDTH,
  LIFE_MOMENTS,
  heroMrzLines,
} from "@/components/landing/landing-content";

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
    // PO 2026-09-30: "sin datos personales" -> "y anónimas".
    expect(html).toContain("Sin papeleo. Estadísticas abiertas y anónimas.");
    // "Datos abiertos" next to a pet's credential read as "her data is open".
    expect(html).not.toContain("Datos abiertos");
    // The old P4-1 variant must not resurface.
    expect(html).not.toContain("Tarda menos de un minuto");
  });

  // PO 2026-09-30: the hero lead used to close on "Lo que firma tu
  // veterinaria no se edita: si algo estaba mal, se corrige con un asiento
  // nuevo." — removed from the hero (the same idea still lives in chapter 5,
  // StorySection.tsx) to make room for the Play badge right below the lead.
  it("no longer carries the 'no se edita … asiento nuevo' sentence in the hero lead", () => {
    const html = renderHero();
    expect(html).not.toContain("no se edita");
    expect(html).not.toContain("se corrige con un asiento nuevo");
  });

  // PO 2026-09-30: the official Google Play badge, right below the hero
  // lead — a plain image (never a link: there is no listing URL yet).
  it("renders the Google Play badge as a plain image, never a link", () => {
    const html = renderHero();
    expect(html).toContain('alt="Disponible en Google Play"');
    // It must never be wrapped in an <a> — a disabled/dead link is worse than
    // an inert image (docs/agents brief, PO 2026-09-30).
    const badgeIdx = html.indexOf("lp-hero-badge");
    expect(badgeIdx).toBeGreaterThan(-1);
    const badgeBlock = html.slice(badgeIdx, badgeIdx + 400);
    expect(badgeBlock).not.toContain("<a ");
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
    // The visible status chip was removed (PO 2026-09-25): the state now
    // reads through the card's background colour (lost) plus the sr-only
    // live region below, never through a `.lp-hcard-badge` element.
    expect(html).not.toContain("lp-hcard-badge");
    // SSR / no-JS / reduced-motion rest on the first state — "al día" — which
    // now surfaces only through the sr-only aria-live carrier.
    expect(html).toContain("AL DÍA");
    // The al-día contextual row is the one painted at rest.
    expect(html).toContain("Vacunas firmadas");
    // Later-state contextual rows only appear via client-side cycling — never in
    // SSR HTML (the per-state row is keyed to the current index; dot aria-labels
    // carry the badge strings, so absence is asserted on the row copy instead).
    expect(html).not.toContain("Plan en el historial");
    // The jurisdiction PAPERWORK state is still gone from the hero (PO
    // 2026-09-29, critique M4, reversing handoff decision B4) — "PPP" is
    // explained nowhere on the page and /municipios already covers that
    // registration workflow. A DIFFERENT "en observación antirrábica" state
    // was added later the same day (separate PO request): a bite/rabies
    // observation is the owner's own situation, not jurisdiction paperwork, so
    // its dot legitimately puts "OBSERVACIÓN" back into every render via its
    // static aria-label — only the PPP-specific wording stays banned.
    expect(html).not.toContain("PPP");
    expect(html).not.toContain("Requisito jurisdiccional");
  });
});

// The hero card mirrors the REAL credential the QR opens (PO 2026-09-25) and
// is miMAR's document, never a State one. The passport line it used to carry
// opened "P<ARG" — the document and issuing-State codes of an Argentine
// passport — which is the state-endorsement overclaim in machine-readable form.
describe("landing hero — the credential is miMAR's own document", () => {
  // renderToStaticMarkup escapes "<"; read the strip back as text.
  const asText = (html: string) => html.replaceAll("&lt;", "<");

  it("carries the issuing line and the identity fields the public credential prints", () => {
    const html = renderHero();
    expect(html).toContain("Credencial miMAR");
    for (const label of ["Raza", "Microchip"]) {
      expect(html, label).toContain(`<dt>${label}</dt>`);
    }
  });

  // "Sexo" and "Edad" were removed from the front (PO 2026-09-30): the field
  // grid only needs the two facts a scanner actually uses.
  it("no longer carries Sexo or Edad on the front", () => {
    const html = renderHero();
    expect(html).not.toContain("<dt>Sexo</dt>");
    expect(html).not.toContain("<dt>Edad</dt>");
  });

  it("prints a machine-readable strip in miMAR's format, built from the real token", () => {
    const [line1, line2] = heroMrzLines(DEMO_TOKEN);
    expect(line1).toBe("MIMAR<DIM<PAMP<0001<<PAMPA<<<<");
    expect(line2.startsWith("PERRO<CANICHE<<H<2021<11")).toBe(true);
    expect(line1).toHaveLength(HERO_MRZ_WIDTH);
    expect(line2).toHaveLength(HERO_MRZ_WIDTH);
    const text = asText(renderHero());
    expect(text).toContain(line1);
    expect(text).toContain(line2);
  });

  it("never reads as a State document", () => {
    for (const text of [asText(renderHero()), asText(renderHeroWithoutDemoPet())]) {
      expect(text).not.toContain("P<ARG");
      expect(text).not.toMatch(/Rep[uú]blica Argentina/i);
      expect(text).not.toMatch(/escudo/i);
    }
  });

  it("masks the token in the strip when there is no demo pet, as it does on the face", () => {
    const text = asText(renderHeroWithoutDemoPet());
    expect(text).toContain("MIMAR<DIM<<<<<<<<<<<<PAMPA");
    expect(text).not.toContain("PAMP<0001");
  });
});

// The doors left their own band for the hero on 2026-10-02 (PO): on every
// screen the band sat below the fold, and the hero's CTA row repeated what the
// nav already offers. Same three doors, same destinations, no account.
describe("quick doors — four doors in the hero, no account", () => {
  function doors(html: string): string {
    const start = html.indexOf('data-section="crisis-doors"');
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("</nav>", start));
  }

  it("renders the four quick doors inside the hero (PO 2026-10-02)", () => {
    const html = doors(renderHero());
    expect(html).not.toContain("Perdí una mascota");
    expect(html).toContain("Encontré una mascota");
    expect(html).toContain("Adoptar");
    expect(html).toContain("Refugios y vets cerca");
    // Third door, added 2026-08-19. The band already accepted DEN- tracking
    // codes while the entry to MAKING a denuncia sat in the footer — it
    // offered the follow-up to a thing it gave you no way to start.
    expect(html).toContain("Vi un caso de maltrato");
    expect(html.match(/<a /g)).toHaveLength(4);
    for (const href of [
      'href="/perdidas"',
      'href="/adoptar"',
      'href="/refugios"',
      'href="/denuncias/nueva"',
    ]) {
      expect(html).toContain(href);
    }
  });

  it("the doors render the same with or without a demo pet", () => {
    expect(doors(renderHeroWithoutDemoPet())).toBe(doors(renderHero()));
  });

  it("promises no account — never intervention", () => {
    // A denuncia is registered and issued a tracking code. It is NOT dispatched
    // to an organism yet (the Ley 14.346 integration is still in development,
    // disclosed in the wizard's last step and on /denuncias/seguimiento). The
    // blind QA run found that the moment of "success" already oversells this;
    // the landing must not be the place that oversells it first.
    const html = doors(renderHero());
    expect(html).toContain("Denunciá sin cuenta.");
    expect(html).not.toMatch(/avisá a la autoridad|intervención|denuncia enviada/i);
  });

  it("carries no typed code lookup — doors only", () => {
    // PO decision 2026-08-19: the code lookup left the landing. Both of its
    // jobs have a better-labelled door (/denuncias/buscar explains the DEN case
    // in a sentence; the "Encontré" card is the finder's path) and it occupied
    // the widest column of the highest-traffic page in the product.
    const html = doors(renderHero());
    expect(html).not.toContain("<input");
    expect(html).not.toContain("¿Tenés un código?");
  });
});

describe("denuncia code lookup — PO-locked decision #2 (no 15-digit ISO chip)", () => {
  // SCOPE, stated exactly, because the first version of this block overclaimed
  // it (caught in the pre-push review, 2026-08-19): this covers the CODE
  // LOOKUP controls — the landing's crisis doors, which have none, and
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
    expect(renderHero()).not.toMatch(/chip iso|15 dígitos/i);
  });
});

describe("story — CastFila + 6 chapters + rail", () => {
  it("renders the CastFila variant with Pampa and the 4 hands", () => {
    const html = renderToStaticMarkup(<StorySection />);
    expect(html).toContain('data-section="cast-fila"');
    // Roles are one word each (PO landing feedback #8 — no "el"/"la"), and
    // the SAME word the chapters use (critique 2026-09-29, M6).
    expect(ACTORS.map((a) => a.name)).toEqual(["Dueño", "Veterinaria", "Refugio", "Estado"]);
    for (const a of ACTORS) expect(html).toContain(`<b>${a.name}.</b>`);
    expect(html).not.toContain("Veterinario");
    expect(html).not.toContain("Organización");
    // The orbit variant is explicitly NOT built (PO decision #1).
    expect(html).not.toContain("orbit");
  });

  it("the cast is one paragraph, not a second set of chapter shortcuts (M6)", () => {
    const html = renderToStaticMarkup(<StorySection />);
    const cast = html.slice(
      html.indexOf('data-section="cast-fila"'),
      html.indexOf('data-section="story-rail-shell"'),
    );
    expect(cast).toContain('<p class="lp-castfila-hands">');
    expect(cast).not.toContain("<button");
  });

  it("the rail names moments, not hands (M6)", () => {
    expect(CHAPTERS.map((c) => c.moment)).toEqual([
      "Alta",
      "Vacuna",
      "Se pierde",
      "Refugio",
      "Libreta",
      "Estado",
    ]);
    const html = renderToStaticMarkup(<StorySection />);
    for (const c of CHAPTERS) expect(html).toContain(`<span class="lp-rname">${c.moment}</span>`);
    expect(html).not.toContain("Anónimo</span>");
  });

  it("every device mock is hidden from assistive tech; the chapter copy is the summary (m6)", () => {
    const html = renderToStaticMarkup(<StorySection />);
    const phones = html.match(/<div class="lp-phone"[^>]*>/g) ?? [];
    // Owner-device chapters at SSR (dueno, anon and refugio's final step —
    // Martín's phone — and libreta): 4. The vet chapter's SSR-final step is
    // now a tablet, not a phone (PO 2026-09-29 — the org portal chapters).
    expect(phones.length).toBeGreaterThanOrEqual(4);
    for (const p of phones) expect(p).toContain('aria-hidden="true"');
    const tablets = html.match(/<div class="lp-tablet"[^>]*>/g) ?? [];
    // The vet chapter's SSR-final step is a tablet at every render.
    expect(tablets.length).toBeGreaterThanOrEqual(1);
    for (const t of tablets) expect(t).toContain('aria-hidden="true"');
    expect(html).toMatch(/<div class="lp-mac" aria-hidden="true">/);
    // Each chapter carries readable copy outside its device. The animated
    // chapters show no visible lead (PO 2026-09-30, "sin descripción"): their
    // lead is screen-reader text next to the back/forward controls.
    const chapters = html.split(/id="cap-/).slice(1);
    expect(chapters).toHaveLength(CHAPTERS.length);
    for (const ch of chapters) expect(ch).toMatch(/lp-ch-lead|lp-estado-bridge|lp-seq-nav/);
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

  it("the phone scales down on short desktop viewports instead of overrunning them (M5)", () => {
    const css = readFileSync(join(process.cwd(), "app", "landing.css"), "utf8");
    const scaled = [
      ...css.matchAll(
        /@media \(min-width: 941px\) and \(max-height: (\d+)px\) \{\s*\.lp \.lp-ch-device \.lp-phone \{\s*zoom: ([\d.]+);/g,
      ),
    ].map((m) => ({ maxHeight: Number(m[1]), zoom: Number(m[2]) }));
    expect(scaled.length).toBeGreaterThanOrEqual(2);
    // Every chapter's phone is now the SAME 640px frame (PhoneFrame's `tall`
    // variant was removed, PO 2026-09-29: it used to make the libreta chapter's
    // phone 760px, visibly bigger than the rest of the story). Plus the nav,
    // it fits an 800px-tall viewport.
    const at800 = scaled.filter((s) => s.maxHeight >= 800).map((s) => s.zoom);
    expect(Math.min(...at800) * 640 + 64 + 40).toBeLessThanOrEqual(800);
  });

  it("the story's sequences never loop (WCAG 2.2.2)", () => {
    // The lost chapter's pin used to pulse forever; it was capped at three
    // (dddee51a4) and then removed with the map it sat on — Pampa's lost
    // report has no coordinates, so her public page draws no map. What stays
    // true is the rule: nothing the story animates on its own repeats.
    const css = readFileSync(join(process.cwd(), "app", "landing.css"), "utf8");
    expect(css).not.toContain("lp-minimap");
    const storyRules = css.match(/\.lp \.lp-(seq|rail|map-grid|vf)[^{]*\{[^}]*\}/g) ?? [];
    expect(storyRules.length).toBeGreaterThan(5);
    for (const rule of storyRules) expect(rule).not.toContain("infinite");
  });

  it("tells Pampa's life in order and closes on the Estado bridge (PO, 2026-09-25)", () => {
    expect(CHAPTERS.map((c) => c.key)).toEqual([
      "dueno",
      "vet",
      "anon",
      "refugio",
      "libreta",
      "estado",
    ]);
    const html = renderToStaticMarkup(<StorySection />);
    // Anchors render in that order, and the rail numbers follow them.
    const anchors = [...html.matchAll(/id="cap-([a-z]+)"/g)].map((m) => m[1]);
    expect(anchors).toEqual(CHAPTERS.map((c) => c.key));
    expect(html).toContain("Capítulo 6 · Estado");
    // The bridge is the Estado heading's standfirst, inside the console
    // (critique 2026-09-29, m8), not loose text above it.
    expect(html).toContain(
      '<p class="lp-estado-bridge">Esa dosis de campaña es una más en la cobertura de su comuna.</p>',
    );
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

  it("the Estado chapter leads with privacy, keeps a small console and hands off to /municipios (M7)", () => {
    const html = renderToStaticMarkup(<StorySection />);
    const estado = html.slice(html.indexOf('data-section="estado-console"'));
    // The owner's line comes before the console window.
    // Copy review 2026-09-30 (the state-access claim, minimal option): "solo
    // datos agregados, nunca individuales" was false — a funcionario can open
    // any pet's file in their own jurisdiction. Replaced with the truthful,
    // narrower claim: only their own zone, and every access is logged.
    const privacy = estado.indexOf(
      "La autoridad de tu zona accede a lo que necesita para cuidar la salud pública",
    );
    expect(privacy).toBeGreaterThan(-1);
    expect(privacy).toBeLessThan(estado.indexOf('class="lp-mac"'));
    // Map + two KPIs, not four.
    expect(estado.match(/class="lp-navy-card/g)?.length).toBe(2);
    expect(estado).toContain('href="/municipios"');
    expect(estado).toContain("Ver más para municipios");
    // Still says the numbers are made up.
    expect(estado).toContain("datos de demostración");
    // No operator jargon in the chapter's own words.
    expect(estado).not.toContain("planillas");
  });

  it("libreta screen shows the native asientos (es-AR labels), no invented footer", () => {
    const html = renderToStaticMarkup(<StorySection />);
    // The native libreta's own eyebrows and titles (components/pet-profile/
    // asiento-fields.ts toAsientoView, via the native LibretaScreen) — raw
    // snake_case must never leak to the public landing (review 19-i18n, #3).
    expect(html).toContain("Mascota registrada");
    expect(html).toContain("Vacuna · obligatoria");
    expect(html).toContain("Ingreso al refugio");
    expect(html).not.toContain("pet_registered");
    expect(html).not.toContain("vaccination_administered");
    expect(html).not.toContain("shelter_intake_recorded");
    // Límites honestos A.1 wording (2026-09-24): "nada se edita, nada se borra"
    // overclaimed — account erasure replaces the user's own free text. The
    // landing's own "Historial que solo se agrega" badge was not product copy
    // (landing-vs-app audit 2026-09-30), and the native face's note says the
    // events are never deleted, so no footer is drawn at all.
    expect(html).not.toContain("Historial que solo se agrega");
    expect(html).not.toContain("nada se borra");
    expect(html).not.toContain("no se editan ni se borran");
  });
});

// "El porqué" — the full-bleed photo band between the hero and the story —
// was removed entirely (PO 2026-10-02), photo and CSS with it.
describe("the 'El porqué' band is gone", () => {
  const PAGE = readFileSync(join(process.cwd(), "app", "page.tsx"), "utf8");
  const CSS = readFileSync(join(process.cwd(), "app", "landing.css"), "utf8");

  it("the page mounts neither of the two bands that used to sit under the hero", () => {
    expect(PAGE).not.toMatch(/BondBand|CrisisBand/);
    expect(CSS).not.toMatch(/\.lp-bond|\.lp-crisis/);
  });

  it("the photo and its components are deleted, not just unmounted", () => {
    for (const file of [
      ["public", "landing", "portada.jpg"],
      ["components", "landing", "BondBand.tsx"],
      ["components", "landing", "CrisisBand.tsx"],
    ]) {
      expect(() => readFileSync(join(process.cwd(), ...file)), file.join("/")).toThrow();
    }
  });

  it("no rendered section still says it", () => {
    const html = [renderHero(), renderToStaticMarkup(<StorySection />)].join(" ");
    expect(html).not.toContain("El porqué");
    expect(html).not.toContain("Un vínculo para toda la vida");
  });
});

describe("life moments + FAQ + trust row", () => {
  it("titles the band for every situation, not only bad days (M10)", () => {
    const html = renderToStaticMarkup(<FeaturesSection />);
    expect(html).toContain("Para cada situación");
    expect(html).not.toContain("no es un buen día");
  });

  it("renders the 6 life-moment cards without law citations", () => {
    const html = renderToStaticMarkup(<FeaturesSection />);
    expect(html.match(/<article class="lp-feat /g) ?? []).toHaveLength(6);
    expect(html).toContain("Mi perro mordió a alguien");
    expect(html).toContain("Quiero adoptar");
    // The travel card (PO 2026-10-01).
    expect(html).toContain("Me voy de viaje con mi mascota");
    expect(html).toContain(
      "Te dice qué le falta según el país y la aerolínea, con lo que ya está en su libreta.",
    );
    // "Vi un caso de maltrato" was cut here (copy review 2026-09-30, D6):
    // the hero's crisis doors already carry this exact door, and this
    // card's own body contradicted the real denuncia flow.
    expect(html).not.toContain("Vi un caso de maltrato");
    // No law citations in feature copy (README §6).
    expect(html).not.toMatch(/Ley\s+\d/);
  });

  it("every life-moment icon is a real glyph, never the HelpCircle fallback", () => {
    for (const m of LIFE_MOMENTS) {
      expect(ICON_MAP[m.icon], `${m.title}: icon "${m.icon}"`).toBeDefined();
    }
    // The travel card's suitcase (components/Icon.tsx, PO 2026-10-01).
    expect(ICON_MAP.valija?.displayName).toBe("Luggage");
  });

  it("the card count fills every row of the grid: 6 = 3 × 2 = 2 × 3", () => {
    // .lp-feat-grid tops out at three columns and drops to two on a tablet
    // (app/landing.css, auto-fit with a 300px minimum), so a count divisible
    // by both leaves no card alone in its row.
    expect(LIFE_MOMENTS.length % 3).toBe(0);
    expect(LIFE_MOMENTS.length % 2).toBe(0);
  });

  it("renders 5 objection <details> and the trust row with a subtle beta chip", () => {
    const html = renderToStaticMarkup(<FaqSection />);
    const details = html.match(/<details/g) ?? [];
    expect(details.length).toBe(6);
    expect(html).toContain("¿Cuánto cuesta?");
    expect(html).toContain('data-section="trust-row"');
    expect(html).toContain("Estadísticas abiertas");
    expect(html).not.toContain("Datos abiertos");
    expect(html).toContain(">beta<");
    // Copy-trim decision (2026-07-21): the trust row's "Ley 25.326" was
    // removed (and the footer's norm line went too, 2026-10-02). Likewise
    // "Gratis para siempre" stays in the hero + this section's cost FAQ
    // answer only, not as a third badge here.
    expect(html).not.toContain("Ley 25.326");
    expect(html).not.toContain("Gratis para siempre");
  });
});

describe("empezar — one row of three equal doors (PO 2026-10-02)", () => {
  // Landing redesign WU4 (PO, 2026-09-24) reverses the old "no government
  // door" rule: the third door leads to /municipios, a PUBLIC information page,
  // never to sign-up — institutional accounts stay invite-only.
  function cards(html: string): string[] {
    return html.split(/<article class="lp-role-card/).slice(1);
  }

  it("renders EXACTLY 3 cards — dueño, organización, municipio — each with one line and one button", () => {
    const html = renderToStaticMarkup(<EmpezarSection />);
    const all = cards(html);
    expect(all).toHaveLength(3);
    expect(all.map((c) => c.match(/<h3>([^<]*)<\/h3>/)?.[1])).toEqual([
      "Tu mascota",
      "Refugios y veterinarias",
      "Municipios y provincias",
    ]);
    expect(html).toContain("Su credencial con QR, lista en minutos.");
    expect(html).toContain("Custodia, adopciones y atención, con acceso verificado.");
    expect(html).toContain("Campañas, cobertura y casos de tu jurisdicción.");
    for (const card of all) {
      expect(card.match(/<p>/g), "one line per card").toHaveLength(1);
      expect(card.match(/<a /g), "one button per card").toHaveLength(1);
    }
  });

  it("each button goes where the PO decided, and only the owner's is primary", () => {
    const html = renderToStaticMarkup(<EmpezarSection />);
    const [owner, org, gob] = cards(html);
    expect(owner).toContain('href="/registro"');
    expect(owner).toContain("Crear mi miMAR");
    expect(owner).toContain("lp-btn--primary");
    expect(org).toContain('href="/organizaciones/solicitar-acceso"');
    expect(org).toContain("Solicitar acceso");
    expect(gob).toContain('href="/municipios"');
    expect(gob).toContain("Conocer más");
    expect(html.match(/lp-btn--primary/g)).toHaveLength(1);
    expect(html.match(/class="lp-role-card[^"]*lp-role-card--primary[^"]*"/g)).toHaveLength(1);
  });

  it("no card says 'Ya tengo cuenta', lists steps, or signs a government up", () => {
    const html = renderToStaticMarkup(<EmpezarSection />);
    expect(html).not.toContain("Ya tengo cuenta");
    expect(html).not.toContain('href="/iniciar-sesion"');
    expect(html).not.toContain("<ol");
    expect(html).not.toContain("empezar-steps");
    expect(html).not.toContain("Soy gobierno");
    const gob = cards(html)[2];
    expect(gob).not.toContain('href="/registro"');
  });

  it("the cards sit in one row of three on a wide screen", () => {
    const css = readFileSync(join(process.cwd(), "app", "landing.css"), "utf8");
    expect(css).toMatch(
      /\.lp \.lp-role-grid \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/,
    );
    // No card spans the row any more.
    expect(css).not.toMatch(/\.lp \.lp-role-card--primary \{[^}]*grid-column/);
  });

  it("the organization's request route exists", () => {
    const page = join(
      process.cwd(),
      "app",
      "(public)",
      "organizaciones",
      "solicitar-acceso",
      "page.tsx",
    );
    expect(() => readFileSync(page, "utf8")).not.toThrow();
  });
});

// Critique 2026-09-29, M1 — the page promised "anyone can scan it if she gets
// lost" and never said how the QR reaches the collar.
describe("how the QR reaches the collar (M1)", () => {
  it("the FAQ answers it with the two paths that exist: self-print and a pre-issued tag", () => {
    // The self-print channel really is on by default, for every jurisdiction.
    const defaults = readFileSync(
      join(process.cwd(), "lib", "domain", "business-rules-defaults.ts"),
      "utf8",
    );
    expect(defaults).toMatch(/physical_credential_channels: \{\s*printable_qr: true,/);
    const html = renderToStaticMarkup(<FaqSection />);
    expect(html).toContain("¿Cómo le pongo el QR?");
    // PO 2026-10-02: the exact answer, without the jurisdiction qualifier —
    // the printable sheet's channel defaults to ON everywhere
    // (lib/domain/business-rules-defaults.ts, physical_credential_channels).
    expect(html).toContain(
      "Desde la ficha de tu mascota imprimís su chapita con el QR. Si te dieron una chapa miMAR, la activás desde tu cuenta.",
    );
    expect(html).not.toContain("si tu jurisdicción lo habilita");
    // Both paths are real routes today.
    for (const route of [
      ["app", "(app)", "mis-mascotas", "[publicToken]", "chapita", "page.tsx"],
      ["app", "(app)", "cuenta", "chapas", "activar", "page.tsx"],
    ]) {
      expect(() => readFileSync(join(process.cwd(), ...route), "utf8")).not.toThrow();
    }
  });
});

// PO 2026-10-02: the phone question covers changing or losing it, not only theft.
describe("the phone FAQ", () => {
  it("asks about changing or losing the phone and says the libreta lives in the account", () => {
    const html = renderToStaticMarkup(<FaqSection />);
    expect(html).toContain("¿Y si cambio o pierdo el teléfono?");
    expect(html).toContain(
      "No pasa nada: tu libreta está en tu cuenta, no en el teléfono. Entrás desde cualquier dispositivo y el QR sigue funcionando igual.",
    );
    expect(html).not.toContain("¿Y si me roban el teléfono?");
  });
});

describe("footer", () => {
  // PO 2026-10-02: four short columns and a small legal row at the bottom.
  function columns(html: string): Array<{ heading: string; hrefs: string[] }> {
    return html
      .split(/<h4[^>]*>/)
      .slice(1)
      .map((chunk) => ({
        heading: chunk.slice(0, chunk.indexOf("</h4>")),
        hrefs: [...chunk.slice(0, chunk.indexOf("</ul>")).matchAll(/href="([^"]+)"/g)].map(
          (m) => m[1],
        ),
      }));
  }

  it("renders the brand + 4 columns, each with the PO's links in order", () => {
    const html = renderToStaticMarkup(<LandingFooter />);
    expect(html).toContain("miMAR");
    expect(columns(html)).toEqual([
      {
        heading: "Para vos",
        hrefs: ["/registro", "/perdidas", "/adoptar", "/refugios", "/denuncias/nueva"],
      },
      { heading: "Ayuda", hrefs: ["/ayuda", "/denuncias/buscar"] },
      {
        heading: "Organizaciones",
        hrefs: ["/organizaciones/solicitar-acceso", "/municipios", "/iniciar-sesion"],
      },
      {
        heading: "miMAR",
        hrefs: ["/acerca", "/funcionalidades", "/transparencia", "/leyes"],
      },
    ]);
    for (const label of [
      "Crear mi miMAR",
      "Mascotas perdidas",
      "Adoptar",
      "Denunciar maltrato",
      "Centro de ayuda",
      "Seguir mi denuncia",
      "Refugios y veterinarias",
      "Municipios",
      "Iniciar sesión",
      "Acerca",
      "Funcionalidades",
      "Transparencia y datos",
      "Marco legal",
    ]) {
      expect(html, label).toContain(`>${label}</a>`);
    }
  });

  it("the brand's column heading keeps the brand's casing", () => {
    const html = renderToStaticMarkup(<LandingFooter />);
    expect(html).toContain('<h4 class="lp-foot-h-brand">miMAR</h4>');
    const css = readFileSync(join(process.cwd(), "app", "landing.css"), "utf8");
    expect(css).toMatch(/\.lp \.lp-foot h4\.lp-foot-h-brand \{\s*text-transform: none;/);
  });

  it("closes on a small legal row: Privacidad · Términos · Cookies · Accesibilidad", () => {
    const html = renderToStaticMarkup(<LandingFooter />);
    const legal = html.slice(html.indexOf('class="lp-foot-legal"'));
    expect([...legal.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "/privacidad",
      "/terminos",
      "/cookies",
      "/accesibilidad",
    ]);
    // None of them is repeated up in the columns.
    for (const { hrefs } of columns(html)) {
      for (const href of ["/privacidad", "/terminos", "/cookies", "/accesibilidad"]) {
        expect(hrefs).not.toContain(href);
      }
    }
  });

  it("keeps the independence line and drops the norm line (Ley 14.346 / Ley 25.326)", () => {
    const html = renderToStaticMarkup(<LandingFooter />);
    expect(html).toContain(
      "miMAR es un proyecto independiente: no es un sitio oficial del Estado argentino.",
    );
    expect(html).not.toContain("Ley 25.326");
    expect(html).not.toContain("Ley 14.346");
    expect(html).not.toContain("se encuadran");
  });

  // Copy review 2026-09-30 (D1/D2/D3): the footer used to repeat the
  // append-only mechanic, the anonymous-stats promise and the free-forever
  // promise — all already said elsewhere on the page.
  it("no longer repeats the append-only / anonymous-stats / free-forever promises", () => {
    const html = renderToStaticMarkup(<LandingFooter />);
    expect(html).not.toContain("historial que solo se agrega");
    expect(html).not.toContain("estadísticas abiertas");
    expect(html).not.toContain("Gratis");
  });
});

// Copy review 2026-09-30 — the full punch list of removed overclaims and
// repeats, checked across the rendered sections they used to live in.
describe("copy review 2026-09-30 — removed overclaims stay removed", () => {
  function reviewedSections(): string {
    return [
      renderHero(),
      renderToStaticMarkup(<StorySection />),
      renderToStaticMarkup(<FeaturesSection />),
      renderToStaticMarkup(<FaqSection />),
      renderToStaticMarkup(<LandingFooter />),
    ].join(" ");
  }

  it("the false 'the State sees only totals' claim is gone from every place it used to appear", () => {
    const html = reviewedSections();
    expect(html).not.toMatch(/ve solo totales/i);
    expect(html).not.toContain("nunca a tu mascota");
    expect(html).not.toContain("nunca a Pampa");
    expect(html).not.toContain("sin ver las de nadie");
  });

  it("the new, truthful state-access line is present in the Estado chapter and the matching FAQ", () => {
    const truthfulLine = "accede a lo que necesita para cuidar la salud pública";
    expect(renderToStaticMarkup(<StorySection />)).toContain(truthfulLine);
    expect(renderToStaticMarkup(<FaqSection />)).toContain(truthfulLine);
  });

  it("'Volvió a casa' / 'vuelve a casa' are gone from the narrative", () => {
    const html = reviewedSections();
    expect(html).not.toContain("Volvió a casa");
    expect(html).not.toContain("vuelve a casa");
    // The replacement is the native libreta's own asiento title.
    expect(html).toContain("Marcada como encontrada");
  });

  it("the 'asiento nuevo' mechanic is not repeated across the narrative", () => {
    expect(reviewedSections()).not.toContain("asiento nuevo");
  });
});
