// Use-case: createServiceOfferingWriter
//
// Shared inner writer for both org and vet-provider paths (Fase 2.5).
// Receives a pre-authorized actor context. Auth guard lives in the action.
//
// Steps:
//   1. Validate input via Zod schema.
//   2. Lookup service kind definition.
//   3. Canonicalize jurisdiction (soft locality resolution).
//   4. Generate a unique public token.
//   5. Find approval authorities for jurisdiction.
//   6. Open DB transaction:
//      a. INSERT service_offering (status: pending_approval).
//      b. Notify applicant (service_offering_submitted).
//      c. Fan-out to authorities (service_offering_pending_authority).
//
// createServiceOfferingForOrg delegates to this writer (Fase 1.5 approval routing).

import { db, notifications, serviceOfferings } from "@/db";
import { CoordError, normalizeLocationForWrite } from "@/lib/domain/location-normalize";
import { findAuthoritiesForJurisdiction } from "@/lib/infra/approval-routing";
import { generateOfferingToken } from "@/lib/infra/publicToken";
import { generateUniqueToken } from "@/lib/infra/unique-token";
import { CreateServiceOfferingInput } from "@/lib/reference/scheduling-schemas";
import { findServiceKind } from "@/lib/reference/service-kinds";

import type { OrgProvider, ServiceOfferingResult } from "../domain/types";

export async function createServiceOfferingWriter(
  actorUserId: string,
  provider: OrgProvider,
  province: string,
  locality: string,
  input: {
    serviceKind: string;
    displayName: string;
    description: string | null;
    durationMinutes: number;
    slotCapacity: number;
    priceArs: number | null;
    eligibilitySpecies: ("dog" | "cat")[] | null;
    eligibilityAgeMinMonths: number | null;
    eligibilityAgeMaxMonths: number | null;
  },
): Promise<ServiceOfferingResult> {
  const parsed = CreateServiceOfferingInput.safeParse(input);
  if (!parsed.success) {
    return { error: `Datos inválidos: ${parsed.error.issues[0]?.message ?? "error"}` };
  }

  const kindDef = findServiceKind(parsed.data.serviceKind);
  if (!kindDef) {
    return { error: "Tipo de servicio no reconocido." };
  }

  // Canonicalize jurisdiction so the approval routing + future filters
  // agree on the INDEC spelling. When both fields are empty (vet provider
  // without operational scope yet), persist as null. When the lookup misses
  // (uncatalogued locality), we keep the trimmed input — tolerant variant.
  // locality:"soft" — tryResolveCanonicalJurisdiction (service-offering behavior unchanged).
  let normalized: Awaited<ReturnType<typeof normalizeLocationForWrite>>;
  try {
    normalized = await normalizeLocationForWrite(
      {
        province,
        provinceCode: null,
        locality,
        localityIndecId: null,
        lat: null,
        lng: null,
        address: null,
      },
      { locality: "soft" },
    );
  } catch (err) {
    if (err instanceof CoordError) {
      return { error: err.message };
    }
    throw err;
  }
  const canonicalProvince: string | null = normalized.province || null;
  const canonicalLocality: string | null = normalized.locality || null;

  const publicToken = await generateUniqueToken(
    serviceOfferings,
    serviceOfferings.publicToken,
    generateOfferingToken,
  );
  const authorityIds = await findAuthoritiesForJurisdiction({
    province: canonicalProvince ?? "",
    locality: canonicalLocality ?? "",
  });

  try {
    await db.transaction(async (tx) => {
      await tx.insert(serviceOfferings).values({
        publicToken,
        organizationId: provider.organizationId,
        providerUserId: null,
        jurisdictionProvince: canonicalProvince,
        jurisdictionLocality: canonicalLocality,
        serviceKind: parsed.data.serviceKind,
        displayName: parsed.data.displayName,
        description: parsed.data.description,
        durationMinutes: parsed.data.durationMinutes,
        slotCapacity: parsed.data.slotCapacity,
        priceArs: parsed.data.priceArs?.toString() ?? null,
        eligibilitySpecies: parsed.data.eligibilitySpecies,
        eligibilityAgeMinMonths: parsed.data.eligibilityAgeMinMonths,
        eligibilityAgeMaxMonths: parsed.data.eligibilityAgeMaxMonths,
        status: "pending_approval",
      });

      const providerLabel = provider.organizationDisplayName;

      // Notify applicant.
      const ctaUrl = `/org/${provider.organizationPublicToken}/servicios`;

      await tx.insert(notifications).values({
        userId: actorUserId,
        notificationType: "service_offering_submitted",
        title: "Servicio enviado para revisión",
        body: `"${parsed.data.displayName}" (${kindDef.label}) fue enviado. Te avisamos cuando sea aprobado.`,
        severity: "info",
        ctaLabel: "Ver mis servicios",
        ctaUrl,
      });

      // Fan out to authorities.
      if (authorityIds.length > 0) {
        // Servicios dedup (admin-rules-console R5.1): /gob/servicios is the
        // single canonical surface for both roles — admin reaches universal
        // scope there too, /admin/servicios no longer exists. Role no longer
        // needs to be looked up just to pick a CTA URL. F3+F7 fusion
        // (2026-07-22): Servicios is now the Directorio hub's "servicios"
        // tab — the CTA links straight there instead of through the old
        // /gob/servicios redirect.
        await tx.insert(notifications).values(
          authorityIds.map((authorityId) => {
            return {
              userId: authorityId,
              notificationType: "service_offering_pending_authority",
              title: `Nuevo servicio a aprobar en ${locality || providerLabel}`,
              body: `${providerLabel} solicitó aprobar "${parsed.data.displayName}" (${kindDef.label}).`,
              severity: "info" as const,
              ctaLabel: "Revisar",
              ctaUrl: "/gob/directorio?registro=servicios",
            };
          }),
        );
      }
    });
  } catch (err) {
    return {
      error: `No se pudo crear la solicitud: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { ok: true };
}

// Org-side convenience wrapper — delegates to the shared writer.
export async function createServiceOfferingForOrg(
  actorUserId: string,
  orgId: string,
  orgToken: string,
  orgDisplayName: string,
  orgProvince: string | null,
  orgLocality: string | null,
  input: {
    serviceKind: string;
    displayName: string;
    description: string | null;
    durationMinutes: number;
    slotCapacity: number;
    priceArs: number | null;
    eligibilitySpecies: ("dog" | "cat")[] | null;
    eligibilityAgeMinMonths: number | null;
    eligibilityAgeMaxMonths: number | null;
  },
): Promise<ServiceOfferingResult> {
  return createServiceOfferingWriter(
    actorUserId,
    {
      organizationId: orgId,
      organizationPublicToken: orgToken,
      organizationDisplayName: orgDisplayName,
    },
    orgProvince ?? "",
    orgLocality ?? "",
    input,
  );
}
