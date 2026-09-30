// recent-outbreak-signals — the source-side dedup guard for matcher signals.
//
// THE PROBLEM. An owner writes "le sale baba" on Monday; on Wednesday the vet
// records the intake and writes the same thing. Both go through
// createSymptomObservedWriter, both cross the matcher, and before this guard
// both appended an outbreak_signal. Every authority surface counts
// outbreak_signal ROWS (the /gob/vigilancia 30-day tile, its untriaged
// counterweight, the per-disease table, the trend, the Novedades feed) and each
// row sent its own authority notice — so one animal with one episode read as
// two cases.
//
// THE GUARD. Before a matcher signal is appended, take the NEWEST
// outbreak_signal of any origin (matcher, denuncia, direct diagnosis) for the
// same pet and disease inside the window. The new report is folded into it —
// no second signal, no second notice, the corroboration recorded as
// `corroborated_signals` on the new symptom_observed — ONLY when all of these
// hold:
//
//   1. NOBODY HAS ACTED ON IT. No `signal_link` case event names it. That row is
//      the only per-signal state the system has: openOutbreakInvestigation
//      writes it (src/modules/surveillance/application/outbreak-investigation.ts
//      ~line 232) and /gob/vigilancia reads the same row to tell a triaged
//      signal from an untriaged one (lib/analytics/dashboards/surveillance.ts,
//      `investigation`, and the "sin investigación" tile). A linked signal is
//      never absorbing, WHATEVER the case status: a closed or dismissed case
//      means a new report is a new episode the authority must hear about, and an
//      open one is being worked by people who should be told, not have the
//      report vanish into a signal they already read. There is no "dismiss the
//      signal without a case" action in the system; if one is added, it has to
//      be added here too.
//   2. IT IS NOT A WORSENING. See `isWorsening`.
//   3. AN ESCALATION FOLDS ONLY INTO AN ESCALATION (rabies during an active
//      observation): the URGENT notice is the point of the escalation.
//
// Whenever the answer is unclear, the report is NOT folded. Over-notifying is
// the safe side for public health; a silent fold is not.
//
// Only the newest signal is considered: if it is linked (acted on), an older
// untriaged one in the window must not absorb the report either — the
// authority's latest action on this animal and disease is the one that counts.
//
// Nothing is ever updated — the earlier signal stays exactly as written
// (append-only). /gob reads the corroborations back from the later
// symptom_observed rows (fetchSurveillanceSignals, `corroboration`).
//
// THE WINDOW — 30 days, measured from the EXISTING SIGNAL's occurred_at:
//   - it is the owner public-alert throttle (lib/infra/owner-disease-alerts.ts
//     THROTTLE_DAYS), so the owner side and the authority side agree on what
//     "the same episode" means;
//   - it is the /gob/vigilancia KPI window (`gte(occurred_at, now - 30d)`).
//     Anchored on the signal (not on the latest corroboration), a new signal is
//     appended at the latest once the previous one is MORE than 30 days old, so
//     a folded report never makes an episode last longer than a KPI window.
//   - anchoring on the signal rather than chaining through corroborations also
//     means a case that persists is re-surfaced as a fresh signal once a month.
// A shorter window (say 14 days) would leave the double count in the KPI for
// reports 15-30 days apart; a longer one would hide a genuine recurrence behind
// a signal the tile no longer shows.
//
// CLOCK. `now` is the writer's own `now`, and every outbreak_signal's
// occurred_at is written explicitly from its writer's `now` — never a
// defaultNow() column — so both sides of the comparison come from the same
// kind of clock.

import { sql } from "drizzle-orm";

import type { db } from "@/db";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const SIGNAL_CORROBORATION_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReportSeverity = "mild" | "moderate" | "severe";

export type RecentSignal = {
  id: string;
  diseaseCode: string;
  /** The signal was raised during an active rabies observation. */
  escalation: boolean;
  /** A `signal_link` case event names this signal: somebody acted on it. */
  linked: boolean;
  /**
   * `severity_self_assessed` of the symptom_observed the signal was raised
   * from. null when that report carried none, or when the signal has no
   * symptom source at all (a direct diagnosis) — "unknown", not "mild".
   */
  sourceSeverity: ReportSeverity | null;
};

/**
 * Serialize the signal decision for one pet, then return the outbreak_signal
 * rows for `diseaseCodes` inside the corroboration window, newest first, with
 * the state the fold rule needs.
 *
 * The advisory lock closes the race the read alone cannot: an owner report and
 * a vet intake committing at the same moment would both read "no signal yet".
 * Two-key form, so it never collides with the single-key custody lock
 * (`hashtext(petId)`) — Postgres keeps the two keyspaces apart. Transaction
 * scoped: released at commit or rollback.
 */
export async function lockAndFindRecentSignals(
  tx: DbTx,
  input: { petId: string; diseaseCodes: string[]; now: Date },
): Promise<RecentSignal[]> {
  if (input.diseaseCodes.length === 0) return [];
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('outbreak_signal'), hashtext(${input.petId}))`,
  );
  const since = new Date(input.now.getTime() - SIGNAL_CORROBORATION_WINDOW_DAYS * DAY_MS);
  const rows = await tx.execute<{
    id: string;
    disease_code: string;
    escalation: boolean | null;
    linked: boolean;
    source_severity: string | null;
  }>(sql`
    SELECT s.id,
           s.payload->>'disease_code' AS disease_code,
           (s.payload->>'bite_observation_active')::boolean AS escalation,
           EXISTS (
             SELECT 1 FROM case_events ce
              WHERE ce.entry_type = 'signal_link'
                AND ce.payload->>'signal_event_id' = s.id::text
           ) AS linked,
           src.payload->>'severity_self_assessed' AS source_severity
      FROM pet_events s
      LEFT JOIN pet_events src
        ON src.id::text = s.payload->>'source_symptom_event_id'
       AND src.event_type = 'symptom_observed'
     WHERE s.pet_id = ${input.petId}
       AND s.event_type = 'outbreak_signal'
       AND s.payload->>'disease_code' IN (${sql.join(
         input.diseaseCodes.map((c) => sql`${c}`),
         sql`, `,
       )})
       AND s.occurred_at >= ${since.toISOString()}::timestamptz
     ORDER BY s.occurred_at DESC, s.id DESC
  `);
  return Array.from(
    rows as Iterable<{
      id: string;
      disease_code: string;
      escalation: boolean | null;
      linked: boolean;
      source_severity: string | null;
    }>,
  ).map((r) => ({
    id: r.id,
    diseaseCode: r.disease_code,
    escalation: r.escalation === true,
    linked: r.linked === true,
    sourceSeverity: asSeverity(r.source_severity),
  }));
}

function asSeverity(value: string | null): ReportSeverity | null {
  return value === "mild" || value === "moderate" || value === "severe" ? value : null;
}

const SEVERITY_RANK: Record<ReportSeverity, number> = { mild: 1, moderate: 2, severe: 3 };

/** What the new report says about how bad things are. */
export type NewReportState = {
  escalation: boolean;
  /** The reporter's own severity (owner form); null when not given. */
  severity: ReportSeverity | null;
  /**
   * The vet's general condition at intake, when the report is an intake.
   * A different scale from `severity` (it grades the animal, not the
   * symptom), so it is never ranked against it — only its two worst values
   * are read, as a worsening on their own.
   */
  vetGeneralCondition?: "good" | "fair" | "poor" | "critical" | null;
};

/**
 * Does the new report say the episode got WORSE than the signal it would fold
 * into? Conservative on every branch that is not a like-for-like comparison:
 *
 *   - a vet recording the animal in poor or critical condition is a worsening;
 *   - a report with no severity carries no claim of worsening;
 *   - a severity against a signal whose source had none is NOT comparable, so
 *     it counts as a worsening (do not fold);
 *   - otherwise, higher on mild < moderate < severe is a worsening.
 */
export function isWorsening(signal: RecentSignal, report: NewReportState): boolean {
  if (report.vetGeneralCondition === "poor" || report.vetGeneralCondition === "critical") {
    return true;
  }
  if (report.severity === null) return false;
  if (signal.sourceSeverity === null) return true;
  return SEVERITY_RANK[report.severity] > SEVERITY_RANK[signal.sourceSeverity];
}

/**
 * The signal a new report corroborates, or null when it must raise its own.
 * `recent` is newest first; only the newest signal for the disease is eligible
 * (see the header for why an older one never is).
 */
export function signalToCorroborate(
  recent: RecentSignal[],
  diseaseCode: string,
  report: NewReportState,
): RecentSignal | null {
  const newest = recent.find((s) => s.diseaseCode === diseaseCode);
  if (!newest) return null;
  if (newest.linked) return null;
  if (report.escalation && !newest.escalation) return null;
  if (isWorsening(newest, report)) return null;
  return newest;
}
