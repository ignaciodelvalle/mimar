"use server";

// slot-materialization.ts — thin shim (strangler 28/61).
//
// Business logic moved to:
//   src/modules/service-offerings/application/slot-materialization/
//
// This file re-exports all writer functions (used by the cron route and
// integration tests) and provides thin Action wrappers (used by UI components)
// that enforce the auth guard before delegating.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { blockSlot as _blockSlot } from "@/src/modules/service-offerings/application/slot-materialization/block-slot";
import { materializeOfferingNow as _materializeOfferingNow } from "@/src/modules/service-offerings/application/slot-materialization/materialize-offering-now";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type {
  MaterializeNowResult,
  BlockSlotResult,
} from "@/src/modules/service-offerings/application/slot-materialization/types";

// materializeAllActiveSlots and materializeSlotsForOffering are intentionally
// NOT re-exported here (review 07). A "use server" export is client-
// addressable and bypasses the /api/cron/materialize-slots CRON_SECRET gate,
// so exposing materializeAllActiveSlots would let any client trigger unbounded
// global slot materialization (resource-exhaustion surface). Both live on in
// src/modules/service-offerings/application/slot-materialization/; the cron
// route, the standalone script, and integration tests import
// materializeAllActiveSlots from the module directly.

// ---------------------------------------------------------------------------
// Action wrappers — auth guard + delegate to use-cases
// ---------------------------------------------------------------------------

// @no-auth-required: auth enforced inside the delegated use-case (requireCapability runs after
// offering validation that supplies organizationId — lifting would reorder checks)
export async function materializeOfferingNowAction(
  offeringToken: string,
): Promise<{ rulesProcessed: number; slotsInserted: number } | { error: string }> {
  return _materializeOfferingNow(offeringToken);
}

export async function blockSlotAction(input: {
  orgToken: string;
  slotId: string;
}): Promise<{ ok: true } | { error: string }> {
  const { organization, membership } = await requireOrgAccessByToken(input.orgToken);
  const granted = await getGrantedCapabilities(membership);
  if (!granted.has("appointment.manage")) {
    return { error: "No tenés permiso para esta acción." };
  }

  return _blockSlot({ ...input, organizationId: organization.id });
}
