"use server";

// upgrade.ts — thin shim (strangler migration 7/61).
//
// Business logic moved to:
//   src/modules/organizations/application/upgrade/
//
// This file provides thin Action wrappers (used by UI components) that add
// the auth guard + revalidatePath/redirect. The bare ForUser writers are NOT
// exported here (authz triage 2026-07-04): every export of a "use server"
// file is an independently-addressable server action, so a bare writer
// taking a caller-supplied userId would let any client create orgs or
// request vet upgrades as any user. Callers import the writers from
// src/modules/organizations/application/upgrade/ directly.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db, organizations } from "@/db";
import { canonicalProvinceNameForStorage } from "@/lib/domain/jurisdiction-canonical";
import { requireLiveUser } from "@/lib/infra/live-user";
import { createOrganizationForUser as _createOrg } from "@/src/modules/organizations/application/upgrade/create-organization";
import { requestVetUpgradeForUser as _requestVetUpgrade } from "@/src/modules/organizations/application/upgrade/request-vet-upgrade";
import type {
  CreateOrganizationInput,
  UpgradeFormState,
} from "@/src/modules/organizations/application/upgrade/types";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type {
  VetUpgradeInput,
  CreateOrganizationInput,
  UpgradeFormState,
} from "@/src/modules/organizations/application/upgrade/types";

// ---------------------------------------------------------------------------
// Action wrappers — thin controllers for UI components
// ---------------------------------------------------------------------------

export async function requestVetUpgradeAction(
  _prev: UpgradeFormState,
  formData: FormData,
): Promise<UpgradeFormState> {
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };
  const user = live.user;

  const anosRaw = String(formData.get("anosExperiencia") ?? "").trim();
  const anos = anosRaw ? Number.parseInt(anosRaw, 10) : null;

  return _requestVetUpgrade(user.id, {
    matriculaNumber: String(formData.get("matriculaNumber") ?? "").trim(),
    matriculaJurisdiccion: String(formData.get("matriculaJurisdiccion") ?? "").trim(),
    // LocationFields (l1) submits provinceCode (ISO) + localityName; keep the
    // legacy free-text names as fallback. canonicalProvinceNameForStorage
    // normalizes either shape to the canonical province display name.
    operationalProvince:
      canonicalProvinceNameForStorage(
        String(formData.get("provinceCode") ?? "").trim() ||
          String(formData.get("operationalProvince") ?? "").trim(),
      ) ?? "",
    operationalLocality:
      String(formData.get("localityName") ?? "").trim() ||
      String(formData.get("operationalLocality") ?? "").trim(),
    especialidad: String(formData.get("especialidad") ?? "").trim() || null,
    anosExperiencia: anos && Number.isFinite(anos) ? anos : null,
  });
}

export async function createOrganizationAction(
  _prev: UpgradeFormState,
  formData: FormData,
): Promise<UpgradeFormState> {
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };
  const user = live.user;

  const orgType = String(formData.get("orgType") ?? "").trim();
  const input: CreateOrganizationInput = {
    name: String(formData.get("name") ?? "").trim(),
    legalName: String(formData.get("legalName") ?? "").trim(),
    orgType: orgType as CreateOrganizationInput["orgType"],
    cuit: String(formData.get("cuit") ?? "").trim() || null,
    email: String(formData.get("email") ?? "").trim(),
    phone: String(formData.get("phone") ?? "").trim() || null,
    // LocationFields (l1) submits the ISO code as `provinceCode` + the display
    // name as `localityName`. Legacy free-text inputs submitted these under
    // `jurisdictionProvince` / `jurisdictionLocality`. canonicalProvinceNameForStorage
    // accepts any shape and returns the canonical display name (lib/jurisdiction-canonical.ts).
    jurisdictionProvince:
      canonicalProvinceNameForStorage(
        String(formData.get("provinceCode") ?? "").trim() ||
          String(formData.get("jurisdictionProvince") ?? "").trim(),
      ) ?? "",
    jurisdictionLocality:
      String(formData.get("localityName") ?? "").trim() ||
      String(formData.get("jurisdictionLocality") ?? "").trim(),
    personeriaJuridicaNumber: String(formData.get("personeriaJuridicaNumber") ?? "").trim() || null,
  };

  const result = await _createOrg(user.id, input);
  if (result.error) return result;

  revalidatePath("/cuenta/upgrade");
  return { error: null, ok: true, redirectTo: "/org" };
}

// Clinic-only wrapper used by /cuenta/crear-consultorio.
// Forces orgType='clinic' and redirects to the new org's panel instead of /org.
export async function createClinicAction(
  _prev: UpgradeFormState,
  formData: FormData,
): Promise<UpgradeFormState> {
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };
  const user = live.user;

  const input: CreateOrganizationInput = {
    name: String(formData.get("name") ?? "").trim(),
    legalName: String(formData.get("legalName") ?? "").trim(),
    orgType: "clinic",
    cuit: String(formData.get("cuit") ?? "").trim() || null,
    email: String(formData.get("email") ?? "").trim(),
    phone: String(formData.get("phone") ?? "").trim() || null,
    jurisdictionProvince:
      canonicalProvinceNameForStorage(
        String(formData.get("provinceCode") ?? "").trim() ||
          String(formData.get("jurisdictionProvince") ?? "").trim(),
      ) ?? "",
    jurisdictionLocality:
      String(formData.get("localityName") ?? "").trim() ||
      String(formData.get("jurisdictionLocality") ?? "").trim(),
    personeriaJuridicaNumber: String(formData.get("personeriaJuridicaNumber") ?? "").trim() || null,
  };

  const result = await _createOrg(user.id, input);
  if (result.error || !result.organizationId)
    return result.error ? result : { error: "No se pudo obtener el ID de la organización." };

  const [org] = await db
    .select({ publicToken: organizations.publicToken })
    .from(organizations)
    .where(eq(organizations.id, result.organizationId))
    .limit(1);

  revalidatePath("/cuenta/crear-consultorio");
  revalidatePath("/cuenta");
  return {
    error: null,
    ok: true,
    organizationId: result.organizationId,
    redirectTo: org ? `/org/${org.publicToken}` : "/org",
  };
}
