// /admin/alertas — Bandeja de alertas + triage (Paquete K).
//
// Lists alert_firings (the lifecycle records opened when an alert_subscriptions
// threshold is crossed) and lets an admin work each alert through its state
// machine: reconocer → investigar / registrar seguimiento → contactar autoridad
// → resolver / descartar. Dedicated a11y table (NOT CaseQueue — firings are not
// CaseListItem-shaped). Every list view writes a pii_queried audit row
// (surface: "alert_inbox").
//
// Auth: requireAdminOrRedirect (admin-only; govt + everyone else → /).

import { AlertInboxTable } from "@/components/admin/AlertInboxTable";
import {
  DateRangeFilterFields,
  OpCard,
  OpCardBody,
  OpCardHead,
  type OpFilterAxis,
  OpFilterBar,
} from "@/components/ui/dashboard";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import {
  ALERT_FIRING_STATUSES,
  ALERT_METRIC_KEYS,
  type AlertFiring,
  type AlertMetricKey,
} from "@/db/schema";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { withDbBudget } from "@/lib/infra/db-budget";
import {
  type AlertInboxFilters,
  fetchAlertFirings,
  logAlertInboxView,
} from "@/lib/metrics/alert-firing-inbox";
import { PROVINCES } from "@/lib/reference/ar-provincias";

import { AlertEstadoFilter } from "./_components/AlertEstadoFilter";

export const dynamic = "force-dynamic";

// Server-render budget for the inbox fetch. On expiry (or a fetcher rejection,
// caught below) the page renders a degraded-but-honest state — "no pudimos
// cargar la bandeja, reintentá" — instead of hanging the RSC stream forever
// behind loading.tsx (QA histórico 2026-07-08: deterministic 25s+ eternal
// spinner). Mirrors the panorama page's withDbBudget guard (task #74).
const PAGE_BUDGET_MS = 9000;

const METRIC_LABEL: Record<string, string> = {
  active_zoonosis: "Zoonosis activos",
  eno_sla_ontime_pct: "SLA ENO (%)",
  queue_oldest_days: "Días sin atender",
  sterilization_coverage_pct: "Cobertura esteriliz. (%)",
  microchip_penetration_pct: "Microchip (%)",
  open_welfare_reports: "Maltrato abiertas",
};

const STATUS_FILTER_LABEL: Record<string, string> = {
  open: "Abiertas (todas)",
  all: "Todas",
  disparada: "Disparada",
  reconocida: "Reconocida",
  en_investigacion: "En investigación",
  autoridad_contactada: "Autoridad contactada",
  resuelta: "Resuelta",
  descartada: "Descartada",
};

// Domain-axis/child-control options for the OpFilterBar (F-migration
// 2026-07-21, off the bespoke <form>) — same values/labels the old hand-rolled
// selects used. Estado is NOT an axis — see AlertEstadoFilter (BUGFIX
// opfilterbar-sweep-2026-07-21: its default is the specific "open" subset,
// not "all").
const METRIC_OPTIONS = ALERT_METRIC_KEYS.map((m) => ({
  value: m,
  label: METRIC_LABEL[m] ?? m,
}));
const PROVINCE_OPTIONS = PROVINCES.map((p) => ({ value: p.name, label: p.name }));
const ESTADO_OPTIONS = Object.entries(STATUS_FILTER_LABEL).map(([value, label]) => ({
  value,
  label,
}));

function parseFilters(sp: Record<string, string | undefined>): AlertInboxFilters {
  const status = sp.status;
  const metricKey =
    sp.metric && (ALERT_METRIC_KEYS as readonly string[]).includes(sp.metric)
      ? (sp.metric as AlertMetricKey)
      : undefined;
  return {
    status:
      status && (status === "all" || (ALERT_FIRING_STATUSES as readonly string[]).includes(status))
        ? (status as AlertInboxFilters["status"])
        : "open",
    metricKey,
    province: sp.province || undefined,
    from: sp.from || undefined,
    to: sp.to || undefined,
  };
}

export default async function AdminAlertasPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireAdminOrRedirect();
  const sp = searchParams ? await searchParams : {};
  const filters = parseFilters(sp);

  // Bound the inbox fetch on BOTH axes (time + crash-safety). `null` is the
  // degraded sentinel: on a timeout or a rejected query the page renders an
  // honest "reintentá" card instead of an eternal skeleton.
  const rows = await withDbBudget<AlertFiring[] | null>(
    fetchAlertFirings(filters),
    PAGE_BUDGET_MS,
    "admin/alertas firings",
    null,
  ).catch(() => null);

  const degraded = rows === null;

  // Mandatory PII audit row for this list view (surface: alert_inbox) — only
  // when we actually read rows. Bounded so a degraded audit-log write can never
  // re-introduce the hang we just fixed; a failed audit is logged and swallowed.
  if (!degraded) {
    await withDbBudget(
      logAlertInboxView(session.user.id, filters, rows.length),
      PAGE_BUDGET_MS,
      "admin/alertas audit",
      undefined,
    ).catch(() => undefined);
  }

  return (
    <div className="space-y-6">
      <ScreenHeader
        className="space-y-2"
        eyebrow="Admin · Operaciones"
        title="Bandeja de alertas"
        subtitle={
          <p className="text-md text-ln-op-mute">
            Alertas disparadas al cruzar un umbral suscripto. Reconocé, investigá, contactá a la
            autoridad de la jurisdicción y cerrá cada alerta. El SLA de atención (antigüedad)
            refuerza el grado sanitario del programa.
          </p>
        }
      />

      {/* Unified filter bar — Métrica/Provincia axes + Estado/Desde/Hasta as
          children (F-migration 2026-07-21, off the divergent OpCard-wrapped
          <form> the PO flagged as "otro tipo de filtro, raro"). Estado is NOT
          an axis — see AlertEstadoFilter (BUGFIX opfilterbar-sweep-2026-07-21:
          its no-param default is the specific "open" subset, not "all" — an
          axis's injected blank "Todas" would silently collide with that
          default instead of clearing it). Desde/Hasta have NO default bound
          (genuinely unbounded, not a preset period) — see
          DateRangeFilterFields for why they stay a two-field `children`
          control (rather than OpFilterBar's `period` prop) that commits on
          change, no "Aplicar". No pagination on this page, so no `cursor` to
          reset. */}
      <OpFilterBar
        showPeriod={false}
        axes={
          [
            {
              id: "metric",
              label: "Métrica",
              paramKey: "metric",
              options: METRIC_OPTIONS,
              current: filters.metricKey ?? null,
              allLabel: "Todas",
            },
            {
              id: "province",
              label: "Provincia",
              paramKey: "province",
              options: PROVINCE_OPTIONS,
              current: filters.province ?? null,
              allLabel: "Todas",
            },
          ] satisfies OpFilterAxis[]
        }
      >
        <AlertEstadoFilter value={filters.status ?? "open"} options={ESTADO_OPTIONS} />
        <DateRangeFilterFields fromValue={filters.from} toValue={filters.to} />
      </OpFilterBar>

      <OpCard>
        <OpCardHead
          title="Alertas"
          actions={
            degraded ? undefined : (
              <span className="text-sm text-ln-op-mute">
                {rows.length} {rows.length === 1 ? "alerta" : "alertas"}
              </span>
            )
          }
        />
        <OpCardBody>
          {degraded ? (
            <div className="space-y-3 py-4 text-center">
              <p className="text-sm font-semibold text-ln-op-ink">
                No pudimos cargar la bandeja de alertas.
              </p>
              <p className="text-sm text-ln-op-mute">
                La consulta tardó demasiado o falló. Reintentá en unos segundos.
              </p>
              <a
                href="/admin/alertas"
                className="inline-flex items-center justify-center rounded-[var(--radius-op-btn,6px)] border border-ln-op-line bg-ln-op-card px-3 py-1.5 text-sm font-semibold text-ln-op-ink no-underline hover:bg-ln-op-stripe"
              >
                Reintentar
              </a>
            </div>
          ) : (
            <AlertInboxTable rows={rows} />
          )}
        </OpCardBody>
      </OpCard>
    </div>
  );
}
