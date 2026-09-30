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
// THE GUARD. Before a matcher signal is appended, look for an outbreak_signal
// of ANY origin (matcher, denuncia, direct diagnosis) for the same pet and the
// same disease within the window. When one exists, no second signal and no
// second notice: the new symptom_observed records the corroboration instead
// (`corroborated_signals` on its payload), because a vet confirming what an
// owner reported is information the authority wants, not noise. Nothing is
// ever updated — the earlier signal stays exactly as written (append-only).
//
// THE WINDOW — 30 days, measured from the EXISTING SIGNAL's occurred_at:
//   - it is the owner public-alert throttle (lib/infra/owner-disease-alerts.ts
//     THROTTLE_DAYS), so the owner side and the authority side agree on what
//     "the same episode" means;
//   - it is the /gob/vigilancia KPI window (`gte(occurred_at, now - 30d)`).
//     Anchored on the signal (not on the latest corroboration), a new signal is
//     only appended once the previous one is MORE than 30 days old, so any
//     30-day KPI window holds at most one matcher-guarded signal per pet and
//     disease. That is the property the tile needs.
//   - anchoring on the signal rather than chaining through corroborations also
//     means a case that persists is re-surfaced as a fresh signal once a month
//     instead of being folded into a signal the authority closed long ago.
// A shorter window (say 14 days, one incubation-scale period) would leave the
// double count in the KPI for reports 15-30 days apart; a longer one would hide
// a genuine recurrence behind a signal the tile no longer shows.
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

export type RecentSignal = {
  id: string;
  diseaseCode: string;
  /** The signal was raised during an active rabies observation. */
  escalation: boolean;
};

/**
 * Serialize the signal decision for one pet, then return the outbreak_signal
 * rows for `diseaseCodes` inside the corroboration window, newest first.
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
  }>(sql`
    SELECT id,
           payload->>'disease_code' AS disease_code,
           (payload->>'bite_observation_active')::boolean AS escalation
      FROM pet_events
     WHERE pet_id = ${input.petId}
       AND event_type = 'outbreak_signal'
       AND payload->>'disease_code' IN (${sql.join(
         input.diseaseCodes.map((c) => sql`${c}`),
         sql`, `,
       )})
       AND occurred_at >= ${since.toISOString()}::timestamptz
     ORDER BY occurred_at DESC
  `);
  return Array.from(
    rows as Iterable<{ id: string; disease_code: string; escalation: boolean | null }>,
  ).map((r) => ({ id: r.id, diseaseCode: r.disease_code, escalation: r.escalation === true }));
}

/**
 * The signal a new one would duplicate, or null. An escalating signal (rabies
 * during an active observation) is folded only into a signal that was itself
 * an escalation: the URGENT notice is the whole point of the escalation, and a
 * routine signal from before the observation never sent one.
 */
export function signalToCorroborate(
  recent: RecentSignal[],
  diseaseCode: string,
  escalation: boolean,
): RecentSignal | null {
  return recent.find((s) => s.diseaseCode === diseaseCode && (!escalation || s.escalation)) ?? null;
}
