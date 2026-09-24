"use server";

// profile-self-service.ts — thin shim (strangler migration 9/61).
//
// Business logic moved to:
//   src/modules/pets/application/profile/
//
// This file provides thin Action wrappers (used by UI components) that add
// the auth guard + revalidatePath. The bare ForUser writers are NOT exported
// here (authz triage 2026-07-04): every export of a "use server" file is an
// independently-addressable server action, so a bare writer taking a
// caller-supplied userId would let any client resign/deactivate/toggle
// privacy prefs for any user. Callers import the writers from
// src/modules/pets/application/profile/ directly.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { revalidatePath } from "next/cache";

import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { govtSelfDeactivateForUser as _govtSelfDeactivate } from "@/src/modules/pets/application/profile/govt-self-deactivate";
import { selfDeactivatePersonalAccountForUser as _selfDeactivatePersonal } from "@/src/modules/pets/application/profile/self-deactivate-personal-account";
import { selfReactivatePersonalAccountForUser as _selfReactivatePersonal } from "@/src/modules/pets/application/profile/self-reactivate-personal-account";
import { setDailyDigestOptOutForUser as _setDailyDigestOptOut } from "@/src/modules/pets/application/profile/set-daily-digest-opt-out";
import { vetSelfResignForUser as _vetSelfResign } from "@/src/modules/pets/application/profile/vet-self-resign";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type {
  GovtSelfDeactivateResult,
  PersonalSelfDeactivateResult,
  PersonalSelfReactivateResult,
  VetSelfResignResult,
} from "@/src/modules/pets/application/profile/types";

// ---------------------------------------------------------------------------
// Action wrappers — thin controllers for UI components
// ---------------------------------------------------------------------------

export async function vetSelfResignAction(input?: {
  reason?: string;
}) {
  const { user } = await requireUserOrRedirect();
  const result = await _vetSelfResign(user.id, input);
  if ("ok" in result) {
    revalidatePath("/cuenta");
  }
  return result;
}

export async function govtSelfDeactivateAction(input?: {
  reason?: string;
}) {
  const { user } = await requireUserOrRedirect();
  const result = await _govtSelfDeactivate(user.id, input);
  if ("ok" in result && !result.noOp) {
    revalidatePath("/cuenta");
  }
  return result;
}

export async function selfDeactivatePersonalAccountAction(reason: string) {
  const { user } = await requireUserOrRedirect();
  return _selfDeactivatePersonal(user.id, reason);
}

/**
 * The way back from selfDeactivatePersonalAccountAction.
 *
 * GATED ON requireUserOrRedirect AND NOT ON requireLiveUser, and unlike its
 * siblings that is not incidental — it is the whole reason this action can
 * work. `requireLiveUser` refuses a DEACTIVATED caller by design, and this
 * action's ONLY caller is a deactivated one; gating it there would make the
 * reactivation button refuse itself and rebuild the dead end it exists to
 * remove. `requireUserOrRedirect` tolerates exactly this refusal, for exactly
 * this reason (lib/infra/auth-guards.ts: "Reads stay open so the user can see
 * why; writes stop" — plus the one write that undoes the state).
 *
 * That tolerance is safe here because the write's blast radius is a single
 * column on the CALLER'S OWN row, resolved from the session and never from an
 * argument: this action takes no parameters at all. The use-case re-checks
 * personal-account-ness and non-erasure in the database, so the exemption
 * cannot be widened by a UI mistake.
 */
export async function selfReactivatePersonalAccountAction() {
  const { user } = await requireUserOrRedirect();
  const result = await _selfReactivatePersonal(user.id);
  if ("ok" in result && !result.noOp) {
    revalidatePath("/cuenta");
  }
  return result;
}

/**
 * T2-N1 — /cuenta toggle for the daily operator digest email. Writes exactly
 * one boolean column on the CALLER'S OWN row (resolved from the session,
 * never from an argument beyond the desired state) — no separate module
 * needed for a single-column preference, unlike the account-state writers
 * above whose invariants (last-admin guard, account-type checks) actually
 * live in src/modules/pets/application/profile/.
 */
export async function setDailyDigestOptOutAction(
  optOut: boolean,
): Promise<{ ok: true; optOut: boolean }> {
  const { user } = await requireUserOrRedirect();
  const result = await _setDailyDigestOptOut(user.id, optOut);
  revalidatePath("/cuenta");
  return result;
}
