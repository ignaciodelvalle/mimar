// Read-only GET /api/panorama/rule-changes — the TimeScrubber's rule-change
// marker layer (política → resultado on the timeline, 2026-08-02).
//
// Returns recent govt_business_rules mutations (from audit_log, via the
// tested fetchRuleChanges) scoped to the console's effective jurisdiction.
// Auth MIRRORS the sibling /api/panorama/* routes EXACTLY:
//   - resolveInstitutionalPanoramaActor (_guard.ts): ACTIVE INSTITUTIONAL
//     admin/govt only — 401/403 for everyone else, 429 on the aggregate cap.
//   - scope is parsed from the query string (province/locality, same keys as
//     the dashboards) and INTERSECTED with the viewer's actual assignments
//     via narrowGovtScope — a govt user can NEVER widen scope by crafting
//     params (G1: for /gob/panorama this is access control, not a filter).
//     An out-of-scope request answers an EMPTY list (fail-closed, same
//     posture as the sibling scope route's defense-in-depth).
//
// National rules (province null) always pass through fetchRuleChanges'
// scope filter — a jurisdiction-scoped operator is still governed by them.
//
// TRANSACTION BASIS BY CONSTRUCTION: `changedAt` is audit_log.performed_at —
// when the change was ENTERED INTO DIM. The client labels it "cambio
// registrado el …", never "vigente desde" (the real-world decision date is
// unknowable from the audit spine).

import { NextResponse } from "next/server";

import {
  POLICY_OUTCOME_MAX_CHANGES,
  type RuleChangeRow,
  type RuleChangeScope,
  fetchRuleChanges,
} from "@/lib/analytics/policy-outcome";
import { isWholeProvinceAssignment, narrowGovtScope } from "@/lib/domain/jurisdiction-canonical";
import { localityByName } from "@/lib/infra/ar-localidades";
import { type ProvinceCode, provinceByCode } from "@/lib/reference/ar-provincias";

import { withDbBudget } from "@/lib/infra/db-budget";

import { resolveInstitutionalPanoramaActor } from "../_guard";

// Annotation layer, not critical path: on a degraded pooler the markers simply
// don't render this refresh (the scrubber stays fully usable without them).
const RULE_CHANGES_BUDGET_MS = 4_000;

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: Request) {
  // 1. Non-redirect auth — same full invariant set as every panorama route.
  const auth = await resolveInstitutionalPanoramaActor();
  if (!auth.ok) return auth.response;
  const { profile, jurisdictions } = auth.actor;

  // 2. Resolve the requested province/locality to canonical display names
  //    (rules are stored with canonical names — see policy-outcome.ts SCOPING).
  //    Same ISO-code + slug resolution as the sibling kpis route.
  const url = new URL(request.url);
  const provinceIso = url.searchParams.get("province");
  const localitySlug = url.searchParams.get("locality");
  const provinceObj = provinceIso ? provinceByCode(provinceIso) : null;
  const localityRow =
    provinceObj && localitySlug
      ? await localityByName(provinceObj.code as ProvinceCode, localitySlug)
      : null;

  // 3. Scope resolution. Admin: the requested drill (or platform-wide).
  //    Govt: intersect the request with the actor's assignments — NEVER the
  //    raw client param. One fetch scope per surviving assignment tuple
  //    (fetchRuleChanges takes a single-province scope): a whole-province
  //    assignment queries province-wide; a locality assignment queries only
  //    its own locality, so a two-barrio operator never reads a third
  //    barrio's rule history through a province-wide query.
  let scopes: Array<RuleChangeScope | undefined>;
  if (profile.role === "admin") {
    scopes = [
      provinceObj
        ? {
            province: provinceObj.name,
            ...(localityRow ? { locality: localityRow.localityName } : {}),
          }
        : undefined,
    ];
  } else {
    const narrowed = narrowGovtScope(
      jurisdictions,
      provinceObj?.name ?? null,
      localityRow?.localityName ?? null,
    );
    // Out-of-scope request (or no active assignments): fail-closed, no query.
    if (narrowed.length === 0) {
      return NextResponse.json({ changes: [] }, { headers: NO_STORE });
    }
    scopes = narrowed.map((j) =>
      isWholeProvinceAssignment(j)
        ? { province: j.province }
        : { province: j.province, locality: j.locality },
    );
  }

  // 4. Fetch per scope, merge, dedupe (national rules appear in EVERY scoped
  //    result), newest first, capped at the same limit a single fetch has.
  try {
    const results = await Promise.all(
      scopes.map((scope, i) =>
        withDbBudget(
          fetchRuleChanges(POLICY_OUTCOME_MAX_CHANGES, scope),
          RULE_CHANGES_BUDGET_MS,
          `panorama/rule-changes scope#${i}`,
          [] as RuleChangeRow[],
        ),
      ),
    );
    const byAuditId = new Map<string, RuleChangeRow>();
    for (const rows of results) {
      for (const row of rows) byAuditId.set(row.auditId, row);
    }
    const changes = Array.from(byAuditId.values())
      .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime())
      .slice(0, POLICY_OUTCOME_MAX_CHANGES)
      .map((row) => ({
        auditId: row.auditId,
        action: row.action,
        ruleType: row.ruleType,
        province: row.province,
        locality: row.locality,
        changedAt: row.changedAt.toISOString(),
      }));
    return NextResponse.json({ changes }, { headers: NO_STORE });
  } catch (err) {
    console.error("[GET /api/panorama/rule-changes] failed:", err);
    return NextResponse.json(
      { error: "rule_changes_unavailable", changes: [] },
      { status: 503, headers: NO_STORE },
    );
  }
}
