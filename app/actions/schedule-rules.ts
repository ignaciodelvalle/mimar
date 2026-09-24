"use server";

// schedule-rules.ts — thin shim (strangler 24/61).
//
// Business logic moved to:
//   src/modules/service-offerings/application/schedule-rules/
//
// This file provides thin Action wrappers (used by UI components) that add
// the auth guard + revalidatePath. The bare ForOrg writers are NOT exported
// here (authz triage 2026-07-04): every export of a "use server" file is an
// independently-addressable server action, so a bare writer taking a
// caller-supplied actorUserId/orgId would let any client edit another org's
// schedule. Callers import the writers from
// src/modules/service-offerings/application/schedule-rules/ directly.
//
// CRITICAL: Every runtime export in a "use server" file must be an async
// function. Types are re-exported with `export type` (erased at runtime).

import { revalidatePath } from "next/cache";

import { requireCapabilityForOrgToken } from "@/src/modules/organizations/infrastructure/authz-resolver";

import { createScheduleRuleForOrg as _createScheduleRuleForOrg } from "@/src/modules/service-offerings/application/schedule-rules/create-schedule-rule";
import { deleteScheduleRuleForOrg as _deleteScheduleRuleForOrg } from "@/src/modules/service-offerings/application/schedule-rules/delete-schedule-rule";
import type { ScheduleRuleFormState } from "@/src/modules/service-offerings/application/schedule-rules/types";
import { updateScheduleRuleForOrg as _updateScheduleRuleForOrg } from "@/src/modules/service-offerings/application/schedule-rules/update-schedule-rule";

// ---------------------------------------------------------------------------
// Type re-exports (erased at runtime — allowed in "use server" files)
// ---------------------------------------------------------------------------

export type {
  ScheduleRuleFormState,
  ScheduleRuleResult,
} from "@/src/modules/service-offerings/application/schedule-rules/types";

// ---------------------------------------------------------------------------
// Form-shaped wrappers — gate auth + capability, delegate to inner writers
// ---------------------------------------------------------------------------

// ── Org-side wrappers ────────────────────────────────────────────────────────

export async function createScheduleRuleAction(
  _prev: ScheduleRuleFormState,
  formData: FormData,
): Promise<ScheduleRuleFormState> {
  // SCOPED TO THE URL's ORGANIZATION. `orgToken` was already in this form's
  // payload — it was read below, but only to revalidate a path — while the
  // capability check resolved the caller's SESSION-DEFAULT membership instead.
  // For a member of several organizations those are different, so a vet
  // building an agenda inside their clinic was authorized against, and scoped
  // to, whichever org they happened to join last. Same defect as
  // createServiceOfferingAction; found in the same sweep (2026-08-09).
  const orgToken = String(formData.get("orgToken") ?? "").trim();
  if (!orgToken) return { error: "No pudimos determinar la organización." };

  const auth = await requireCapabilityForOrgToken("service_offering.create", orgToken);
  if (auth.error !== null) return { error: auth.error };
  // biome-ignore lint/style/noNonNullAssertion: narrowed by auth.error === null check above.
  const user = auth.user!;
  // biome-ignore lint/style/noNonNullAssertion: narrowed by auth.error === null check above.
  const organization = auth.organization!;

  const serviceOfferingId = String(formData.get("serviceOfferingId") ?? "").trim();
  const daysRaw = formData.getAll("daysOfWeek").map((v) => Number.parseInt(String(v), 10));
  const startTimeLocal = String(formData.get("startTimeLocal") ?? "").trim();
  const endTimeLocal = String(formData.get("endTimeLocal") ?? "").trim();
  const effectiveFrom = String(formData.get("effectiveFrom") ?? "").trim();
  const effectiveUntilRaw = String(formData.get("effectiveUntil") ?? "").trim();
  const effectiveUntil = effectiveUntilRaw || null;

  const result = await _createScheduleRuleForOrg(user.id, organization.id, {
    serviceOfferingId,
    daysOfWeek: daysRaw.filter((d) => !Number.isNaN(d)),
    startTimeLocal,
    endTimeLocal,
    effectiveFrom,
    effectiveUntil,
  });

  if ("error" in result) return { error: result.error };

  // Revalidate so the agenda page reflects the new rule.
  const offeringToken = String(formData.get("offeringPublicToken") ?? "").trim();
  if (offeringToken) {
    revalidatePath(`/org/${orgToken}/servicios/${offeringToken}/agenda`);
  }

  return { error: null };
}

export async function updateScheduleRuleAction(
  _prev: ScheduleRuleFormState,
  formData: FormData,
): Promise<ScheduleRuleFormState> {
  // SCOPED TO THE URL's ORGANIZATION — same fix and same reason as the create
  // wrapper above. deleteScheduleRuleAction below already took this shape and
  // calls it "URL-pinned org resolution (confused-deputy guard)"; create and
  // update were the two that never got it.
  const orgToken = String(formData.get("orgToken") ?? "").trim();
  if (!orgToken) return { error: "No pudimos determinar la organización." };

  const auth = await requireCapabilityForOrgToken("service_offering.create", orgToken);
  if (auth.error !== null) return { error: auth.error };
  // biome-ignore lint/style/noNonNullAssertion: narrowed by auth.error === null check above.
  const user = auth.user!;
  // biome-ignore lint/style/noNonNullAssertion: narrowed by auth.error === null check above.
  const organization = auth.organization!;

  const ruleId = String(formData.get("ruleId") ?? "").trim();
  const daysRaw = formData.getAll("daysOfWeek").map((v) => Number.parseInt(String(v), 10));
  const startTimeLocal = String(formData.get("startTimeLocal") ?? "").trim() || undefined;
  const endTimeLocal = String(formData.get("endTimeLocal") ?? "").trim() || undefined;
  const effectiveFrom = String(formData.get("effectiveFrom") ?? "").trim() || undefined;
  const effectiveUntilRaw = formData.get("effectiveUntil");
  const effectiveUntil =
    effectiveUntilRaw !== null ? String(effectiveUntilRaw).trim() || null : undefined;

  const result = await _updateScheduleRuleForOrg(user.id, ruleId, organization.id, {
    daysOfWeek: daysRaw.length > 0 ? daysRaw.filter((d) => !Number.isNaN(d)) : undefined,
    startTimeLocal,
    endTimeLocal,
    effectiveFrom,
    effectiveUntil,
  });

  if ("error" in result) return { error: result.error };

  const offeringToken = String(formData.get("offeringPublicToken") ?? "").trim();
  if (offeringToken) {
    revalidatePath(`/org/${orgToken}/servicios/${offeringToken}/agenda`);
  }

  return { error: null };
}

export async function deleteScheduleRuleAction(
  ruleId: string,
  orgToken: string,
  offeringToken: string,
): Promise<{ error: string | null }> {
  // URL-pinned org resolution (confused-deputy guard): resolve the acting org
  // FROM the URL orgToken rather than the session-default (most-recently-joined)
  // membership, so a multi-org member deleting from /org/{orgToken}/… is
  // authorized against that org. The delete stays scoped to organization.id.
  const auth = await requireCapabilityForOrgToken("service_offering.create", orgToken);
  if (auth.error !== null) return { error: auth.error };
  const { user, organization } = auth;

  const result = await _deleteScheduleRuleForOrg(user.id, ruleId, organization.id);
  if ("error" in result) return { error: result.error };

  revalidatePath(`/org/${orgToken}/servicios/${offeringToken}/agenda`);
  return { error: null };
}
