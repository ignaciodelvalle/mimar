// Admin card — pets.status cache drift visibility (projection-cron audit
// 2026-07-03 B3). Surfaces what the reconcile-pet-status cron already detects
// (cronRuns.details.divergent + sample) and the cron-health meta-cron's
// semantic verdict, which were previously invisible outside function logs.
//
// Detect-only surface: no repair action is offered here — repairing the cache
// is human-gated (scripts/rebuild-projections.ts --apply) because a divergence
// may indicate a missing upcaster rather than a stale cache.

import { OpCard, OpCardBody, OpCardHead, OpPill } from "@/components/ui/dashboard";
import type { PetStatusDrift } from "@/lib/analytics/admin-metrics";
import { AR_TIME_ZONE } from "@/lib/utils/format";

function formatDate(d: Date): string {
  return d.toLocaleString("es-AR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: AR_TIME_ZONE,
  });
}

export function PetStatusDriftCard({ data }: { data: PetStatusDrift }) {
  const { reconcile, metaCheck } = data;
  const hasDrift = (reconcile?.divergent ?? 0) > 0;

  return (
    // A5 (motion review): op-fade-in (globals.css) — this component is only
    // used by app/admin/sistema's streamed SistemaDriftCard section.
    <OpCard className="op-fade-in">
      <OpCardHead
        title="Deriva de caché · pets.status"
        actions={
          reconcile ? (
            <OpPill tone={hasDrift ? "danger" : "ok"}>
              {hasDrift ? `${reconcile.divergent} divergentes` : "Sin deriva"}
            </OpPill>
          ) : undefined
        }
      />
      <OpCardBody>
        {reconcile === null ? (
          <p className="text-md text-ln-op-mute">
            El cron reconcile_pet_status todavía no registró corridas.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Row label="Último escaneo" value={formatDate(reconcile.lastRunAt)} />
              <Row
                label="Mascotas escaneadas"
                value={
                  reconcile.earlyStop
                    ? `${reconcile.scanned} (escaneo parcial)`
                    : String(reconcile.scanned)
                }
              />
              <Row label="Divergentes" value={String(reconcile.divergent)} />
            </div>

            {hasDrift && reconcile.sample.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute">
                  Muestra
                </p>
                <ul className="space-y-1">
                  {reconcile.sample.slice(0, 5).map((s) => {
                    // A pet is flagged divergent when ANY checked cache column
                    // drifts (status, weight, microchip, tattoo, …), not just
                    // status. Showing only the status pair made non-status
                    // drifts look mislabelled ("cache active → log active" for a
                    // row that actually diverged on weight). Surface the field(s)
                    // that truly diverged so a DIVERGENTE row demonstrates it.
                    const cols = s.driftedColumns;
                    // Legacy runs (pre-driftedColumns) recorded only the status
                    // pair — treat a differing pair as a status drift so those
                    // rows still render their cache→log detail.
                    const statusDrifted =
                      cols.includes("status") || (cols.length === 0 && s.cached !== s.derived);
                    const fieldLabel =
                      cols.length > 0 ? cols.join(", ") : statusDrifted ? "status" : "—";
                    return (
                      <li key={s.publicToken} className="flex flex-col gap-0.5 text-sm">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="font-ln-mono text-ln-op-ink">{s.publicToken}</span>
                          <span className="text-ln-op-mute">{fieldLabel}</span>
                        </div>
                        {statusDrifted && (
                          <span className="text-ln-op-mute">
                            status: cache {s.cached ?? "—"} {"→"} log {s.derived ?? "—"}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <div className="flex items-baseline justify-between gap-3 border-t border-ln-op-line pt-2">
              <span className="text-sm text-ln-op-mute">Chequeo semántico (cron-health)</span>
              {metaCheck === null ? (
                <span className="text-sm text-ln-op-mute">Sin datos</span>
              ) : (
                <span className="flex items-center gap-1.5 text-sm tabular-nums">
                  {formatDate(metaCheck.checkedAt)}
                  <OpPill tone={metaCheck.healthy ? "ok" : "danger"}>
                    {metaCheck.healthy
                      ? "OK"
                      : metaCheck.reason === "drift"
                        ? "Deriva detectada"
                        : metaCheck.reason}
                  </OpPill>
                </span>
              )}
            </div>

            <p className="text-sm text-ln-op-mute">
              Solo detección: la reparación de la caché es manual y auditada (no hay auto-repair).
            </p>
          </div>
        )}
      </OpCardBody>
    </OpCard>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm text-ln-op-mute">{label}</span>
      <span className="text-md font-medium tabular-nums text-ln-op-ink">{value}</span>
    </div>
  );
}
