import { LnEmptyState } from "@/components/ui/EmptyState";
import {
  OpCard,
  OpCardBody,
  OpCardHead,
  type OpFilterAxis,
  OpFilterBar,
  ViewScopeCaption,
} from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import { fetchSurveillanceSignals } from "@/lib/analytics/govt-dashboards";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { computeConfidence, isAtLeast } from "@/lib/events/event-confidence";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { DISEASES } from "@/lib/reference/diseases";
import { describeNarrowedView } from "@/lib/ui/view-scope-caption";
import { pluralizeEs } from "@/lib/utils/format";
import { OutbreakSignalRow } from "../_components/OutbreakSignalRow";
import { ScrollToSignal } from "../_components/ScrollToSignal";
import { VerifiedFilterCheckbox } from "../_components/VerifiedFilterCheckbox";

// Disease/zoonosis axis — the page already reads the disease_code from each
// signal's payload, and fetchSurveillanceSignals applies `disease_code = X`
// when filters.diseaseCode is set (previously wired but never surfaced — the
// TODO this axis replaces). Options come from the SAME curated catalog
// (lib/reference/diseases.ts) the disease-diagnosis form and mortality
// disposition screens use — never an invented list.
const DISEASE_OPTIONS = DISEASES.map((d) => ({ value: d.code, label: d.label }));

export default async function GobVigilanciaBrotesPage({
  searchParams,
}: {
  searchParams: Promise<{
    period?: string;
    from?: string;
    to?: string;
    signalId?: string;
    soloVerificados?: string;
    province?: string;
    locality?: string;
    diseaseCode?: string;
  }>;
}) {
  const { profile, jurisdictions } = await requireGobReadAccessOrRedirect();
  const actor = { role: profile.role };
  const sp = await searchParams;

  const days = sp.period === "7d" ? 7 : sp.period === "90d" ? 90 : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

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

  // Validate against the real catalog — an unrecognized/stale code in the URL
  // is dropped rather than silently sent to the DB as a narrowing predicate
  // that would (dishonestly) return zero rows.
  const diseaseCode =
    sp.diseaseCode && DISEASES.some((d) => d.code === sp.diseaseCode) ? sp.diseaseCode : undefined;

  // A.5: tier-based filter — "Solo verificados institucionalmente".
  // Read before the load because the filter bar (which renders in both
  // branches) needs it; the filtering itself happens after.
  const soloVerificados = sp.soloVerificados === "1";

  // Header + filter bar render in BOTH the data and the degraded branch (same
  // shape as app/gob/censo/CensoScreen.tsx). Nothing here depends on the
  // fetcher below, and dropping the bar on timeout removed the period, the
  // jurisdiction and the disease axis — the only controls that could have
  // narrowed the query that timed out, while "Reintentar" re-issues it as is.
  const shell = (
    <>
      <ScreenHeader
        className="space-y-2"
        eyebrow="Vigilancia · Brotes"
        title="Brotes y señales epidemiológicas"
        subtitle={
          <>
            {/* The universal claim yields to the narrowed-view caption (never both). */}
            {hasNationalReadScope(profile.role) ? (
              narrowedView ? null : (
                <p className="text-md text-ln-op-mute">
                  Vista universal — todas las jurisdicciones.
                </p>
              )
            ) : (
              <p className="text-md text-ln-op-mute">
                Lista completa de señales de brote en tu cobertura.
              </p>
            )}
            <ViewScopeCaption scope={narrowedView} />
          </>
        }
      />

      {/* Unified filter bar — period + jurisdiction + disease axis, same rail as
          vigilancia's own /gob/vigilancia. A.5's confidence-tier toggle ("solo
          verificados institucionalmente") is a per-screen boolean, not a
          select-driven axis, so it lives in the free-form `children` slot —
          the OpCheckbox itself commits via the SAME serverNavCommit path as
          the bar's own controls (see VerifiedFilterCheckbox), so toggling it
          never drops the active period/jurisdiction/disease the way the old
          hidden-input <form> did. */}
      <OpFilterBar
        period={{ defaultPreset: "30d" }}
        jurisdiction={{ allowedProvinces, localities }}
        axes={
          [
            {
              id: "diseaseCode",
              label: "Enfermedad",
              paramKey: "diseaseCode",
              options: DISEASE_OPTIONS,
              current: diseaseCode ?? null,
            },
          ] satisfies OpFilterAxis[]
        }
      >
        <VerifiedFilterCheckbox defaultChecked={soloVerificados} />
      </OpFilterBar>
    </>
  );

  // BOUNDED (outage pass 2026-08-09). /gob/vigilancia bounds this same fetcher;
  // the brotes sub-route did not.
  const load = await loadWithTimeout(
    fetchSurveillanceSignals(actor, filteredJurisdictions, { since, diseaseCode }),
  );
  if (!load.ok) {
    return (
      <div className="space-y-6">
        {shell}
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref={analyticsRetryHref("/gob/vigilancia/brotes", sp)}
        />
      </div>
    );
  }
  const allSignals = load.value;

  // When the checkbox is active, filter to signals where tier >= professional_verified.
  const signals = soloVerificados
    ? allSignals.filter((s) =>
        isAtLeast(
          computeConfidence({
            authorRole: s.authorRole,
            authorVerified: s.authorVerified,
            authorOrganizationId: s.authorOrganizationId,
            payload: s.payload,
          }),
          "professional_verified",
        ),
      )
    : allSignals;

  // Deep-link target (?signalId=): highlight + scroll the matching row into
  // view. Only activates when the requested signal is actually present in the
  // current (filtered) result set — a stale or out-of-window id is a no-op.
  const targetSignalId = sp.signalId ?? null;
  const hasSignalTarget =
    targetSignalId != null && signals.some((s) => s.signalEventId === targetSignalId);

  const panelId = "panel-brotes-titulo";

  return (
    <div className="space-y-6">
      {/* Header + filter bar — hoisted above the load so the degraded branch
          keeps them (see the `shell` definition). */}
      {shell}

      <OpCard aria-labelledby={panelId}>
        <OpCardHead
          title={
            <span id={panelId}>
              {signals.length} {pluralizeEs(signals.length, "señal")}
            </span>
          }
        />
        <OpCardBody className="p-0">
          {signals.length === 0 ? (
            <div className="px-4 py-3">
              {/* C4 (2026-07-22, §S4): same reasoning as /gob/vigilancia's
                  "Señales recientes" panel — no-signal, not "all clear". */}
              <LnEmptyState
                icon="eye-off"
                nature="no-signal"
                title="Sin señales registradas en miMAR"
                description="La ausencia de señales no implica ausencia de enfermedad — nadie reportó un caso en este período."
              />
            </div>
          ) : (
            <ul className="px-3">
              {signals.map((s) => (
                <OutbreakSignalRow
                  key={s.signalEventId}
                  signal={s}
                  highlighted={s.signalEventId === targetSignalId}
                />
              ))}
            </ul>
          )}
        </OpCardBody>
      </OpCard>

      {hasSignalTarget && targetSignalId != null && <ScrollToSignal signalId={targetSignalId} />}
    </div>
  );
}
