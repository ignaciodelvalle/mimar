// /gob/reglas — THE single rules console (design ADR-1). Server-side
// capability branch on profile.role:
//   - admin lens: inline CRUD at universal scope + jurisdiction picker
//     (folded in verbatim from the old /admin/jurisdicciones surface).
//   - govt lens: read-only resolved-cascade view, pre-scoped to the user's
//     own institutional assignments (unchanged behavior, BR6 preserved).
//
// Mirrors app/gob/servicios/page.tsx — one page, two presentational lenses,
// not parallel routes (AC3 pattern).

import { OpCard, OpCardBody, OpCardHead, OpCodeBadge } from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { GOVT_BUSINESS_RULE_TYPES } from "@/db";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import {
  RULE_TYPE_REGISTRY,
  RULE_SOURCE_LABEL as SOURCE_LABEL,
  summarizeRulePayload,
} from "@/lib/domain/rule-types-registry";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { portalBase } from "@/lib/ui/portal-base";
import { trimmedSearchParam } from "@/lib/utils/search-params";

import { AdminReglasLens } from "./AdminReglasLens";

export const dynamic = "force-dynamic";

export default async function ReglasPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const { jurisdictions, profile } = await requireAdminOrGovtOrRedirect();
  const base = await portalBase();

  if (profile.role === "admin") {
    // Rule-kind filter (PO redesign 2026-07-23) only applies to the admin
    // lens — it's now a short list of ONLY the jurisdictions that have custom
    // rules, so a "which jurisdictions touched this rule kind?" dropdown is
    // useful. The govt read-only cascade view below is pre-scoped to the
    // viewer's own few assigned localities — always a short, already-filtered
    // list — so a filter there would narrow almost nothing.
    const { kind } = await searchParams;
    // Q1: a repeated ?kind= hands Next a string[] — raw `.trim()` on that
    // throws (500).
    return <AdminReglasLens base={base} kind={trimmedSearchParam(kind) ?? ""} />;
  }

  return <GovtReglasReadOnlyView jurisdictions={jurisdictions} />;
}

async function GovtReglasReadOnlyView({
  jurisdictions,
}: {
  jurisdictions: { province: string | null; locality: string | null }[];
}) {
  const scopes =
    jurisdictions.length === 0
      ? [{ province: null as string | null, locality: null as string | null }]
      : jurisdictions;

  // BOUNDED — it was awaited bare, and this page issues more queries per render
  // than anything else in the portal: `scopes × GOVT_BUSINESS_RULE_TYPES` (10),
  // each resolveBusinessRule walking up to three candidates (locality →
  // province → country).
  //
  // The count, corrected — an earlier version of this comment claimed "up to 30
  // SEQUENTIAL round-trips per jurisdiction, 150 for five". That was wrong on
  // both axes: both maps are Promise.all, so the ten rule types resolve
  // CONCURRENTLY, and the sequential part is only the 3-deep cascade inside one
  // resolution (which also short-circuits — a country-level scope does exactly
  // one query per type). So L localities is ≤30L queries at pool concurrency,
  // not 30L serialized. 10s of budget has an order of magnitude of headroom.
  //
  // WHAT THE DEADLINE DOES NOT DO IS CANCEL. The queries keep running after it
  // fires, and the fallback below offers "Reintentar" — which on a degraded DB
  // launches another full batch while the first still holds pool slots
  // (prod max: 5). That is the abandoned-backend spiral scripts/check-db-budget
  // names as the task #74 failure. The deadline stops the hang; it does not
  // make this page cheap.
  //
  // The real fix is one query for the jurisdictions' rules plus an in-memory
  // cascade, filed separately. It has to live at THIS call site, not in the
  // resolver: resolveBusinessRule accepts an optional transaction executor, so
  // it can be neither cached nor batched globally without a worse bug.
  const load = await loadWithTimeout(
    Promise.all(
      scopes.map(async (scope) => {
        const resolved = await Promise.all(
          GOVT_BUSINESS_RULE_TYPES.map(async (ruleType) => {
            const r = await resolveBusinessRule(ruleType, {
              country: "AR",
              province: scope.province ?? undefined,
              locality: scope.locality ?? undefined,
            });
            return { ruleType, ...r };
          }),
        );
        return { scope, resolved };
      }),
    ),
  );

  // Hoisted above the load so the degraded branch keeps it: a page that loses
  // its title tells the operator nothing about WHERE the failure happened.
  // Same shape as app/gob/censo/CensoScreen.tsx.
  const header = (
    <ScreenHeader
      eyebrow="miMAR Gobierno · Reglas"
      title="Reglas que aplican a tu jurisdicción"
      subtitle={
        <p className="text-md text-ln-op-ink-2">
          Vista de solo lectura, pre-filtrada a tus localidades asignadas. La administración de
          reglas la hace el admin nacional.
        </p>
      }
    />
  );

  if (!load.ok) {
    return (
      <div className="space-y-6 max-w-3xl">
        {header}
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref={analyticsRetryHref("/gob/reglas")}
        />
      </div>
    );
  }
  const groups = load.value;

  return (
    <div className="space-y-6 max-w-3xl">
      {header}

      {groups.map((g, idx) => (
        <OpCard key={`${g.scope.province ?? "country"}-${g.scope.locality ?? "all"}-${idx}`}>
          <OpCardHead
            title={
              g.scope.province == null
                ? "AR · (nivel país)"
                : g.scope.locality == null
                  ? `AR · ${g.scope.province}`
                  : `AR · ${g.scope.province} · ${g.scope.locality}`
            }
          />
          <OpCardBody className="p-0">
            <ul className="divide-y divide-ln-op-line-2">
              {g.resolved.map(({ ruleType, payload, source }) => (
                <li key={ruleType} className="px-4 py-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-md font-medium text-ln-op-ink">
                      {RULE_TYPE_REGISTRY[ruleType].label}
                    </p>
                    <span className="text-sm text-ln-op-mute">{SOURCE_LABEL[source]}</span>
                  </div>
                  {ruleType === "ppp_breed_list" &&
                  payload != null &&
                  typeof payload === "object" &&
                  "breeds" in payload &&
                  Array.isArray((payload as { breeds: unknown }).breeds) ? (
                    <div className="flex flex-wrap gap-1.5">
                      {(payload as { breeds: string[] }).breeds.map((breed) => (
                        <OpCodeBadge key={breed} tone="neutral">
                          {breed}
                        </OpCodeBadge>
                      ))}
                    </div>
                  ) : (
                    // es-AR summary instead of raw JSON — operators read the
                    // console, they don't parse payloads (QA round 2 #7).
                    <p className="text-md text-ln-op-ink-2">
                      {summarizeRulePayload(ruleType, payload)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </OpCardBody>
        </OpCard>
      ))}
    </div>
  );
}
