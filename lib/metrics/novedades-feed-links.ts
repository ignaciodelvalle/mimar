// lib/metrics/novedades-feed-links.ts — client-safe slice of the Novedades feed.
//
// The feed's event-type set and queue routing are pure data with no DB access,
// but they used to live inside novedades-feed.ts, which is `server-only`
// (it queries the DB). When NovedadesCard became a client component (collapse
// toggle), importing `feedQueueHref` from there turned into a hard build error.
// This module holds the shared, import-anywhere pieces; novedades-feed.ts
// re-exports them so server callers keep their existing import path.

import type { EventType } from "@/db/schema";

/**
 * The bounded set of pet_event types the feed surfaces — the queue-feeding,
 * operator-actionable types, each grounded in an existing gob queue that
 * consumes it. See novedades-feed.ts for the inclusion/exclusion rationale
 * and the index that serves the scan.
 */
export const FEED_EVENT_TYPES = [
  "outbreak_signal",
  "disease_reported",
  "rabies_observation_started",
  "incident_reported",
  "custody_dispute_raised",
] as const satisfies readonly EventType[];

export type FeedEventType = (typeof FEED_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Destination registry (C2 language contract, 2026-07-22) — the structural
// fix for "Ver en su cola →" pointing at /gob/vigilancia, which is a MAP
// ("Mapa de vigilancia"), not a queue. 4 of the 5 feed event types land on
// that map; only custody_dispute_raised lands on a genuine triage queue
// (/gob/casos?expediente=disputas, CaseQueue — F6 fusion, 2026-07-22, moved
// off the standalone /gob/disputas route into the Casos hub's "Disputas"
// tab). A free-text label next to an href can drift
// from what the destination actually is — this registry makes that
// impossible: every entry declares its destination's CAPABILITY CLASS, and
// the label is DERIVED from the class (never retyped per event type), so a
// future feed type can only ever say what its destination really does.
// ---------------------------------------------------------------------------

/** The kind of surface a feed link lands on — the vocabulary every operator
 * nav/CTA registry in the app should eventually share (C2). */
export type FeedDestinationCapability = "queue" | "map" | "form" | "report" | "config";

type FeedDestination = {
  href: string;
  /** What /gob/vigilancia (a map) or /gob/casos?expediente=disputas (a queue)
   * actually IS — the label below is derived from this, never written
   * inline per type. */
  capability: FeedDestinationCapability;
};

/** The gob page that handles each feed event type (admin+govt guarded),
 * plus the capability class that destination actually delivers. */
const FEED_DESTINATION: Record<FeedEventType, FeedDestination> = {
  // /gob/vigilancia is "Mapa de vigilancia" — a map, not a queue. A feed row
  // routed here shows "Ver en el mapa →", never "Ver en su/la cola →".
  outbreak_signal: { href: "/gob/vigilancia", capability: "map" },
  disease_reported: { href: "/gob/vigilancia", capability: "map" },
  rabies_observation_started: { href: "/gob/vigilancia", capability: "map" },
  incident_reported: { href: "/gob/vigilancia", capability: "map" },
  // The Disputas expediente (Casos hub, F6 fusion 2026-07-22) IS a genuine
  // triage queue (CaseQueue, tomar→actuar→cerrar).
  custody_dispute_raised: { href: "/gob/casos?expediente=disputas", capability: "queue" },
};

/** One canonical label per capability class — the ONLY place feed-link copy
 * is written. Adding a capability here is a deliberate, reviewed choice;
 * nothing downstream can retype a mismatched label for an existing class. */
const CAPABILITY_LABEL: Record<FeedDestinationCapability, string> = {
  queue: "Ver en la cola →",
  map: "Ver en el mapa →",
  form: "Completar →",
  report: "Ver el reporte →",
  config: "Configurar →",
};

/** Route to the page that handles a feed event type. */
export function feedQueueHref(eventType: FeedEventType): string {
  return FEED_DESTINATION[eventType].href;
}

/** The destination's capability class — queue|map|form|report|config. */
export function feedDestinationCapability(eventType: FeedEventType): FeedDestinationCapability {
  return FEED_DESTINATION[eventType].capability;
}

/** The honest CTA label for a feed row, DERIVED from the destination's
 * capability class — never a free string a caller could mismatch against
 * the actual href (the "Ver en su cola →"→map bug this registry kills). */
export function feedDestinationLabel(eventType: FeedEventType): string {
  return CAPABILITY_LABEL[FEED_DESTINATION[eventType].capability];
}

/**
 * Plural, category-style es-AR label for a GROUPED feed row (Cowork M2). The
 * per-event `eventTypeLabel` is singular ("Incidente reportado"); a grouped row
 * counts many of them ("Incidentes reportados · Tucumán · 18"), so it needs the
 * category noun. Only the five feed types need an entry.
 */
export const FEED_EVENT_GROUP_LABEL: Record<FeedEventType, string> = {
  outbreak_signal: "Señales de brote",
  disease_reported: "Enfermedades reportadas",
  rabies_observation_started: "Observaciones antirrábicas iniciadas",
  incident_reported: "Incidentes reportados",
  custody_dispute_raised: "Disputas de custodia",
};

/** Category label for a grouped feed row. */
export function feedGroupLabel(eventType: FeedEventType): string {
  return FEED_EVENT_GROUP_LABEL[eventType];
}
