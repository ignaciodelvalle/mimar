// PetAlertStrip — pet profile v2.1 (Item 6, design spec §3.2).
//
// Single prioritized container for the conditional alerts that used to render
// as separate full-width banners ABOVE the hero. v2.1 puts identity first
// (D2): the hero is always the first block, and these avisos collapse into one
// strip BELOW it, ordered by urgency (D3).
//
// The strip owns ORDERING, not data fetching. The page derives which alerts
// apply (rabies / transit / open-cases / pregnancy) and passes each as a
// pre-built node tagged with a tone; the strip sorts them by the urgency rank
// and renders them stacked. Empty input → renders nothing (no empty chrome).
//
// Tones reuse the `urgent | warning | info` severity scale from the `*_signal`
// convention documented in AGENTS.md. No new chrome tokens are introduced.

import type { ReactNode } from "react";

export type AlertTone = "urgent" | "warning" | "info";

export type PetAlert = {
  /** Stable key for React + ordering ties. */
  id: string;
  /** Severity — drives both ordering and the leading accent. */
  tone: AlertTone;
  /** The already-built alert content (banner / card summary). */
  node: ReactNode;
};

// Lower number = higher priority = rendered first. Mirrors spec §3.2:
// rabies (urgent) → transit (warning) → open cases (warning) → pregnancy (info).
const TONE_RANK: Record<AlertTone, number> = {
  urgent: 0,
  warning: 1,
  info: 2,
};

/**
 * Orders alerts by urgency. Pure — exported for unit testing without rendering.
 * Stable: alerts with the same tone keep their input order (open-cases before
 * pregnancy is handled by tone; transit before open-cases by input order).
 */
export function orderAlertsByUrgency(alerts: PetAlert[]): PetAlert[] {
  return [...alerts]
    .map((alert, index) => ({ alert, index }))
    .sort((a, b) => {
      const rankDelta = TONE_RANK[a.alert.tone] - TONE_RANK[b.alert.tone];
      return rankDelta !== 0 ? rankDelta : a.index - b.index;
    })
    .map(({ alert }) => alert);
}

export function PetAlertStrip({ alerts }: { alerts: PetAlert[] }) {
  // Empty → render nothing. The strip never shows an empty container.
  if (alerts.length === 0) return null;

  const ordered = orderAlertsByUrgency(alerts);

  return (
    <section
      data-section="alert-strip"
      aria-label="Avisos de la mascota"
      className="mb-5 flex flex-col gap-2.5"
    >
      {ordered.map((alert) => (
        <div key={alert.id} data-alert-id={alert.id} data-alert-tone={alert.tone}>
          {alert.node}
        </div>
      ))}
    </section>
  );
}
