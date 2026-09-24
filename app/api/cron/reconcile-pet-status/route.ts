// Cron route — detect drift between pets.status (denormalized cache) and the
// canonical value derived from the pet_events log.
//
// GET /api/cron/reconcile-pet-status
//
// Authentication: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron contract)
// or legacy `x-cron-secret: <CRON_SECRET>` — see lib/cron-auth.ts.
//
// Background (finding R2 in the pre-mortem):
//   pets.status is a denormalized cache with multiple writers (status_changed,
//   death_recorded, transfer handlers, etc.). Writers dual-write the event AND
//   the cache column inside the same transaction, but there is no continuous
//   verification that the cache stays consistent with the event log. A missed
//   dual-write, a failed migration, or an upcaster gap can cause silent drift.
//
// This cron DETECTS drift; it does NOT auto-repair.
//
// WHY not auto-repair:
//   A status divergence might indicate a missing upcaster or incomplete event
//   rather than a stale cache. Auto-repairing would overwrite the stored value
//   with a potentially wrong derived value. Repair is a gated, human-reviewed
//   follow-up once the root cause of each divergence is understood.
//   For the repair path, see scripts/rebuild-projections.ts --apply.
//
// Strategy:
//   - Uses rederivePetCache (lib/rederive-pet-cache.ts), the canonical deriver
//     shared by CI (pet-cache-rederivation.test.ts) and the ops script
//     (scripts/detect-pet-cache-drift.ts). No duplicated derivation logic.
//   - Only the `status` and `deceasedAt` columns decide `divergent`, the
//     /admin/sistema card and cron-health's verdict. Every OTHER column the
//     report carries is counted per family into `details.familyDrift` and
//     pages through a SEPARATE warning alert (finding A08-3, 2026-09-22).
//     Before that, the wide report was computed here every night and thrown
//     away, and the only full-column detector (scripts/detect-pet-cache-drift.ts)
//     was wired to nothing — a pets.jurisdictionProvince written without its
//     movement_recorded painted the /gob choropleth wrong with nobody told.
//     Why a separate alert and not a wider `divergent`: the 2026-07-18 staging
//     episode (463 pets "divergent" on identifier columns while status matched)
//     kept cron-health red for a family the status card does not own. One noisy
//     family must not mute the status alarm, and the status contract must not
//     silence the rest — so each side pages on its own, and the family alert
//     names its counts so a noisy family is visible as itself.
//     Why not schedule the ops script instead: it walks the whole table in one
//     process with no budget or cursor, and its only scheduled home would be a
//     staging workflow gated on a secret. This cron already runs rederivePetCache
//     on every pet under a budget and a resumable cursor.
//   - Keyset pagination over pets.id — same approach as the ops script.
//   - Time-guarded: stops after MAX_DURATION_MS to stay within Vercel's
//     cron timeout budget (30 s on the Hobby plan default).
//   - The keyset cursor IS persisted across invocations (fixed 2026-07-04 —
//     without this, drift detection capped at the first MAX_PETS_PER_RUN
//     pets FOREVER on any registry larger than that). No new table/migration
//     needed: we piggy-back on the existing cron_runs telemetry row for this
//     cron name (see migration 0024_cron_runs.sql) — the finished run's
//     `details.nextCursor` is read at the start of the next run and written
//     again at the end. When a run reaches the true end of the table (no
//     more rows past the cursor) `nextCursor` resets to null so the next
//     run wraps around and starts a fresh full sweep.
//   - Drift alerting: `divergent > 0` fires a "warning"-severity sendCronAlert
//     (lib/infra/cron-alert.ts) with the sample + count, in addition to the
//     cronRuns row and cron-health's own "drift" verdict (status-family gate
//     in app/api/cron/cron-health/route.ts) — see the in-body comment for why
//     this doesn't flip the run to "failed".
//
// Returns: { ok, scanned, divergent, sample, durationMs }
// cronRuns.details includes divergence summary + sample for /admin/sistema.

import { type NextRequest, NextResponse } from "next/server";

import { and, asc, desc, eq, gt, isNotNull } from "drizzle-orm";

import { cronRuns, db, pets } from "@/db";
import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { sendCronAlert } from "@/lib/infra/cron-alert";
import { effectiveDeadlineMs } from "@/lib/infra/cron-dispatcher";
import { type RederivePetCacheReport, rederivePetCache } from "@/lib/infra/rederive-pet-cache";

// The status projection's column family — the ONLY columns this cron's
// divergence verdict may consider (see header contract).
const STATUS_FAMILY = ["status", "deceasedAt"] as const;

/**
 * Family of every NON-status column rederivePetCache reports. A column missing
 * here still counts, under "unclassified" — a new checked column must never be
 * dropped on the floor the way the whole wide report used to be.
 */
const COLUMN_FAMILY: Record<string, string> = {
  estimatedWeightKg: "weight",
  microchipId: "identification",
  microchipCountryCode: "identification",
  microchipImplantedAt: "identification",
  microchipImplantedBy: "identification",
  microchipLocation: "identification",
  tattooCode: "identification",
  tattooLocation: "identification",
  tattooDescription: "identification",
  tattooRecordedAt: "identification",
  tattooRecordedBy: "identification",
  pregnancyStatus: "pregnancy",
  rabiesObservationStatus: "rabies_observation",
  jurisdictionCountry: "jurisdiction",
  jurisdictionProvince: "jurisdiction",
  jurisdictionLocality: "jurisdiction",
  inCustodyDispute: "custody_dispute",
  adoptionEligible: "adoption_eligibility",
  adoptionIneligibleReason: "adoption_eligibility",
  adoptionIneligibleReasonNotes: "adoption_eligibility",
  adoptionIneligibleUntil: "adoption_eligibility",
  adoptionEligibilitySetAt: "adoption_eligibility",
};

/** Drifted columns OUTSIDE the status family, grouped by family. */
function otherFamilyDrift(report: RederivePetCacheReport): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [column, r] of Object.entries(report)) {
    if (r.matches || (STATUS_FAMILY as readonly string[]).includes(column)) continue;
    const family = COLUMN_FAMILY[column] ?? "unclassified";
    out[family] = [...(out[family] ?? []), column];
  }
  return out;
}

/** Drifted column names, restricted to the status family. */
function statusFamilyDrift(report: RederivePetCacheReport): string[] {
  return STATUS_FAMILY.filter((c) => {
    const r = report[c];
    return r !== undefined && !r.matches;
  });
}

export const dynamic = "force-dynamic";

const CRON_NAME = "reconcile_pet_status";

// Maximum number of pets to process per run. Keeps the wall-clock cost
// predictable regardless of registry size; the next nightly run picks up
// where this one left off via the persisted keyset cursor (see header
// comment) and the sweep wraps around once it reaches the end of the table.
const MAX_PETS_PER_RUN = 2000;

// Absolute wall-clock budget per invocation (ms). Stops the batch loop before
// Vercel's function timeout so we can still write the cronRuns row.
// C-b (2026-08-16): 45s → 20s. This job no longer runs alone — the daily
// dispatcher runs the WHOLE fleet inside one 60s function with a 55s total
// budget, and the dispatcher's soft check only fires BETWEEN jobs: a single
// job legitimately using its own 45s could bust the shared ceiling from
// inside a "safe" budget. 20s means no early job can plausibly exhaust the
// window; the sweep is keyset-resumable, so the tail rolls to tomorrow.
const MAX_DURATION_MS = 20_000;

// Maximum divergence samples to store in cronRuns.details (keeps the JSONB
// payload small while still giving operators something actionable to inspect).
const MAX_SAMPLE = 20;

type PetRef = { id: string; publicToken: string };

type FamilyDriftSample = {
  petId: string;
  publicToken: string;
  /** Drifted columns outside the status family, by family. */
  families: Record<string, string[]>;
};

type DivergenceSample = {
  petId: string;
  publicToken: string;
  /** Status stored in pets.status at scan time. */
  cached: string | null;
  /** Status derived from the event log at scan time. */
  derived: string | null;
  /** All drifted column names for this pet (may include deceasedAt etc.). */
  driftedColumns: string[];
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------
  const authError = authorizeCronRequest(req);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  const start = Date.now();
  // RN #9 (2026-08-22): min(our own ceiling, the share the dispatcher handed
  // down). The constant alone is blind to how much of the fleet's 55 s is
  // already spent; the header is not. Standalone it is the constant, unchanged.
  const budgetMs = effectiveDeadlineMs(MAX_DURATION_MS, req.headers);

  // ---------------------------------------------------------------------------
  // Start cronRuns telemetry row
  // ---------------------------------------------------------------------------
  const [run] = await db
    .insert(cronRuns)
    .values({ cronName: CRON_NAME, status: "running" })
    .returning();

  let scanned = 0;
  let divergent = 0;
  const sample: DivergenceSample[] = [];
  // Pets drifted per non-status family (a pet drifted in two families counts in both).
  const familyDrift: Record<string, number> = {};
  const familySample: FamilyDriftSample[] = [];
  let cronStatus: "ok" | "failed" = "ok";
  const errors: { petId: string; reason: string }[] = [];
  let earlyStop = false;
  let nextCursor: string | null = null;

  try {
    // -------------------------------------------------------------------------
    // Resume from the last persisted cursor (see header comment). We look at
    // the most recently FINISHED run for this cron name and read its
    // `details.nextCursor` — null means "start a fresh sweep from the top".
    // -------------------------------------------------------------------------
    const [lastRun] = await db
      .select({ details: cronRuns.details })
      .from(cronRuns)
      .where(and(eq(cronRuns.cronName, CRON_NAME), isNotNull(cronRuns.finishedAt)))
      .orderBy(desc(cronRuns.startedAt))
      .limit(1);

    const resumeCursor =
      lastRun?.details && typeof lastRun.details === "object"
        ? (((lastRun.details as Record<string, unknown>).nextCursor as string | null | undefined) ??
          null)
        : null;

    // -------------------------------------------------------------------------
    // Keyset-paginated scan over pets
    // -------------------------------------------------------------------------
    let cursor: string | null = resumeCursor;
    const BATCH_SIZE = 100;

    outer: for (;;) {
      if (scanned >= MAX_PETS_PER_RUN) {
        earlyStop = true;
        break;
      }
      if (Date.now() - start >= budgetMs) {
        earlyStop = true;
        break;
      }

      const base = db
        .select({ id: pets.id, publicToken: pets.publicToken, status: pets.status })
        .from(pets)
        .$dynamic();
      const query = cursor ? base.where(gt(pets.id, cursor)) : base;
      const batch = (await query.orderBy(asc(pets.id)).limit(BATCH_SIZE)) as (PetRef & {
        status: string | null;
      })[];

      if (batch.length === 0) break;

      for (const pet of batch) {
        scanned += 1;

        try {
          const report = await rederivePetCache(pet.id);
          // CONTRACT (header): only status + deceasedAt count as divergence
          // here — this cron backs the "Deriva de caché · pets.status" card
          // and the health verdict. rederivePetCache reports EVERY cached
          // column, and counting the rest (e.g. legacy microchip columns vs
          // the canonical identifier rows) made the card claim status drift
          // that wasn't there (staging 2026-07-18: 463 "divergent" pets whose
          // status matched perfectly). The wider report is counted per family
          // just below and pages through its own alert (finding A08-3).
          const others = otherFamilyDrift(report);
          if (Object.keys(others).length > 0) {
            for (const family of Object.keys(others)) {
              familyDrift[family] = (familyDrift[family] ?? 0) + 1;
            }
            if (familySample.length < MAX_SAMPLE) {
              familySample.push({ petId: pet.id, publicToken: pet.publicToken, families: others });
            }
          }

          const statusFamily = statusFamilyDrift(report);
          if (statusFamily.length > 0) {
            divergent += 1;

            if (sample.length < MAX_SAMPLE) {
              const statusReport = report.status;
              sample.push({
                petId: pet.id,
                publicToken: pet.publicToken,
                cached: statusReport ? String(statusReport.stored ?? "") : pet.status,
                derived: statusReport ? String(statusReport.derived ?? "") : null,
                driftedColumns: statusFamily,
              });
            }
          }
        } catch (err) {
          errors.push({
            petId: pet.id,
            reason: err instanceof Error ? err.message : String(err),
          });
        }

        // Advance the cursor to this pet even if the budget check below stops
        // the run mid-batch — the next run must resume AFTER this pet, not
        // re-scan it or fall back to the previous batch's cursor.
        cursor = pet.id;

        if (scanned >= MAX_PETS_PER_RUN || Date.now() - start >= budgetMs) {
          earlyStop = true;
          break outer;
        }
      }

      if (batch.length < BATCH_SIZE) break;
    }

    // Persist the resume point: if we stopped early (budget exhausted) the
    // next run must continue from `cursor`; if we reached the true end of
    // the table (no earlyStop), wrap around — next run starts a fresh sweep.
    nextCursor = earlyStop ? cursor : null;

    if (divergent > 0) {
      // Prominent log line — surfaces in Vercel function logs and any log
      // aggregator that tails the function output.
      console.warn(
        `[cron/reconcile-pet-status] DRIFT DETECTED — scanned=${scanned} divergent=${divergent} sample_ids=${sample.map((s) => s.publicToken).join(",")}`,
      );

      // Page a human directly instead of relying on cron-health's "drift"
      // verdict (app/api/cron/cron-health/route.ts, status-family gate) to
      // surface it on its own daily schedule (up to ~24h later — see
      // lib/infra/cron-registry.ts). Severity is "warning", not "critical":
      // THIS run succeeded — it detected the drift it was built to detect.
      // Drift is detect-not-repair (see header), so it's a degraded-state
      // signal, not a run failure; cronStatus below stays "ok" and the route
      // still returns 200 on drift alone.
      //
      // Dedup: sendCronAlert has no built-in dedup (lib/infra/cron-alert.ts
      // is a stateless best-effort webhook POST). This cron runs nightly, so
      // a persisting drift re-alerts once per run until repaired — acceptable
      // cadence, not spam. cron-health's own "drift" verdict remains the
      // backstop if this alert is ever missed (webhook down, env unset, etc.).
      await sendCronAlert({
        job: CRON_NAME,
        severity: "warning",
        error: `${divergent} pet(s) with status-family drift (cache vs. event log)`,
        details: { scanned, divergent, sample },
      });
    } else {
      console.info(
        `[cron/reconcile-pet-status] clean — scanned=${scanned} divergent=0 earlyStop=${earlyStop}`,
      );
    }

    // The rest of the report (finding A08-3). Its own alert, so it neither
    // mutes nor is muted by the status one — see the header.
    const familyCounts = Object.entries(familyDrift);
    if (familyCounts.length > 0) {
      const summary = familyCounts
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([family, n]) => `${family}=${n}`)
        .join(", ");
      console.warn(
        `[cron/reconcile-pet-status] CACHE DRIFT OUTSIDE STATUS — scanned=${scanned} ${summary}`,
      );
      await sendCronAlert({
        job: CRON_NAME,
        severity: "warning",
        error: `pets cache drift outside the status family (cache vs. event log): ${summary}`,
        details: { scanned, familyDrift, familySample },
      });
    }
  } catch (err) {
    cronStatus = "failed";
    errors.push({ petId: "global", reason: err instanceof Error ? err.message : String(err) });
    console.error("[cron/reconcile-pet-status] fatal error:", err);
  }

  // Per-pet rederivation failures (not just the fatal outer catch) mean the run
  // was not fully healthy: flip it to failed so the route returns HTTP 500,
  // Vercel retries, and a human is paged — a cron must not report success on
  // failure (review 23 fleet extension). Drift detection itself is idempotent,
  // so a retry is safe.
  if (cronStatus === "ok" && errors.length > 0) {
    cronStatus = "failed";
  }

  const durationMs = Date.now() - start;

  // ---------------------------------------------------------------------------
  // Finalize cronRuns row
  // ---------------------------------------------------------------------------
  await db
    .update(cronRuns)
    .set({
      status: cronStatus,
      finishedAt: new Date(),
      itemsProcessed: scanned,
      details: {
        scanned,
        divergent,
        earlyStop,
        nextCursor,
        ...(sample.length > 0 && { sample }),
        ...(familySample.length > 0 && { familyDrift, familySample }),
        ...(errors.length > 0 && { errors }),
      },
    })
    .where(eq(cronRuns.id, run.id));

  if (cronStatus === "failed") {
    await sendCronAlert({
      job: CRON_NAME,
      severity: "critical",
      error: `${errors.length} error(s) during reconcile — see cron_runs.details`,
      details: { scanned, divergent, errors: errors.slice(0, 20) },
    });
  }

  return NextResponse.json(
    {
      ok: cronStatus === "ok",
      scanned,
      divergent,
      sample,
      durationMs,
    },
    { status: cronStatus === "ok" ? 200 : 500 },
  );
}
