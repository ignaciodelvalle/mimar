import type { EventType } from "@/db/schema";

/**
 * Registry that maps a `pet_events.event_type` to the UI form route that
 * captures it. Single source of truth for:
 *
 *   - which route handles each event type
 *   - which `searchParams` slots the form pre-fills with
 *   - a short es-AR description used by the captura-rápida matcher
 *     (`lib/event-capture-matcher.ts`) and — if/when a conversational
 *     LLM agent lands — by its tool-use surface
 *
 * Naming: the original "agent" wording was confusing because no LLM
 * exists yet. The registry powers the deterministic Captura rápida
 * feature today; the LLM agent is a deferred future layer.
 *
 * Adding a new event-creation form? Add its registry entry in the same
 * PR. Lib-level tests enforce route validity and slot consistency.
 */
export type EventCaptureEntry = {
  /** Route relative to `/mis-mascotas/{publicToken}`. */
  route: string;
  /**
   * One-line Spanish description for matcher ranking and LLM intent
   * matching. Describe what the *user said* that maps here (NOT what the
   * system does). Examples:
   *   - "El usuario está registrando una vacunación administrada a su mascota"
   *   - "El usuario está reportando el peso actual de su mascota"
   * Keep under 120 chars. Avoid jargon.
   */
  description: string;
  /**
   * Query-param names the form accepts via `searchParams` for prefill.
   * MUST match the actual `name=""` attributes the form's inputs use.
   * Empty array means the form is reachable via deeplink (intent
   * detection works) but does NOT pre-fill any field — used for forms
   * whose slot extraction needs LLM-level parsing (medication, symptom,
   * incident, clinical).
   */
  prefillSlots: readonly string[];
};

export const EVENT_CAPTURE_REGISTRY: Partial<Record<EventType, EventCaptureEntry>> = {
  weight_recorded: {
    route: "?sheet=peso",
    description: "El usuario está reportando el peso actual de su mascota",
    prefillSlots: ["kg", "occurredAt", "notes"],
  },
  vaccination_administered: {
    route: "/eventos/nuevo/vacuna",
    description: "El usuario registra una vacuna que le administraron a su mascota",
    prefillSlots: ["vaccineName", "occurredAt", "notes"],
  },
  deworming_administered: {
    route: "/eventos/nuevo/antiparasitario",
    description: "El usuario registra un antiparasitario o desparasitación",
    // `product` matches the input name in DewormingForm.tsx — the action
    // handler reads formData.get("product"), so the slot has to mirror it.
    prefillSlots: ["product", "occurredAt", "notes"],
  },
  sterilization_performed: {
    route: "/eventos/nuevo/esterilizacion",
    description: "El usuario registra la esterilización (castración) de su mascota",
    prefillSlots: ["occurredAt", "notes"],
  },
  vet_visit_logged: {
    route: "/eventos/nuevo/vet",
    description: "El usuario registra una visita al veterinario",
    prefillSlots: ["occurredAt", "notes"],
  },
  microchip_implanted: {
    route: "/eventos/nuevo/microchip",
    description: "El usuario registra la colocación del microchip",
    // `chipNumber` matches MicrochipForm.tsx — the action handler reads
    // formData.get("chipNumber").
    prefillSlots: ["chipNumber", "occurredAt", "notes"],
  },
  note_added: {
    route: "?sheet=nota",
    description: "El usuario agrega una nota libre sobre su mascota",
    // `text` matches NoteForm.tsx — the main body field is named `text`,
    // not `body`. Keep slot aligned to the handler.
    prefillSlots: ["text", "occurredAt"],
  },
  death_recorded: {
    route: "/eventos/nuevo/fallecimiento",
    description: "El usuario reporta el fallecimiento de su mascota",
    prefillSlots: ["occurredAt", "notes"],
  },
  post_adoption_checkin: {
    route: "/eventos/nuevo/checkin",
    description: "El adoptante reporta un check-in post-adopción",
    // CheckinForm has no `occurredAt` input — the action timestamps
    // server-side. Only `notes` is prefillable.
    prefillSlots: ["notes"],
  },
  medication_started: {
    route: "?sheet=medicacion",
    description: "El usuario empezó a darle una medicación a su mascota",
    prefillSlots: ["notes", "occurredAt"],
  },
  // ---- Forms with partial prefill (date/notes extractable; complex fields need LLM) ----
  medication_stopped: {
    route: "/eventos/nuevo/medicacion-fin",
    description: "El usuario terminó una medicación de su mascota",
    // `occurredAt` + `notes` are the slots the page accepts; the drug selector
    // (medicationStartedEventId) is loaded from the DB and cannot be pre-filled
    // via URL — the user must choose the open medication from the list.
    prefillSlots: ["occurredAt", "notes"],
  },
  incident_reported: {
    route: "/eventos/nuevo/mordedura",
    description: "El usuario reporta una mordedura u otro incidente de la mascota",
    // `occurredAt` is extractable; severity/victimKind/context need LLM-level parsing.
    prefillSlots: ["occurredAt"],
  },
  symptom_observed: {
    route: "?sheet=sintoma",
    description: "El usuario reporta un síntoma observado en su mascota",
    // `freeText` (main description) and `onsetAt` are the two prefillable slots.
    // `freeText` carries the user's raw symptom description; `onsetAt` is the onset date.
    prefillSlots: ["freeText", "onsetAt"],
  },
  clinical_info_logged: {
    route: "/eventos/nuevo/clinico",
    description: "El usuario registra información clínica de su mascota",
    // `occurredAt` + `notes` are safe to prefill; title/details/subKind need LLM parsing.
    prefillSlots: ["occurredAt", "notes"],
  },
  // WP-4: new entries for identification events previously missing from registry.
  tattoo_recorded: {
    route: "/eventos/nuevo/tatuaje",
    description: "El usuario registra el tatuaje de identificación de su mascota",
    // tattooCode matches TattooForm.tsx input name. recordedAt maps to occurredAt.
    prefillSlots: ["tattooCode", "occurredAt", "notes"],
  },
  microchip_replaced: {
    route: "/eventos/nuevo/microchip-reemplazo",
    description: "El usuario registra el reemplazo del microchip de su mascota",
    // newChipNumber matches ReplaceMicrochipForm.tsx input name.
    prefillSlots: ["newChipNumber", "occurredAt", "notes"],
  },
};

/**
 * Build a deeplink to the creation form for an event_type, given a
 * pet's publicToken and an optional slot payload. Returns null if the
 * event_type has no registry entry yet.
 *
 * Handles two route shapes stored in the registry:
 *
 *   1. Absolute path (e.g. "/eventos/nuevo/vacuna") — the legacy full-page
 *      form. URL becomes /mis-mascotas/{token}/eventos/nuevo/vacuna?slots…
 *
 *   2. Query-string shorthand (e.g. "?sheet=peso") — the route was migrated
 *      to a SheetMounter sheet. URL becomes
 *      /mis-mascotas/{token}?sheet=peso&slots…
 *
 * Usage:
 *   const url = buildCaptureDeeplink('weight_recorded', 'DIM-3K4F-9P2X', {
 *     kg: '12.5', occurredAt: '2026-05-16'
 *   });
 *   // → '/mis-mascotas/DIM-3K4F-9P2X?sheet=peso&kg=12.5&occurredAt=2026-05-16'
 *
 * Slot keys not declared in `prefillSlots` are silently dropped (forms
 * with empty `prefillSlots` therefore always produce a bare URL).
 */
export function buildCaptureDeeplink(
  eventType: EventType,
  publicToken: string,
  slots: Record<string, string | number | null | undefined> = {},
): string | null {
  const entry = EVENT_CAPTURE_REGISTRY[eventType];
  if (!entry) return null;

  // Build the filled slot params (only declared prefillSlots, non-empty values).
  const slotParams = new URLSearchParams();
  for (const slot of entry.prefillSlots) {
    const value = slots[slot];
    if (value !== null && value !== undefined && value !== "") {
      slotParams.set(slot, String(value));
    }
  }
  const slotQs = slotParams.toString();

  // Route is either an absolute path ("/eventos/nuevo/…") or a query-string
  // shorthand ("?sheet=…") for forms that were migrated to SheetMounter.
  if (entry.route.startsWith("?")) {
    // e.g. "?sheet=peso" → /mis-mascotas/{token}?sheet=peso&kg=12.5&…
    const base = `/mis-mascotas/${publicToken}${entry.route}`;
    return slotQs ? `${base}&${slotQs}` : base;
  }

  // Absolute path: /mis-mascotas/{token}/eventos/nuevo/…?slots…
  const base = `/mis-mascotas/${publicToken}${entry.route}`;
  return slotQs ? `${base}?${slotQs}` : base;
}
