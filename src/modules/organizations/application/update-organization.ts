// Use-case: update organization profile.
//
// Migrated from app/actions/organizations.ts::updateOrganizationForUser.
// Auth (requireOrgAccessByToken outer gate) handled by caller.
// Inner admin re-check is performed HERE (independent of outer guard — preserve exactly).
//
// Field whitelist: displayName, legalName, email, phone, website, description,
// personeriaJuridicaNumber, tier0ShowOriginOrg, publicDirectoryOptIn (clinics
// only — migration 0283), updatedAt.
// Excluded: orgType, verified, status, publicToken, jurisdictionProvince, jurisdictionLocality.
//
// AUDIT: a change of publicDirectoryOptIn publishes (or withdraws) the clinic's
// name and contact on /refugios, so it writes one
// `org_public_directory_opt_in_changed` audit row — who, when, before → after
// — in the SAME transaction as the column. Re-saving the form with the value
// unchanged writes none.

import { canOptIntoPublicDirectory } from "@/src/modules/organizations/domain/public-directory";
import type {
  Exec,
  OrgRepository,
} from "@/src/modules/organizations/infrastructure/org-repository";
import type { UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Validation helpers (exact parity with original)
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s.]+\.[^\s]{2,}/;

export type UpdateOrganizationFields = {
  displayName: string;
  legalName?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  description?: string | null;
  personeriaJuridicaNumber?: string | null;
  tier0ShowOriginOrg?: boolean;
  // Listing in the public directory at /refugios (migration 0283). Only a
  // clinic has the setting; undefined means "not submitted" (keep existing).
  publicDirectoryOptIn?: boolean;
  // Shelter capacity (Item 16 D1). Nullable — org may leave them unset.
  capacityDogs?: number | null;
  capacityCats?: number | null;
  capacityOther?: number | null;
  capacityTotal?: number | null;
};

function validateFields(fields: UpdateOrganizationFields): string | null {
  const displayName = (fields.displayName ?? "").trim();
  if (!displayName || displayName.length < 2 || displayName.length > 100) {
    return "El nombre debe tener entre 2 y 100 caracteres.";
  }
  if (fields.legalName !== undefined && fields.legalName !== null) {
    const legalName = fields.legalName.trim();
    if (!legalName) return "El nombre legal no puede quedar vacío.";
    if (legalName.length < 2 || legalName.length > 100) {
      return "La razón social debe tener entre 2 y 100 caracteres.";
    }
  }
  if (fields.email !== undefined && fields.email !== null) {
    const email = fields.email.trim();
    if (!email) return "El email no puede quedar vacío.";
    if (!EMAIL_RE.test(email)) return "El correo electrónico es inválido.";
  }
  if (fields.website) {
    if (!URL_RE.test(fields.website.trim())) {
      return "El sitio web debe comenzar con http:// o https://.";
    }
    if (fields.website.trim().length > 200) {
      return "El sitio web no puede tener más de 200 caracteres.";
    }
  }
  if (fields.description && fields.description.trim().length > 2000) {
    return "La descripción no puede tener más de 2000 caracteres.";
  }
  if (fields.phone && fields.phone.trim().length > 30) {
    return "El teléfono no puede tener más de 30 caracteres.";
  }
  if (fields.personeriaJuridicaNumber && fields.personeriaJuridicaNumber.trim().length > 60) {
    return "El número de personería jurídica no puede tener más de 60 caracteres.";
  }
  // Capacity fields must be non-negative integers when provided.
  for (const [key, val] of [
    ["capacityDogs", fields.capacityDogs],
    ["capacityCats", fields.capacityCats],
    ["capacityOther", fields.capacityOther],
    ["capacityTotal", fields.capacityTotal],
  ] as const) {
    if (val !== undefined && val !== null) {
      if (!Number.isInteger(val) || val < 0) {
        return `La capacidad (${key}) debe ser un número entero no negativo.`;
      }
      if (val > 99999) {
        return `La capacidad (${key}) no puede superar 99 999.`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Input / Deps
// ---------------------------------------------------------------------------

export type UpdateOrganizationInput = {
  userId: string;
  orgToken: string;
  fields: UpdateOrganizationFields;
};

type RepoDeps = Pick<
  OrgRepository,
  "findMembershipByUserAndOrgToken" | "updateOrgProfile" | "insertAuditLog"
>;

type Deps = {
  repo: RepoDeps;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function updateOrganization(
  input: UpdateOrganizationInput,
  deps: Deps,
): Promise<UseCaseResult<void>> {
  const { repo, transaction } = deps;

  // 1. Validate fields.
  const validationError = validateFields(input.fields);
  if (validationError) return { ok: false, error: validationError };

  // 2. Inner admin re-check (independent from outer requireOrgAccessByToken guard).
  //    Separate lookup so this function is independently security-auditable.
  const row = await repo.findMembershipByUserAndOrgToken(input.userId, input.orgToken);
  if (!row) return { ok: false, error: "No tenés acceso a esta organización." };
  if (row.membership.role !== "admin") {
    return {
      ok: false,
      error: "Solo los administradores de la organización pueden editar el perfil.",
    };
  }

  // 3. The directory listing is a clinic's choice. Shelters and rescue
  //    networks are listed on verification alone (see
  //    domain/public-directory.ts), so the setting does not exist for them —
  //    refused rather than stored as a value nothing reads.
  const f = input.fields;
  if (f.publicDirectoryOptIn !== undefined && !canOptIntoPublicDirectory(row.org.orgType)) {
    return {
      ok: false,
      error: "Solo las veterinarias eligen si aparecen en el directorio público.",
    };
  }

  // 4. Build whitelisted update fields; the directory switch, when it moves,
  //    is audited in the same transaction.
  const optInBefore = row.org.publicDirectoryOptIn;
  const optInChanged =
    f.publicDirectoryOptIn !== undefined && f.publicDirectoryOptIn !== optInBefore;
  await transaction(async (tx) => {
    const e = tx as Exec;
    await repo.updateOrgProfile(
      row.org.id,
      {
        displayName: f.displayName.trim(),
        legalName: f.legalName?.trim() || undefined,
        email: f.email?.trim() || undefined,
        phone: f.phone?.trim() || null,
        website: f.website?.trim() || null,
        description: f.description?.trim() || null,
        personeriaJuridicaNumber: f.personeriaJuridicaNumber?.trim() || null,
        ...(f.tier0ShowOriginOrg !== undefined && { tier0ShowOriginOrg: f.tier0ShowOriginOrg }),
        ...(f.publicDirectoryOptIn !== undefined && {
          publicDirectoryOptIn: f.publicDirectoryOptIn,
        }),
        // Capacity columns (Item 16 D1) — undefined means "not submitted" (keep existing).
        ...(f.capacityDogs !== undefined && { capacityDogs: f.capacityDogs }),
        ...(f.capacityCats !== undefined && { capacityCats: f.capacityCats }),
        ...(f.capacityOther !== undefined && { capacityOther: f.capacityOther }),
        ...(f.capacityTotal !== undefined && { capacityTotal: f.capacityTotal }),
        updatedAt: new Date(),
      },
      e,
    );
    if (optInChanged) {
      await repo.insertAuditLog(
        {
          actorUserId: input.userId,
          action: "org_public_directory_opt_in_changed",
          targetOrganizationId: row.org.id,
          payload: {
            org_id: row.org.id,
            before_values: { public_directory_opt_in: optInBefore },
            after_values: { public_directory_opt_in: f.publicDirectoryOptIn },
          },
        },
        e,
      );
    }
  });

  return { ok: true, value: undefined, notifications: [] };
}
