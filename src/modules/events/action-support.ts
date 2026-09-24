// Shared plumbing for the events action modules.
//
// DELIBERATELY WITHOUT A "use server" DIRECTIVE. Next turns every export of a
// "use server" module into a client-addressable endpoint, so a type and two
// internal helpers must not live in one. Keeping them here is what lets
// actions.ts and actions-medical.ts share them without either file exporting a
// callable it never meant to.
//
// Split out of actions.ts on 2026-08-21 with the medical actions; see
// actions-medical.ts for why that file exists and what had to change with it.

import { db } from "@/db";
import type { SupabaseServerClient } from "@/lib/infra/pet-access";

export type EventFormState = {
  error: string | null;
  ok?: boolean;
  /**
   * On success, the URL the calling form must navigate to via a FULL
   * document navigation (lib/ui/use-action-redirect.ts). Actions in this
   * module never call next/navigation's redirect(): its post-action
   * transition is silently dropped by the client router in production
   * (engram #621/#622, verify-report #650 WARNING-1 — see
   * lib/ui/full-page-action-nav.ts for the mechanism).
   */
  redirectTo?: string;
  /**
   * P4 item 4 (2026-07-08): SUSPICIOUS same-day-duplicate warn — set only by
   * createVaccinationAction / createDewormingAction when the same event type
   * was already recorded for this pet earlier the same (Argentina-local)
   * calendar day. Non-blocking: the form re-renders the message with a
   * confirm affordance and resubmits with a `sameDayOverride=1` hidden field,
   * mirroring the P2 soft-dedupe duplicatePrompt/duplicateOverride pattern in
   * src/modules/pets/actions.ts + MinimalNewPetForm.tsx (commit dd1c3f97).
   */
  sameDayPrompt?: { message: string };
  /**
   * degraded-states (2026-08-06): set ONLY client-side by
   * lib/ui/use-retryable-action.ts when the action DISPATCH rejected
   * (503/abort) — the actions in this module never set it. Marks a
   * recoverable transport failure: the form stays mounted, typed input
   * survives, and MutationErrorCard offers a same-idempotency-key retry.
   */
  transientFailure?: boolean;
};

export async function cleanupAttachment(supabase: SupabaseServerClient, path: string | null) {
  if (!path) return;
  try {
    await supabase.storage.from("event-attachments").remove([path]);
  } catch {
    // Swallow — orphaned file at worst.
  }
}

export function makeTransaction(): <T>(cb: (tx: unknown) => Promise<T>) => Promise<T> {
  return <T>(cb: (tx: unknown) => Promise<T>) =>
    db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>;
}
