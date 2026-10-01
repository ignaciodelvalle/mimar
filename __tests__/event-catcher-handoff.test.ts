import { describe, expect, it } from "vitest";

import {
  ALL_CAPTURE_OPTIONS,
  buildKindDeeplink,
  getNoteSlotKey,
} from "@/app/(app)/mis-mascotas/[publicToken]/anotar/handoff";
import { buildAnotarUrl } from "@/app/(app)/mis-mascotas/[publicToken]/anotar/handoff";

const TOKEN = "DIM-TEST-TOKEN";

// owner-pet-actions (PO 2026-10-01): the Anotar catalogue is for RECORDING. Its
// "Perfil" category re-listed the panel's doors under other labels ("Transferir
// mascota", "Editar datos de la mascota", "Buscar hogar (adopción)") — one of
// the three drifted copies the shared action catalogue replaced. Those doors
// live in the owner's panel below the credential now, once.
describe("the Anotar catalogue records; it is not a second menu of the pet's doors", () => {
  it("has no Perfil category", () => {
    expect(ALL_CAPTURE_OPTIONS.map((o) => o.category)).not.toContain("Perfil");
  });

  it("still offers the recording catalogue itself", () => {
    const categories = new Set(ALL_CAPTURE_OPTIONS.map((o) => o.category));
    expect(categories).toContain("Salud");
    expect(categories).toContain("Estado");
    expect(ALL_CAPTURE_OPTIONS.length).toBeGreaterThan(15);
  });
});

describe("buildAnotarUrl", () => {
  // Flow audit 2026-07-03: the handoff target is the PROFILE with
  // ?sheet=anotar (canonical capture surface) — same-route shallow open from
  // the profile, one navigation from /inicio — never the standalone /anotar
  // page (kept only as a deep-link fallback route).
  it("kind only produces the profile sheet URL with kind param", () => {
    const url = buildAnotarUrl(TOKEN, { kind: "vaccination_administered" });
    expect(url).toBe(`/mis-mascotas/${TOKEN}?sheet=anotar&kind=vaccination_administered`);
  });

  it("kind + text produces both params on the profile sheet URL", () => {
    const url = buildAnotarUrl(TOKEN, { kind: "vaccination_administered", text: "vacuna" });
    expect(url).toContain(`/mis-mascotas/${TOKEN}?sheet=anotar`);
    expect(url).toContain("kind=vaccination_administered");
    expect(url).toContain("text=vacuna");
  });

  it("text only produces text param without kind", () => {
    const url = buildAnotarUrl(TOKEN, { text: "vacuna" });
    expect(url).toContain("sheet=anotar");
    expect(url).toContain("text=vacuna");
    expect(url).not.toContain("kind=");
  });
});

describe("getNoteSlotKey", () => {
  it("returns notes for vaccination_administered", () => {
    expect(getNoteSlotKey("vaccination_administered")).toBe("notes");
  });

  it("returns text for note_added", () => {
    expect(getNoteSlotKey("note_added")).toBe("text");
  });

  it("returns notes for medication_started after registry expansion", () => {
    expect(getNoteSlotKey("medication_started")).toBe("notes");
  });
});

describe("buildKindDeeplink", () => {
  it("vaccination_administered places text into notes slot and adds occurredAt", () => {
    const url = buildKindDeeplink("vaccination_administered", TOKEN, "Roma tos seca");
    expect(url).toBeTruthy();
    const parsed = new URL(url!, "http://x");
    expect(parsed.searchParams.get("notes")).toBe("Roma tos seca");
    expect(parsed.searchParams.get("occurredAt")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("note_added places text into text slot", () => {
    const url = buildKindDeeplink("note_added", TOKEN, "lo de hoy");
    expect(url).toBeTruthy();
    const parsed = new URL(url!, "http://x");
    expect(parsed.searchParams.get("text")).toBe("lo de hoy");
  });

  it("medication_started places text into notes slot after registry expansion", () => {
    const url = buildKindDeeplink("medication_started", TOKEN, "amoxi cada 8h");
    expect(url).toBeTruthy();
    const parsed = new URL(url!, "http://x");
    expect(parsed.searchParams.get("notes")).toBe("amoxi cada 8h");
  });
});
