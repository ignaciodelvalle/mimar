"use client";

// WelfareInspectorContent — the TABBED body of the inspector for a single
// welfare report (task #12). Fed by GET /api/gob/maltrato/[id] (rehydrated to
// Date fields by the mounter). Tabs (Resumen / Línea de tiempo / Acciones /
// Exportar) are LOCAL DOM state — they are inspector-internal and must never
// touch the URL (the URL's `?queue=`/`?cursor=` belong to the LIST). Grouping
// the actions into their own tab keeps them from being buried below a scroll.

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";

import { OpButton, OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";
import type { WelfareInspectorDetail } from "@/lib/infra/welfare-inspector-detail";
import { formatDate, formatDateTime } from "@/lib/utils/format";
import {
  type WelfareReportStatus,
  welfareAssignmentField,
  welfareReportSeverityLabel,
  welfareReportStatusLabel,
  welfareReportSubjectKindLabel,
} from "@/src/modules/welfare/domain/types";

import { AssignmentActions } from "../[id]/AssignmentActions";
import { DerivationPanel } from "../[id]/DerivationPanel";
import { Timeline } from "../[id]/Timeline";
import { TriageActions } from "../[id]/TriageActions";
import { MpfExportGate } from "./MpfExportGate";

const LocationMap = dynamic(() => import("@/components/LocationMap"), {
  loading: () => (
    <div className="h-64 w-full animate-pulse rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-stripe" />
  ),
});

type Tab = "resumen" | "timeline" | "acciones" | "export";

const TABS: { value: Tab; label: string }[] = [
  { value: "resumen", label: "Resumen" },
  { value: "timeline", label: "Línea de tiempo" },
  { value: "acciones", label: "Acciones" },
  { value: "export", label: "Exportar" },
];

export function WelfareInspectorContent({
  detail,
  onOpenMascota,
  initialTab,
}: {
  detail: WelfareInspectorDetail;
  onOpenMascota: (token: string) => void;
  /** C6c workqueue grammar: ActuarButton selects a case with `&panel=acciones`
   * so the inspector opens straight on the tab that hosts the primary
   * next-step verb, instead of defaulting to "Resumen". The caller
   * (InspectorMounter) keys this component by case id, so a fresh selection
   * always re-seeds this initial value rather than carrying over a stale tab. */
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "resumen");

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div
        role="tablist"
        aria-label="Secciones de la denuncia"
        className="flex gap-1 border-b border-ln-op-line"
      >
        {TABS.map((t) => (
          <OpButton
            key={t.value}
            type="button"
            size="sm"
            variant={tab === t.value ? "primary" : "ghost"}
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => setTab(t.value)}
          >
            {t.label}
          </OpButton>
        ))}
      </div>

      {tab === "resumen" && <ResumenTab detail={detail} onOpenMascota={onOpenMascota} />}
      {tab === "timeline" && (
        <Timeline
          events={detail.timelineEvents.map((e) => ({
            ...e,
            occurredAt: new Date(e.occurredAt),
          }))}
        />
      )}
      {tab === "acciones" && <AccionesTab detail={detail} />}
      {tab === "export" && (
        <OpCard>
          <OpCardHead title="Exportación fiscal" />
          <OpCardBody>
            <MpfExportGate
              welfareReportId={detail.id}
              status={detail.status}
              jurisdictionProvince={detail.jurisdictionProvince}
            />
          </OpCardBody>
        </OpCard>
      )}
    </div>
  );
}

function ResumenTab({
  detail,
  onOpenMascota,
}: {
  detail: WelfareInspectorDetail;
  onOpenMascota: (token: string) => void;
}) {
  const { locationPoint } = detail;
  return (
    <div className="space-y-4">
      {/* Summary chips */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Chip label="Edad del caso" value={ageLabel(detail.ageInDays)} />
        <Chip label="Gravedad" value={welfareReportSeverityLabel(detail.severity)} />
        <Chip label="Estado" value={welfareReportStatusLabel(detail.status)} />
        {/* Label and value move together — under a fixed "Asignado a" the
            derived case read "Asignado a: Derivada a Refugio Test". */}
        <Chip
          {...welfareAssignmentField(detail.assignedToName, detail.derivedOrgInfo?.orgDisplayName)}
        />
      </div>

      <OpCard>
        <OpCardHead title="¿Qué pasó?" />
        <OpCardBody className="space-y-2">
          <p className="whitespace-pre-wrap text-sm text-ln-op-ink">{detail.description}</p>
          {detail.observedSymptoms && (
            <p className="whitespace-pre-wrap text-sm text-ln-op-ink">
              <span className="font-semibold">Síntomas observados: </span>
              {detail.observedSymptoms}
            </p>
          )}
          {detail.occurredAt && (
            <p className="text-xs text-ln-op-mute">Ocurrió el {formatDate(detail.occurredAt)}</p>
          )}
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead title="Sujeto" />
        <OpCardBody className="space-y-2">
          <p className="text-sm text-ln-op-ink">
            {welfareReportSubjectKindLabel(detail.subjectKind)}
          </p>
          {detail.subjectDescription && (
            <p className="whitespace-pre-wrap text-sm text-ln-op-ink-2">
              {detail.subjectDescription}
            </p>
          )}
          {detail.subjectPetToken && (
            <OpButton
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenMascota(detail.subjectPetToken as string)}
            >
              Ver mascota vinculada →
            </OpButton>
          )}
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead title="Lugar" />
        <OpCardBody className="space-y-3">
          <div className="space-y-1 text-sm text-ln-op-ink-2">
            {detail.locationAddress && <p>{detail.locationAddress}</p>}
            {(detail.jurisdictionLocality || detail.jurisdictionProvince) && (
              <p>
                {[detail.jurisdictionLocality, detail.jurisdictionProvince]
                  .filter(Boolean)
                  .join(", ")}
              </p>
            )}
          </div>
          {locationPoint && (
            <>
              <p className="text-xs uppercase tracking-wider text-ln-op-mute">
                Ubicación exacta — uso oficial (Ley 14.346)
              </p>
              <LocationMap lat={locationPoint.lat} lng={locationPoint.lng} />
              <p className="font-ln-mono text-xs text-ln-op-mute">
                {locationPoint.lat.toFixed(6)}, {locationPoint.lng.toFixed(6)}
              </p>
            </>
          )}
        </OpCardBody>
      </OpCard>

      {detail.attachments.length > 0 && (
        <OpCard>
          <OpCardHead title={`Evidencia (${detail.attachments.length})`} />
          <OpCardBody>
            <ul className="space-y-1.5 text-sm">
              {detail.attachments.map((a) => (
                <li key={a.id} className="flex items-baseline justify-between gap-3">
                  <span className="truncate font-ln-mono text-xs text-ln-op-ink-2">
                    {a.originalFilename ?? a.storagePath.split("/").pop()}
                  </span>
                  {a.signedUrl ? (
                    <a
                      href={a.signedUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-ln-op-azul underline hover:text-ln-op-azul-700"
                    >
                      Abrir →
                    </a>
                  ) : (
                    <span className="text-xs text-ln-op-mute">(no disponible)</span>
                  )}
                </li>
              ))}
            </ul>
          </OpCardBody>
        </OpCard>
      )}

      <OpCard>
        <OpCardHead title="Reportante" />
        <OpCardBody>
          {detail.reporter.isAnonymous ? (
            <p className="text-sm text-ln-op-mute">
              Denuncia anónima.
              {(detail.reporter.email || detail.reporter.phone) && (
                <span>
                  {" "}
                  Contacto opcional dejado:{" "}
                  {[detail.reporter.email, detail.reporter.phone].filter(Boolean).join(" · ")}
                </span>
              )}
            </p>
          ) : (
            <p className="text-sm text-ln-op-ink-2">
              {detail.reporter.name ?? "Usuario registrado"}
              {detail.reporter.email && (
                <span className="text-ln-op-mute"> · {detail.reporter.email}</span>
              )}
              {detail.reporter.phone && (
                <span className="text-ln-op-mute"> · {detail.reporter.phone}</span>
              )}
            </p>
          )}
        </OpCardBody>
      </OpCard>

      {(detail.triagedAt || detail.closedAt) && (
        <OpCard>
          <OpCardHead title="Trayectoria" />
          <OpCardBody className="space-y-2 text-sm">
            {detail.triagedAt && (
              <p className="text-ln-op-ink">
                Revisada el {formatDateTime(detail.triagedAt)}
                {detail.triagedByName && (
                  <span className="text-ln-op-mute"> por {detail.triagedByName}</span>
                )}
              </p>
            )}
            {detail.closedAt && (
              <p className="text-ln-op-ink">Cerrada el {formatDateTime(detail.closedAt)}</p>
            )}
            {detail.resolutionNotes && (
              <div className="whitespace-pre-wrap rounded-[var(--radius-sm)] bg-ln-op-stripe p-3 text-xs text-ln-op-ink-2">
                {detail.resolutionNotes}
              </div>
            )}
          </OpCardBody>
        </OpCard>
      )}

      <OpCard>
        <OpCardHead title="Normativa aplicable" />
        <OpCardBody>
          {detail.normativas.length === 0 ? (
            <p className="text-sm text-ln-op-mute">
              Sin normativa catalogada para esta jurisdicción.
            </p>
          ) : (
            <ul className="space-y-2 text-sm text-ln-op-ink-2">
              {detail.normativas.map((law) => (
                <li key={law.id}>
                  <span className="font-medium text-ln-op-ink">{law.label}</span>
                  {` — ${law.scope}`}
                </li>
              ))}
            </ul>
          )}
        </OpCardBody>
      </OpCard>
    </div>
  );
}

function AccionesTab({ detail }: { detail: WelfareInspectorDetail }) {
  if (detail.isTerminal) {
    return (
      <OpCard>
        <OpCardHead title="Acciones" />
        <OpCardBody>
          <p className="text-sm text-ln-op-mute">
            La denuncia está en estado terminal ({welfareReportStatusLabel(detail.status)}). No hay
            acciones de seguimiento disponibles.
          </p>
        </OpCardBody>
      </OpCard>
    );
  }

  return (
    <div className="space-y-4">
      <OpCard>
        <OpCardHead title="Asignación" />
        <OpCardBody>
          <AssignmentActions
            reportId={detail.id}
            assignedToUserId={detail.assignedToUserId}
            currentUserId={detail.currentUserId}
            isAdmin={detail.isAdmin}
          />
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead title="Triage" />
        <OpCardBody>
          <TriageActions
            welfareReportId={detail.id}
            currentStatus={detail.status as WelfareReportStatus}
          />
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead title="Derivar a organización" />
        <OpCardBody className="space-y-2">
          <p className="text-xs text-ln-op-mute">
            Derivá esta denuncia a un refugio o red de rescate verificada para seguimiento en campo.
          </p>
          {detail.orgInterventionStatus === "tomado" && (
            <div className="rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-stripe px-3 py-2">
              <p className="text-sm text-ln-op-ink">
                <span className="font-medium">En intervención</span> — la organización tomó la
                denuncia
                {detail.orgInterventionAt && (
                  <span className="text-ln-op-mute">
                    {" "}
                    el {formatDateTime(detail.orgInterventionAt)}
                  </span>
                )}
                .
              </p>
            </div>
          )}
          {detail.orgInterventionStatus === "devuelto" && (
            <div className="rounded-[var(--radius-sm)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-3 py-2">
              <p className="text-sm text-ln-op-warn">
                <span className="font-medium">Devuelta por la organización</span>
                {detail.orgReturnReason ? `: ${detail.orgReturnReason}` : "."} Volvé a derivarla o
                gestionala directamente.
              </p>
            </div>
          )}
          <DerivationPanel
            welfareReportId={detail.id}
            availableOrgs={detail.derivableOrgs.map((o) => ({
              id: o.id,
              displayName: o.displayName,
              orgType: o.orgType,
            }))}
            alreadyDerivedTo={
              detail.derivedOrgInfo
                ? { ...detail.derivedOrgInfo, derivedAt: new Date(detail.derivedOrgInfo.derivedAt) }
                : null
            }
          />
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead title="Derivar a decomiso" />
        <OpCardBody className="space-y-2">
          <p className="text-xs text-ln-op-mute">
            Si la denuncia amerita una incautación bajo Ley 14.346, iniciá el decomiso desde acá.
          </p>
          <Link
            href={`/gob/decomisos/nuevo?welfareReportId=${detail.id}${detail.subjectPetToken ? `&pet=${detail.subjectPetToken}` : ""}`}
            prefetch={false}
            className="inline-flex items-center gap-2 rounded-[var(--radius-md)] bg-ln-op-azul px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Iniciar decomiso →
          </Link>
        </OpCardBody>
      </OpCard>
    </div>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 py-2">
      <p className="text-xs uppercase tracking-wider text-ln-op-mute">{label}</p>
      <p className="truncate text-sm font-semibold text-ln-op-ink">{value}</p>
    </div>
  );
}

function ageLabel(days: number): string {
  if (days === 0) return "Hoy";
  if (days === 1) return "1 día";
  return `${days} días`;
}
