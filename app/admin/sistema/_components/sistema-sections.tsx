// /admin/sistema — streamed, per-query-budgeted sections (platform-budget T3.1).
//
// The page used to await SEVEN fetchers in one Promise.all at the top of an
// async default export — the whole shell (header included) waited for the
// slowest query (>34 s observed on staging under pooler contention). The page
// now streams: the shell flushes immediately and each section below resolves
// behind its own <Suspense> with its own DB budget, so one slow query degrades
// ALONE into an honest "sin datos por demora" state instead of holding the
// entire dashboard hostage.
//
// Budget discipline (same recipe as app/admin/panorama/page.tsx, task #74):
//   - critical KPI fetchers: SISTEMA_KPI_BUDGET_MS each, individually.
//   - card sections (crons / drift / govt activity): SISTEMA_SECTION_BUDGET_MS.
//   - a degraded section NEVER renders zeros as data — it renders an explicit
//     timeout/error notice with a real retry link (honest-fallback rule).

import Link from "next/link";

import { AdminKpiStrip } from "@/components/admin/AdminKpiStrip";
import { CronsDownBanner } from "@/components/admin/CronsDownBanner";
import { PetStatusDriftCard } from "@/components/admin/PetStatusDriftCard";
import { OpCard, OpCardBody, OpCardHead, OpPill } from "@/components/ui/dashboard";
import {
  type DecisionsMetrics,
  type QueueHealth,
  type UserMetrics,
  fetchCronRuns,
  fetchFailedCronNames,
  fetchGovtActivity,
  fetchPetStatusDrift,
  sortGovtActivityByActivity,
} from "@/lib/analytics/admin-metrics";
import type { EnoSlaMetric } from "@/lib/analytics/surveillance-metrics";
import { cronDisplayLabel } from "@/lib/infra/cron-registry";
import { withDbBudget } from "@/lib/infra/db-budget";
import { type OutboundChannelStatus, deriveOutboundChannels } from "@/lib/infra/outbound-channels";
import { decisionsDeltaPct } from "@/lib/metrics";
import { decisionsAuditDrillHref } from "@/lib/ui/audit-filters";
import { formatDateShort, formatDateTimeShortAr } from "@/lib/utils/format";

// ---------------------------------------------------------------------------
// Budgets + degraded envelope
// ---------------------------------------------------------------------------

/** Per-fetcher budget for the critical KPI strip (users/queue/decisions/ENO). */
export const SISTEMA_KPI_BUDGET_MS = 5_000;
/** Budget for each self-contained card section (crons, drift, govt activity). */
export const SISTEMA_SECTION_BUDGET_MS = 8_000;

/**
 * Degraded marker resolved in place of real data when a fetcher blows its
 * budget ("timeout") or rejects before it ("error"). A discriminated object —
 * NOT null — so the render layer can say honestly WHY there is no data.
 */
export type Degraded = { readonly degraded: "timeout" | "error" };

export function isDegraded(value: unknown): value is Degraded {
  return (
    typeof value === "object" &&
    value !== null &&
    "degraded" in value &&
    ((value as Degraded).degraded === "timeout" || (value as Degraded).degraded === "error")
  );
}

/**
 * Bound a page fetcher with withDbBudget and fold BOTH failure axes into the
 * Degraded marker: budget expiry resolves `{degraded:"timeout"}` (withDbBudget's
 * fallback) and a pre-budget rejection resolves `{degraded:"error"}` (the page
 * caller's own `.catch`, per db-budget.ts's documented page-caller contract).
 * Never rejects — a slow or broken query can only degrade its own section.
 */
export async function budgetedOrDegraded<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T | Degraded> {
  try {
    return await withDbBudget<T | Degraded>(promise, ms, label, { degraded: "timeout" });
  } catch (err) {
    console.error(`[admin/sistema] ${label} failed before its budget:`, err);
    return { degraded: "error" };
  }
}

// ---------------------------------------------------------------------------
// Honest degraded notice (es-AR, terse) — shared by every section below
// ---------------------------------------------------------------------------

function DegradedBody({
  reason,
  seconds,
}: {
  reason: Degraded["degraded"];
  seconds: number;
}) {
  return (
    <p className="text-sm text-ln-op-mute">
      {reason === "timeout"
        ? `Esta sección tardó más de ${seconds} s en responder.`
        : "No pudimos cargar esta sección."}{" "}
      {/* Plain <a>: a hard navigation re-requests the route (real retry). */}
      <a
        href="/admin/sistema"
        className="font-semibold text-ln-op-azul underline underline-offset-2"
      >
        Reintentá
      </a>
      .
    </p>
  );
}

/** Card-shaped degraded state so the grid keeps its silhouette. */
export function SectionDegradedCard({
  title,
  reason,
  seconds,
}: {
  title: string;
  reason: Degraded["degraded"];
  seconds: number;
}) {
  return (
    // A5 (motion review): op-fade-in (globals.css) — every degraded section
    // shares this component, so one class here covers every streamed section's
    // "sorry, timed out" branch.
    <OpCard className="op-fade-in">
      <OpCardHead title={title} />
      <OpCardBody>
        <DegradedBody reason={reason} seconds={seconds} />
      </OpCardBody>
    </OpCard>
  );
}

// ---------------------------------------------------------------------------
// Outbound channels — can the system still reach a person who left the screen?
// ---------------------------------------------------------------------------

/**
 * Reports which outbound channels this deployment can actually attempt, and
 * what a real person loses while one is down. No DB call and no budget wrapper:
 * it reads env-var PRESENCE only (never values), so there is nothing to time
 * out and no secret to leak into the tree.
 *
 * It earns a slot on this screen because of an asymmetry the rest of the
 * product cannot fix: the denuncia access endpoint answers identically whether
 * mail went out or was never configured — deliberately, so it cannot be used
 * as an existence oracle — which leaves the operator as the only party who can
 * be told the truth, and only ahead of time.
 */
export function SistemaChannelsCard() {
  const channels = deriveOutboundChannels(process.env);

  return (
    <OpCard className="op-fade-in">
      <OpCardHead title="Canales de salida" />
      <OpCardBody>
        <ul className="space-y-3">
          {channels.map((c) => (
            <li key={c.key} className="space-y-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-ln-op-ink-2">{c.label}</span>
                <OpPill tone={CHANNEL_TONE[c.status]}>{CHANNEL_LABEL[c.status]}</OpPill>
              </div>
              {/* The consequence renders only when the channel cannot deliver.
                  On a healthy deployment this card is three short rows; the
                  prose appears exactly when someone has to act on it. */}
              {c.status !== "configured" && (
                <p className="text-sm text-ln-op-mute">{c.consequence}</p>
              )}
              {c.status === "unconfigured" && c.requires.length > 0 && (
                <p className="text-xs text-ln-op-mute">
                  Falta configurar en el entorno: {c.requires.join(", ")}
                </p>
              )}
            </li>
          ))}
        </ul>
        {/* The honest ceiling of this card. A present key proves the app can
            ATTEMPT a send — an unverified sending domain or a suspended
            account still bounces every message, and this screen cannot see
            that. Saying so here is what keeps a green pill from being read as
            a delivery guarantee. */}
        <p className="mt-4 text-xs text-ln-op-mute">
          "Configurado" significa que la aplicación puede intentar el envío. No prueba que el
          mensaje llegue: un dominio sin verificar o una cuenta suspendida rebotan igual, y eso no
          se ve desde acá.
        </p>
      </OpCardBody>
    </OpCard>
  );
}

const CHANNEL_TONE: Record<OutboundChannelStatus, "ok" | "open" | "danger" | "neutral"> = {
  configured: "ok",
  // Ámbar, ni verde ni rojo: el canal ANDA, pero solo llega a la casilla de la
  // cuenta del proveedor. Pintarlo verde diría que el aviso sale, y pintarlo
  // rojo escondería que el mecanismo está probado y funcionando.
  restricted: "open",
  unconfigured: "danger",
  // A product gap is not an outage: rendering it red would send an operator
  // hunting for a key that does not exist.
  "not-built": "neutral",
};

const CHANNEL_LABEL: Record<OutboundChannelStatus, string> = {
  configured: "Configurado",
  restricted: "Solo a la casilla de la cuenta",
  unconfigured: "Sin configurar",
  "not-built": "No implementado",
};

// ---------------------------------------------------------------------------
// Crons-down banner — cheap fetchFailedCronNames (not the full fetchCronRuns)
// ---------------------------------------------------------------------------

export async function SistemaCronsBanner() {
  // Cheap single-pass DISTINCT ON query (admin-metrics.ts) instead of deriving
  // from the full fetchCronRuns — the banner no longer rides the heavy card
  // query. Degraded (timeout/error) renders NOTHING: absence of the banner
  // never claims health affirmatively; the Crons card below owns the honest
  // degraded state for this data.
  const names = await budgetedOrDegraded(
    fetchFailedCronNames(),
    SISTEMA_SECTION_BUDGET_MS,
    "admin/sistema crons-banner",
  );
  if (isDegraded(names)) return null;
  // A5: CronsDownBanner has no className prop (shared with the admin landing
  // page, out of this fix's scope) — wrap instead of threading a new prop
  // through a component used elsewhere. This <Suspense> has no grid layout,
  // so the extra div is layout-safe.
  return (
    <div className="op-fade-in">
      <CronsDownBanner failedCronNames={names} showSistemaLink={false} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI strip — the four critical fetchers, budgeted individually by the shell
// ---------------------------------------------------------------------------

export async function SistemaKpiStrip({
  users,
  queue,
  decisions,
  enoSla,
}: {
  users: Promise<UserMetrics | Degraded>;
  queue: Promise<QueueHealth | Degraded>;
  decisions: Promise<DecisionsMetrics | Degraded>;
  enoSla: Promise<EnoSlaMetric | Degraded>;
}) {
  const [u, q, d, e] = await Promise.all([users, queue, decisions, enoSla]);

  // AdminKpiStrip (C26: single presentational source of truth) needs the full
  // core trio — if any of them degraded, render the honest notice instead of
  // a strip with invented zeros.
  if (isDegraded(u) || isDegraded(q) || isDegraded(d)) {
    const reason = [u, q, d].filter(isDegraded).some((x) => x.degraded === "timeout")
      ? ("timeout" as const)
      : ("error" as const);
    return (
      <OpCard className="op-fade-in">
        <OpCardBody>
          <DegradedBody reason={reason} seconds={SISTEMA_KPI_BUDGET_MS / 1000} />
        </OpCardBody>
      </OpCard>
    );
  }

  const total7d = d.approved7d + d.rejected7d;
  // T4.10: `.priorBase` feeds AdminKpiStrip's guardInput so the tile suppresses
  // the colored verdict when the prior-week base is unstably small (n<5).
  const decisionsDeltaResult = decisionsDeltaPct(d);
  const decisionsDelta = decisionsDeltaResult?.pct ?? null;
  const decisionsPriorBase = decisionsDeltaResult?.priorBase ?? null;

  return (
    // A5: AdminKpiStrip has no className prop (shared with /admin's landing
    // strip) — wrap instead. No grid sits above this Suspense (page.tsx), so
    // the extra div is layout-safe; AdminKpiStrip's own grid is unaffected.
    <div className="op-fade-in">
      <AdminKpiStrip
        data={{
          totalPersonal: u.totalPersonal,
          pendingTotal: q.pendingTotal,
          oldestPendingDaysAgo: q.oldestPendingDaysAgo,
          decisionsTotal7d: total7d,
          approved7d: d.approved7d,
          rejected7d: d.rejected7d,
          decisionsDelta,
          decisionsPriorBase,
          decisionsDrillHref: decisionsAuditDrillHref(),
          // ENO SLA degrades ALONE: the strip falls back to its 3-tile variant
          // (a real AdminKpiStrip mode) and the note below says why.
          ...(isDegraded(e)
            ? {}
            : {
                enoSla: {
                  onTimePct: e.onTimePct,
                  breachedOpen: e.breachedOpen,
                  total: e.total,
                  medianLatencyHours: e.medianLatencyHours,
                },
              }),
        }}
      />
      {isDegraded(e) && (
        <p className="mt-2 text-sm text-ln-op-mute">
          SLA ENO: sin datos por demora.{" "}
          <a
            href="/admin/sistema"
            className="font-semibold text-ln-op-azul underline underline-offset-2"
          >
            Reintentá
          </a>
          .
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat cards — Usuarios / Aprobaciones / Decisiones, each degrades alone
// ---------------------------------------------------------------------------

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm text-ln-op-mute">{label}</span>
      <span className="text-md font-medium tabular-nums text-ln-op-ink">{value}</span>
    </div>
  );
}

export async function SistemaStatCards({
  users,
  queue,
  decisions,
}: {
  users: Promise<UserMetrics | Degraded>;
  queue: Promise<QueueHealth | Degraded>;
  decisions: Promise<DecisionsMetrics | Degraded>;
}) {
  const [u, q, d] = await Promise.all([users, queue, decisions]);
  const seconds = SISTEMA_KPI_BUDGET_MS / 1000;

  return (
    <>
      {isDegraded(u) ? (
        <SectionDegradedCard title="Usuarios" reason={u.degraded} seconds={seconds} />
      ) : (
        <OpCard className="op-fade-in">
          <OpCardHead title="Usuarios" />
          <OpCardBody>
            <StatRow label="Personal" value={u.totalPersonal} />
            <StatRow label="Institucional activo" value={u.totalInstitutionalActive} />
            <StatRow
              label="Nuevos personal · 24h / 7d / 30d"
              value={`${u.new24h} / ${u.new7d} / ${u.new30d}`}
            />
          </OpCardBody>
        </OpCard>
      )}

      {isDegraded(q) ? (
        <SectionDegradedCard title="Aprobaciones" reason={q.degraded} seconds={seconds} />
      ) : (
        <OpCard className="op-fade-in">
          <OpCardHead title="Aprobaciones" />
          <OpCardBody>
            <StatRow label="Pendientes" value={q.pendingTotal} />
            <StatRow label="Más antigua pendiente (días)" value={q.oldestPendingDaysAgo ?? "—"} />
            <StatRow
              label="14d+ / 30d+ / 60d+"
              value={`${q.pending14dPlus} / ${q.pending30dPlus} / ${q.pending60dPlus}`}
            />
          </OpCardBody>
        </OpCard>
      )}

      {isDegraded(d) ? (
        <SectionDegradedCard title="Decisiones" reason={d.degraded} seconds={seconds} />
      ) : (
        <OpCard className="op-fade-in">
          <OpCardHead title="Decisiones" />
          <OpCardBody>
            <StatRow label="Aprobadas · 7d / 30d" value={`${d.approved7d} / ${d.approved30d}`} />
            <StatRow label="Rechazadas · 7d / 30d" value={`${d.rejected7d} / ${d.rejected30d}`} />
            <StatRow label="Revocaciones · 30d" value={d.revocations30d} />
          </OpCardBody>
        </OpCard>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Crons card
// ---------------------------------------------------------------------------

type CronTone = "ok" | "danger" | "open";
const STATUS_LABEL: Record<string, string> = {
  ok: "OK",
  failed: "Fallo",
  running: "Corriendo",
};
const STATUS_TONE: Record<string, CronTone> = {
  ok: "ok",
  failed: "danger",
  running: "open",
};

// Operator-facing plain-es-AR explanation of each background job (Cowork M6).
// `does` = what the job does for the program; `whenFails` = what stops working
// when it is in FALLO. The dev-only detail (logs / CRON_SECRET) is kept in a
// collapsed "Detalle técnico" block — an operator needs the impact and the
// action ("avisale al equipo técnico"), not the curl command.
const CRON_JOB_HELP: Record<string, { does: string; whenFails: string }> = {
  vaccine_due: {
    does: "Envía los recordatorios de vacunas a los dueños.",
    whenFails: "los recordatorios de vacunas no se están enviando.",
  },
  post_adoption_checkin: {
    does: "Envía los seguimientos post-adopción a las familias adoptantes.",
    whenFails: "los seguimientos post-adopción no se están enviando.",
  },
  expire_foster_proposals: {
    does: "Cierra las propuestas de tránsito que vencieron sin respuesta.",
    whenFails: "las propuestas de tránsito vencidas quedan abiertas.",
  },
  auto_expire_approvals: {
    does: "Da de baja las solicitudes de aprobación que caducaron.",
    whenFails: "solicitudes ya vencidas siguen figurando como pendientes en la cola.",
  },
  close_rabies_observations: {
    does: "Cierra las observaciones antirrábicas de 10 días ya cumplidas.",
    whenFails: "las observaciones antirrábicas cumplidas no se cierran solas.",
  },
  close_stale_lost_episodes: {
    does: "Cierra los casos de mascota perdida que quedaron inactivos.",
    whenFails: "los casos de pérdida inactivos siguen abiertos.",
  },
  close_followup_expired_adoptions: {
    does: "Cierra los seguimientos de adopción vencidos.",
    whenFails: "los seguimientos de adopción vencidos quedan abiertos.",
  },
  escalate_stale_welfare_cases: {
    does: "Escala las denuncias de maltrato que no tuvieron avance.",
    whenFails: "las denuncias estancadas no se escalan al siguiente nivel.",
  },
  escalate_stale_disputes: {
    does: "Escala las disputas de custodia que no tuvieron avance.",
    whenFails: "las disputas estancadas no se escalan.",
  },
  expire_cross_org_transfers: {
    does: "Vence las transferencias entre organizaciones que nadie aceptó.",
    whenFails: "las transferencias entre organizaciones sin aceptar no vencen.",
  },
  drain_outbox: {
    does: "Entrega las notificaciones pendientes de la bandeja de salida.",
    whenFails: "las notificaciones pendientes (incluidas las ENO) no se entregan.",
  },
  process_eno_queue: {
    does: "Notifica los eventos ENO (enfermedades de notificación obligatoria) a la autoridad sanitaria.",
    whenFails: "las notificaciones ENO a la autoridad sanitaria no se están enviando.",
  },
  expire_pet_transfers: {
    does: "Vence las transferencias de mascota que nadie aceptó.",
    whenFails: "las transferencias de mascota sin aceptar no vencen.",
  },
  expire_decomiso_handoffs: {
    does: "Vence las entregas de decomiso que no se confirmaron.",
    whenFails: "las entregas de decomiso sin confirmar no vencen.",
  },
  materialize_slots: {
    does: "Genera los turnos disponibles de las agendas.",
    whenFails: "no se generan turnos nuevos en las agendas.",
  },
  business_rules_reeval: {
    does: "Reevalúa las reglas de negocio por jurisdicción.",
    whenFails: "las reglas no se reevalúan con los datos nuevos.",
  },
  data_lifecycle: {
    does: "Aplica las políticas de retención y borrado de datos.",
    whenFails: "las políticas de retención de datos no se aplican.",
  },
  purge_scan_events: {
    does: "Depura los eventos de escaneo antiguos.",
    whenFails: "los eventos de escaneo antiguos no se depuran.",
  },
  evaluate_alerts: {
    does: "Evalúa las reglas de vigilancia y dispara las alertas.",
    whenFails: "las alertas de vigilancia no se están disparando.",
  },
  reconcile_pet_status: {
    does: "Reconcilia el estado cacheado de las mascotas con el libro de eventos.",
    whenFails: "el estado de las mascotas puede quedar desactualizado.",
  },
  cron_health: {
    does: "Controla que el resto de los procesos automáticos hayan corrido.",
    whenFails: "no se controla la salud de los demás procesos automáticos.",
  },
};

export async function SistemaCronsCard() {
  const crons = await budgetedOrDegraded(
    fetchCronRuns(),
    SISTEMA_SECTION_BUDGET_MS,
    "admin/sistema crons",
  );

  if (isDegraded(crons)) {
    return (
      <SectionDegradedCard
        title="Crons"
        reason={crons.degraded}
        seconds={SISTEMA_SECTION_BUDGET_MS / 1000}
      />
    );
  }

  return (
    <OpCard className="op-fade-in">
      <OpCardHead
        title="Crons"
        actions={
          <Link
            href="/admin/sistema/crons"
            className="text-xs font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline"
          >
            Ver detalle →
          </Link>
        }
      />
      <OpCardBody>
        {crons.length === 0 ? (
          <p className="text-md text-ln-op-mute">Sin runs registrados.</p>
        ) : (
          <ul className="space-y-3">
            {crons.map((c) => {
              // Extract error summary from details JSONB when present.
              // Route handlers write: { errors: [{ id: string, reason: string }] }
              const errorList = Array.isArray((c.lastDetails as { errors?: unknown })?.errors)
                ? (c.lastDetails as { errors: { id: string; reason: string }[] }).errors
                : [];
              const errorSummary =
                errorList.length > 0 ? errorList.map((e) => e.reason).join("; ") : null;

              return (
                <li key={c.cronName} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-3">
                    {/* M2 (cowork demo): show the es-AR label; the raw
                        snake_case key rides `title` for support/debugging. */}
                    <span className="text-sm text-ln-op-ink-2" title={c.cronName}>
                      {cronDisplayLabel(c.cronName)}
                    </span>
                    <span className="tabular-nums text-sm flex items-center gap-1.5">
                      {formatDateTimeShortAr(c.lastRunAt)}
                      {c.lastStatus && (
                        <OpPill tone={STATUS_TONE[c.lastStatus] ?? "neutral"}>
                          {STATUS_LABEL[c.lastStatus] ?? c.lastStatus}
                        </OpPill>
                      )}
                      {c.itemsProcessed != null && (
                        <span className="text-ln-op-mute">
                          {"·"} {c.itemsProcessed} items
                        </span>
                      )}
                    </span>
                  </div>
                  {/* Failure copy is operator-first (Cowork M6): a plain-es-AR
                      impact line + the action ("avisale al equipo técnico"),
                      with the dev detail (logs / CRON_SECRET) folded into a
                      collapsed "Detalle técnico" block. No automated re-trigger
                      is offered: the cron routes require `Authorization: Bearer
                      <CRON_SECRET>` from the Vercel infrastructure and there is
                      no safe way to reconstruct that header in a server action
                      without exposing the secret in the browser. */}
                  {c.lastStatus === "failed" &&
                    (() => {
                      const help = CRON_JOB_HELP[c.cronName];
                      return (
                        <div className="space-y-1.5 text-sm">
                          {help && (
                            <>
                              <p className="text-ln-op-danger">
                                <span className="font-semibold">FALLO:</span> {help.whenFails}{" "}
                                Avisale al equipo técnico.
                              </p>
                              <p className="text-ln-op-mute">Qué hace este proceso: {help.does}</p>
                            </>
                          )}
                          <details className="space-y-0.5 text-ln-op-mute">
                            <summary className="cursor-pointer select-none font-medium">
                              Detalle técnico
                            </summary>
                            <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-ln-op-danger-bg px-2 py-1 text-xs text-ln-op-danger">
                              {errorSummary ??
                                JSON.stringify(c.lastDetails, null, 2) ??
                                "Sin detalle disponible."}
                            </pre>
                            <p className="text-ln-op-mute">
                              Para el equipo técnico: revisá los logs en el dashboard de Vercel y
                              reejecutá el cron desde ahí (o vía curl con el CRON_SECRET
                              configurado).
                            </p>
                          </details>
                        </div>
                      );
                    })()}
                </li>
              );
            })}
          </ul>
        )}
      </OpCardBody>
    </OpCard>
  );
}

// ---------------------------------------------------------------------------
// Pet-status drift card
// ---------------------------------------------------------------------------

export async function SistemaDriftCard() {
  const drift = await budgetedOrDegraded(
    fetchPetStatusDrift(),
    SISTEMA_SECTION_BUDGET_MS,
    "admin/sistema drift",
  );

  if (isDegraded(drift)) {
    return (
      <SectionDegradedCard
        title="Deriva de caché · pets.status"
        reason={drift.degraded}
        seconds={SISTEMA_SECTION_BUDGET_MS / 1000}
      />
    );
  }

  // Deriva de caché pets.status ↔ event log — projection-cron audit
  // 2026-07-03 B3. Detección solamente; la reparación es manual.
  return <PetStatusDriftCard data={drift} />;
}

// ---------------------------------------------------------------------------
// "Actividad por gobierno" — 3 serial round trips inside fetchGovtActivity,
// the heaviest section; streams last with its own budget.
// ---------------------------------------------------------------------------

// Cap the "actividad por govt" table so a universal-scope roster (which can hold
// dozens of duplicate seed govts) never pushes live operators below the fold.
const GOVT_ACTIVITY_LIMIT = 25;

export async function SistemaGovtActivity() {
  const govts = await budgetedOrDegraded(
    fetchGovtActivity(),
    SISTEMA_SECTION_BUDGET_MS,
    "admin/sistema govt-activity",
  );

  if (isDegraded(govts)) {
    return (
      <SectionDegradedCard
        title="Actividad por gobierno"
        reason={govts.degraded}
        seconds={SISTEMA_SECTION_BUDGET_MS / 1000}
      />
    );
  }

  if (govts.length === 0) {
    return <p className="op-fade-in text-md text-ln-op-mute">No hay gobiernos activos.</p>;
  }

  // Surface the most active operators first, then cap the render so a
  // long seed roster can't bury them.
  const sortedGovts = sortGovtActivityByActivity(govts);
  const visibleGovts = sortedGovts.slice(0, GOVT_ACTIVITY_LIMIT);
  const govtsTruncated = sortedGovts.length > GOVT_ACTIVITY_LIMIT;

  return (
    <OpCard className="op-fade-in">
      <div className="overflow-x-auto">
        <table className="w-full">
          <caption className="sr-only">
            Actividad de operadores de gobierno: localidades asignadas, decisiones y última acción
          </caption>
          <thead>
            <tr className="border-b border-ln-op-line">
              <th
                scope="col"
                className="px-3 py-2 text-left text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute"
              >
                Gobierno
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-left text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute"
              >
                Localidades
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-left text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute"
              >
                Decisiones 30d
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-left text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute"
              >
                Última acción
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleGovts.map((g) => (
              <tr key={g.userId} className="border-t border-ln-op-line">
                <td className="px-3 py-2 text-md font-medium text-ln-op-ink">{g.displayName}</td>
                <td className="px-3 py-2 tabular-nums text-sm text-ln-op-ink-2">
                  {g.localitiesCount}
                </td>
                <td className="px-3 py-2 tabular-nums text-sm text-ln-op-ink-2">
                  {g.decisions30d}
                </td>
                <td className="px-3 py-2 text-sm text-ln-op-mute">
                  {g.lastActionAt ? formatDateShort(g.lastActionAt) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {govtsTruncated && (
        <p className="px-3 py-2 text-sm text-ln-op-mute">
          Mostrando los {GOVT_ACTIVITY_LIMIT} gobiernos más activos de {sortedGovts.length}.
        </p>
      )}
    </OpCard>
  );
}
