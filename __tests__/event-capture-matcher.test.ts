import { describe, expect, it } from "vitest";

import {
  CAPTURE_INPUT_MAX_LENGTH,
  extractDateFromText,
  matchCaptureIntent,
} from "@/lib/events/event-capture-matcher";

// Use a fixed reference date so the date tests are stable.
const NOW = new Date("2026-05-19T12:00:00Z");

describe("matchCaptureIntent — triggers (14 event types)", () => {
  it.each([
    ["le di la antirrábica hoy", "vaccination_administered"],
    ["le aplicaron la triple", "vaccination_administered"],
    ["recordar darle pulgas el sábado", "deworming_administered"],
    ["le di antiparasitario interno", "deworming_administered"],
    ["pesa 12.5 kg", "weight_recorded"],
    ["lo pesé hoy", "weight_recorded"],
    ["le pusieron el chip ayer", "microchip_implanted"],
    ["lo castraron la semana pasada", "sterilization_performed"],
    ["esterilizada", "sterilization_performed"],
    ["lo mordió un perro", "incident_reported"],
    ["tiene vómitos hace 2 días", "symptom_observed"],
    ["no come desde el lunes", "symptom_observed"],
    ["visita al veterinario", "vet_visit_logged"],
    ["control con la clínica", "vet_visit_logged"],
    ["empecé el tratamiento", "medication_started"],
    ["empecé pastillas", "medication_started"],
    ["antibiotico", "medication_started"],
    ["terminé la medicación", "medication_stopped"],
    ["dejé las pastillas", "medication_stopped"],
    ["se murió esta mañana", "death_recorded"],
    ["falleció en la clínica", "death_recorded"],
    ["estudio de sangre", "clinical_info_logged"],
    ["ecografía abdominal", "clinical_info_logged"],
    ["check-in post adopción", "post_adoption_checkin"],
    ["anotar: tomó poca agua", "note_added"],
    ["perdí a mi perro", "status_changed"],
    ["se perdió ayer", "status_changed"],
    ["lo encontré en la plaza", "status_changed"],
    ["apareció esta mañana", "status_changed"],
  ])("'%s' → %s", (text, expected) => {
    const result = matchCaptureIntent(text);
    expect(result, `no match for "${text}"`).toBeTruthy();
    expect(result?.eventType).toBe(expected);
  });

  it("returns null for completely unrelated input", () => {
    expect(matchCaptureIntent("hola")).toBeNull();
    expect(matchCaptureIntent("")).toBeNull();
    expect(matchCaptureIntent("   ")).toBeNull();
  });
});

describe("matchCaptureIntent — lost / found routing", () => {
  it("'perdí a mi perro' routes to marcar-perdida (confirm)", () => {
    const r = matchCaptureIntent("perdí a mi perro");
    expect(r?.eventType).toBe("status_changed");
    expect(r?.routeOverride).toBe("?sheet=marcar-perdida");
    expect(r?.confidence).toBe("medium");
  });

  it("'se perdió' / 'se escapó' route to marcar-perdida", () => {
    expect(matchCaptureIntent("se perdió ayer")?.routeOverride).toBe("?sheet=marcar-perdida");
    expect(matchCaptureIntent("se escapó del patio")?.routeOverride).toBe("?sheet=marcar-perdida");
  });

  it("'apareció' / 'lo encontré' route to marcar-encontrada", () => {
    expect(matchCaptureIntent("apareció esta mañana")?.routeOverride).toBe(
      "?sheet=marcar-encontrada",
    );
    expect(matchCaptureIntent("lo encontré en la plaza")?.routeOverride).toBe(
      "?sheet=marcar-encontrada",
    );
  });

  it("'perdió el embarazo' still routes to miscarriage, NOT lost-pet", () => {
    const r = matchCaptureIntent("perdió el embarazo");
    expect(r?.eventType).toBe("clinical_info_logged");
    expect(r?.routeOverride).toContain("miscarriage");
  });

  it("symptom phrasings with 'perdió' are NOT classified as lost-pet", () => {
    expect(matchCaptureIntent("perdió el apetito")?.eventType).not.toBe("status_changed");
    expect(matchCaptureIntent("perdió mucho peso")?.eventType).not.toBe("status_changed");
  });
});

describe("matchCaptureIntent — slot extraction", () => {
  it("extracts kg from weight phrasing (dot)", () => {
    const r = matchCaptureIntent("pesa 12.5 kg");
    expect(r?.slots.kg).toBe("12.5");
  });

  it("normalizes comma decimals to dot", () => {
    const r = matchCaptureIntent("pesa 12,5 kg");
    expect(r?.slots.kg).toBe("12.5");
  });

  it("extracts vaccine name", () => {
    const r = matchCaptureIntent("le di la antirrábica");
    expect(r?.slots.vaccineName?.toLowerCase()).toBe("antirrábica");
  });

  it("extracts chipNumber when 15 digits are present", () => {
    const r = matchCaptureIntent("le pusieron el chip 985141004321456");
    expect(r?.slots.chipNumber).toBe("985141004321456");
  });

  it("note_added captures the full text as `text` slot", () => {
    const r = matchCaptureIntent("anotar: comió pollo y le cayó bien");
    expect(r?.eventType).toBe("note_added");
    expect(r?.slots.text).toContain("comió pollo");
  });

  it("complex forms (mordedura, sintoma, medicación) match but expose no slots", () => {
    expect(matchCaptureIntent("lo mordió un perro")?.slots).toEqual({});
    expect(matchCaptureIntent("tiene vómitos")?.slots).toEqual({});
    expect(matchCaptureIntent("antibiotico")?.slots).toEqual({});
  });
});

describe("extractDateFromText", () => {
  it("hoy → today", () => {
    expect(extractDateFromText("le di antirrábica hoy", NOW)).toBe("2026-05-19");
  });
  it("ayer → today - 1", () => {
    expect(extractDateFromText("ayer le di la vacuna", NOW)).toBe("2026-05-18");
  });
  it("anteayer → today - 2", () => {
    expect(extractDateFromText("anteayer", NOW)).toBe("2026-05-17");
  });
  it("hace 3 días", () => {
    expect(extractDateFromText("le di la antirrábica hace 3 días", NOW)).toBe("2026-05-16");
  });
  it("DD/MM/YYYY parses correctly", () => {
    expect(extractDateFromText("el 12/05/2026 lo pesé", NOW)).toBe("2026-05-12");
  });
  it("DD/MM (no year) assumes current year", () => {
    expect(extractDateFromText("le di la triple el 10/03", NOW)).toBe("2026-03-10");
  });
  it("'el DD de {mes}' parses correctly", () => {
    expect(extractDateFromText("le di la antirrábica el 15 de marzo", NOW)).toBe("2026-03-15");
  });
  // Master test CIU, hallazgo B1-a. The frase escrita por el usuario, textual:
  // el año iba al evento equivocado y quedaba en la URL como occurredAt.
  it("'el DD de {mes} de AAAA' honors the explicit year", () => {
    expect(extractDateFromText("lo desparasitamos el 15 de marzo de 2024", NOW)).toBe("2024-03-15");
  });
  it("'{mes} del AAAA' (rioplatense) honors the explicit year too", () => {
    expect(extractDateFromText("la castramos el 3 de julio del 2019", NOW)).toBe("2019-07-03");
  });
  it("a trailing number that is NOT a year leaves the current year alone", () => {
    // "de 12 kg" no es un año: sin AAAA explícito el default sigue siendo el
    // año en curso, igual que antes de que esta rama aprendiera a leerlo.
    expect(extractDateFromText("el 15 de marzo pesaba 12 kg", NOW)).toBe("2026-03-15");
  });
  it("an explicit year still gets validated (Feb 30 of a real year)", () => {
    expect(extractDateFromText("el 30 de febrero de 2024", NOW)).toBeNull();
  });
  it("returns null when no date phrase fired", () => {
    expect(extractDateFromText("pesa 12 kg", NOW)).toBeNull();
  });
  it("rejects invalid dates (Feb 30)", () => {
    expect(extractDateFromText("el 30/02/2026", NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WP-1: Bug fixes
// ---------------------------------------------------------------------------
describe("matchCaptureIntent — WP-1 bug fixes", () => {
  describe("ranalisis typo fixed — análisis now routes to clinical_info_logged", () => {
    it.each([
      ["análisis de sangre", "clinical_info_logged"],
      ["análisis clínico", "clinical_info_logged"],
      ["analisis de orina", "clinical_info_logged"],
    ])("'%s' → %s", (text, expected) => {
      const r = matchCaptureIntent(text);
      expect(r?.eventType).toBe(expected);
    });
  });

  it("bare 'volvió' routes to marcar-encontrada", () => {
    const r = matchCaptureIntent("volvió");
    expect(r?.routeOverride).toBe("?sheet=marcar-encontrada");
  });

  it("'volvió hoy' routes to marcar-encontrada", () => {
    expect(matchCaptureIntent("volvió hoy")?.routeOverride).toBe("?sheet=marcar-encontrada");
  });

  it("'lo recuperé' routes to marcar-encontrada", () => {
    expect(matchCaptureIntent("lo recuperé esta tarde")?.routeOverride).toBe(
      "?sheet=marcar-encontrada",
    );
  });

  it("'la recuperé' routes to marcar-encontrada", () => {
    expect(matchCaptureIntent("la recuperé ayer")?.routeOverride).toBe("?sheet=marcar-encontrada");
  });

  it("'está en casa' (without ya) routes to marcar-encontrada", () => {
    expect(matchCaptureIntent("está en casa")?.routeOverride).toBe("?sheet=marcar-encontrada");
  });

  it("'empecé un tratamiento' routes to medication_started (connector fix)", () => {
    expect(matchCaptureIntent("empecé un tratamiento")?.eventType).toBe("medication_started");
  });

  it("'empecé una medicación' routes to medication_started (connector fix)", () => {
    expect(matchCaptureIntent("empecé una medicación")?.eventType).toBe("medication_started");
  });
});

// ---------------------------------------------------------------------------
// WP-2: Found/Lost Rioplatense colloquialisms
// ---------------------------------------------------------------------------
describe("matchCaptureIntent — WP-2 found/lost Rioplatense phrases", () => {
  describe("found phrases → marcar-encontrada", () => {
    it.each([
      ["lo encontramos en el parque"],
      ["la encontramos"],
      ["lo devolvieron esta tarde"],
      ["la devolvieron"],
      ["apareció en el barrio"],
      ["está de vuelta"],
    ])("'%s' → marcar-encontrada", (text) => {
      expect(matchCaptureIntent(text)?.routeOverride).toBe("?sheet=marcar-encontrada");
    });
  });

  describe("lost phrases → marcar-perdida", () => {
    it.each([
      ["no aparece desde ayer"],
      ["salió y no volvió"],
      ["no llegó a casa"],
      ["lo busco hace horas"],
      ["la busco desde esta mañana"],
    ])("'%s' → marcar-perdida", (text) => {
      expect(matchCaptureIntent(text)?.routeOverride).toBe("?sheet=marcar-perdida");
    });
  });
});

// ---------------------------------------------------------------------------
// WP-3: Symptom + medication colloquialisms
// ---------------------------------------------------------------------------
describe("matchCaptureIntent — WP-3 symptom colloquialisms", () => {
  it.each([
    ["está descompuesto", "symptom_observed"],
    ["está descompuesta", "symptom_observed"],
    ["no quiere comer nada", "symptom_observed"],
    ["se rasca mucho", "symptom_observed"],
    ["está mal desde ayer", "symptom_observed"],
    ["tiene la panza hinchada", "symptom_observed"],
  ])("'%s' → %s", (text, expected) => {
    expect(matchCaptureIntent(text)?.eventType).toBe(expected);
  });
});

describe("matchCaptureIntent — WP-3 medication colloquialisms", () => {
  describe("medication_started colloquialisms", () => {
    it.each([
      ["le recetaron un antibiótico"],
      ["le recetaron pastillas"],
      ["empezamos el tratamiento ayer"],
      ["empezamos una medicación nueva"],
      ["está tomando medicación para el corazón"],
      ["está tomando pastillas"],
    ])("'%s' → medication_started", (text) => {
      expect(matchCaptureIntent(text)?.eventType).toBe("medication_started");
    });
  });

  describe("medication_stopped colloquialisms", () => {
    it.each([
      ["completó el tratamiento"],
      ["terminamos las pastillas ayer"],
      ["se terminaron las pastillas"],
      ["suspendió la medicación"],
      ["suspendió el tratamiento"],
    ])("'%s' → medication_stopped", (text) => {
      expect(matchCaptureIntent(text)?.eventType).toBe("medication_stopped");
    });
  });
});

// ---------------------------------------------------------------------------
// WP-4: Tattoo + microchip-reemplazo coverage
// ---------------------------------------------------------------------------
describe("matchCaptureIntent — WP-4 tattoo / microchip-reemplazo", () => {
  describe("tattoo_recorded triggers → /eventos/nuevo/tatuaje", () => {
    it.each([
      ["tiene tatuaje en la oreja"],
      ["le pusieron el tatuaje"],
      ["número de tatuaje"],
      ["tatú de criadero"],
    ])("'%s' → tattoo_recorded with routeOverride", (text) => {
      const r = matchCaptureIntent(text);
      expect(r?.eventType).toBe("tattoo_recorded");
      expect(r?.routeOverride).toBe("/eventos/nuevo/tatuaje");
    });
  });

  describe("microchip_replaced triggers → /eventos/nuevo/microchip-reemplazo", () => {
    it.each([
      ["reemplazaron el chip"],
      ["reemplazó el microchip"],
      ["cambiaron el chip"],
      ["cambiaron el microchip"],
      ["chip dañado"],
      ["microchip ilegible"],
      ["le pusieron otro chip"],
      ["le pusieron un nuevo microchip"],
    ])("'%s' → microchip_replaced with routeOverride", (text) => {
      const r = matchCaptureIntent(text);
      expect(r?.eventType).toBe("microchip_replaced");
      expect(r?.routeOverride).toBe("/eventos/nuevo/microchip-reemplazo");
    });
  });

  it("generic 'le pusieron el chip' still routes to microchip_implanted (ordering check)", () => {
    const r = matchCaptureIntent("le pusieron el chip ayer");
    expect(r?.eventType).toBe("microchip_implanted");
  });
});

// ---------------------------------------------------------------------------
// WP-5: Management-flow triggers
// ---------------------------------------------------------------------------
describe("matchCaptureIntent — WP-5 management flows", () => {
  it.each([
    ["compartir la libreta", "?sheet=compartir-libreta"],
    ["compartir historial", "?sheet=compartir-libreta"],
    ["transferir la mascota", "?sheet=transferir-mascota"],
    ["ceder la mascota", "?sheet=transferir-mascota"],
    ["editar la mascota", "?sheet=editar-mascota"],
    ["actualizar los datos", "?sheet=editar-mascota"],
    ["mostrar la libreta pública", "?sheet=mostrar-tier2"],
    ["libreta pública", "?sheet=mostrar-tier2"],
    ["programar una vacuna", "/vacunas/programar"],
    ["recordatorio de vacuna", "/vacunas/programar"],
    ["buscar un hogar", "/buscar-hogar"],
    ["dar en adopción", "/buscar-hogar"],
  ])("'%s' → routeOverride '%s'", (text, expectedRoute) => {
    const r = matchCaptureIntent(text);
    expect(r?.routeOverride).toBe(expectedRoute);
  });
});

// ---------------------------------------------------------------------------
// Adversarial inputs
// ---------------------------------------------------------------------------
describe("matchCaptureIntent — adversarial inputs", () => {
  it("truncates input above CAPTURE_INPUT_MAX_LENGTH before matching", () => {
    // Place the trigger word past the cap. After truncation it disappears, so
    // the matcher returns null — which is exactly the desired anti-abuse
    // behavior (no pathological string ever reaches the RegExp engine).
    const padding = "x".repeat(CAPTURE_INPUT_MAX_LENGTH + 10);
    const input = `${padding} vacuna`;
    expect(matchCaptureIntent(input)).toBeNull();
  });

  it("matches normally when the trigger word fits under the cap", () => {
    const padding = "x".repeat(CAPTURE_INPUT_MAX_LENGTH - 20);
    const input = `vacuna ${padding}`;
    const result = matchCaptureIntent(input);
    expect(result?.eventType).toBe("vaccination_administered");
  });

  it("handles emoji and unicode without crashing", () => {
    // Emojis don't trigger any pattern but the matcher must return null
    // cleanly, not throw on grapheme weirdness.
    expect(matchCaptureIntent("🐕 🩺 ❤️")).toBeNull();
    expect(matchCaptureIntent("vacuna 💉 antirrábica")?.eventType).toBe("vaccination_administered");
  });

  it("treats regex metacharacters in input as literal text", () => {
    // The user typing "vacuna|peso" must match SOLO vacuna — the `|` is just
    // a character to the matcher because triggers are hardcoded patterns,
    // not built from input.
    const result = matchCaptureIntent("vacuna|peso");
    expect(result?.eventType).toBe("vaccination_administered");
  });

  it("handles a multi-kb input without crashing (cap protects regex)", () => {
    // 10kb of `a` characters. After truncation the matcher runs on 500
    // chars max and returns null in under a few ms. The point is no crash.
    const input = "a".repeat(10_000);
    expect(matchCaptureIntent(input)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deep-review regressions (2026-07-04) — each case was a confirmed-by-execution
// bug before the fix landed.
// ---------------------------------------------------------------------------

import { buildKindDeeplink as _kindLink } from "@/app/(app)/mis-mascotas/[publicToken]/anotar/handoff";
import {
  matchCaptureIntent as _match,
  matchToCaptureUrl,
  ymdLocal,
} from "@/lib/events/event-capture-matcher";
import { buildCaptureDeeplink as _deeplink } from "@/lib/events/event-capture-registry";

describe("deep-review regressions (2026-07-04)", () => {
  it("'control post adopción' routes to post_adoption_checkin, not vet_visit", () => {
    const r = _match("control post adopción de Toby");
    expect(r?.eventType).toBe("post_adoption_checkin");
  });

  it("'seguimiento de la adopción' routes to post_adoption_checkin", () => {
    const r = _match("seguimiento de la adopción");
    expect(r?.eventType).toBe("post_adoption_checkin");
  });

  it("override routes drop undeclared slots (no occurredAt on marcar-perdida)", () => {
    const r = _match("ayer se me perdió la perra");
    expect(r?.routeOverride).toBe("?sheet=marcar-perdida");
    expect(r?.slots).toEqual({});
    const url = matchToCaptureUrl("DIM-TEST-0001", r!, _deeplink);
    expect(url).toBe("/mis-mascotas/DIM-TEST-0001?sheet=marcar-perdida");
  });

  it("pregnancy live-birth override KEEPS its declared slots", () => {
    const r = _match("parió 4 cachorros ayer");
    expect(r?.routeOverride).toContain("/eventos/nuevo/embarazo");
    expect(r?.slots.liveBirthsCount).toBe("4");
    expect(r?.slots.occurredAt).toBeDefined();
  });

  it("dash-glued IDs are not parsed as dates (cas-12-06)", () => {
    const r = _match("anotar revisión del caso cas-12-06 pendiente");
    expect(r?.slots.occurredAt).toBeUndefined();
  });

  it("plain date phrases still extract ('el 12/06')", () => {
    const r = _match("anotar control del 12/06");
    expect(r?.slots.occurredAt).toMatch(/-06-12$/);
  });

  it("quick-chip prefill stamps the LOCAL date, not UTC", () => {
    const url = _kindLink("weight_recorded", "DIM-TEST-0001") ?? "";
    expect(url).toContain(`occurredAt=${ymdLocal()}`);
  });
});

// ---------------------------------------------------------------------------
// gateMatchForViewer — QA A9 viewer gate over the matcher (adversarial review
// 2026-08-14). The fixed options list already hides "Check-in post-adopción"
// from non-adopters; free text bypassed that gate and deep-linked them into
// the checkin page's 404. The gate filters at the boundary, keeping the
// matcher itself pure and viewer-blind.
// ---------------------------------------------------------------------------

import { gateMatchForViewer } from "@/lib/events/event-capture-matcher";

describe("gateMatchForViewer", () => {
  it("drops a checkin match for a non-adopter — caller falls through to the generic selector", () => {
    const match = _match("check-in de Toby");
    expect(match?.eventType).toBe("post_adoption_checkin");
    expect(gateMatchForViewer(match, { showCheckinOption: false })).toBeNull();
  });

  it("keeps the checkin match for the registered adopter", () => {
    const match = _match("control post adopción de Toby");
    expect(match?.eventType).toBe("post_adoption_checkin");
    expect(gateMatchForViewer(match, { showCheckinOption: true })).toBe(match);
  });

  it("passes every other match through untouched, whatever the flag says", () => {
    const match = _match("le di la antirrábica hoy");
    expect(match?.eventType).toBe("vaccination_administered");
    expect(gateMatchForViewer(match, { showCheckinOption: false })).toBe(match);
    expect(gateMatchForViewer(match, { showCheckinOption: true })).toBe(match);
  });

  it("passes null through (no match stays no match)", () => {
    expect(gateMatchForViewer(null, { showCheckinOption: false })).toBeNull();
  });
});
