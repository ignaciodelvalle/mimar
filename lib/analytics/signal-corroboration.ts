// Client-safe half of the signal corroboration read (no DB import): the shape
// fetchSurveillanceSignals returns and the es-AR line a signal row renders.
//
// A corroboration is a later report of the SAME episode that the source-side
// dedup folded into an existing outbreak_signal instead of raising a second one
// (src/modules/events/application/surveillance/recent-outbreak-signals.ts). It
// raises no signal and no notice of its own, so without this line it would be
// invisible to the authority.

export type SignalCorroboration = {
  /** symptom_observed rows that name the signal in `corroborated_signals`. */
  reports: number;
  /** Of those, the ones a vet reported (an intake confirming the account). */
  byVet: number;
};

/**
 * The es-AR line for a signal's corroborations, or null when there are none.
 * The vet's confirmation leads because it is the stronger fact; the count
 * says how many reports stand behind the one signal.
 */
export function corroborationLabel(c: SignalCorroboration): string | null {
  if (c.reports <= 0) return null;
  const count = c.reports === 1 ? "+1 reporte" : `+${c.reports} reportes`;
  return c.byVet > 0
    ? `Corroborado por veterinario · ${count} del mismo episodio`
    : `${count} del mismo episodio`;
}
