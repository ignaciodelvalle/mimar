"use server";

// jurisdiction-admin.ts — thin shims for /admin/designaciones (SDD
// jurisdiction-admin, Phase 3): appoint and revoke a jurisdiction
// administrator.
//
// Business logic lives in
//   src/modules/organizations/application/admin-authority/{appoint,revoke}.ts
// which re-check the platform-admin authority INSIDE their transaction (and
// the database re-checks it again: 0268's validator, 0269's audit guard).
// These wrappers add the route guard and the revalidation; the writers are
// NOT exported from here (every export of a "use server" file is an
// independently addressable action, so a writer taking a caller-supplied
// actor id would let a client act as any admin).

import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { appointJurisdictionAdmin } from "@/src/modules/organizations/application/admin-authority/appoint";
import { revokeJurisdictionAdmin } from "@/src/modules/organizations/application/admin-authority/revoke";

export type {
  AppointError,
  AppointResult,
} from "@/src/modules/organizations/application/admin-authority/appoint";
export type {
  RevokeError,
  RevokeResult,
} from "@/src/modules/organizations/application/admin-authority/revoke";

export async function appointJurisdictionAdminAction(input: {
  userId: string;
  provinceCode: string;
  reason: string;
}) {
  const { user } = await requireAdminOrRedirect();
  const result = await appointJurisdictionAdmin(db, user.id, input);
  if ("ok" in result) {
    revalidatePath("/admin/designaciones");
    revalidatePath(`/admin/govts/${input.userId}`);
  }
  return result;
}

export async function revokeJurisdictionAdminAction(input: {
  appointmentId: string;
  reason: string;
}) {
  const { user } = await requireAdminOrRedirect();
  const result = await revokeJurisdictionAdmin(db, user.id, input);
  if ("ok" in result) revalidatePath("/admin/designaciones");
  return result;
}
