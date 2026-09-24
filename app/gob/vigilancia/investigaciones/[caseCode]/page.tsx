import Link from "next/link";
import { notFound } from "next/navigation";

import { Icon } from "@/components/Icon";
import { OpBreach, OpCard, OpCardBody, OpCardHead, OpPill } from "@/components/ui/dashboard";
import { CASE_STATUS_CONFIG } from "@/components/ui/dashboard/CaseStatusBadge";
import { getNormativesForCase } from "@/lib/domain/case-normatives";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { getOutbreakInvestigationDetail } from "@/lib/infra/case-queries";
import { formatDateTime } from "@/lib/utils/format";
import {
  caseClosedReasonLabel,
  caseOpenedReasonDisplay,
} from "@/src/modules/cases/domain/opened-reason-display";

import { InvestigationActions } from "./InvestigationActions";

// Label comes from the same CaseStatus vocabulary the unified case queue
// renders (CASE_STATUS_CONFIG) — this investigation is a `cases` row too,
// so the same status must never read differently here vs /gob/casos or the
// investigaciones list.
const STATUS_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(CASE_STATUS_CONFIG).map(([status, cfg]) => [status, cfg.label]),
);

type PillTone = "open" | "escalated" | "closed";
const STATUS_PILL_TONE: Record<string, PillTone> = {
  open: "open",
  escalated: "escalated",
  closed: "closed",
};

const ENTRY_LABEL: Record<string, string> = {
  case_opened: "Apertura",
  case_escalated: "Escalada",
  case_closed: "Cierre",
  classification: "Clasificación",
  lab_result: "Resultado de laboratorio",
  control_action: "Medida de control",
  contact_tracing: "Rastreo de contactos",
  final_report: "Informe final",
  external_notification: "Notificación externa registrada",
  signal_link: "Señal vinculada",
  system: "Nota",
};

// Format an external_notification payload (channel / reference / date) for
// distinct rendering in the timeline (UI-7 B9).
function externalNotificationDetail(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof p.channel === "string" && p.channel.trim()) parts.push(`Canal: ${p.channel.trim()}`);
  if (typeof p.notified_at === "string" && p.notified_at.trim())
    parts.push(`Fecha: ${p.notified_at.trim()}`);
  if (typeof p.reference === "string" && p.reference.trim())
    parts.push(`Ref.: ${p.reference.trim()}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function parseDiseaseCode(openedReason: string | null): string | null {
  if (!openedReason) return null;
  const match = openedReason.match(/^manual \[([^\]]+)\]:/);
  return match ? match[1] : null;
}

export default async function InvestigacionDetailPage({
  params,
}: {
  params: Promise<{ caseCode: string }>;
}) {
  const { caseCode } = await params;
  const { profile, jurisdictions } = await requireGobReadAccessOrRedirect();

  // Scope is enforced INSIDE the query (review 24 HIGH #1/#2): a govt reader
  // only resolves a case whose (province, locality) matches one of their
  // assignments — a province-only / null-province check let a CABA-Palermo
  // operator read another locality's case notes (owner PII). Out of scope →
  // detail is null → notFound (no existence leak).
  const detail = await getOutbreakInvestigationDetail(
    caseCode,
    jurisdictions,
    hasNationalReadScope(profile.role),
  );
  if (!detail) notFound();

  const diseaseCode = parseDiseaseCode(detail.openedReason);
  const isClosed = detail.status === "closed";

  const normatives = getNormativesForCase(detail.caseKind, {
    country: detail.jurisdictionCountry,
    province: detail.jurisdictionProvince ?? undefined,
    locality: detail.jurisdictionLocality ?? undefined,
  });

  const DATASET_ENTRY_TYPES = [
    "classification",
    "lab_result",
    "control_action",
    "contact_tracing",
    "external_notification",
  ];
  const datasetNotes = detail.notes.filter((n) => DATASET_ENTRY_TYPES.includes(n.entryType));
  const timelineNotes = detail.notes.filter((n) => !DATASET_ENTRY_TYPES.includes(n.entryType));

  return (
    <div className="max-w-3xl space-y-6">
      <Link
        href="/gob/vigilancia/investigaciones"
        className="text-md text-ln-op-mute hover:text-ln-op-ink no-underline"
      >
        ← Volver al listado
      </Link>

      <header className="space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-title font-semibold text-ln-op-ink">
            {/* eslint-disable-next-line react/jsx-curly-brace-presence */}
            {"Investigación de brote"}
            {diseaseCode ? ` — ${diseaseCode}` : ""}
          </h1>
          <OpPill tone={STATUS_PILL_TONE[detail.status] ?? "neutral"}>
            {STATUS_LABEL[detail.status] ?? detail.status}
          </OpPill>
        </div>
        <p className="text-sm font-ln-mono text-ln-op-mute">
          {detail.publicCode} · abierta {formatDateTime(detail.openedAt)}
        </p>
      </header>

      {/* PERSISTENT honesty banner — now points to the in-app audit action. */}
      <OpBreach
        title="Notificación externa no integrada"
        detail="La notificación obligatoria a SNVS/SENASA/zoonosis (Ley 15.465/60, Decreto 3640/64) no está integrada en esta versión: debe realizarse por los canales habituales de la jurisdicción. Registrá acá cuándo y por qué canal notificaste para dejar el rastro de auditoría."
        icon={<Icon name="alerta" decorative />}
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {diseaseCode && (
          <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 py-2 space-y-0.5">
            <p className="text-xs uppercase tracking-wider text-ln-op-mute">Enfermedad</p>
            <p className="text-md font-semibold text-ln-op-ink">{diseaseCode}</p>
          </div>
        )}
        <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 py-2 space-y-0.5">
          <p className="text-xs uppercase tracking-wider text-ln-op-mute">Estado</p>
          <p className="text-md font-semibold text-ln-op-ink">
            {STATUS_LABEL[detail.status] ?? detail.status}
          </p>
        </div>
        <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 py-2 space-y-0.5">
          <p className="text-xs uppercase tracking-wider text-ln-op-mute">Jurisdicción</p>
          <p className="text-md font-semibold text-ln-op-ink">
            {[detail.jurisdictionLocality, detail.jurisdictionProvince]
              .filter(Boolean)
              .join(", ") || "Nacional"}
          </p>
        </div>
      </div>

      <OpCard>
        <OpCardHead title="Motivo de apertura" />
        <OpCardBody>
          <p className="text-md text-ln-op-ink whitespace-pre-wrap">
            {caseOpenedReasonDisplay(detail)}
          </p>
        </OpCardBody>
      </OpCard>

      {datasetNotes.length > 0 && (
        <OpCard>
          <OpCardHead title={`Datos epidemiológicos (${datasetNotes.length})`} />
          <OpCardBody className="p-0">
            <ul className="divide-y divide-ln-op-line-2">
              {datasetNotes.map((n) => {
                const isExternal = n.entryType === "external_notification";
                const externalDetail = isExternal ? externalNotificationDetail(n.payload) : null;
                return (
                  <li key={n.id} className="px-4 py-3 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-md font-medium text-ln-op-ink">
                        {isExternal && (
                          <span
                            className="inline-flex items-center rounded-[var(--radius-op-chip)] border border-ln-op-line bg-ln-op-stripe px-1.5 py-0.5 text-xs uppercase tracking-wider text-ln-op-ink-2"
                            aria-hidden="true"
                          >
                            Externa
                          </span>
                        )}
                        {ENTRY_LABEL[n.entryType] ?? n.entryType}
                      </span>
                      <span className="text-sm text-ln-op-mute">
                        {formatDateTime(n.occurredAt)}
                      </span>
                    </div>
                    {externalDetail && (
                      <p className="text-sm font-ln-mono text-ln-op-ink-2">{externalDetail}</p>
                    )}
                    {n.notes && (
                      <p className="text-md text-ln-op-ink-2 whitespace-pre-wrap">{n.notes}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </OpCardBody>
        </OpCard>
      )}

      {timelineNotes.length > 0 && (
        <OpCard>
          <OpCardHead title="Línea de tiempo" />
          <OpCardBody className="p-0">
            <ul className="divide-y divide-ln-op-line-2">
              {timelineNotes.map((n) => (
                <li key={n.id} className="flex gap-3 px-4 py-3">
                  <span className="text-sm text-ln-op-mute shrink-0 mt-0.5 tabular-nums">
                    {formatDateTime(n.occurredAt)}
                  </span>
                  <span className="text-md text-ln-op-ink">
                    <span className="font-medium">{ENTRY_LABEL[n.entryType] ?? n.entryType}</span>
                    {n.notes ? ` — ${n.notes}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </OpCardBody>
        </OpCard>
      )}

      {!isClosed && (
        <section className="space-y-3 pt-2 border-t border-ln-op-line">
          <h2 className="text-md font-semibold text-ln-op-ink">Acciones</h2>
          <InvestigationActions casePublicCode={detail.publicCode} currentStatus={detail.status} />
        </section>
      )}

      {normatives.length > 0 && (
        <OpCard>
          <OpCardHead title="Normativa aplicable" />
          <OpCardBody>
            <ul className="space-y-2 text-md text-ln-op-ink-2">
              {normatives.map((law) => (
                <li key={law.id}>
                  <span className="font-medium text-ln-op-ink">{law.label}</span> — {law.scope}
                </li>
              ))}
            </ul>
          </OpCardBody>
        </OpCard>
      )}

      {isClosed && (
        <OpCard>
          <OpCardHead title="Cierre" />
          <OpCardBody>
            <p className="text-md text-ln-op-ink">
              Cerrada el {detail.closedAt ? formatDateTime(detail.closedAt) : ""}{" "}
              {detail.closedReason ? `— ${caseClosedReasonLabel(detail.closedReason)}` : ""}
            </p>
          </OpCardBody>
        </OpCard>
      )}
    </div>
  );
}
