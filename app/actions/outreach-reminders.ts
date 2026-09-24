"use server";

// Server actions for the outreach "Enviar recordatorio(s)" write path
// (sweep-fixes-2 2026-07-23) — the per-row "Recordar" button and the bulk
// "Enviar recordatorios (N)" button on /gob/operativos?vista=alcance's
// overdue-antirrábica pipeline.
//
// Both actions funnel through the SAME re-derivation: a fresh
// requireAdminOrGovtOrRedirect() session (never trusts client-supplied role
// or jurisdiction) and the SAME capability gate AlcanceScreen itself uses.
// The heavy lifting (scope re-validation, throttle, notification write,
// audit) lives in lib/infra/outreach-reminders.ts; this file is a thin,
// auth-gated wrapper — mirrors app/actions/bulk-actions.ts's shim posture.
//
// CRITICAL: every runtime export in a "use server" file must be an async
// function — non-function exports use `export type` (erased at runtime).

import { revalidatePath } from "next/cache";

import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import {
  type OutreachReminderBulkResult,
  sendOverdueRabiesReminders,
} from "@/lib/infra/outreach-reminders";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";

export type SendOutreachRabiesRemindersResult =
  | { ok: true; result: OutreachReminderBulkResult }
  | { ok: false; error: string };

type OutreachSession = {
  userId: string;
  role: "admin" | "govt";
  jurisdictions: Parameters<typeof buildProjectionContext>[1];
};

/**
 * Shared body, given an ALREADY-authenticated session. Each exported action
 * below calls requireAdminOrGovtOrRedirect() itself (rather than through this
 * helper) so the auth-coverage linter (lint:authz, scripts/check-authz-
 * guards.ts) can see the guard call directly in the exported function's own
 * body — it does not trace into private helpers.
 */
async function performSendReminders(
  session: OutreachSession,
  petIds: string[],
): Promise<SendOutreachRabiesRemindersResult> {
  // Same capability gate as AlcanceScreen (app/gob/outreach/AlcanceScreen.tsx)
  // — a govt operator with zero jurisdiction assignments has no outreach
  // access at all, list or action.
  const hasOutreachAccess =
    session.role === "admin" || (session.role === "govt" && session.jurisdictions.length > 0);
  if (!hasOutreachAccess) {
    return {
      ok: false,
      error: "Tu rol no tiene acceso a los pipelines de alcance comunitario.",
    };
  }

  if (petIds.length === 0) {
    return { ok: false, error: "No hay mascotas seleccionadas." };
  }

  // Same 12-month window fetchOverdueRabiesVaccine uses on the list itself —
  // the re-derivation must match what the operator actually saw, or a pet
  // just outside the window would spuriously report as "out of scope".
  const ctx = buildProjectionContext(
    { role: session.role },
    session.jurisdictions,
    windows.trailing12m(),
  );

  const result = await sendOverdueRabiesReminders(session.userId, ctx, petIds);

  // The KPI/count on the pipeline card doesn't change (reminders don't alter
  // overdue status), but revalidate anyway so a future badge/read reflects
  // the just-written audit row without a hard refresh.
  revalidatePath("/gob/operativos");

  return { ok: true, result };
}

/** Per-row "Recordar" — single pet. */
export async function sendOutreachRabiesReminderAction(
  petId: string,
): Promise<SendOutreachRabiesRemindersResult> {
  const { user, profile, jurisdictions } = await requireAdminOrGovtOrRedirect();
  return performSendReminders({ userId: user.id, role: profile.role, jurisdictions }, [petId]);
}

/** Bulk "Enviar recordatorios (N)" — the visible list. */
export async function sendOutreachRabiesRemindersBulkAction(
  petIds: string[],
): Promise<SendOutreachRabiesRemindersResult> {
  const { user, profile, jurisdictions } = await requireAdminOrGovtOrRedirect();
  return performSendReminders({ userId: user.id, role: profile.role, jurisdictions }, petIds);
}
