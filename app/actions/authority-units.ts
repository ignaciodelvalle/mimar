"use server";

// authority-units.ts — thin shims for the /admin/localidades unit editor
// (localidades-por-id C4).
//
// Business logic lives in
//   src/modules/organizations/application/authority-units/manage-units.ts
// which re-checks the platform-admin capability, and writes every change
// together with its audit_log row. These wrappers add the route guard and the
// revalidation; the writers themselves are NOT exported from here (every
// export of a "use server" file is an independently addressable action, so a
// writer taking a caller-supplied actor id would let a client act as any
// admin).

import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import {
  notifyNewlyCoveringAuthorities,
  retargetPendingOutbox,
} from "@/lib/place/resolution-rerouting";
import { type QueueSubjectTable, resolvePlaceFromQueue } from "@/lib/place/unresolved-queue";
import { confirmGrantUnit } from "@/src/modules/organizations/application/authority-units/grant-unit";
import {
  confirmAuthorityUnit,
  createAuthorityUnit,
  moveLocalityToUnit,
  removeLocalityFromUnit,
  renameAuthorityUnit,
} from "@/src/modules/organizations/application/authority-units/manage-units";
import { closeRemovedLocalityMembership } from "@/src/modules/organizations/application/authority-units/removed-locality-memberships";

export type { UnitEditError } from "@/src/modules/organizations/application/authority-units/manage-units";

function revalidateUnit(unitId: string): void {
  revalidatePath("/admin/localidades");
  revalidatePath(`/admin/localidades/${unitId}`);
}

export async function moveLocalityToUnitAction(input: {
  localityId: string;
  toUnitId: string;
  reason: string;
}) {
  const { user } = await requireAdminOrRedirect();
  const result = await moveLocalityToUnit(db, user.id, input);
  if ("ok" in result && !result.noOp) revalidateUnit(input.toUnitId);
  return result;
}

export async function removeLocalityFromUnitAction(input: {
  localityId: string;
  unitId: string;
  reason: string;
}) {
  const { user } = await requireAdminOrRedirect();
  const result = await removeLocalityFromUnit(db, user.id, input);
  if ("ok" in result) revalidateUnit(input.unitId);
  return result;
}

/**
 * E3: close the membership of a locality the INDEC import removed. Never
 * automatic: an admin's act, with its reason, audited.
 */
export async function closeRemovedLocalityMembershipAction(input: {
  localityId: string;
  unitId: string;
  reason: string;
}) {
  const { user } = await requireAdminOrRedirect();
  const result = await closeRemovedLocalityMembership(db, user.id, input);
  if ("ok" in result) revalidateUnit(input.unitId);
  return result;
}

export async function createAuthorityUnitAction(input: {
  kind: string;
  provinceCode: string;
  name: string;
}) {
  const { user } = await requireAdminOrRedirect();
  const result = await createAuthorityUnit(db, user.id, input);
  if ("ok" in result) revalidateUnit(result.unitId);
  return result;
}

export async function renameAuthorityUnitAction(input: { unitId: string; name: string }) {
  const { user } = await requireAdminOrRedirect();
  const result = await renameAuthorityUnit(db, user.id, input);
  if ("ok" in result) revalidateUnit(input.unitId);
  return result;
}

export async function confirmAuthorityUnitAction(input: { unitId: string }) {
  const { user } = await requireAdminOrRedirect();
  const result = await confirmAuthorityUnit(db, user.id, input);
  if ("ok" in result) revalidateUnit(input.unitId);
  return result;
}

/**
 * Move a govt user's grants onto this unit (localidades-por-id D2). The use
 * case refuses unless `acceptAdded` names exactly the localities the unit
 * adds to them.
 */
export async function confirmGrantUnitAction(input: {
  userId: string;
  unitId: string;
  reason: string;
  acceptAdded: string[];
}) {
  const { user } = await requireAdminOrRedirect();
  const result = await confirmGrantUnit(db, user.id, input);
  if ("ok" in result) revalidateUnit(input.unitId);
  return result;
}

/**
 * Resolve one row of the unresolved-place queue to a catalogue locality of
 * its own province (localidades-por-id D9). The use case re-checks the
 * platform-admin capability and writes the place_resolutions row with the
 * row's cache columns in one transaction.
 */
export async function resolvePlaceFromQueueAction(input: {
  subjectTable: QueueSubjectTable;
  subjectId: string;
  localityId: string;
  reason: string;
}) {
  const { user } = await requireAdminOrRedirect();
  const result = await resolvePlaceFromQueue(db, user.id, input);
  if ("ok" in result) {
    // After the commit, best effort: pending outbox rows snapshotted while the
    // place was unresolved take the resolved row (W7), and an OPEN case whose
    // place is now known reaches the unit that governs it (D9). Neither ever
    // un-notifies anyone.
    try {
      await retargetPendingOutbox(db, input);
      await notifyNewlyCoveringAuthorities(db, input);
    } catch (err) {
      console.error("[place-queue] re-routing after resolution failed", err);
    }
    revalidatePath("/admin/localidades/pendientes");
  }
  return result;
}
