// Pure helpers backing the Anotar quick-capture handoff (a notification CTA or
// a home deeplink → CaptureBox). Extracted from CaptureBox.tsx so vitest can
// parse them without pulling in JSX (the project tsconfig uses jsx: "preserve"
// for Next.js, which vitest's import-analysis plugin can't handle).

import type { EventType } from "@/db/schema";
import {
  gateMatchForViewer,
  matchCaptureIntent,
  matchToCaptureUrl,
  ymdLocal,
} from "@/lib/events/event-capture-matcher";
import { EVENT_CAPTURE_REGISTRY, buildCaptureDeeplink } from "@/lib/events/event-capture-registry";

// Builds the URL a notification CTA or home deeplink uses to hand off typed
// text + chosen kind to the capture surface (?sheet=anotar). Pure function,
// kept out of any JSX module so the vitest import-analysis can parse it.
//
// Flow audit 2026-07-03: the target is the PROFILE with ?sheet=anotar — the
// canonical capture surface — not the standalone /anotar page. From the
// profile itself this is a same-route shallow sheet open (pushSheetUrl);
// from /inicio it is one real navigation that lands the user on the pet's
// profile with the capture sheet already open, instead of a dead-end page.
// The /anotar page remains as a deep-link fallback route (old notification
// CTAs still point there).
export function buildAnotarUrl(
  publicToken: string,
  opts: { text?: string; kind?: EventType },
): string {
  const params = new URLSearchParams({ sheet: "anotar" });
  if (opts.kind) params.set("kind", opts.kind);
  if (opts.text) params.set("text", opts.text);
  return `/mis-mascotas/${publicToken}?${params.toString()}`;
}

// Quick-action cards shown in the capture box grid. Each links to a form
// prefilled with `occurredAt=today` where applicable. Order is roughly by
// frequency of use.
export const QUICK_ACTIONS: Array<{ eventType: EventType; label: string }> = [
  { eventType: "vaccination_administered", label: "Vacuna" },
  // "Antiparasitario", entero: era la única etiqueta abreviada con punto de
  // todo el conjunto (S2-F09). La grilla es de 2 columnas en celular y 4 en
  // escritorio; que envuelva es mejor que una abreviatura que sólo aparece acá.
  { eventType: "deworming_administered", label: "Antiparasitario" },
  { eventType: "weight_recorded", label: "Peso" },
  { eventType: "vet_visit_logged", label: "Visita al vet" },
  { eventType: "sterilization_performed", label: "Castración" },
  { eventType: "microchip_implanted", label: "Microchip" },
  { eventType: "note_added", label: "Nota" },
  { eventType: "symptom_observed", label: "Síntoma" },
];

export type QuickAction = (typeof QUICK_ACTIONS)[number];

// All loggable events and owner flows — the full discoverability list for the
// anotar surface (WP-7). Driven by the registry so it stays in sync. Entries
// with a `routeOverride` bypass the registry deeplink (management flows that
// open sheets or navigate to paths not in EVENT_CAPTURE_REGISTRY).
export type CaptureOption = {
  eventType: EventType;
  label: string;
  /** Human-readable category shown as a section header. */
  category: string;
  /** If set, link goes here instead of buildCaptureDeeplink. */
  routeOverride?: string;
};

/**
 * Where "Registrar embarazo" points, as ONE string nobody restates.
 *
 * It is also the row's identity: the entry rides `clinical_info_logged`, which
 * the catalog already uses for "Información clínica / estudios", so the gate in
 * `CaptureOptionsList` cannot pick it out by event type. `phase=started` is
 * written out even though the page defaults to it — a default is a thing that
 * can be flipped, and this link means the START of a pregnancy specifically.
 */
export const PREGNANCY_START_ROUTE = "/eventos/nuevo/embarazo?phase=started";

export const ALL_CAPTURE_OPTIONS: CaptureOption[] = [
  // Eventos de salud
  { eventType: "vaccination_administered", label: "Registrar vacuna", category: "Salud" },
  { eventType: "deworming_administered", label: "Registrar antiparasitario", category: "Salud" },
  { eventType: "weight_recorded", label: "Registrar peso", category: "Salud" },
  { eventType: "vet_visit_logged", label: "Visita al veterinario", category: "Salud" },
  { eventType: "sterilization_performed", label: "Castración / esterilización", category: "Salud" },
  { eventType: "symptom_observed", label: "Reportar síntoma", category: "Salud" },
  { eventType: "medication_started", label: "Inicio de medicación", category: "Salud" },
  { eventType: "medication_stopped", label: "Fin de medicación", category: "Salud" },
  { eventType: "clinical_info_logged", label: "Información clínica / estudios", category: "Salud" },
  // "Declarar un embarazo" had NO entry point on the web at all until this row:
  // the route and the form both shipped, and the only ways in were free text the
  // capture matcher happened to recognise, or typing the URL. Its sibling — the
  // CLOSE of a pregnancy — has had a real link since it shipped
  // (`PregnancyInProgressCard`), because an open pregnancy is a state the
  // profile can announce. "Not pregnant" is not a state, so the start belongs in
  // the catalog and not in a card that would sit on every female dog's profile
  // asking a question nobody posed. Same place the phone puts it
  // (`conditionalKinds`, apps/mobile/src/pets/record-event-view-model.ts).
  //
  // CONDITIONAL — gated in `CaptureOptionsList` on `canStartPregnancy`, the same
  // predicate the destination page enforces. See `PREGNANCY_START_ROUTE`.
  {
    eventType: "clinical_info_logged",
    label: "Registrar embarazo",
    category: "Salud",
    routeOverride: PREGNANCY_START_ROUTE,
  },
  // Identificación
  {
    eventType: "microchip_implanted",
    label: "Colocación de microchip",
    category: "Identificación",
  },
  { eventType: "microchip_replaced", label: "Reemplazo de microchip", category: "Identificación" },
  { eventType: "tattoo_recorded", label: "Registrar tatuaje", category: "Identificación" },
  // Eventos de vida
  {
    eventType: "incident_reported",
    label: "Reportar mordedura / incidente",
    category: "Incidentes",
  },
  { eventType: "death_recorded", label: "Reportar fallecimiento", category: "Incidentes" },
  { eventType: "post_adoption_checkin", label: "Check-in post-adopción", category: "Adopción" },
  // Estado
  {
    eventType: "status_changed",
    label: "Marcar como perdida",
    category: "Estado",
    routeOverride: "?sheet=marcar-perdida",
  },
  {
    eventType: "status_changed",
    label: "Marcar como encontrada",
    category: "Estado",
    routeOverride: "?sheet=marcar-encontrada",
  },
  // Notas
  { eventType: "note_added", label: "Agregar nota", category: "Notas" },
  // Gestión del perfil
  {
    eventType: "status_changed",
    label: "Compartir libreta",
    category: "Perfil",
    routeOverride: "?sheet=compartir-libreta",
  },
  {
    eventType: "status_changed",
    label: "Transferir mascota",
    category: "Perfil",
    routeOverride: "?sheet=transferir-mascota",
  },
  {
    eventType: "status_changed",
    label: "Editar datos de la mascota",
    category: "Perfil",
    routeOverride: "?sheet=editar-mascota",
  },
  {
    eventType: "vaccination_administered",
    label: "Programar vacuna",
    category: "Perfil",
    routeOverride: "/vacunas/programar",
  },
  {
    eventType: "status_changed",
    label: "Buscar hogar (adopción)",
    category: "Perfil",
    routeOverride: "/buscar-hogar",
  },
];

export function findQuickAction(kind: string | undefined): QuickAction | undefined {
  if (!kind) return undefined;
  return QUICK_ACTIONS.find((qa) => qa.eventType === kind);
}

export function getNoteSlotKey(eventType: EventType): "notes" | "text" | null {
  const entry = EVENT_CAPTURE_REGISTRY[eventType];
  if (!entry) return null;
  if (entry.prefillSlots.includes("notes")) return "notes";
  if (entry.prefillSlots.includes("text")) return "text";
  return null;
}

export function buildKindDeeplink(
  eventType: EventType,
  publicToken: string,
  text?: string,
): string | null {
  const entry = EVENT_CAPTURE_REGISTRY[eventType];
  if (!entry) return null;
  const slots: Record<string, string> = {};
  if (entry.prefillSlots.includes("occurredAt")) {
    // ymdLocal, not toISOString: UTC stamped TOMORROW for taps after 21:00 ART.
    slots.occurredAt = ymdLocal();
  }
  const noteKey = getNoteSlotKey(eventType);
  if (text && noteKey) {
    slots[noteKey] = text;
  }
  return buildCaptureDeeplink(eventType, publicToken, slots);
}

/**
 * Resolve a capture intent (a known `kind`, or free text the deterministic
 * matcher recognizes) into its target URL WITHOUT rendering anything —
 * flow audit 2026-07-03 no-flash fix. SheetMounter calls this before
 * mounting the anotar sheet: a resolvable deep link redirects straight to
 * its form (sheet shorthand or full page) so the user never sees the anotar
 * sheet flash open and immediately navigate away.
 *
 * Returns null when there is nothing to resolve (no kind/text, or the
 * matcher didn't recognize the text) — the anotar sheet then renders
 * normally and CaptureBox surfaces the "no reconocemos eso" UI.
 *
 * `viewer` threads the QA A9 check-in gate through the FREE-TEXT branch
 * (gateMatchForViewer): a non-adopter's "check-in" must fall through to the
 * anotar sheet, not redirect server-side into a page that 404s. Defaults to
 * fail-closed so a call site that doesn't compute the flag can't deep-link
 * anyone into the 404 (adversarial review 2026-08-14).
 */
export function resolveCaptureIntentUrl(
  publicToken: string,
  opts: { kind?: string; text?: string },
  viewer: { showCheckinOption: boolean } = { showCheckinOption: false },
): string | null {
  if (opts.kind) {
    const url = buildKindDeeplink(
      opts.kind as EventType,
      publicToken,
      opts.text?.trim() || undefined,
    );
    if (url) return url;
  }
  const trimmed = opts.text?.trim();
  if (!trimmed) return null;
  const match = gateMatchForViewer(matchCaptureIntent(trimmed), viewer);
  if (!match) return null;
  return matchToCaptureUrl(publicToken, match, buildCaptureDeeplink);
}
