// Pure helper: derives a display href for an audit log target user.
//
// Used by app/admin/auditoria/page.tsx (C12) to render "sobre: {targetName}" with
// a link when the target's role is resolvable to a known admin entity page.
//
// Rules:
//   - role "admin"  → /admin/admins/{id}
//   - role "govt"   → /admin/govts/{id}
//   - any other role → null (render name only, no link)
//
// Returning null is intentional and safe — the RSC renders the name without a link.

export type KnownRole = "admin" | "govt" | "owner" | "vet" | string;

export interface TargetLinkInfo {
  id: string;
  displayName: string;
  href: string | null;
}

/**
 * Given a target's profile row, returns the display name and an href (or null).
 * Pure function — no DB calls, fully unit-testable.
 */
export function deriveTargetHref(id: string, role: KnownRole): string | null {
  if (role === "admin") return `/admin/admins/${id}`;
  if (role === "govt") return `/admin/govts/${id}`;
  return null;
}

/**
 * Builds TargetLinkInfo from a profile row.
 */
export function buildTargetLinkInfo(profile: {
  id: string;
  displayName: string;
  role: KnownRole;
}): TargetLinkInfo {
  return {
    id: profile.id,
    displayName: profile.displayName,
    href: deriveTargetHref(profile.id, profile.role),
  };
}

// ---------------------------------------------------------------------------
// govt_business_rule_* target summary (admin-rules-console live-QA finding)
// ---------------------------------------------------------------------------

const BUSINESS_RULE_ACTIONS = new Set([
  "govt_business_rule_created",
  "govt_business_rule_updated",
  "govt_business_rule_deleted",
]);

/**
 * Target summary for govt_business_rule_* audit rows: the 3 rule-mutation
 * action codes are generic across every rule type (design decision — see
 * lib/ui/audit-action-labels.test.ts), so the row itself carries no target
 * reference. The writers already put ruleType + jurisdiction in
 * `auditLog.payload` — this derives a "ruleType @ jurisdiction" summary from
 * it instead of leaving the row un-attributable (previously: action + actor
 * + timestamp only, impossible to tell WHICH rule was mutated without
 * cross-referencing timestamps). Pure function — no DB calls.
 */
export function businessRuleTargetSummary(action: string, payload: unknown): string | null {
  if (!BUSINESS_RULE_ACTIONS.has(action)) return null;
  if (payload == null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const ruleType = typeof p.ruleType === "string" ? p.ruleType : null;
  if (!ruleType) return null;
  const jurisdiction = p.jurisdiction as
    | { country?: string | null; province?: string | null; locality?: string | null }
    | undefined;
  const parts = [
    jurisdiction?.country ?? "AR",
    jurisdiction?.province ?? "(nivel país)",
    jurisdiction?.locality ?? "(toda la provincia)",
  ];
  return `${ruleType} @ ${parts.join(" · ")}`;
}
