import Link from "next/link";

import { Icon } from "@/components/Icon";
import { LnEmptyState } from "@/components/ui/EmptyState";
import {
  OpBreach,
  OpCard,
  OpCardBody,
  OpCardHead,
  OpFilterBar,
  OpPill,
  ViewScopeCaption,
} from "@/components/ui/dashboard";
import { CASE_STATUS_CONFIG } from "@/components/ui/dashboard/CaseStatusBadge";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { listOutbreakInvestigationsForGovt } from "@/lib/infra/case-queries";
import { describeNarrowedView } from "@/lib/ui/view-scope-caption";
import { formatDateTime } from "@/lib/utils/format";
import { caseOpenedReasonDisplay } from "@/src/modules/cases/domain/opened-reason-display";

// Label comes from the same CaseStatus vocabulary the unified case queue
// renders (CASE_STATUS_CONFIG) — these investigations are `cases` rows too,
// so the same status must never read differently here vs /gob/casos.
const STATUS_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(CASE_STATUS_CONFIG).map(([status, cfg]) => [status, cfg.label]),
);

type PillTone = "open" | "escalated" | "closed";
const STATUS_PILL_TONE: Record<string, PillTone> = {
  open: "open",
  escalated: "escalated",
  closed: "closed",
};

export default async function GobInvestigacionesPage({
  searchParams,
}: {
  searchParams: Promise<{ province?: string; locality?: string }>;
}) {
  const { profile, jurisdictions } = await requireGobReadAccessOrRedirect();
  // Universal READ scope (admin | national) — the flag the list loader takes
  // to skip the jurisdiction predicate.
  const isAdmin = hasNationalReadScope(profile.role);
  const sp = await searchParams;

  // Same pattern as /gob/vigilancia and /gob/vigilancia/brotes: resolve the
  // jurisdiction scope (fence — govt narrows DOWN only, never widens) and
  // thread the admin drill-down (province/locality names) the same way
  // /gob/vigilancia does.
  const {
    filteredJurisdictions,
    localities,
    allowedProvinces,
    adminSelectedProvince,
    adminSelectedLocality,
  } = await resolveJurisdictionScope({
    role: profile.role,
    jurisdictions,
    params: { province: sp.province, locality: sp.locality },
  });
  const adminProvince = adminSelectedProvince ?? undefined;
  const adminLocality = adminSelectedLocality ?? undefined;

  // C3 disclosure: caption when this page's filters narrow below the mandate.
  const narrowedView = describeNarrowedView({
    role: profile.role,
    mandateJurisdictions: jurisdictions,
    effectiveJurisdictions: filteredJurisdictions,
    adminProvince,
    adminLocality,
  });

  const investigations = await listOutbreakInvestigationsForGovt(filteredJurisdictions, isAdmin, {
    adminProvince,
    adminLocality,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <ScreenHeader
          eyebrow="Vigilancia · Investigaciones"
          title="Investigaciones de brote"
          subtitle={
            <>
              <p className="text-md text-ln-op-mute">
                Casos abiertos, escalados y cerrados en los últimos 90 días.
              </p>
              <ViewScopeCaption scope={narrowedView} />
            </>
          }
        />
        <Link
          href="/gob/vigilancia/investigaciones/nuevo"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-[var(--radius-md)] bg-ln-op-azul text-white text-md font-medium hover:bg-ln-op-azul-700 transition-colors no-underline"
        >
          Nueva investigación
        </Link>
      </div>

      <OpBreach
        title="Notificación externa no integrada"
        detail="La notificación obligatoria a SNVS/SENASA/zoonosis (Ley 15.465/60, Decreto 3640/64) NO está integrada en esta versión. Realizala a través de los canales habituales de tu jurisdicción."
        icon={<Icon name="alerta" decorative />}
      />

      {/* Unified filter bar — jurisdiction only (no period control on this
          screen, same as before migration); selecting a province/locality
          narrows the list below (never widens beyond the operator's
          assignments). */}
      <OpFilterBar showPeriod={false} jurisdiction={{ allowedProvinces, localities }} />

      <OpCard>
        <OpCardHead
          title={
            <span>
              {investigations.length === 1
                ? "1 investigación"
                : `${investigations.length} investigaciones`}
            </span>
          }
        />
        <OpCardBody className="p-0">
          {investigations.length === 0 ? (
            <div className="px-4 py-3">
              {/* C4 (2026-07-22, §S4): unlike the disease-signal panels above
                  this is an internal work queue — investigations are opened
                  by staff, not passively reported in, and the underlying
                  signal count (the outbreak-signal tile, KPI_CATALOG entry
                  `outbreak_active_signals` — renamed 2026-09-16 once it was
                  clear it counts a 30-day flow and not a stock of open
                  outbreaks) is already visible
                  side-by-side on /gob/vigilancia. A real, verified zero:
                  measured-zero. */}
              <LnEmptyState
                icon="shield-check"
                nature="measured-zero"
                title="Sin investigaciones en este periodo"
                description="No hay investigaciones de brote en tu cobertura en los últimos 90 días."
              />
            </div>
          ) : (
            <ul className="divide-y divide-ln-op-line-2">
              {investigations.map((inv) => (
                <li
                  key={inv.id}
                  className="px-4 py-3 flex items-center justify-between gap-4 odd:bg-ln-op-stripe"
                >
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-ln-mono text-sm text-ln-op-mute">{inv.publicCode}</span>
                      <OpPill tone={STATUS_PILL_TONE[inv.status] ?? "neutral"}>
                        {STATUS_LABEL[inv.status] ?? inv.status}
                      </OpPill>
                    </div>
                    {/* Render through the display dispatch, never the raw audit
                        string: this list used to substring `openedReason`
                        directly, so a funcionario read "manual [rabia_urbana]:
                        …" — the writer's machine grammar — truncated at 80
                        chars. The detail page one level down was already
                        migrated; this list was the surface the columns were
                        plumbed to and never wired. CSS truncates; slicing the
                        string cut mid-word and mid-token. */}
                    <p className="text-md text-ln-op-ink truncate">
                      {caseOpenedReasonDisplay({
                        openedReasonCode: inv.openedReasonCode,
                        openedReasonParams: inv.openedReasonParams,
                        openedReason: inv.openedReason,
                      })}
                    </p>
                    <p className="text-sm text-ln-op-mute">
                      {[inv.jurisdictionLocality, inv.jurisdictionProvince]
                        .filter(Boolean)
                        .join(", ") || "Jurisdicción nacional"}{" "}
                      &middot; Abierta {formatDateTime(inv.openedAt)}
                    </p>
                  </div>
                  <Link
                    href={`/gob/vigilancia/investigaciones/${inv.publicCode}`}
                    className="shrink-0 px-3 py-1.5 rounded-[var(--radius-md)] border border-ln-op-line text-md text-ln-op-azul hover:bg-ln-op-stripe transition-colors no-underline"
                  >
                    Ver &rarr;
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </OpCardBody>
      </OpCard>
    </div>
  );
}
