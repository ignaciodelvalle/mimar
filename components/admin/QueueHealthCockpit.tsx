// QueueHealthCockpit — the /admin home operational cockpit (Epic D).
//
// WHY: the admin home used to show a single lumped "Cola pendiente" number that
// counted only pending approval_requests, while several other operational
// queues (moderación, alertas, outbox breaches, casos, observaciones) stayed
// invisible and the Novedades feed pointed at a different source entirely. This
// cockpit renders EVERY queue an admin owns as a compact tile with its live
// count and a jump-off to its page — approvals broken out per type.
//
// D-1 (Lote D, 2026-08-16) — THE METRIC CONTRACT REACHES THESE TILES. Until
// now every one of the eight rendered through a bespoke local `QueueTile`: a
// retyped label, a raw count and an ad-hoc tone, with no descriptorId, no ⓘ, no
// "Ver origen" — the single largest descriptor-less reporting surface of either
// operator portal, on the FIRST screen an admin sees. They are now <OpKpi>
// tiles resolving descriptors from lib/metrics/kpi-catalog-queues.ts, so each
// one carries its own definition, caveat and provenance card. Every label comes
// FROM the catalog (never retyped — registry-import fence,
// scripts/check-metric-labels.ts), which is why several read more precisely
// than the old copy — the open-cases tile now names its national scope, because
// the bare wording it used to carry also names a page title, a choropleth scale
// and an owner-side list elsewhere in the app.
//
// D-3 (same lote) — MEASURED ZERO, SAID OUT LOUD. A bare "0" cannot tell an
// operator whether the queue was queried and is genuinely empty or whether
// nothing ever fed it. Here the answer is unambiguous and worth stating: every
// count in QueueCockpit comes from an UNCONDITIONAL aggregate over a live table
// (approval_requests, welfare_reports, cases, pets, outbox, alert firings — see
// fetchQueueCockpit), so a 0 is always a MEASURED zero, never a no-signal one.
// The zero tiles say so in their sub-line, matching the epistemic vocabulary
// app/gob/* already uses via LnEmptyState's nature="measured-zero"
// (components/ui/EmptyState.tsx). No tile here is ever "no-signal": if a count
// query fails the whole cockpit degrades upstream through the page's
// loadWithTimeout, it does not render a fabricated 0.
//
// PRESENTATIONAL ONLY — no data fetching. The page computes the counts via
// `fetchQueueCockpit` (lib/analytics/admin-metrics) and passes them in.
//
// Server component: pure render, no interactivity. Uses design tokens only
// (ln-op-* / st-* via the .op-surface cascade) — no raw colours, no emojis.

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";
import { OpKpi } from "@/components/ui/dashboard/OpKpi";
import type { ProvenanceContext } from "@/components/ui/dashboard/ProvenanceCard";
import type { QueueCockpit } from "@/lib/analytics/admin-metrics";
import { KPI_CATALOG } from "@/lib/metrics/kpi-catalog";
import { pluralizeEs } from "@/lib/utils/format";

/** count > 0 → warn, else neutral. */
function warnIf(count: number): "warn" | "neutral" {
  return count > 0 ? "warn" : "neutral";
}

/**
 * D-3: the sub-line every tile carries at zero. Not decoration — it is the
 * CLAIM that the number was measured (see the module comment). A non-zero tile
 * needs no such line: the count itself is the evidence.
 */
const MEASURED_ZERO_NOTE = "Consultado ahora: la cola está vacía.";

function measuredZeroSub(count: number): string | undefined {
  return count === 0 ? MEASURED_ZERO_NOTE : undefined;
}

export function QueueHealthCockpit({ cockpit }: { cockpit: QueueCockpit }) {
  const { approvals } = cockpit;

  const oldestNote =
    approvals.oldestPendingDaysAgo != null
      ? `Más antigua pendiente: ${approvals.oldestPendingDaysAgo}d`
      : "Sin pendientes";

  // Every count here is national and unfiltered, and the page renders a
  // DashboardFreshnessFooter — so the provenance card defers freshness to it
  // instead of inventing a second timestamp.
  const provenance: ProvenanceContext = {
    scopeLabel: "Nacional — todas las jurisdicciones",
    pageHasFreshnessFooter: true,
  };

  return (
    <OpCard>
      <OpCardHead
        title="Estado de las colas"
        actions={
          // The single GLOBAL unfiltered jump-off. Each tile below deep-links to
          // its OWN filtered queue, so this is the only link to the full cola.
          <Link href="/admin/cola" className="inline-flex items-center gap-1 hover:underline">
            Ver cola completa
            <Icon name="chevron-right" size="sm" decorative />
          </Link>
        }
      />
      <OpCardBody className="space-y-4">
        {/* Aprobaciones — the one queue that was a KPI, now broken out per type. */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-sm font-bold uppercase tracking-[0.12em] text-ln-op-mute">
              Aprobaciones {"·"} {approvals.pendingTotal}{" "}
              {pluralizeEs(approvals.pendingTotal, "pendiente")}
            </h4>
            <span className="text-sm text-ln-op-mute">{oldestNote}</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {/* Each approval tile deep-links to its OWN filtered queue via ?type=
                (the cola page validates it against APPROVAL_REQUEST_TYPES —
                app/gob/cola/page.tsx) so the tile lands on exactly the queue it
                counts, not the lumped list. */}
            <OpKpi
              href="/admin/cola?type=role_upgrade_vet"
              label={KPI_CATALOG.queue_approvals_role_upgrade_vet.label}
              value={approvals.roleUpgradeVet}
              tone={warnIf(approvals.roleUpgradeVet)}
              sub={measuredZeroSub(approvals.roleUpgradeVet)}
              descriptorId="queue_approvals_role_upgrade_vet"
              provenance={provenance}
            />
            <OpKpi
              href="/admin/cola?type=organization_verification"
              label={KPI_CATALOG.queue_approvals_org_verification.label}
              value={approvals.organizationVerification}
              tone={warnIf(approvals.organizationVerification)}
              sub={measuredZeroSub(approvals.organizationVerification)}
              descriptorId="queue_approvals_org_verification"
              provenance={provenance}
            />
            <OpKpi
              href="/admin/cola?type=service_dog_credential_verification"
              label={KPI_CATALOG.queue_approvals_service_dog_credential.label}
              value={approvals.serviceDogCredentialVerification}
              tone={warnIf(approvals.serviceDogCredentialVerification)}
              sub={measuredZeroSub(approvals.serviceDogCredentialVerification)}
              descriptorId="queue_approvals_service_dog_credential"
              provenance={provenance}
            />
          </div>
        </div>

        {/* Colas operativas — previously invisible on the home. */}
        <div className="space-y-2">
          <h4 className="text-sm font-bold uppercase tracking-[0.12em] text-ln-op-mute">
            Colas operativas
          </h4>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <OpKpi
              // The Denuncias hub's Moderación stage, addressed directly.
              // /admin/moderacion is a redirect-only shim since the F1 fusion
              // (buildDenunciasHubRedirectUrl(sp, "moderacion")), so the old
              // href cost the admin a hop to reach exactly this URL
              // (link-integrity.test.ts block 5, 2026-08-01). The cross-portal
              // jump into /gob chrome is unchanged and still the documented
              // exception recorded on the ADMIN_NAV "Moderación" entry — this
              // only removes the bounce, not the jump.
              href="/gob/denuncias?etapa=moderacion"
              label={KPI_CATALOG.queue_moderation_pending.label}
              value={cockpit.moderationPending}
              tone={warnIf(cockpit.moderationPending)}
              sub={measuredZeroSub(cockpit.moderationPending)}
              descriptorId="queue_moderation_pending"
              provenance={provenance}
            />
            <OpKpi
              href="/admin/alertas"
              label={KPI_CATALOG.queue_alerts_open.label}
              value={cockpit.alertsOpen}
              tone={warnIf(cockpit.alertsOpen)}
              sub={measuredZeroSub(cockpit.alertsOpen)}
              descriptorId="queue_alerts_open"
              provenance={provenance}
            />
            <OpKpi
              // Deep-link to the breached rows only (breach=yes → pending AND
              // past SLA — app/admin/outbox/page.tsx), not the full outbox.
              href="/admin/outbox?breach=yes"
              label={KPI_CATALOG.queue_outbox_sla_breaches.label}
              value={cockpit.outboxBreaches}
              tone={cockpit.outboxBreaches > 0 ? "danger" : "neutral"}
              sub={measuredZeroSub(cockpit.outboxBreaches)}
              descriptorId="queue_outbox_sla_breaches"
              provenance={provenance}
            />
            <OpKpi
              href="/admin/casos"
              label={KPI_CATALOG.queue_cases_open_national.label}
              value={cockpit.casesOpen}
              // W2: open cases are ongoing INVENTORY, not a "decide now" alarm.
              // Warm tones are reserved for tiles that need an operator decision
              // this moment (pending approvals, moderación, alertas, SLA breaches,
              // observaciones en curso). A large open-cases count competing in
              // orange next to the pink SLA breach mis-ranks attention, so this
              // tile stays NEUTRAL regardless of count.
              tone="neutral"
              sub={measuredZeroSub(cockpit.casesOpen)}
              descriptorId="queue_cases_open_national"
              provenance={provenance}
            />
            <OpKpi
              href="/admin/observaciones"
              // red-team-admin #3: this counts only in-progress observations, so
              // a "0" here sits next to a full /admin/observaciones list (which
              // also shows recently-closed ones) — the label's "(en curso)"
              // preempts that, and the descriptor's caveat spells it out.
              label={KPI_CATALOG.queue_rabies_observations_in_progress.label}
              value={cockpit.rabiesInProgress}
              tone={warnIf(cockpit.rabiesInProgress)}
              sub={measuredZeroSub(cockpit.rabiesInProgress)}
              descriptorId="queue_rabies_observations_in_progress"
              provenance={provenance}
            />
          </div>
        </div>
      </OpCardBody>
    </OpCard>
  );
}
