"use server";

// authority-units.ts — the unit editor's guard + revalidation shims. Writers
// (src/modules/organizations/application/authority-units/) check the actor in
// their transaction and audit every change; never exported here (a "use server"
// export taking a caller-supplied actor id would impersonate anyone). Shared
// acts admit the administration principal (jurisdiction-admin Phase 6); the
// rest and ./authority-unit-reversals.ts stay platform-only. Inventory pinned
// by __tests__/jurisdiction-admin-portal.test.tsx.

import { revalidatePath } from "next/cache";

import { db } from "@/db";
import {
  requireAdminOrRedirect,
  requireAdministrationPrincipalOrRedirect,
} from "@/lib/infra/auth-guards";
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
  revalidatePath("/gob/administracion/unidades");
  revalidatePath(`/gob/administracion/unidades/${unitId}`);
}

export async function moveLocalityToUnitAction(input: {
  localityId: string;
  toUnitId: string;
  reason: string;
}) {
  const { user } = await requireAdministrationPrincipalOrRedirect();
  const result = await moveLocalityToUnit(db, user.id, input);
  if ("ok" in result && !result.noOp) revalidateUnit(input.toUnitId);
  return result;
}

export async function removeLocalityFromUnitAction(input: {
  localityId: string;
  unitId: string;
  reason: string;
}) {
  const { user } = await requireAdministrationPrincipalOrRedirect();
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
  const { user } = await requireAdministrationPrincipalOrRedirect();
  const result = await createAuthorityUnit(db, user.id, input);
  if ("ok" in result) revalidateUnit(result.unitId);
  return result;
}

export async function renameAuthorityUnitAction(input: { unitId: string; name: string }) {
  const { user } = await requireAdministrationPrincipalOrRedirect();
  const result = await renameAuthorityUnit(db, user.id, input);
  if ("ok" in result) revalidateUnit(input.unitId);
  return result;
}

export async function confirmAuthorityUnitAction(input: { unitId: string }) {
  const { user } = await requireAdministrationPrincipalOrRedirect();
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
  const { user } = await requireAdministrationPrincipalOrRedirect();
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
