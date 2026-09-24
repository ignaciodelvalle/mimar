// Mis denuncias — Libreta Nacional redesign.
// Presentation only; data fetching unchanged.

import Link from "next/link";

import { LnButton } from "@/components/ui/Button";
import { LnCallout } from "@/components/ui/DocElements";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { db, welfareReports } from "@/db";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime, pluralizeEs } from "@/lib/utils/format";
import {
  welfareReportKindLabel,
  welfareReportSeverityCitizenLabel,
  welfareReportStatusLabel,
} from "@/src/modules/welfare/domain/types";
import { and, desc, eq } from "drizzle-orm";

// Status badge class mapping using LN tokens.
function statusBadgeClass(status: string): string {
  switch (status) {
    case "closed":
      return "border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] text-[var(--color-ln-ok)]";
    case "invalid":
    case "duplicate":
      return "border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]";
    case "in_progress":
      return "border-[var(--color-ln-celeste-100)] bg-[var(--color-ln-celeste-050)] text-[var(--color-ln-azul)]";
    case "triaged":
      return "border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)]";
    default:
      // open
      return "border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] text-[var(--color-ln-ink-2)]";
  }
}

export default async function MisDenunciasPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
        <LnCallout tone="warn" title="Necesitás iniciar sesión">
          <Link
            href="/iniciar-sesion"
            className="text-[var(--color-ln-azul)] no-underline hover:underline"
          >
            Iniciar sesión →
          </Link>
        </LnCallout>
      </div>
    );
  }

  const reports = await db
    .select()
    .from(welfareReports)
    .where(and(eq(welfareReports.reporterUserId, user.id)))
    .orderBy(desc(welfareReports.createdAt))
    .limit(50);

  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      {/* Back — this is a reports page, its parent is the home dashboard,
          not the pet roster (QA 2026-07-03). */}
      <Link
        href="/inicio"
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Inicio
      </Link>

      {/* Header */}
      <div className="mb-7 flex items-start justify-between gap-4">
        <div>
          <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
            Mis denuncias
          </h1>
          <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
            {reports.length === 0
              ? "Sin denuncias enviadas."
              : `${reports.length} ${pluralizeEs(reports.length, "denuncia", "denuncias")} ${pluralizeEs(reports.length, "enviada", "enviadas")}.`}
          </p>
        </div>
        <Link href="/denuncias/nueva" className="flex-shrink-0 mt-1">
          <LnButton variant="primary" size="sm">
            Nueva denuncia
          </LnButton>
        </Link>
      </div>

      {reports.length === 0 ? (
        <LnEmptyState
          variant="dashed"
          title="Aún no enviaste denuncias."
          description="Podés reportar maltrato, abandono u otras situaciones de riesgo para animales."
        />
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
          {reports.map((report) => (
            <Link
              key={report.id}
              href={`/denuncias/${report.id}`}
              className="flex items-start justify-between gap-4 border-b border-[var(--color-ln-line-2)] px-4 py-3.5 no-underline last:border-b-0 hover:bg-[var(--color-ln-stripe)] transition-colors"
            >
              <div className="min-w-0 flex-1">
                <p className="font-ln-serif text-md font-semibold text-[var(--color-ln-ink)]">
                  {welfareReportKindLabel(report.kind)}
                </p>
                <p className="mt-0.5 font-ln-mono text-sm text-[var(--color-ln-mute)]">
                  {welfareReportSeverityCitizenLabel(report.severity)}
                  {" · "}
                  {report.referenceCode}
                </p>
                <p className="mt-1 text-md text-[var(--color-ln-ink-2)] line-clamp-2">
                  {report.description.length > 150
                    ? `${report.description.slice(0, 150)}…`
                    : report.description}
                </p>
                <p className="mt-1 font-ln-mono text-xs text-[var(--color-ln-mute)]">
                  {formatDateTime(report.createdAt)}
                  {(report.jurisdictionLocality || report.jurisdictionProvince) && (
                    <>
                      {" · "}
                      {[report.jurisdictionLocality, report.jurisdictionProvince]
                        .filter(Boolean)
                        .join(", ")}
                    </>
                  )}
                </p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                <span
                  className={`inline-flex items-center rounded-[var(--radius-xs)] border px-2 py-0.5 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] ${statusBadgeClass(report.status)}`}
                >
                  {welfareReportStatusLabel(report.status)}
                </span>
                <span aria-hidden="true" className="text-base text-[var(--color-ln-mute)]">
                  ›
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
