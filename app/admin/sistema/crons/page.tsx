// /admin/sistema/crons — Cron health surface (admin-only, read-only).
//
// Lists every registered cron with its last run time, status, items processed,
// and a healthy/stale badge. Data is read server-side from cronRuns.
//
// Guard: requireAdminOrRedirect — admin-only. Govt cannot access this surface
// (cron telemetry is infra-internal, not jurisdiction-scoped data).

import Link from "next/link";

import { OpCard, OpCardBody, OpCardHead, OpPill } from "@/components/ui/dashboard";
import { OpStatusPill } from "@/components/ui/dashboard/OpStatusPill";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { fetchCronHealth } from "@/lib/analytics/admin-metrics";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { formatDateTimeShortAr } from "@/lib/utils/format";

export const dynamic = "force-dynamic";

type OpPillTone =
  | "open"
  | "triaged"
  | "escalated"
  | "danger"
  | "progress"
  | "closed"
  | "ok"
  | "neutral";

const REASON_LABEL: Record<string, string> = {
  ok: "OK",
  never_ran: "Sin ejecución",
  stale: "Desactualizado",
  last_failed: "Falló",
  // C-b: a run orphaned at 'running' (hard kill) — used to render as a green
  // "Saludable" for up to 26 horas.
  stuck_running: "Colgado",
};

const STATUS_LABEL: Record<string, string> = {
  ok: "OK",
  failed: "Fallo",
  running: "Corriendo",
};

const STATUS_TONE: Record<string, OpPillTone> = {
  ok: "ok",
  failed: "danger",
  running: "open",
};

function formatAgeMs(ageMs: number | null): string {
  if (ageMs === null) return "—";
  const hours = Math.floor(ageMs / (1000 * 60 * 60));
  if (hours < 1) return "< 1h";
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export default async function AdminSistemaCronsPage() {
  await requireAdminOrRedirect();

  const crons = await fetchCronHealth();

  const unhealthyCount = crons.filter((c) => !c.healthy).length;
  const healthyCount = crons.filter((c) => c.healthy).length;

  return (
    <div className="space-y-6">
      {/* Page header — non-canonical h1 fix (adversarial-admin 2026-07-23):
          was text-lg + a bespoke breadcrumb-style eyebrow instead of the
          canonical ScreenHeader h1. The "solo lectura" pill (Ola 4 /
          decision-density audit, 2026-07-21 — WHERE AM I answered immediately,
          not after scrolling) moves into the subtitle, right under the
          canonical h1, instead of squeezed beside it. */}
      <ScreenHeader
        className="space-y-2"
        eyebrow={
          <>
            Admin · Sistema ·{" "}
            <Link
              href="/admin/sistema"
              className="hover:underline underline-offset-4 text-ln-op-azul"
            >
              Salud del sistema
            </Link>{" "}
            · Crons
          </>
        }
        title="Salud de crons"
        subtitle={
          <>
            <OpStatusPill tone="neutral">Herramienta de sistema · solo lectura</OpStatusPill>
            <p className="text-sm text-ln-op-ink-2">
              Estado de cada cron registrado en vercel.json — lectura de cronRuns en vivo. Solo
              admin.
            </p>
            <div className="flex gap-4 pt-1 text-sm">
              <span className="text-ln-op-mute">
                <span className="font-semibold text-ln-op-ink">{healthyCount}</span> saludables
              </span>
              <span className="text-ln-op-mute">
                <span
                  className={[
                    "font-semibold",
                    unhealthyCount > 0 ? "text-ln-op-danger" : "text-ln-op-ink",
                  ].join(" ")}
                >
                  {unhealthyCount}
                </span>{" "}
                con problemas
              </span>
            </div>
          </>
        }
      />

      {/* Cron health table */}
      <OpCard>
        <OpCardHead title="Estado por cron" />
        <OpCardBody>
          {crons.length === 0 ? (
            <p className="text-sm text-ln-op-mute">Sin crons registrados.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <caption className="sr-only">
                  Estado de salud de cada cron: nombre, schedule, última ejecución, estado, items
                  procesados y diagnóstico.
                </caption>
                <thead>
                  <tr className="border-b border-ln-op-line">
                    <th
                      scope="col"
                      className="px-3 py-2 text-left text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute"
                    >
                      Cron
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-left text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute"
                    >
                      Schedule
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-left text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute"
                    >
                      Último run
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-left text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute"
                    >
                      Antigüedad
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-left text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute"
                    >
                      Estado
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-right text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute"
                    >
                      Items
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-left text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute"
                    >
                      Salud
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {crons.map((c) => (
                    <tr
                      key={c.cronName}
                      className={[
                        "border-t border-ln-op-line",
                        !c.healthy ? "bg-[var(--color-st-err-bg)]" : "",
                      ].join(" ")}
                    >
                      <td className="px-3 py-2 text-sm font-medium text-ln-op-ink font-ln-mono">
                        {c.cronName}
                      </td>
                      <td className="px-3 py-2 text-xs text-ln-op-mute font-ln-mono">
                        {c.schedule}
                      </td>
                      <td className="px-3 py-2 text-xs tabular-nums text-ln-op-ink-2">
                        {formatDateTimeShortAr(c.lastRunAt)}
                        {/* C-b: when the latest ATTEMPT never finished, show
                            the last run that actually completed — the number
                            the operator needs while a run is stuck. */}
                        {c.lastCompletedAt !== null &&
                          c.lastRunAt !== null &&
                          c.lastStatus === "running" && (
                            <span className="block text-ln-op-mute">
                              Última completa: {formatDateTimeShortAr(c.lastCompletedAt)} (
                              {c.lastCompletedStatus === "ok" ? "OK" : "fallo"})
                            </span>
                          )}
                      </td>
                      <td className="px-3 py-2 text-xs tabular-nums text-ln-op-mute">
                        {formatAgeMs(c.ageMs)}
                      </td>
                      <td className="px-3 py-2">
                        {c.lastStatus ? (
                          <OpPill tone={STATUS_TONE[c.lastStatus] ?? "neutral"}>
                            {STATUS_LABEL[c.lastStatus] ?? c.lastStatus}
                          </OpPill>
                        ) : (
                          <span className="text-xs text-ln-op-mute">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums text-ln-op-ink-2">
                        {c.lastItemsProcessed ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        {c.healthy ? (
                          <OpStatusPill tone="st-ok">Saludable</OpStatusPill>
                        ) : (
                          <OpStatusPill tone="st-err">
                            {REASON_LABEL[c.reason] ?? c.reason}
                          </OpStatusPill>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </OpCardBody>
      </OpCard>

      {/* Legend */}
      <div className="text-xs text-ln-op-mute space-y-1">
        <p>
          <span className="font-semibold">Desactualizado</span>: sin run exitoso en las últimas 26
          horas (umbral = schedule diario + 2h de margen).
        </p>
        <p>
          <span className="font-semibold">Sin ejecución</span>: ningún run registrado en cronRuns
          para este cron (esperado en entornos nuevos o locales sin seed de crons).
        </p>
        <p>
          <span className="font-semibold">Falló</span>: el último run terminó con status=failed.
          Revisá los logs del servidor en el dashboard de Vercel.
        </p>
        <p className="pt-1">
          Superficie de solo lectura. Para diagnosticar: revisá los logs en Vercel o ejecutá el cron
          manualmente con CRON_SECRET.
        </p>
      </div>
    </div>
  );
}
