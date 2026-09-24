// One SQL predicate for "this pet's rabies observation is still OPEN".
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// Until 2026-08-17 "open" was a single literal, `rabies_observation_status =
// 'in_progress'`, hand-written into six analytics queries. The PO decision that
// only a professional may assert a clinical outcome (engram
// roadmap/decisiones-legales-flujos-2026-08-17, item 1) added a second open
// state: `window_expired_unclosed`, written by the daily sweep when the
// statutory window elapses with nobody having closed the observation.
//
// Every one of those six queries would have gone quietly WRONG. The worst is
// lib/analytics/surveillance-metrics.ts's `openBreaches` — "started more than
// windowDays ago and never closed", i.e. the legal-breach counter. Its extra
// `status = 'in_progress'` guard exists to keep breaches ⊆ the open-observations
// KPI; left alone, it would have reported ZERO breaches at the exact moment
// breaches became the normal outcome, because the sweep moves every breaching
// observation out of `in_progress` within a day.
//
// So the predicate is built ONCE, from the domain constant, and every counter
// that means "unfinished observation" imports it. Counters that genuinely mean
// "window currently running" are free to keep the narrow literal — none do
// today, and any future one should say so at its own call site.

import { type SQL, inArray } from "drizzle-orm";

import { pets } from "@/db";
import { OPEN_OBSERVATION_STATUSES } from "@/src/modules/surveillance/domain/rabies-observation";

/**
 * `pets.rabies_observation_status IN ('in_progress','window_expired_unclosed')`.
 *
 * A function rather than a const so each call site gets its own SQL node —
 * drizzle chunks are consumed when embedded, and sharing one instance across
 * several queries in the same request is a footgun.
 */
export function openObservationStatusSql(): SQL {
  return inArray(pets.rabiesObservationStatus, [...OPEN_OBSERVATION_STATUSES]);
}
