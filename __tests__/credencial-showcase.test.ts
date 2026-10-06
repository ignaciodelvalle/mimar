// /design/credencial — the side-by-side family board.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PAGE = readFileSync("app/(public)/design/credencial/page.tsx", "utf8");
const LANDING = readFileSync("app/(public)/design/credencial/LandingSample.tsx", "utf8");

describe("/design/credencial — composition", () => {
  it("is gated in production", () => {
    expect(PAGE).toContain("gateDesignPreview()");
  });

  it("reuses the public sheets and the owner fixtures — it does not invent a third painter", () => {
    expect(PAGE).toContain('from "../p-niveles/sheets"');
    expect(PAGE).toContain('from "../ficha-estados/OwnerFicha"');
    expect(PAGE).toContain("OWNER_IDS");
    expect(PAGE).toContain('"al-dia"');
    expect(PAGE).toContain('"perdida"');
    expect(PAGE).toContain('"fallecida"');
  });

  it("keeps the landing sample still — no auto-cycle, only a flip", () => {
    expect(LANDING).toContain("CredentialCarnetFaces");
    expect(LANDING).toContain("onFlip");
    expect(LANDING).not.toContain("setInterval");
    expect(LANDING).not.toContain("prefers-reduced-motion");
  });
});
