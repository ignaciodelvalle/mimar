// Unit tests for quickCaptureAction (app/actions/quick-capture.ts).
//
// The action is a pure text → URL transform (no DB, no auth) so these
// are fast unit tests. They cover the same text patterns that the
// event-capture-matcher tests exercise but verify the action's full
// output contract: the resolved navigation URL.
//
// Route-shape note: tests for event types whose registry entry may change
// (e.g. note/weight/medication/symptom moving from /eventos/nuevo/... to
// ?sheet=... URLs) do NOT assert the literal path string. Instead they
// assert that the action's output equals what buildCaptureDeeplink returns
// for that intent — proving the action correctly delegates to the registry
// regardless of how the registry routes the event type.

import { quickCaptureAction } from "@/app/actions/quick-capture";
import { matchCaptureIntent } from "@/lib/events/event-capture-matcher";
import { buildCaptureDeeplink } from "@/lib/events/event-capture-registry";
import { describe, expect, it } from "vitest";

const TOKEN = "DIM-TEST-9X2F";

// Helper — parse URL from the action result and assert it's non-null.
async function resolve(text: string) {
  const { url } = await quickCaptureAction(TOKEN, text);
  return url;
}

describe("quickCaptureAction — matched patterns", () => {
  it("vacuna text resolves to the vaccination form", async () => {
    const url = await resolve("le di la antirrábica hoy");
    expect(url).not.toBeNull();
    expect(url).toContain(`/mis-mascotas/${TOKEN}/eventos/nuevo/vacuna`);
  });

  it("prefills vaccineName slot", async () => {
    const url = await resolve("le di la antirrábica hoy");
    // URLSearchParams encodes non-ASCII chars; check the decoded value.
    const parsed = new URL(url!, "http://x");
    expect(parsed.searchParams.get("vaccineName")?.toLowerCase()).toBe("antirrábica");
  });

  it("prefills occurredAt when 'hoy' is in text", async () => {
    const url = await resolve("le di la antirrábica hoy");
    expect(url).toMatch(/occurredAt=\d{4}-\d{2}-\d{2}/);
  });

  it("peso text delegates to the registry for the weight event URL", async () => {
    const text = "pesa 12.5 kg";
    const url = await resolve(text);
    const match = matchCaptureIntent(text);
    const expected = buildCaptureDeeplink(match!.eventType, TOKEN, match!.slots);
    expect(url).toBe(expected);
    // Slot sanity: the kg value must be captured and forwarded.
    expect(url).toContain("kg=12.5");
  });

  it("normalizes comma decimal in kg slot", async () => {
    const url = await resolve("pesa 12,5 kg");
    expect(url).toContain("kg=12.5");
  });

  it("microchip text resolves to the microchip form", async () => {
    const url = await resolve("le pusieron el chip");
    expect(url).toContain(`/mis-mascotas/${TOKEN}/eventos/nuevo/microchip`);
  });

  it("esterilización text resolves to the sterilization form", async () => {
    const url = await resolve("lo castraron ayer");
    expect(url).toContain(`/mis-mascotas/${TOKEN}/eventos/nuevo/esterilizacion`);
  });

  it("vet text resolves to the vet form", async () => {
    const url = await resolve("visita al veterinario");
    expect(url).toContain(`/mis-mascotas/${TOKEN}/eventos/nuevo/vet`);
  });

  it("fallecimiento text resolves to the death form", async () => {
    const url = await resolve("se murió esta mañana");
    expect(url).toContain(`/mis-mascotas/${TOKEN}/eventos/nuevo/fallecimiento`);
  });

  it("nota text delegates to the registry for the note event URL", async () => {
    const text = "anotar: comió bien hoy";
    const url = await resolve(text);
    const match = matchCaptureIntent(text);
    const expected = buildCaptureDeeplink(match!.eventType, TOKEN, match!.slots);
    expect(url).toBe(expected);
    // Slot sanity: the note body must be forwarded via the text param.
    expect(url).toContain("text=");
  });

  it("antiparasitario text resolves to deworming form", async () => {
    const url = await resolve("le di antiparasitario");
    expect(url).toContain(`/mis-mascotas/${TOKEN}/eventos/nuevo/antiparasitario`);
  });
});

describe("quickCaptureAction — routeOverride sub-flows", () => {
  it("embarazo started resolves to pregnancy route with phase=started", async () => {
    const url = await resolve("está embarazada");
    expect(url).not.toBeNull();
    expect(url).toContain(`/mis-mascotas/${TOKEN}/eventos/nuevo/embarazo`);
    expect(url).toContain("phase=started");
  });

  it("parto (live birth) resolves with phase=ended&outcome=live_birth", async () => {
    const url = await resolve("parió 4 cachorros");
    expect(url).toContain("phase=ended");
    expect(url).toContain("outcome=live_birth");
  });

  it("aborto resolves with phase=ended&outcome=miscarriage", async () => {
    const url = await resolve("perdió el embarazo");
    expect(url).toContain("phase=ended");
    expect(url).toContain("outcome=miscarriage");
  });
});

describe("quickCaptureAction — no match / fallback cases", () => {
  it("returns null for completely unrelated text", async () => {
    expect(await resolve("hola")).toBeNull();
  });

  it("returns null for empty string", async () => {
    const { url } = await quickCaptureAction(TOKEN, "");
    expect(url).toBeNull();
  });

  it("returns null for whitespace-only input", async () => {
    const { url } = await quickCaptureAction(TOKEN, "   ");
    expect(url).toBeNull();
  });

  it("returns null for text shorter than 3 chars after trim", async () => {
    const { url } = await quickCaptureAction(TOKEN, "ab");
    expect(url).toBeNull();
  });

  it("returns null for unrecognized medical phrase", async () => {
    // No pattern fires for a generic greeting — the caller should fall back
    // to /anotar?text=... to let CaptureBox surface the "no reconocemos eso" UI.
    expect(await resolve("como está")).toBeNull();
  });
});

describe("quickCaptureAction — output shape", () => {
  it("always returns a { url } object", async () => {
    const result = await quickCaptureAction(TOKEN, "pesa 12 kg");
    expect(result).toHaveProperty("url");
  });

  it("url for a matched event always contains the publicToken", async () => {
    const url = await resolve("pesa 12 kg");
    expect(url).toContain(TOKEN);
  });
});
