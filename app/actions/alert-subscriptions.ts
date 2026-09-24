"use server";

// alert-subscriptions.ts — thin shim (strangler migration 31/61, 2026-06-30).
//
// Business logic moved to:
//   src/modules/alerts/application/subscriptions/
//
// This file provides thin action wrappers (used by /gob/suscripciones and
// its /admin/suscripciones thin wrapper — moved out of /admin/programa and
// /gob/programa on 2026-07-21) that add the auth guard + revalidatePath, plus
// the input type. The bare ForUser writers are NOT exported here (authz triage
// 2026-07-04): every export of a "use server" file is an independently-
// addressable server action, so a bare writer taking a caller-supplied
// userId would let any client manage another user's subscriptions. Callers
// import the writers from src/modules/alerts/application/subscriptions/.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { revalidatePath } from "next/cache";

import type { AlertDirection, AlertMetricKey } from "@/db";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { createAlertSubscriptionForUser as _createAlertSubscriptionForUser } from "@/src/modules/alerts/application/subscriptions/create-alert-subscription";
import { deleteAlertSubscriptionForUser as _deleteAlertSubscriptionForUser } from "@/src/modules/alerts/application/subscriptions/delete-alert-subscription";
import { toggleAlertSubscriptionForUser as _toggleAlertSubscriptionForUser } from "@/src/modules/alerts/application/subscriptions/toggle-alert-subscription";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type { CreateAlertSubscriptionInput } from "@/src/modules/alerts/application/subscriptions/types";

// ---------------------------------------------------------------------------
// Auth — the full-invariant admin guard, NOT a role-only profiles lookup.
// ---------------------------------------------------------------------------
//
// Previously a private requireAdminUser() checked only role==='admin' via a
// getUser() + profiles lookup, so a DEACTIVATED admin, an ERASED (soft-deleted,
// session still valid — Ley 25.326 art. 16) admin, or a personal-type account
// whose role column read 'admin' still passed. requireAdminOrRedirect enforces
// the full invariant (role==='admin' + accountType==='institutional' +
// deactivatedAt IS NULL + deletedAt IS NULL), consistent with alert-firings.ts.

// ---------------------------------------------------------------------------
// Form-action wrappers — thin controllers (auth + revalidatePath only)
// ---------------------------------------------------------------------------

export async function createAlertSubscriptionAction(
  formData: FormData,
): Promise<{ ok: true; id: string } | { error: string }> {
  const { user } = await requireAdminOrRedirect();

  const input = {
    metricKey: formData.get("metricKey") as AlertMetricKey,
    direction: formData.get("direction") as AlertDirection,
    threshold: Number(formData.get("threshold")),
    jurisdictionProvince: (formData.get("jurisdictionProvince") as string) || null,
    jurisdictionLocality: (formData.get("jurisdictionLocality") as string) || null,
    label: (formData.get("label") as string) || null,
  };

  const result = await _createAlertSubscriptionForUser(user.id, input);
  if ("error" in result) return result;

  revalidatePath("/gob/suscripciones");
  revalidatePath("/admin/suscripciones");
  return { ok: true, id: result.id };
}

export async function deleteAlertSubscriptionAction(formData: FormData): Promise<void> {
  const { user } = await requireAdminOrRedirect();

  const id = formData.get("id") as string;
  if (!id) return;

  await _deleteAlertSubscriptionForUser(user.id, id);
  revalidatePath("/gob/suscripciones");
  revalidatePath("/admin/suscripciones");
}

export async function toggleAlertSubscriptionAction(formData: FormData): Promise<void> {
  const { user } = await requireAdminOrRedirect();

  const id = formData.get("id") as string;
  if (!id) return;
  const isActive = formData.get("isActive") === "true";

  await _toggleAlertSubscriptionForUser(user.id, id, isActive);
  revalidatePath("/gob/suscripciones");
  revalidatePath("/admin/suscripciones");
}
