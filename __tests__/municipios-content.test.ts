// /municipios copy after the PO review of 2026-09-25 ("soluciones, no dudas").
//
// Pins the three decisions a later edit could silently undo:
//   1. The Android app is named ONLY when a Play listing is configured — the
//      app is not published yet, and an unset env must not promise it.
//   2. No identification talk on the page (DNI, hashes): each municipio
//      negotiates it, /privacidad covers the current handling.
//   3. The CTA is "Contactate con el equipo"; "sin costo" and the "Todavía no"
//      column are gone.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CAPABILITIES, QUESTIONS, faqs, pilotSteps } from "@/app/municipios/content";
import { resolvePlayStoreUrl } from "@/lib/ui/play-store";

const PLAY = "https://play.google.com/store/apps/details?id=ar.com.mimar";

function allCopy(playStoreUrl: string | null): string {
  return JSON.stringify([QUESTIONS, CAPABILITIES, pilotSteps(playStoreUrl), faqs(playStoreUrl)]);
}

function pageSources(): string {
  const dir = "app/municipios";
  return readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

describe("resolvePlayStoreUrl", () => {
  it("is null when the env is unset, blank, or not a Play URL", () => {
    expect(resolvePlayStoreUrl({})).toBeNull();
    expect(resolvePlayStoreUrl({ NEXT_PUBLIC_PLAY_STORE_URL: "  " })).toBeNull();
    expect(
      resolvePlayStoreUrl({ NEXT_PUBLIC_PLAY_STORE_URL: "https://example.com/app" }),
    ).toBeNull();
    expect(
      resolvePlayStoreUrl({ NEXT_PUBLIC_PLAY_STORE_URL: "http://play.google.com/x" }),
    ).toBeNull();
    expect(resolvePlayStoreUrl({ NEXT_PUBLIC_PLAY_STORE_URL: "not a url" })).toBeNull();
  });

  it("returns the listing when it is a Play URL", () => {
    expect(resolvePlayStoreUrl({ NEXT_PUBLIC_PLAY_STORE_URL: ` ${PLAY} ` })).toBe(PLAY);
  });
});

describe("the Android app is mentioned only when it is on Play", () => {
  it("without a listing, no step or answer mentions an app or a download", () => {
    const copy = allCopy(null);
    expect(copy).not.toMatch(/\bapp\b|descarg[aá]\w* la app|Android/i);
    expect(pilotSteps(null)[2]).toContain("portal web");
  });

  it("with a listing, the citizen step and the FAQ name the Android app", () => {
    expect(pilotSteps(PLAY)[2]).toContain("descargando la app de Android");
    const howCitizensJoin = faqs(PLAY).find((f) => f.q === "¿Cómo se suman los vecinos?");
    expect(howCitizensJoin?.a).toContain("app de Android");
  });
});

describe("the page offers solutions, not doubts", () => {
  it("never talks about identification, and never says 'sin costo' or 'todavía no'", () => {
    const source = pageSources();
    expect(source).not.toMatch(/\bDNI\b|huella criptogr|hash/i);
    expect(source).not.toMatch(/sin costo/i);
    expect(source).not.toMatch(/Todav[ií]a no/);
  });

  it("uses the contact CTA in the hero and the form section", () => {
    const source = pageSources();
    expect(source.match(/Contactate con el equipo/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(source).not.toMatch(/Solicitar un piloto/);
  });

  it("keeps four questions, a capability inventory and 4-5 FAQs", () => {
    expect(QUESTIONS).toHaveLength(4);
    expect(CAPABILITIES.length).toBeGreaterThanOrEqual(8);
    expect(faqs(null).length).toBeGreaterThanOrEqual(4);
    expect(faqs(null).length).toBeLessThanOrEqual(5);
  });
});
