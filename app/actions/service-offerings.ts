"use server";

// Service offering actions — thin Next.js "use server" controllers.
//
// Business logic lives in src/modules/service-offerings/application/.
// This file: parse input · AUTH guard · delegate to use-case · revalidate/redirect.
//
// Writer/wrapper split (authz triage 2026-07-04): the bare ForOrg /
// ForAuthority writers are NOT exported here — every export of a "use
// server" file is an independently-addressable server action, so a bare
// writer taking a caller-supplied actorUserId/orgId would let any client
// create or approve offerings as any org/authority. Callers import them
// from src/modules/service-offerings/application/ directly.
// updateOfferingCapacityWriter is NOT exported either (review 07): it takes an
// arbitrary offeringId with no auth guard, so a "use server" export would let
// any client resize any offering. The capacity-sync test imports it from
// src/modules/service-offerings/application/update-offering-capacity; the
// guarded updateOfferingCapacityAction below scopes it to the caller's org.

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db, serviceOfferings } from "@/db";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { requireCapabilityForOrgToken } from "@/src/modules/organizations/infrastructure/authz-resolver";

import { approveServiceOfferingForAuthority as approveServiceOfferingForAuthorityUC } from "@/src/modules/service-offerings/application/approve-service-offering";
import { createServiceOfferingForOrg as createServiceOfferingForOrgUC } from "@/src/modules/service-offerings/application/create-service-offering";
import {
  archiveServiceOfferingUseCase,
  pauseServiceOfferingUseCase,
  unpauseServiceOfferingUseCase,
} from "@/src/modules/service-offerings/application/lifecycle-offering";
import { rejectServiceOfferingForAuthority as rejectServiceOfferingForAuthorityUC } from "@/src/modules/service-offerings/application/reject-service-offering";
import { updateOfferingCapacityWriter as updateOfferingCapacityWriterUC } from "@/src/modules/service-offerings/application/update-offering-capacity";
import type {
  AuthorityScope,
  ServiceOfferingFormState,
  ServiceOfferingResult,
  UpdateCapacityResult,
} from "@/src/modules/service-offerings/domain/types";

// Build the authority scope threaded into the approve/reject use-cases from the
// institutional guard result. Admin is universal; a govt actor carries its
// active jurisdiction assignments so the use-case can bound the offering's org
// to that scope (fail-closed). A single builder keeps approve and reject in sync.
function authorityScopeFromSession(
  role: "admin" | "govt",
  jurisdictions: ReadonlyArray<{ province: string; locality: string }>,
): AuthorityScope {
  return role === "admin" ? { role: "admin" } : { role: "govt", jurisdictions };
}

// ============================================================================
// Type re-exports — keep public type surface stable for existing callers
// (type-only exports are erased at runtime; allowed in "use server" files)
// ============================================================================

export type { ServiceOfferingResult } from "@/src/modules/service-offerings/domain/types";
export type { UpdateCapacityResult } from "@/src/modules/service-offerings/domain/types";
export type { ServiceOfferingFormState } from "@/src/modules/service-offerings/domain/types";

// ============================================================================
// Form-shaped wrappers — gate auth + capability, delegate to use-cases
// ============================================================================

export async function createServiceOfferingAction(
  _prev: ServiceOfferingFormState,
  formData: FormData,
): Promise<ServiceOfferingFormState> {
  // SCOPED TO THE URL's ORGANIZATION, like every sibling in this file.
  //
  // This used to be a bare `requireCapability("service_offering.create")`, which
  // resolves the caller's SESSION-DEFAULT (most-recently-joined) membership and
  // ignores the organization whose page the form was submitted from. The
  // sibling actions below were migrated to requireCapabilityForOrgToken for
  // exactly this reason — the comment three functions down says so — and create
  // was left behind.
  //
  // Found by clicking through it (2026-08-09): a service published from the
  // Clínica Veterinaria Recoleta panel was written to Mascotas BA Centro, a
  // sanitary authority the same admin also belongs to, and the post-submit
  // redirect landed on that other organization's page. Not an authorization
  // hole — the capability was checked against the org it wrote to — but a
  // tenant-integrity one, which for an org-scoped product is bad enough: a
  // clinic's service appears in a government body's catalogue.
  const orgToken = String(formData.get("orgToken") ?? "").trim();
  if (!orgToken) return { error: "No pudimos determinar la organización." };

  const auth = await requireCapabilityForOrgToken("service_offering.create", orgToken);
  if (auth.error !== null) return { error: auth.error };
  // auth.error === null narrows to RequireCapabilitySuccess; all fields non-null.
  // biome-ignore lint/style/noNonNullAssertion: narrowed by auth.error === null check above.
  const user = auth.user!;
  // biome-ignore lint/style/noNonNullAssertion: narrowed by auth.error === null check above.
  const organization = auth.organization!;

  const priceRaw = formData.get("priceArs");
  const priceArs =
    priceRaw !== null && priceRaw !== "" ? Number.parseFloat(String(priceRaw)) : null;

  const durationRaw = formData.get("durationMinutes");
  const durationMinutes = durationRaw !== null ? Number.parseInt(String(durationRaw), 10) : 15;

  const capacityRaw = formData.get("slotCapacity");
  const slotCapacity = capacityRaw !== null ? Number.parseInt(String(capacityRaw), 10) : 1;

  const ageMinRaw = formData.get("eligibilityAgeMinMonths");
  const ageMaxRaw = formData.get("eligibilityAgeMaxMonths");

  const speciesRaw = formData.getAll("eligibilitySpecies");
  const eligibilitySpecies =
    speciesRaw.length > 0
      ? (speciesRaw.map(String).filter((s) => s === "dog" || s === "cat") as ("dog" | "cat")[])
      : null;

  const input = {
    serviceKind: String(formData.get("serviceKind") ?? "").trim(),
    displayName: String(formData.get("displayName") ?? "").trim(),
    description: String(formData.get("description") ?? "").trim() || null,
    durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : 15,
    slotCapacity: Number.isFinite(slotCapacity) ? slotCapacity : 1,
    priceArs: priceArs !== null && Number.isFinite(priceArs) ? priceArs : null,
    eligibilitySpecies,
    eligibilityAgeMinMonths:
      ageMinRaw !== null && ageMinRaw !== "" ? Number.parseInt(String(ageMinRaw), 10) : null,
    eligibilityAgeMaxMonths:
      ageMaxRaw !== null && ageMaxRaw !== "" ? Number.parseInt(String(ageMaxRaw), 10) : null,
  };

  const result = await createServiceOfferingForOrgUC(
    user.id,
    organization.id,
    orgToken,
    organization.displayName,
    organization.jurisdictionProvince,
    organization.jurisdictionLocality,
    input,
  );

  if ("error" in result) return { error: result.error };

  revalidatePath(`/org/${orgToken}/servicios`);
  // N3: return the destination; the form navigates (useActionRedirect).
  return { error: null, redirectTo: `/org/${orgToken}/servicios` };
}

export async function approveServiceOfferingAction(
  publicToken: string,
): Promise<{ error: string | null }> {
  // Authority-side approval is an act of admin/govt, not an org capability
  // (unlike create/pause, which use requireCapability scoped to the caller's
  // org). Gate with the full-invariant institutional guard — role ∈
  // {admin,govt} + accountType==='institutional' + deactivatedAt IS NULL +
  // deletedAt IS NULL — instead of the previous role-only profiles lookup,
  // which let a DEACTIVATED or ERASED (soft-deleted, session still valid —
  // Ley 25.326 art. 16) operator whose role column still read 'admin'/'govt'
  // approve offerings.
  // Destructure the FULL guard result — the previous `{ user }`-only destructure
  // discarded session.jurisdictions, letting a jurisdiction-scoped govt operator
  // approve a PENDING offering belonging to an org in ANY other jurisdiction. The
  // use-case now bounds the offering's org to this scope (fail-closed for govt).
  const { user, profile, jurisdictions } = await requireAdminOrGovtOrRedirect();

  const result = await approveServiceOfferingForAuthorityUC(
    user.id,
    publicToken,
    authorityScopeFromSession(profile.role, jurisdictions),
  );
  if ("error" in result) return { error: result.error };

  // Servicios is a dual-portal surface (portal-follows-viewer, 2026-07-02):
  // F3+F7 fusion (2026-07-22) made it the Directorio hub's "servicios" tab in
  // BOTH portals — revalidate both hub routes or one goes stale.
  revalidatePath("/gob/directorio");
  revalidatePath("/admin/directorio");
  return { error: null };
}

// ============================================================================
// Org-side lifecycle actions: pause / unpause / archive
// ============================================================================

export async function pauseServiceOfferingAction(
  orgToken: string,
  publicToken: string,
): Promise<ServiceOfferingResult> {
  // URL-pinned org resolution (confused-deputy guard): resolve the acting org
  // FROM the URL orgToken, not the session-default (most-recently-joined)
  // membership. Replaces the post-hoc `publicToken !== orgToken` mismatch check,
  // which was security-safe but false-rejected legitimate multi-org members.
  const auth = await requireCapabilityForOrgToken("service_offering.create", orgToken);
  if (auth.error !== null) return { error: auth.error };
  const { organization } = auth;

  const result = await pauseServiceOfferingUseCase(organization.id, publicToken);
  if ("error" in result) return result;

  revalidatePath(`/org/${orgToken}/servicios`);
  revalidatePath(`/org/${orgToken}/servicios/${publicToken}`);
  return { ok: true };
}

export async function unpauseServiceOfferingAction(
  orgToken: string,
  publicToken: string,
): Promise<ServiceOfferingResult> {
  // URL-pinned org resolution (confused-deputy guard) — see pauseServiceOfferingAction.
  const auth = await requireCapabilityForOrgToken("service_offering.create", orgToken);
  if (auth.error !== null) return { error: auth.error };
  const { organization } = auth;

  const result = await unpauseServiceOfferingUseCase(organization.id, publicToken);
  if ("error" in result) return result;

  revalidatePath(`/org/${orgToken}/servicios`);
  revalidatePath(`/org/${orgToken}/servicios/${publicToken}`);
  return { ok: true };
}

export async function archiveServiceOfferingAction(
  orgToken: string,
  publicToken: string,
): Promise<ServiceOfferingResult> {
  // URL-pinned org resolution (confused-deputy guard) — see pauseServiceOfferingAction.
  const auth = await requireCapabilityForOrgToken("service_offering.create", orgToken);
  if (auth.error !== null) return { error: auth.error };
  const { organization } = auth;

  const result = await archiveServiceOfferingUseCase(organization.id, publicToken);
  if ("error" in result) return result;

  revalidatePath(`/org/${orgToken}/servicios`);
  revalidatePath(`/org/${orgToken}/servicios/${publicToken}`);
  return { ok: true };
}

export async function rejectServiceOfferingAction(
  publicToken: string,
  rejectionReason: string,
): Promise<{ error: string | null }> {
  // Mirror approveServiceOfferingAction: authority-side rejection gates on the
  // full-invariant institutional guard, not a role-only profiles lookup.
  // Mirror approveServiceOfferingAction: destructure the full guard result and
  // thread the jurisdiction scope so a scoped govt cannot reject an offering
  // belonging to an org outside their assigned jurisdiction(s).
  const { user, profile, jurisdictions } = await requireAdminOrGovtOrRedirect();

  const result = await rejectServiceOfferingForAuthorityUC(
    user.id,
    publicToken,
    rejectionReason,
    authorityScopeFromSession(profile.role, jurisdictions),
  );
  if ("error" in result) return { error: result.error };

  // Servicios is a dual-portal surface (portal-follows-viewer, 2026-07-02):
  // F3+F7 fusion (2026-07-22) made it the Directorio hub's "servicios" tab in
  // BOTH portals — revalidate both hub routes or one goes stale.
  revalidatePath("/gob/directorio");
  revalidatePath("/admin/directorio");
  return { error: null };
}

// ============================================================================
// Offering capacity update — ARCH-F
// ============================================================================

/**
 * Org-scoped server action: updates the capacity of a service offering.
 * The authenticated user must have the service_offering.create capability
 * on the org that owns the offering.
 */
export async function updateOfferingCapacityAction(
  orgToken: string,
  offeringPublicToken: string,
  newCapacity: number,
): Promise<UpdateCapacityResult> {
  // URL-pinned org resolution (confused-deputy guard) — see pauseServiceOfferingAction.
  const auth = await requireCapabilityForOrgToken("service_offering.create", orgToken);
  if (auth.error !== null) return { error: auth.error };
  const { organization } = auth;

  const [offering] = await db
    .select({ id: serviceOfferings.id, status: serviceOfferings.status })
    .from(serviceOfferings)
    .where(
      and(
        eq(serviceOfferings.publicToken, offeringPublicToken),
        eq(serviceOfferings.organizationId, organization.id),
      ),
    )
    .limit(1);

  if (!offering) return { error: "Servicio no encontrado." };
  if (offering.status === "archived") {
    return { error: "No podés modificar un servicio archivado." };
  }

  const result = await updateOfferingCapacityWriterUC(offering.id, newCapacity);
  if ("error" in result) return result;

  revalidatePath(`/org/${orgToken}/servicios`);
  revalidatePath(`/org/${orgToken}/servicios/${offeringPublicToken}`);
  revalidatePath(`/org/${orgToken}/servicios/${offeringPublicToken}/agenda`);
  revalidatePath(`/org/${orgToken}/agenda`);
  return result;
}
