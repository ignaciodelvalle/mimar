// Cron route — re-evaluate PPP classification (breed list + weight
// threshold) across all configured jurisdictions.
// Spec 2026-05-19-govt-business-rules-poc-design §4.5; admin-rules-console ADR-3.
//
// GET /api/cron/business-rules-reeval
//
// Authentication: header `x-cron-secret` must match process.env.CRON_SECRET.
//
// Use case: belt-and-suspenders sweep. The writer (createBusinessRuleAction
// etc.) already re-evals inline after each successful write, so this cron
// is for safety nets — recovering from a writer-time crash, applying a
// breeds.ts edit that changed the AR default, etc. Idempotent.
//
// Boundedness (fixed 2026-07-04 — capstone perf-scale finding): this sweep
// used to process EVERY configured jurisdiction scope in a single
// invocation, with no time/count budget. On a fleet with many jurisdiction
// overrides that risked exceeding the function's maxDuration:60 budget
// (vercel.json) and getting killed mid-sweep with no persisted progress.
//
// Fix: bound the OUTER scope loop with a resumable cursor — same pattern as
// reconcile-pet-status (piggy-backs on the existing cron_runs telemetry row;
// no new table/migration). Each run processes at most MAX_SCOPES_PER_RUN
// scopes, or fewer if MAX_DURATION_MS elapses first, then persists
// `nextScopeIndex` so the next run resumes with the next unprocessed scope.
// Once every scope has been covered in a cycle the cursor wraps back to 0.
// This does NOT change reEvaluatePppClassificationChange itself (the
// business-rule sweep logic) — only how many jurisdiction scopes the route
// asks it to process per invocation. Residual risk: a SINGLE scope with an
// unusually large matching population could still be slow (the AR
// country-level default is always scope 0 and runs every invocation); if
// that becomes a real problem, the next step is row-level pagination INSIDE
// reEvaluatePppClassificationChange (out of scope for this fix).
//
// Correctness: every jurisdiction's rules are still re-evaluated — just
// spread across successive daily runs when the scope list is large, instead
// of always crammed into one. reEvaluatePppClassificationChange is already
// idempotent, so partial/repeated coverage across runs is safe.

import { type NextRequest, NextResponse } from "next/server";

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { cronRuns, db, govtBusinessRules } from "@/db";
import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import {
  type JurisdictionScope,
  reEvaluatePppClassificationChange,
} from "@/lib/infra/business-rules-reeval";
import { withCronRun } from "@/lib/infra/case-cron";
import { effectiveDeadlineMs } from "@/lib/infra/cron-dispatcher";

export const dynamic = "force-dynamic";

const CRON_NAME = "business_rules_reeval";

// Hard cap on scopes processed per run, independent of the time budget below
// — keeps worst-case work predictable even if every scope call is fast.
const MAX_SCOPES_PER_RUN = 25;

// Wall-clock budget per invocation (ms), checked BETWEEN scope calls (a
// single scope's internal work cannot be interrupted mid-call — see header
// comment). C-b (2026-08-16): 45s → 20s — this job runs inside the daily
// dispatcher's shared 55s budget, whose soft check only fires BETWEEN jobs;
// an uncoordinated 45s here could bust the fleet's 60s hard cap from inside
// a "safe" budget. The reeval is cursor-resumable; the tail rolls over.
const MAX_DURATION_MS = 20_000;

type Scope = { country: string; province: string | null; locality: string | null };

function scopeKey(s: Scope): string {
  return `${s.country}|${s.province ?? ""}|${s.locality ?? ""}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = authorizeCronRequest(req);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  const start = Date.now();
  // RN #9 (2026-08-22): the ceiling is min(our own, the share the dispatcher
  // handed down). MAX_DURATION_MS alone is blind to how much of the fleet's
  // 55 s is already spent; the header is not. Standalone (no header) it is the
  // constant, unchanged.
  const budgetMs = effectiveDeadlineMs(MAX_DURATION_MS, req.headers);
  try {
    // -----------------------------------------------------------------------
    // Resume cursor: index into the deterministically-ordered scope list,
    // read from the last FINISHED run for this cron (see header comment).
    // -----------------------------------------------------------------------
    const [lastRun] = await db
      .select({ details: cronRuns.details })
      .from(cronRuns)
      .where(and(eq(cronRuns.cronName, CRON_NAME), isNotNull(cronRuns.finishedAt)))
      .orderBy(desc(cronRuns.startedAt))
      .limit(1);

    const resumeIndexRaw =
      lastRun?.details && typeof lastRun.details === "object"
        ? (lastRun.details as Record<string, unknown>).nextScopeIndex
        : undefined;
    const resumeIndex =
      typeof resumeIndexRaw === "number" && Number.isInteger(resumeIndexRaw) && resumeIndexRaw >= 0
        ? resumeIndexRaw
        : 0;

    // Pet-level resume cursor (review 23 fleet residual): when a run's deadline
    // interrupted a scope mid-sweep, the previous run persisted the last pet id
    // it processed. We resume that SAME scope AFTER that pet instead of
    // re-scanning it from pet 0.
    const resumePetIdRaw =
      lastRun?.details && typeof lastRun.details === "object"
        ? (lastRun.details as Record<string, unknown>).nextPetId
        : undefined;
    const resumePetId = typeof resumePetIdRaw === "string" ? resumePetIdRaw : null;

    const totals = await withCronRun(
      CRON_NAME,
      async () => {
        // Re-eval every distinct jurisdiction that has a ppp_breed_list OR
        // ppp_weight_threshold row (either can affect classification via the
        // composed resolver). Also include a single "default AR scan" so pets
        // in AR without any override still get re-evaluated against the
        // hardcoded defaults.
        const rows = await db
          .select({
            country: govtBusinessRules.jurisdictionCountry,
            province: govtBusinessRules.jurisdictionProvince,
            locality: govtBusinessRules.jurisdictionLocality,
          })
          .from(govtBusinessRules)
          .where(inArray(govtBusinessRules.ruleType, ["ppp_breed_list", "ppp_weight_threshold"]));

        // Deduplicate + sort for a stable order — the resume index must mean
        // the same scope across runs even as govtBusinessRules rows change.
        const byKey = new Map<string, Scope>();
        byKey.set(scopeKey({ country: "AR", province: null, locality: null }), {
          country: "AR",
          province: null,
          locality: null,
        });
        for (const r of rows) {
          const scope: Scope = { country: r.country, province: r.province, locality: r.locality };
          byKey.set(scopeKey(scope), scope);
        }
        const scopes = Array.from(byKey.values()).sort((a, b) =>
          scopeKey(a).localeCompare(scopeKey(b)),
        );

        let totalScanned = 0;
        let totalFlippedToPpp = 0;
        let totalFlippedToNonPpp = 0;
        let totalNotified = 0;
        let processedCount = 0;
        let earlyStop = false;
        let index = resumeIndex < scopes.length ? resumeIndex : 0;
        // Only the FIRST scope processed this run resumes mid-sweep (from the
        // persisted pet cursor); every subsequent scope starts from its top.
        let scopeAfterPetId: string | null = resumeIndex < scopes.length ? resumePetId : null;
        let nextPetId: string | null = null;

        while (processedCount < scopes.length) {
          if (processedCount >= MAX_SCOPES_PER_RUN || Date.now() - start >= budgetMs) {
            earlyStop = true;
            break;
          }

          const scope: JurisdictionScope = scopes[index];
          // Pass a wall-clock deadline so a single large scope's in-scope pet
          // sweep is keyset-batched AND time-bounded (review 23 item 10) — it
          // can't blow the 60s function budget.
          const result = await reEvaluatePppClassificationChange(scope, {
            deadlineMs: start + budgetMs,
            afterPetId: scopeAfterPetId,
          });
          totalScanned += result.scanned;
          totalFlippedToPpp += result.flippedToPpp;
          totalFlippedToNonPpp += result.flippedToNonPpp;
          totalNotified += result.notified;

          if (result.nextPetId) {
            // The deadline interrupted this scope mid-sweep. Resume the SAME
            // scope from this pet cursor next run instead of re-scanning it from
            // pet 0 (review 23 fleet residual). Do NOT advance the scope index
            // or processedCount — this scope is not yet fully covered.
            earlyStop = true;
            nextPetId = result.nextPetId;
            break;
          }

          // Scope fully covered — consume its pet cursor and move to the next.
          scopeAfterPetId = null;
          processedCount += 1;
          index = (index + 1) % scopes.length;
        }

        // earlyStop mid-scope → resume {index, nextPetId}. earlyStop between
        // scopes → resume {index, null}. Otherwise every scope in this cycle
        // was covered → wrap back to the top for the next cycle.
        const nextScopeIndex = earlyStop ? index : 0;

        return {
          scopesTotal: scopes.length,
          scopes: processedCount,
          earlyStop,
          nextScopeIndex,
          nextPetId,
          scanned: totalScanned,
          flippedToPpp: totalFlippedToPpp,
          flippedToNonPpp: totalFlippedToNonPpp,
          notified: totalNotified,
        };
      },
      (r) => ({
        itemsProcessed: r.scanned,
        details: {
          scopesTotal: r.scopesTotal,
          scopesProcessed: r.scopes,
          earlyStop: r.earlyStop,
          nextScopeIndex: r.nextScopeIndex,
          nextPetId: r.nextPetId,
          flippedToPpp: r.flippedToPpp,
          flippedToNonPpp: r.flippedToNonPpp,
          notified: r.notified,
        },
      }),
    );

    return NextResponse.json({
      ok: true,
      ...totals,
      durationMs: Date.now() - start,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "error desconocido",
      },
      { status: 500 },
    );
  }
}
