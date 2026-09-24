"use server";

// alert-firings.ts — thin shim (strangler migration 16/61).
//
// Business logic moved to:
//   src/modules/alerts/application/firings/
//
// This file re-exports all writers (used by the evaluate-alerts cron and tests)
// and provides thin action wrappers (used by AlertRowActions.tsx) that add the
// auth guard + revalidatePath.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { revalidatePath } from "next/cache";

import { requireLiveUser } from "@/lib/infra/live-user";
import { evaluateAndRecordFiringsForAllAdmins as _evaluateAndRecordFiringsForAllAdmins } from "@/src/modules/alerts/application/firings/record-firings";
import {
  acknowledgeFiring,
  contactAuthorityFiring,
  dismissFiring,
  openInvestigationFiring,
  registerFollowupFiring,
  resolveFiring,
} from "@/src/modules/alerts/application/firings/triage";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { FiringActionResult } from "@/src/modules/alerts/application/firings/types";
export type { RecordFiringsResult } from "@/src/modules/alerts/application/firings/types";

// ---------------------------------------------------------------------------
// Writer re-export — used by the cron route
// ---------------------------------------------------------------------------
//
// recordFiringsForUser is intentionally NOT re-exported here: it accepts a
// caller-supplied userId, so exporting it from a "use server" file would make
// it an independently-addressable action (authz triage 2026-07-04). Tests
// import it from src/modules/alerts/application/firings/record-firings.

// @no-auth-required: cron/internal writer — invoked by /api/cron/evaluate-alerts,
// which is gated by authorizeCronRequest (CRON_SECRET) before calling this
// (verified 2026-07-04). Takes no user-scoping argument.
export async function evaluateAndRecordFiringsForAllAdmins(
  ...args: Parameters<typeof _evaluateAndRecordFiringsForAllAdmins>
) {
  return _evaluateAndRecordFiringsForAllAdmins(...args);
}

// ---------------------------------------------------------------------------
// Auth helper (admin-only) — stays in the shim, never in use-cases
// ---------------------------------------------------------------------------

/**
 * The admin gate for the six triage actions below.
 *
 * IT USED TO BE A BARE getUser() PLUS A HAND-ROLLED PROFILE QUERY, and that is
 * why it changed (2026-08-25). The query was thorough about the ACCOUNT — role,
 * accountType, deactivatedAt, deletedAt — and blind to everything else the
 * platform decides about a caller:
 *
 *   - no maintenance kill-switch: a triage transition committed mid-window,
 *     because a layout gates a render and a Server Action POST runs its body
 *     before any layout re-renders;
 *   - NO 8-HOUR SHIFT (B9): every caller here is `role: "admin"`, which is an
 *     INSTITUTIONAL principal by definition, so these six were exactly the
 *     population the shift is for — and the one guard that could not apply it
 *     was the one they went through.
 *
 * `requireLiveUser` answers all five liveness questions in one place and in one
 * order, and hands back the already-resolved profile, so this guard costs one
 * request-memoized read instead of a second round-trip of its own.
 *
 * WHAT IS LEFT HERE IS WHAT LIVENESS DOES NOT ANSWER: role and account type.
 * The old `deactivatedAt`/`deletedAt` legs are gone rather than kept as belt and
 * braces — requireLiveUser refuses both before returning, and a second copy of a
 * check is a second thing to drift. The refusal STRING for a non-admin is
 * unchanged; the no-session one is now requireLiveUser's canonical
 * "Sesión expirada." (the local copy was missing its full stop).
 */
async function requireAdminUser(): Promise<{ userId: string } | { error: string }> {
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };

  const profile = live.profile;
  if (!profile || profile.role !== "admin" || profile.accountType !== "institutional") {
    return { error: "Acceso restringido a administradores" };
  }
  return { userId: live.user.id };
}

// ---------------------------------------------------------------------------
// Triage action wrappers — thin controllers (auth + revalidatePath only)
// ---------------------------------------------------------------------------

/** Reconocer — disparada → reconocida. */
export async function acknowledgeFiringAction(firingId: string) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth;
  const result = await acknowledgeFiring(auth.userId, firingId);
  if ("ok" in result) revalidatePath("/admin/alertas");
  return result;
}

/**
 * Abrir investigación — reconocida → en_investigacion.
 * ONLY for active_zoonosis (decision K-D2).
 */
export async function openInvestigationFiringAction(firingId: string) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth;
  const result = await openInvestigationFiring(firingId);
  if ("ok" in result) revalidatePath("/admin/alertas");
  return result;
}

/**
 * Registrar seguimiento — append a note without opening an expediente.
 * For non-disease-mapped metrics (decision K-D2).
 */
export async function registerFollowupFiringAction(firingId: string, note: string) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth;
  const result = await registerFollowupFiring(firingId, note);
  if ("ok" in result) revalidatePath("/admin/alertas");
  return result;
}

/**
 * Contactar autoridad — resolve jurisdiction govts, notify them,
 * transition to autoridad_contactada.
 */
export async function contactAuthorityFiringAction(firingId: string) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth;
  const result = await contactAuthorityFiring(firingId);
  if ("ok" in result) revalidatePath("/admin/alertas");
  return result;
}

/** Resolver — close the firing with notes → resuelta. */
export async function resolveFiringAction(firingId: string, notes: string) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth;
  const result = await resolveFiring(auth.userId, firingId, notes);
  if ("ok" in result) revalidatePath("/admin/alertas");
  return result;
}

/** Descartar — close the firing with notes → descartada. */
export async function dismissFiringAction(firingId: string, notes: string) {
  const auth = await requireAdminUser();
  if ("error" in auth) return auth;
  const result = await dismissFiring(auth.userId, firingId, notes);
  if ("ok" in result) revalidatePath("/admin/alertas");
  return result;
}
