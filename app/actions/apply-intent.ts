"use server";

// apply-intent.ts — thin shim (strangler migration 39/61, 2026-06-30).
//
// Business logic moved to:
//   src/modules/adoption/application/apply-intent/
//
// This file re-exports all originally-exported symbols (3 actions + 1 type)
// with identical signatures so all callers keep working unchanged.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { dismissApplyIntentAction as _dismissApplyIntentAction } from "@/src/modules/adoption/application/apply-intent/dismiss-apply-intent";
import {
  startApplyIntentAction as _startApplyIntentAction,
  startApplyIntentFormAction as _startApplyIntentFormAction,
} from "@/src/modules/adoption/application/apply-intent/start-apply-intent";
import type { StartApplyIntentResult } from "@/src/modules/adoption/application/apply-intent/types";

export type { StartApplyIntentResult };

// @no-auth-required: auth enforced inside the delegated use-case (auth.getUser() runs after the
// pet-listability check that must precede it — lifting would reorder)
export async function startApplyIntentAction(petToken: string): Promise<StartApplyIntentResult> {
  return _startApplyIntentAction(petToken);
}

// @no-auth-required: auth enforced inside the delegated use-case (delegates to
// startApplyIntentAction where auth.getUser() runs after the pet-listability check that must
// precede it — lifting would reorder)
export async function startApplyIntentFormAction(
  _prevState: StartApplyIntentResult | null,
  formData: FormData,
): Promise<StartApplyIntentResult> {
  return _startApplyIntentFormAction(_prevState, formData);
}

// @no-auth-required: cookie clear — no auth needed to dismiss a banner; the action only deletes
// two short-lived cookies from the caller's own browser session
export async function dismissApplyIntentAction(): Promise<void> {
  return _dismissApplyIntentAction();
}
