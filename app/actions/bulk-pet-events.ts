"use server";

// Thin server-action shim — bulk pet events (strangler 6/61, 2026-06-29).
//
// Auth guard (requireCapability) + use-case delegation. Business logic lives in:
//   bulkVaccinateAction      → src/modules/events/application/bulk/bulk-vaccinate-use-case.ts
//   bulkSetEligibilityAction → src/modules/adoption/application/bulk-set-eligibility-use-case.ts
//   bulkPublishListingAction → src/modules/adoption/application/bulk-publish-listing-use-case.ts
//
// The UI importer (OrgMascotasBulkList.tsx) and integration tests continue to import
// from this path — the shim preserves the public contract unchanged.

import { revalidatePath } from "next/cache";

import { db, organizations, profiles } from "@/db";
import {
  type RequireCapabilitySuccess,
  requireCapability,
} from "@/src/modules/organizations/infrastructure/authz-resolver";
import { eq } from "drizzle-orm";

import { bulkPublishListing } from "@/src/modules/adoption/application/bulk-publish-listing-use-case";
import { bulkSetEligibility } from "@/src/modules/adoption/application/bulk-set-eligibility-use-case";
import { AdoptionRepository } from "@/src/modules/adoption/infrastructure/adoption-repository";
import { bulkVaccinate } from "@/src/modules/events/application/bulk/bulk-vaccinate-use-case";
import { EventsRepository } from "@/src/modules/events/infrastructure/events-repository";

import type { BulkResult } from "./bulk-actions";
import type {
  BulkPublishListingInput,
  BulkSetEligibilityInput,
  BulkVaccinateInput,
} from "./bulk-vaccinate-types";
import { isValidBulkActionId } from "./bulk-vaccinate-types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function resolveOrg(orgToken: string) {
  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.publicToken, orgToken))
    .limit(1);
  return row ?? null;
}

function makeTransaction(): <T>(cb: (tx: unknown) => Promise<T>) => Promise<T> {
  return <T>(cb: (tx: unknown) => Promise<T>) =>
    db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>;
}

// ---------------------------------------------------------------------------
// bulkVaccinateAction
// ---------------------------------------------------------------------------

export async function bulkVaccinateAction(input: BulkVaccinateInput): Promise<BulkResult> {
  const bulkActionId = input.bulkActionId;

  if (!isValidBulkActionId(bulkActionId)) {
    return {
      bulkActionId: String(bulkActionId ?? ""),
      succeeded: [],
      failed: input.petPublicTokens.map((id) => ({ id, reason: "bulkActionId inválido." })),
    };
  }

  const org = await resolveOrg(input.orgToken);
  if (!org) {
    return {
      bulkActionId,
      succeeded: [],
      failed: input.petPublicTokens.map((id) => ({ id, reason: "Organización no encontrada." })),
    };
  }

  const cap = await requireCapability("event.write", org.id);
  if (cap.error) {
    return {
      bulkActionId,
      succeeded: [],
      failed: input.petPublicTokens.map((id) => ({ id, reason: cap.error as string })),
    };
  }
  const capOk = cap as RequireCapabilitySuccess;

  // Provenance keystone (#43): the bulk signer's clinical provenance is bound to
  // THEIR validated matrícula, not the org's verified flag — so a verified
  // refugio's batch vaccination signed by a non-matriculado does not falsely
  // clear the "verificado" compliance gate. Mirrors lib/infra/pet-access.ts.
  const [signer] = await db
    .select({ matriculaVerified: profiles.matriculaVerified })
    .from(profiles)
    .where(eq(profiles.id, capOk.user.id))
    .limit(1);

  const repo = new EventsRepository();
  const result = await bulkVaccinate(
    input,
    {
      userId: capOk.user.id,
      organization: capOk.organization,
      signerMatriculaVerified: signer?.matriculaVerified === true,
    },
    { repo, transaction: makeTransaction() },
  );

  revalidatePath(`/org/${input.orgToken}/mascotas`);
  return result;
}

// ---------------------------------------------------------------------------
// bulkSetEligibilityAction
// ---------------------------------------------------------------------------

export async function bulkSetEligibilityAction(
  input: BulkSetEligibilityInput,
): Promise<BulkResult> {
  const bulkActionId = input.bulkActionId;

  if (!isValidBulkActionId(bulkActionId)) {
    return {
      bulkActionId: String(bulkActionId ?? ""),
      succeeded: [],
      failed: input.petPublicTokens.map((id) => ({ id, reason: "bulkActionId inválido." })),
    };
  }

  const org = await resolveOrg(input.orgToken);
  if (!org) {
    return {
      bulkActionId,
      succeeded: [],
      failed: input.petPublicTokens.map((id) => ({ id, reason: "Organización no encontrada." })),
    };
  }

  const cap = await requireCapability("intake.create", org.id);
  if (cap.error) {
    return {
      bulkActionId,
      succeeded: [],
      failed: input.petPublicTokens.map((id) => ({ id, reason: cap.error as string })),
    };
  }
  const capOk = cap as RequireCapabilitySuccess;

  const result = await bulkSetEligibility(
    input,
    { userId: capOk.user.id, organization: capOk.organization },
    { repo: AdoptionRepository, transaction: makeTransaction() },
  );

  revalidatePath(`/org/${input.orgToken}/mascotas`);
  return result;
}

// ---------------------------------------------------------------------------
// bulkPublishListingAction
// ---------------------------------------------------------------------------

export async function bulkPublishListingAction(
  input: BulkPublishListingInput,
): Promise<BulkResult> {
  const bulkActionId = input.bulkActionId;

  if (!isValidBulkActionId(bulkActionId)) {
    return {
      bulkActionId: String(bulkActionId ?? ""),
      succeeded: [],
      failed: input.petPublicTokens.map((id) => ({ id, reason: "bulkActionId inválido." })),
    };
  }

  const org = await resolveOrg(input.orgToken);
  if (!org) {
    return {
      bulkActionId,
      succeeded: [],
      failed: input.petPublicTokens.map((id) => ({ id, reason: "Organización no encontrada." })),
    };
  }

  const cap = await requireCapability("adoption.listing.manage", org.id);
  if (cap.error) {
    return {
      bulkActionId,
      succeeded: [],
      failed: input.petPublicTokens.map((id) => ({ id, reason: cap.error as string })),
    };
  }
  const capOk = cap as RequireCapabilitySuccess;

  const result = await bulkPublishListing(
    input,
    { organization: capOk.organization },
    { repo: AdoptionRepository },
  );

  revalidatePath(`/org/${input.orgToken}/mascotas`);
  revalidatePath("/adoptar");
  return result;
}
