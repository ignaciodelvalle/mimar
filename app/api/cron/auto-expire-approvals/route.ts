// Cron route — auto-expire approval_requests that have been `pending` for
// more than 60 days. Each candidate is swept inside its own tx so a single
// row's failure doesn't poison the rest of the batch.
//
// GET /api/cron/auto-expire-approvals
// Auth: `x-cron-secret` header must match process.env.CRON_SECRET.
//
// Returns: { status: "ok" | "failed", itemsProcessed, runId }

import { type NextRequest, NextResponse } from "next/server";

import { and, asc, eq, gt, isNull, lt } from "drizzle-orm";

import { approvalRequests, auditLog, cronRuns, db, profiles } from "@/db";
import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { sendCronAlert } from "@/lib/infra/cron-alert";
import { effectiveDeadlineMs } from "@/lib/infra/cron-dispatcher";
import { createNotification } from "@/lib/infra/notification-service";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_DAYS = 60;
// Keyset page size + wall-clock budget (review 23 item 21): the stale-approvals
// select was unbounded. Now paged by id; processed rows flip to 'withdrawn' and
// drop out of scope, so the backlog drains across pages / daily runs.
const BATCH_SIZE = 200;
const MAX_DURATION_MS = 45_000;
// Canonical name: snake_case of the route directory (cron-registry SSOT rule,
// projection-cron audit 2026-07-03 B2) — was mismatched with the registry, so
// cron-health reported this cron never_ran while telemetry accrued elsewhere.
const CRON_NAME = "auto_expire_approvals";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = authorizeCronRequest(req);
  if (authError) {
    return NextResponse.json({ ok: false, error: authError.error }, { status: authError.status });
  }

  // Telemetry FIRST, before anything that can bail (cold-start review RA-6,
  // finding 2). This insert used to sit BELOW the system-actor lookup, which
  // returned HTTP 500 when no active admin existed. The run therefore failed
  // every single day while writing zero rows to cron_runs, so cron-health
  // reported `never_ran` — indistinguishable from "never scheduled". A daily
  // failure that looks exactly like a missing schedule is a silent failure.
  const [run] = await db
    .insert(cronRuns)
    .values({ cronName: CRON_NAME, status: "running" })
    .returning();

  // Pick the oldest active admin as the system actor. audit_log.actor_user_id
  // is a nullable SET NULL FK (migration 0080) — a real profile is no longer
  // required, but using a real admin actor produces more meaningful audit rows.
  //
  // Absent on a cold-start DB, and also the moment a single-admin deployment
  // deactivates its only admin. Neither is a reason to stop expiring stale
  // approvals: we log an actor-less audit row and carry on, exactly as
  // lib/infra/outbox-drainer.ts already does for the identical lookup.
  const [systemActor] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(
      and(
        eq(profiles.role, "admin"),
        eq(profiles.accountType, "institutional"),
        isNull(profiles.deactivatedAt),
      ),
    )
    .orderBy(profiles.createdAt)
    .limit(1);

  if (!systemActor) {
    console.warn(
      `[cron/${CRON_NAME}] no active institutional admin — audit rows will carry a null actor`,
    );
  }

  const cutoff = new Date(Date.now() - EXPIRY_DAYS * DAY_MS);
  const start = Date.now();
  // RN #9 (2026-08-22): min(our own ceiling, the share the dispatcher handed
  // down). The constant alone is blind to how much of the fleet's 55 s is
  // already spent; the header is not. Standalone it is the constant, unchanged.
  const budgetMs = effectiveDeadlineMs(MAX_DURATION_MS, req.headers);
  let itemsProcessed = 0;
  let status: "ok" | "failed" = "ok";
  const errors: { id: string; reason: string }[] = [];

  try {
    let cursor: string | null = null;

    for (;;) {
      if (Date.now() - start >= budgetMs) break;

      const stale = await db
        .select({
          id: approvalRequests.id,
          publicToken: approvalRequests.publicToken,
          applicantUserId: approvalRequests.applicantUserId,
          createdAt: approvalRequests.createdAt,
        })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.status, "pending"),
            lt(approvalRequests.createdAt, cutoff),
            ...(cursor ? [gt(approvalRequests.id, cursor)] : []),
          ),
        )
        .orderBy(asc(approvalRequests.id))
        .limit(BATCH_SIZE);

      if (stale.length === 0) break;

      for (const r of stale) {
        cursor = r.id;
        try {
          await db.transaction(async (tx) => {
            // Anti-race: only update if still pending. If somebody approved/
            // rejected/withdrew between the SELECT and the UPDATE, skip silently.
            const updated = await tx
              .update(approvalRequests)
              .set({
                status: "withdrawn",
                withdrawnAt: new Date(),
                decisionNotes: "Auto-expirada por inactividad mayor a 60 días",
                updatedAt: new Date(),
              })
              .where(and(eq(approvalRequests.id, r.id), eq(approvalRequests.status, "pending")))
              .returning({ id: approvalRequests.id });
            if (updated.length === 0) return;

            await tx.insert(auditLog).values({
              actorUserId: systemActor?.id ?? null,
              action: "approval_request_withdrawn_by_system",
              approvalRequestId: r.id,
              payload: {
                reason: "auto_expired",
                cron_run_id: run.id,
                days_pending: Math.floor((Date.now() - r.createdAt.getTime()) / DAY_MS),
              },
            });

            // Route through the canonical write path: a stable dedupe key makes a
            // re-run idempotent (ON CONFLICT DO NOTHING) and an insert failure is
            // dead-lettered (recoverable) rather than aborting the withdrawal tx.
            // Passed the `tx` so a committed withdrawal and its notification stay
            // atomic; the service's dead-letter write uses the shared pool, so a
            // notify failure never poisons this transaction.
            await createNotification(
              {
                userId: r.applicantUserId,
                notificationType: "approval_request_auto_expired",
                title: "Tu solicitud fue auto-expirada",
                body: "Tu solicitud pendiente fue cerrada automáticamente por inactividad mayor a 60 días. Podés volver a iniciarla cuando quieras.",
                severity: "info",
                ctaLabel: "Ver solicitudes",
                ctaUrl: "/cuenta/solicitudes",
                dedupeKey: `approval-auto-expired:${r.id}`,
              },
              tx,
            );
          });
          itemsProcessed += 1;
        } catch (err) {
          errors.push({ id: r.id, reason: err instanceof Error ? err.message : "unknown" });
        }
      }

      if (stale.length < BATCH_SIZE) break; // drained
    }
  } catch (err) {
    status = "failed";
    errors.push({ id: "global", reason: err instanceof Error ? err.message : "unknown" });
  }

  // Don't report success on failure: per-candidate errors (a single approval's
  // tx threw) previously left status:"ok" because only the outer catch flipped
  // it. Any error at all means the run was not fully healthy.
  if (errors.length > 0 && status === "ok") {
    status = "failed";
    console.error(
      `[cron/auto-expire-approvals] ${errors.length} candidate error(s) — run marked failed`,
    );
  }

  await db
    .update(cronRuns)
    .set({
      status,
      finishedAt: new Date(),
      itemsProcessed,
      details: errors.length > 0 ? { errors } : {},
    })
    .where(eq(cronRuns.id, run.id));

  // HTTP 500 on failure (review 23 item 4): the route wrote status='failed' to
  // the DB but always returned 200, so Vercel treated the run as successful.
  if (status === "failed") {
    await sendCronAlert({
      job: CRON_NAME,
      severity: "critical",
      error: `${errors.length} error(s) auto-expiring approvals`,
      details: { errors: errors.slice(0, 20) },
    });
  }

  return NextResponse.json(
    { status, itemsProcessed, runId: run.id },
    { status: status === "ok" ? 200 : 500 },
  );
}
