// AdminKpiStrip — the shared operational KPI strip for the admin portal.
//
// WHY (critique C26): the admin landing (/admin) and /admin/sistema both render
// the same operational quartet — Usuarios personales / Aprobaciones pendientes /
// Decisiones 7d / SLA ENO — with the same tones, info tooltips and drill hrefs.
// They had drifted (label wording, SLA presence). This component is the single
// presentational source of truth so the tiles can't diverge again.
//
// PRESENTATIONAL ONLY — no data fetching. Each page keeps its own fetchers and
// passes the already-computed values in as props. SLA ENO is optional so the
// landing (which doesn't fetch ENO) can render the 3-tile variant.
//
// Tokens: relies entirely on OpKpi (design tokens `ln-op-*`). No raw colours.

import { OpKpi } from "@/components/ui/dashboard";
import { enoSlaHeadline, enoSlaTone } from "@/lib/metrics";
import { KPI_CATALOG, getKpiInfo } from "@/lib/metrics/kpi-catalog";
import { formatPercent } from "@/lib/utils/format";

export type AdminKpiStripData = {
  /** Total personal accounts (count). */
  totalPersonal: number;
  /**
   * Active institutional accounts (count). Rendered in place of the pending-queue
   * tile when `omitPendingQueue` is set (the admin home, where the cockpit above
   * already owns the pending number). Omit when the pending tile is shown.
   */
  totalInstitutionalActive?: number;
  /** Queue: pending approvals right now. */
  pendingTotal: number;
  /** Queue: age in days of the oldest pending request (null when none pending). */
  oldestPendingDaysAgo: number | null;
  /** Decisions: count of approvals + rejections in the trailing 7d. */
  decisionsTotal7d: number;
  /** Decisions: approvals in the trailing 7d (for the sub line). */
  approved7d: number;
  /** Decisions: rejections in the trailing 7d (for the sub line). */
  rejected7d: number;
  /**
   * Decisions: percent change vs the approximated prior 7d window, or null when
   * there is no baseline. Compute with `decisionsDeltaPct` (lib/metrics) —
   * pass its `.pct`.
   */
  decisionsDelta: number | null;
  /**
   * T4.10 (2026-08-01): the approximated prior-week base the delta above was
   * computed against — `decisionsDeltaPct`'s `.priorBase`. Fed to OpKpi's
   * `guardInput.priorBase` so a delta swung wildly by a near-zero base (the
   * "n=2" class) renders with no colored verdict instead of a confident %.
   */
  decisionsPriorBase: number | null;
  /**
   * Drill href for the Decisiones 7d tile. Build with `decisionsAuditDrillHref`
   * (lib/ui/audit-filters) so the link carries the decision-action + last-7d
   * filters and lands on the reconcilable rows — not the all-time audit log.
   * Falls back to the unfiltered log when omitted.
   */
  decisionsDrillHref?: string;
  /**
   * ENO SLA on-time percentage (0–100), or null when there is no data.
   * Omit the whole `enoSla` prop to render the 3-tile variant (landing).
   */
  enoSla?: {
    onTimePct: number | null;
    breachedOpen: number;
    total: number;
    /** Median delivery latency (h) — fed to the shared enoSlaHeadline sub-line. */
    medianLatencyHours: number | null;
  };
};

/**
 * Renders the shared operational KPI tiles inside a responsive grid.
 *
 * The grid auto-fits 3 tiles (no ENO) or 4 tiles (with ENO). The caller owns
 * the surrounding <section>/heading; this returns the tiles wrapped in a grid
 * so the layout stays consistent across both pages.
 */
/**
 * Provenance context for the strip's catalogued tiles ("Ver origen" card).
 * The admin portal is national by definition (the pending tile's own caveat:
 * "todas las jurisdicciones") — no page-level filter narrows it, so the scope
 * is a static truth, not a recomputation. Period/freshness are NOT threaded:
 * the card falls back to the catalog's own window declaration and an honest
 * "No disponible." (neither admin page renders a freshness footer).
 */
const ADMIN_PROVENANCE = { scopeLabel: "Nacional (todas las jurisdicciones)" };

export function AdminKpiStrip({
  data,
  omitPendingQueue = false,
}: {
  data: AdminKpiStripData;
  /**
   * Hide the pending-approvals tile (queue_pending_total) and render
   * Instituciones activas in its place. Used by the admin home, where the
   * QueueHealthCockpit above already shows the pending count (per-type) — the
   * two must not duplicate it (PO ronda 4 + Cowork B1). /admin/sistema keeps
   * the pending tile (no duplication there).
   */
  omitPendingQueue?: boolean;
}) {
  const hasEno = data.enoSla !== undefined;
  const eno = data.enoSla;

  return (
    <div
      className={[
        "grid grid-cols-1 gap-3 sm:grid-cols-2",
        hasEno ? "lg:grid-cols-4" : "sm:grid-cols-3",
      ].join(" ")}
    >
      <OpKpi
        label="Usuarios personales"
        value={data.totalPersonal}
        // F3+F7 fusion (2026-07-22): Usuarios is now the admin Directorio
        // hub's "usuarios" tab — link straight there instead of through the
        // old /admin/usuarios redirect.
        href="/admin/directorio?registro=usuarios"
        info={{
          definition: "Total de cuentas personales activas en la plataforma.",
          formula: "count(*) where account_type = 'personal'",
        }}
      />
      {omitPendingQueue ? (
        // The cockpit above owns the pending-approvals number (broken out per
        // type), so the home strip promotes a non-duplicated metric here instead.
        <OpKpi
          label="Instituciones activas"
          value={data.totalInstitutionalActive ?? 0}
          // F3+F7 fusion (2026-07-22): Organizaciones is now the admin
          // Directorio hub's "organizaciones" tab — link straight there
          // instead of through the old /admin/organizaciones redirect.
          href="/admin/directorio?registro=organizaciones"
          info={{
            definition: "Cuentas institucionales activas (no desactivadas).",
            formula: "count(*) where account_type = 'institutional' and deactivated_at is null",
          }}
        />
      ) : (
        <OpKpi
          // Registry-import fence (lint:metric-labels): this label is
          // catalogued (queue_pending_total) — import it instead of
          // retyping the string, so the two render sites can never drift.
          label={KPI_CATALOG.queue_pending_total.label}
          value={data.pendingTotal}
          tone={data.pendingTotal > 0 ? "warn" : "neutral"}
          sub={
            data.oldestPendingDaysAgo != null
              ? `Más antigua pendiente: ${data.oldestPendingDaysAgo}d`
              : undefined
          }
          href="/admin/cola"
          info={{
            definition: "Solicitudes de aprobación en estado pendiente en este momento.",
            caveat: "Incluye solicitudes de todas las jurisdicciones.",
          }}
          // Provenance: the tile renders the catalogued queue_pending_total —
          // the descriptor unlocks "Ver origen" (and honestly tags the stock
          // as period-invariant, which it is).
          descriptorId="queue_pending_total"
          provenance={ADMIN_PROVENANCE}
        />
      )}
      {(() => {
        // Zero-activity is not a crash (Cowork B2): a demo week with no
        // decisions previously rendered "0" in ok-green with a red "−100%"
        // deltaV2 (↓ arrow) — reading as "something broke". When there are no
        // decisions this week, render a neutral "Sin decisiones esta semana"
        // and suppress the delta chip entirely (a −100% vs a prior week is not
        // an alarm on an empty demo).
        const noDecisions = data.decisionsTotal7d === 0;
        return (
          <OpKpi
            // Registry-import fence (lint:metric-labels): this label is now
            // catalogued (queue_decisions_7d, T4.10) — import it instead of
            // retyping the string, same convention as queue_pending_total
            // above.
            label={KPI_CATALOG.queue_decisions_7d.label}
            value={data.decisionsTotal7d}
            tone={noDecisions ? "neutral" : "ok"}
            sub={
              noDecisions
                ? "Sin decisiones esta semana"
                : `${data.approved7d} aprobadas · ${data.rejected7d} rechazadas`
            }
            href={data.decisionsDrillHref ?? "/admin/auditoria"}
            deltaV2={
              !noDecisions && data.decisionsDelta !== null
                ? { value: data.decisionsDelta, period: "vs 7d anteriores (aprox.)" }
                : undefined
            }
            // T4.10: routes the delta through queue_decisions_7d's
            // unstableDeltaBase guard — a swing against a prior-week base
            // under 5 decisions renders no colored verdict (guarded note),
            // never a confident "+900%".
            descriptorId="queue_decisions_7d"
            guardInput={
              data.decisionsPriorBase !== null ? { priorBase: data.decisionsPriorBase } : undefined
            }
            provenance={ADMIN_PROVENANCE}
          />
        );
      })()}
      {hasEno &&
        eno &&
        (() => {
          // red-team-admin-2 P2.2: this strip (on /admin/sistema) had its OWN
          // inline SLA render — a THIRD copy of the headline that never received
          // the #1/Path-B fixes applied to enoSlaHeadline, so it still showed
          // "Cumplimiento histórico 100% (referencia)" beside "12 vencidas". Route
          // it through the SHARED enoSlaHeadline so there is ONE source of truth:
          // with an open breach it drops the misleading % and shows median
          // latency; otherwise it headlines the on-time %. (tone still via
          // enoSlaTone, which degrades to warn/danger on any open breach.)
          const headline = enoSlaHeadline(eno, formatPercent);
          return (
            <OpKpi
              label="SLA ENO"
              value={headline.value}
              tone={enoSlaTone(eno)}
              sub={headline.sub}
              href="/admin/outbox"
              info={getKpiInfo("eno_sla_compliance")}
              // Provenance: same catalogued KPI the info already resolves —
              // the descriptor unlocks "Ver origen" (its zeroDenominator guard
              // is manualEnforcement via enoSlaHeadline/enoSlaTone above).
              descriptorId="eno_sla_compliance"
              provenance={ADMIN_PROVENANCE}
            />
          );
        })()}
    </div>
  );
}
