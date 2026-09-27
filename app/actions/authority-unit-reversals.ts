"use server";

// authority-unit-reversals.ts — the platform admin's reversals on an authority
// unit (jurisdiction-admin Phase 6.4), for /admin/localidades/[unitId].
//
// PLATFORM-ONLY, BOTH GUARDS: requireAdminOrRedirect here, requirePlatformAdmin
// inside each writer's transaction. Kept apart from ./authority-units.ts, whose
// shared acts a jurisdiction admin may call, so the file a platform-only act
// lives in says what it is. Inventory pinned by
// __tests__/jurisdiction-admin-portal.test.tsx.
//
// The writers are NOT exported here (a "use server" export taking a
// caller-supplied actor id would impersonate anyone).

import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { unconfirmGrantUnit } from "@/src/modules/organizations/application/authority-units/grant-unit";
import { unconfirmAuthorityUnit } from "@/src/modules/organizations/application/authority-units/manage-units";

function revalidateUnit(unitId: string): void {
  for (const base of ["/admin/localidades", "/gob/administracion/unidades"]) {
    revalidatePath(base);
    revalidatePath(`${base}/${unitId}`);
  }
}

/**
 * A confirmed unit back to draft. A draft governs nothing (0260), so every
 * grant pinned to the unit stops covering its localities until it is
 * confirmed again.
 */
export async function unconfirmAuthorityUnitAction(input: { unitId: string; reason: string }) {
  const { user } = await requireAdminOrRedirect();
  const result = await unconfirmAuthorityUnit(db, user.id, input);
  if ("ok" in result) revalidateUnit(input.unitId);
  return result;
}

/** Take a govt user's grants off this unit: they cover by name again. */
export async function unconfirmGrantUnitAction(input: {
  userId: string;
  unitId: string;
  reason: string;
}) {
  const { user } = await requireAdminOrRedirect();
  const result = await unconfirmGrantUnit(db, user.id, input);
  if ("ok" in result) revalidateUnit(input.unitId);
  return result;
}
