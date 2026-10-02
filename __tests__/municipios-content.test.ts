// /municipios copy after the PO review of 2026-09-25 ("soluciones, no dudas").
//
// Pins the three decisions a later edit could silently undo:
//   1. The Android app is named UNCONDITIONALLY (PO decision 2026-10-01: ahead
//      of the product, debt pending) — it replaces the earlier rule that named
//      it only when a Play listing was configured.
//   2. No identification talk on the page (DNI, hashes): each municipio
//      negotiates it, /privacidad covers the current handling.
//   3. The CTA is "Contactate con el equipo"; "sin costo" and the "Todavía no"
//      column are gone.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CAPABILITIES, QUESTIONS, faqs, pilotSteps } from "@/app/municipios/content";
import { isAndroidUserAgent, resolvePlayStoreUrl } from "@/lib/ui/play-store";

const PLAY = "https://play.google.com/store/apps/details?id=ar.com.mimar";

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

  it("recognises an Android User-Agent and nothing else", () => {
    expect(
      isAndroidUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe(true);
    expect(isAndroidUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0")).toBe(
      false,
    );
    expect(isAndroidUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)")).toBe(
      false,
    );
    expect(isAndroidUserAgent("")).toBe(false);
    expect(isAndroidUserAgent(null)).toBe(false);
    expect(isAndroidUserAgent(undefined)).toBe(false);
  });
});

describe("the Android app is always mentioned (PO 2026-10-01)", () => {
  it("the citizen step, the FAQ and the denuncias card name the Android app or the app", () => {
    expect(pilotSteps()[2]).toContain("portal web o descargando la app de Android");
    const howCitizensJoin = faqs().find((f) => f.q === "¿Cómo se suman los vecinos?");
    expect(howCitizensJoin?.a).toBe(
      "Desde el celular con la app de Android, o desde cualquier computadora en el portal web. Registran a sus mascotas y su libreta sanitaria, avisan si se pierden, sacan turno en las campañas y hacen denuncias. Veterinarias y refugios cargan lo suyo con su propia cuenta, y todo llega al tablero de tu oficina.",
    );
    const denuncias = CAPABILITIES.find((c) => c.title === "Denuncias de maltrato");
    expect(denuncias?.body).toBe(
      "Los vecinos denuncian desde la web o la app y tu oficina las toma, las resuelve o abre un caso.",
    );
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
    expect(faqs().length).toBeGreaterThanOrEqual(4);
    expect(faqs().length).toBeLessThanOrEqual(5);
  });
});
