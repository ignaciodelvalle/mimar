import type { GovtBusinessRuleType, RequirementLevel } from "@/db";

export type BusinessRuleFormState = {
  error: string | null;
  warning?: string;
  /**
   * Set on success instead of the action calling next/navigation's
   * redirect(). Next.js 15.5.x's App Router can silently drop a server
   * action's own redirect() transition in production (engram #621/#622,
   * verify-report #650 WARNING-1) — the mutation commits (confirmed via
   * audit_log) but the client never navigates and the submit button stays
   * stuck pending. The calling form does a real `window.location.assign`
   * full document navigation to this URL instead (see
   * lib/ui/full-page-action-nav.ts) — the one mechanism proven immune to
   * the router-drop defect.
   */
  redirectTo?: string;
};

/**
 * Requirement tier + legal provenance COLUMNS on govt_business_rules
 * (migration 0183, spec RM1/RM2). Parsed from form data by the action shim's
 * `parseLegalMetadata` — NOT part of the rule payload.
 *
 * Per-field semantics on update: `undefined` = the form did not carry the
 * field, leave the column untouched (so a form without the tier select never
 * erases a backfilled tier); `null` = the field was present and empty, clear
 * the column. Dates are `YYYY-MM-DD` strings (drizzle date columns, string
 * mode).
 *
 * `baseline_version` is intentionally absent from this type — the console never
 * SETS a version. It does, however, CLEAR it: an admin edit detaches the row
 * from the baseline (`baseline_version = NULL`, see updateBusinessRuleWriter),
 * because a row a legal reviewer has corrected is no longer pristine baseline
 * and the seed's BD2 protection only covers NULL-version rows. Without that
 * detach, the next same-version re-seed silently reverted the correction (T6
 * review M3).
 */
export type BusinessRuleLegalMetadata = {
  requirementLevel?: RequirementLevel | null;
  legalBasis?: string | null;
  authority?: string | null;
  sourceUrl?: string | null;
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
};

export type CreateBusinessRuleWriterParams = {
  actorUserId: string;
  ruleType: GovtBusinessRuleType;
  jurisdictionCountry: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  rulePayload: unknown;
  notes: string | null;
  legalAnchorIds: string[];
  /** Optional so pre-0183 callers keep compiling; absent = all columns NULL. */
  legalMetadata?: BusinessRuleLegalMetadata;
};

export type CreateBusinessRuleResult =
  | { ok: true; ruleId: string; noOp?: false }
  | { ok: true; ruleId: null; noOp: true; reason: string }
  | { ok: false; error: string };

export type UpdateBusinessRuleWriterParams = {
  actorUserId: string;
  ruleId: string;
  rulePayload: unknown;
  notes: string | null;
  legalAnchorIds: string[];
  /**
   * Optional so pre-0183 callers keep compiling; absent = the legal-metadata
   * columns are left untouched (see BusinessRuleLegalMetadata for the
   * per-field undefined/null semantics when present).
   */
  legalMetadata?: BusinessRuleLegalMetadata;
};

export type DeleteBusinessRuleWriterParams = {
  actorUserId: string;
  ruleId: string;
  /** Operator-supplied reason for the deletion — recorded in the audit payload. */
  reason: string;
};
