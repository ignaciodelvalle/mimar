"use server";

// business-rules.ts — thin shim (strangler migration 15/61).
//
// Business logic moved to:
//   src/modules/organizations/application/business-rules/
//
// This file re-exports all writer functions (used by integration tests)
// and provides thin Action wrappers (used by UI components) that add
// the auth guard + redirect.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).
//
// NOTE: on success these actions return `redirectTo` in BusinessRuleFormState
// instead of calling next/navigation's redirect() — the calling form does a
// full document navigation (lib/ui/full-page-action-nav.ts) instead of
// relying on the framework's own post-action transition, which Next 15.5.x
// can silently drop in production (verify-report #650 WARNING-1, see
// BusinessRuleFormState's redirectTo doc comment for the full mechanism).

import { GOVT_BUSINESS_RULE_TYPES, type GovtBusinessRuleType } from "@/db";
import { getRuleTypeDef } from "@/lib/domain/rule-types-registry";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";

import { createBusinessRuleWriter as _createBusinessRuleWriter } from "@/src/modules/organizations/application/business-rules/create-business-rule";
import { deleteBusinessRuleWriter as _deleteBusinessRuleWriter } from "@/src/modules/organizations/application/business-rules/delete-business-rule";
import {
  normalizeJurisdiction,
  normalizeRuleJurisdiction,
  readJurisdictionFields,
} from "@/src/modules/organizations/application/business-rules/normalize-jurisdiction";
import { parseLegalMetadata } from "@/src/modules/organizations/application/business-rules/parse-legal-metadata";
import type { BusinessRuleFormState } from "@/src/modules/organizations/application/business-rules/types";
import { updateBusinessRuleWriter as _updateBusinessRuleWriter } from "@/src/modules/organizations/application/business-rules/update-business-rule";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type {
  BusinessRuleFormState,
  CreateBusinessRuleResult,
  CreateBusinessRuleWriterParams,
  DeleteBusinessRuleWriterParams,
  UpdateBusinessRuleWriterParams,
} from "@/src/modules/organizations/application/business-rules/types";

// Bare writers are NOT re-exported here (impersonation triage, review 07).
// createBusinessRuleWriter/update/delete take a caller-supplied actorUserId;
// exporting them from a "use server" file would make them independently-
// addressable actions that impersonate any user. They live on in
// src/modules/organizations/application/business-rules/*; integration tests
// import them from there, and the guarded *Action wrappers below derive the
// actor from the admin session.

// ---------------------------------------------------------------------------
// Private helpers (controller-only — form data parsing)
// ---------------------------------------------------------------------------

function parseLegalAnchorIds(formData: FormData): string[] {
  return (formData.getAll("legalAnchorIds") as string[])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// parseLegalMetadata (migration 0183) lives in
// src/modules/organizations/application/business-rules/parse-legal-metadata.ts
// — the action line-budget fence keeps parsing logic out of this shim.

/**
 * Reads the `portalBase` hidden field the form threads down from
 * lib/ui/portal-base.ts (portal-follows-viewer, 2026-07-02) so the
 * post-mutation `redirectTo` stays inside whichever portal the operator is
 * browsing. Defaults to "/gob" for older/mistrusted form payloads — never
 * throws on an unexpected value.
 */
function resolvePortalBase(formData: FormData): "/admin" | "/gob" {
  return formData.get("portalBase") === "/admin" ? "/admin" : "/gob";
}

// ---------------------------------------------------------------------------
// Form-bound actions (admin-gated)
// ---------------------------------------------------------------------------

function parseRulePayloadFromForm(ruleType: GovtBusinessRuleType, formData: FormData): unknown {
  // Parsing logic per rule type lives in the registry (lib/domain/rule-types-
  // registry.ts) so the action stays declarative — validators run after.
  return getRuleTypeDef(ruleType).parseFromForm(formData);
}

export async function createBusinessRuleAction(
  _previous: BusinessRuleFormState,
  formData: FormData,
): Promise<BusinessRuleFormState> {
  const { user } = await requireAdminOrRedirect();

  const ruleTypeRaw = String(formData.get("ruleType") ?? "").trim();
  if (!(GOVT_BUSINESS_RULE_TYPES as readonly string[]).includes(ruleTypeRaw)) {
    return { error: "Rule type inválido" };
  }
  const ruleType = ruleTypeRaw as GovtBusinessRuleType;

  // The place by id when the wizard picked one (localidades-por-id D4).
  const jurisdiction = await normalizeRuleJurisdiction(formData);
  if (!jurisdiction.ok) return { error: jurisdiction.error };
  const { country, province, locality } = jurisdiction.value;
  const notes = (formData.get("notes") as string | null)?.trim() || null;
  const legalAnchorIds = parseLegalAnchorIds(formData);
  const legalMetadata = parseLegalMetadata(formData);
  if (!legalMetadata.ok) return { error: legalMetadata.error };

  const result = await _createBusinessRuleWriter({
    actorUserId: user.id,
    ruleType,
    jurisdictionCountry: country,
    jurisdictionProvince: province,
    jurisdictionLocality: locality,
    rulePayload: parseRulePayloadFromForm(ruleType, formData),
    notes,
    legalAnchorIds,
    legalMetadata: legalMetadata.value,
    place: jurisdiction.place,
  });
  if (!result.ok) return { error: result.error };
  if (result.noOp) {
    return { error: null, warning: result.reason };
  }
  const base = resolvePortalBase(formData);
  return {
    error: null,
    redirectTo: `${base}/reglas/${encodeURIComponent(country)}/${encodeURIComponent(province ?? "_")}/${encodeURIComponent(locality ?? "_")}`,
  };
}

export async function updateBusinessRuleAction(
  ruleId: string,
  _previous: BusinessRuleFormState,
  formData: FormData,
): Promise<BusinessRuleFormState> {
  const { user } = await requireAdminOrRedirect();

  const ruleTypeRaw = String(formData.get("ruleType") ?? "").trim();
  if (!(GOVT_BUSINESS_RULE_TYPES as readonly string[]).includes(ruleTypeRaw)) {
    return { error: "Rule type inválido" };
  }
  const ruleType = ruleTypeRaw as GovtBusinessRuleType;
  const notes = (formData.get("notes") as string | null)?.trim() || null;
  const legalAnchorIds = parseLegalAnchorIds(formData);
  const legalMetadata = parseLegalMetadata(formData);
  if (!legalMetadata.ok) return { error: legalMetadata.error };

  const result = await _updateBusinessRuleWriter({
    actorUserId: user.id,
    ruleId,
    rulePayload: parseRulePayloadFromForm(ruleType, formData),
    notes,
    legalAnchorIds,
    legalMetadata: legalMetadata.value,
  });
  if (!result.ok) return { error: result.error };

  // Redirect only — the writer never changes a rule's jurisdiction. A legacy
  // off-catalog row still redirects to its own (raw) address.
  const resolved = await normalizeJurisdiction(formData);
  const { country, province, locality } = resolved.ok
    ? resolved.value
    : readJurisdictionFields(formData);
  const base = resolvePortalBase(formData);
  return {
    error: null,
    redirectTo: `${base}/reglas/${encodeURIComponent(country)}/${encodeURIComponent(province ?? "_")}/${encodeURIComponent(locality ?? "_")}`,
  };
}

export async function deleteBusinessRuleAction(
  ruleId: string,
  _previous: BusinessRuleFormState,
  formData: FormData,
): Promise<BusinessRuleFormState> {
  const { user } = await requireAdminOrRedirect();
  const reason = (formData.get("reason") as string | null)?.trim() ?? "";
  const result = await _deleteBusinessRuleWriter({ actorUserId: user.id, ruleId, reason });
  if (!result.ok) return { error: result.error };
  const country = (formData.get("jurisdictionCountry") as string | null) ?? "AR";
  const province = (formData.get("jurisdictionProvince") as string | null) ?? "_";
  const locality = (formData.get("jurisdictionLocality") as string | null) ?? "_";
  const base = resolvePortalBase(formData);
  return {
    error: null,
    redirectTo: `${base}/reglas/${encodeURIComponent(country)}/${encodeURIComponent(province || "_")}/${encodeURIComponent(locality || "_")}`,
  };
}
