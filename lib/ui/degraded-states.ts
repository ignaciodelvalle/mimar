// degraded-states — timing constants and es-AR copy for the degraded-states
// capability (2026-08-06): timed loading escalation, stale-data banding, and
// idempotent mutation retry. Mirrors lib/ui/action-stall.ts (constants + copy
// live in lib/ui, components consume them — design D4).
//
// THE PROBLEM THIS COVERS
// Under free-tier degradation (slow streams, 503s) the app must never show an
// eternal spinner, a blank shell, or invite a duplicate mutation. Three
// mechanisms share these constants:
//   - DegradedFallback (components/ui/DegradedFallback.tsx): SSR'd pure-CSS
//     escalation of a stalled Suspense fallback — base skeleton → waiting text
//     → degraded card. CSS animation-delay, NEVER JS timers: the failure mode
//     this mitigates (hydration stalled mid-shell) is exactly the one where a
//     useEffect timer never fires.
//   - FreshnessStaleBand (components/ui/dashboard/FreshnessStaleBand.tsx):
//     amber band on dashboards once shown data crosses the staleness
//     threshold.
//   - useRetryableAction + MutationErrorCard: dispatch-level catch and
//     retry-with-same-idempotency-key for whitelisted mutation forms.
//
// Every value is defined ONCE here and imported — no duplicated literals.

/**
 * How long a Suspense fallback may sit on the base skeleton before the
 * waiting text reveals. Applied as an inline CSS `animation-delay` on a
 * `.degraded-reveal` block (see app/globals.css), so it works with zero JS.
 *
 * Same 8s rationale as ACTION_STALL_MS (lib/ui/action-stall.ts): comfortably
 * past every legitimate load, far short of real user patience.
 */
export const DEGRADED_TEXT_MS = 8000;

/**
 * Total wait before the degraded card (icon + retry affordances) reveals.
 * Also an inline CSS `animation-delay` — measured from the same mount as
 * DEGRADED_TEXT_MS, not from the text reveal.
 */
export const DEGRADED_CARD_MS = 20000;

/**
 * Age at which dashboard data is banded as stale ("Mostrando datos de hace
 * N min · Actualizar"). SINGLE source of truth, PO-adjustable — default
 * 10 minutes. Never duplicate this number at a call site.
 */
export const STALE_BAND_AFTER_MS = 10 * 60 * 1000;

/**
 * Minimum interval between mutation retry presses: the "Reintentar envío"
 * button disables for this long after each press so rapid re-presses cannot
 * fire duplicate requests (spec: Retry Backoff).
 */
export const RETRY_DISABLE_MS = 5000;

/**
 * Retry attempts allowed before the card stops offering a retry button and
 * falls back to D.12-shaped copy (go look at the record before re-submitting).
 */
export const RETRY_MAX_ATTEMPTS = 3;

/**
 * es-AR copy, verbatim from the degraded-states spec. The SHAPE of the
 * mutation copy follows ACTION_STALL_COPY's contract: never claim failure,
 * never claim success, never invite a blind duplicate.
 */
export const DEGRADED_COPY = {
  /** 8s stage — the load is slow but alive. */
  slowText: "Esto está tardando más de lo normal.",
  /** 20s degraded card title. */
  cardTitle: "No pudimos cargar esta sección todavía",
  /** 20s degraded card description. */
  cardDescription: "Puede ser tu conexión o un pico nuestro. Lo que ya se ve es confiable.",
  /** Primary card action — a full-document GET on the current URL. */
  retry: "Reintentar",
  /** Secondary card action — restarts the CSS cycle, never navigates. */
  keepWaiting: "Seguir esperando",
} as const;

/**
 * Stale-band copy: "Mostrando datos de hace N min · Actualizar". Split in two
 * because "Actualizar" renders as a link (a full-document GET), not plain
 * text. "min" is an invariant abbreviation — no pluralization needed.
 */
export function staleBandLabel(minutes: number): string {
  return `Mostrando datos de hace ${minutes} min`;
}

export const STALE_BAND_ACTION = "Actualizar";

/**
 * DOM id of the top-of-shell slot the stale band portals into.
 *
 * WHY A SLOT AND NOT A MOVE. The band is mounted inside
 * DashboardFreshnessFooter so every dashboard gains it with zero call-site
 * edits — that property is worth keeping, because a per-page mount is a thing
 * each new dashboard forgets. But the footer sits at the BOTTOM: QA 2026-08-07
 * measured the band rendering at 79% of the main scroll height, above the
 * "Calculado al…" line. On an empty screen you see it; on a loaded briefing —
 * alerts, gaps, sparklines — the operator reads the entire stale dashboard and
 * only learns it was stale at the very end. A warning that arrives after the
 * data it warns about has already done its damage.
 *
 * So the band stays mounted where it is and PORTALS to the top of the shell.
 * AppShell renders this slot in both the citizen and operator variants; when it
 * is absent (a dashboard outside a shell) the band falls back to rendering in
 * place, which is strictly the old behaviour.
 */
export const STALE_BAND_SLOT_ID = "ln-stale-band-slot";

/**
 * Mutation-retry copy (MutationErrorCard). `exhausted` is deliberately
 * D.12-shaped (see ACTION_STALL_COPY): after RETRY_MAX_ATTEMPTS the honest
 * instruction is to go LOOK at the record before acting again, because under
 * invariant #2 a duplicate event can never be removed.
 */
export const MUTATION_RETRY_COPY = {
  title: "No pudimos enviar el registro",
  cause: "Puede ser tu conexión o un pico nuestro. Lo que escribiste sigue acá.",
  retry: "Reintentar envío",
  exhausted:
    "Puede que el registro haya quedado guardado igual. Revisá la libreta de la mascota antes de volver a enviarlo: si el registro ya está, enviarlo de nuevo lo duplica y no se puede borrar.",
} as const;
