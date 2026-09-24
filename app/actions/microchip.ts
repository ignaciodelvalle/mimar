"use server";

// microchip.ts — thin shim (strangler migration 13/61).
//
// Business logic moved to:
//   src/modules/pets/application/microchip/
//
// This file provides replaceMicrochipAction (outer auth-guarded server action
// used by UI components). The inner writer lives in the application module and
// is deliberately NOT exported from this "use server" file — exporting it
// would make it an independently-addressable server action that accepts an
// attacker-supplied userId (authz triage 2026-07-04). Route actions and tests
// import it from src/modules/pets/application/microchip/replace-microchip.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { requireLiveUser } from "@/lib/infra/live-user";
import { replaceMicrochipForUser as _replaceMicrochipForUser } from "@/src/modules/pets/application/microchip/replace-microchip";
import type {
  ReplaceMicrochipInput,
  ReplaceMicrochipResult,
} from "@/src/modules/pets/application/microchip/types";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type {
  ReplaceMicrochipInput,
  ReplaceMicrochipResult,
} from "@/src/modules/pets/application/microchip/types";

// ---------------------------------------------------------------------------
// Outer server action — gates via Supabase session, then delegates to writer.
// ---------------------------------------------------------------------------

export async function replaceMicrochipAction(
  rawInput: ReplaceMicrochipInput,
): Promise<ReplaceMicrochipResult> {
  // The writer gates on an active ownership/custody row keyed by userId and
  // never consults profiles.deleted_at, so the erasure lockout (Ley 25.326
  // art. 16, Wave E2) has to happen at THIS boundary — it used to be six
  // hand-written lines here and is now one call, which also stops the write
  // during a maintenance window and for a deactivated account.
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };
  const user = live.user;

  return _replaceMicrochipForUser(user.id, rawInput);
}
