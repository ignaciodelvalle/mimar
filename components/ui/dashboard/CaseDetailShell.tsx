// CaseDetailShell — consistent header + tab shell for case-detail pages.
//
// Renders:
//   - OpCodeBadge (publicCode) + CaseStatusBadge (status)
//   - Case kind label + opened/closed timestamps
//   - Parties list (opener, org, closer) with graceful degradation for
//     unowned_animal / anonymous viewers
//   - Applicable normativa (via getNormativesForCase)
//   - Jurisdiction info
//   - Four named tabs: Resumen / Timeline / Adjuntos / Acciones
//     (tab navigation is URL-driven via UrlTabs when rendered inside a
//     Next.js page; children render inside the active tab slot)
//
// Edge cases handled:
//   - unowned_animal subject (no pet) → graceful subject descriptor
//   - multi-party (dispute): parties[] list, mobile-safe wrapping
//   - isPublic=true → personal names hidden; org names stay visible
//
// The shell is a *presentational* Server Component — it receives all data
// pre-fetched by the page. It does NOT perform any DB queries.

import Link from "next/link";
import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";
import { CaseHeader } from "@/components/ui/dashboard/CaseHeader";
import { caseStatusDisplay } from "@/components/ui/dashboard/CaseStatusBadge";
import { OpCodeBadge } from "@/components/ui/dashboard/OpCodeBadge";
import type { CaseStatus } from "@/db/schema";
import { type LawReference, getNormativesForCase } from "@/lib/domain/case-normatives";
import { formatDateTime } from "@/lib/utils/format";
import { type CaseKind, caseKindLabel } from "@/src/modules/cases/domain/case-kinds";
import { caseOpenedReasonDisplay } from "@/src/modules/cases/domain/opened-reason-display";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CaseParty {
  role: "opener" | "closer" | "organization" | "applicant" | "respondent" | "reporter";
  /** Display name of the person. Null for anonymous / redacted views. */
  name: string | null;
  /** Public token for orgs — renders a link to /refugios/[token]. */
  orgPublicToken?: string | null;
}

export interface CaseSubjectDescriptor {
  kind: "pet" | "unowned_animal" | "location" | "general";
  /** Pet name, when kind === "pet". */
  petName?: string | null;
  /** Pet species label, when kind === "pet". */
  petSpecies?: string | null;
  /** Link to pet profile. */
  petHref?: string | null;
  /** Photo URL for the pet avatar. */
  petPhotoUrl?: string | null;
  /** Locality/province descriptor, when kind === "location". */
  locationLabel?: string | null;
}

export interface CaseDetailShellProps {
  publicCode: string;
  kind: CaseKind;
  status: CaseStatus;
  openedAt: Date;
  closedAt?: Date | null;
  openedReason?: string | null;
  /** Structured open reason (migration 0149). Absent on pre-cutover rows. */
  openedReasonCode?: string | null;
  openedReasonParams?: unknown;
  jurisdictionCountry: string;
  jurisdictionProvince?: string | null;
  jurisdictionLocality?: string | null;
  /** Resolved normatives — callers pass getNormativesForCase(...) result. */
  normatives?: LawReference[];
  /** Parties involved in the case. */
  parties?: CaseParty[];
  /** Subject descriptor for the case header card. */
  subject?: CaseSubjectDescriptor | null;
  /**
   * When true, personal names (opener, closer) are hidden.
   * Org names stay visible — they are already public entities.
   */
  isPublic?: boolean;
  /**
   * Content rendered inside the shell (Resumen tab body by default).
   * Pass tab-specific children; tab routing is handled outside.
   */
  children?: ReactNode;
  /**
   * Optional breadcrumb element rendered above the header.
   * Callers supply a <nav> or OpCrumbs component.
   */
  breadcrumb?: ReactNode;
}

// ---------------------------------------------------------------------------
// Party role labels (es-AR)
// ---------------------------------------------------------------------------

const PARTY_ROLE_LABEL: Record<CaseParty["role"], string> = {
  opener: "Abrió",
  closer: "Cerró",
  organization: "Organización",
  applicant: "Solicitante",
  respondent: "Parte respondiente",
  reporter: "Denunciante",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Consistent case-detail header + contextual grid.
 * Apply to all case detail pages (casos, maltrato, decomisos, disputas,
 * observaciones) to unify the presentation layer (Wave 2 Item 12).
 */
export function CaseDetailShell({
  publicCode,
  kind,
  status,
  openedAt,
  closedAt,
  openedReason,
  openedReasonCode = null,
  openedReasonParams = null,
  jurisdictionCountry,
  jurisdictionProvince,
  jurisdictionLocality,
  normatives,
  parties = [],
  subject,
  isPublic = false,
  children,
  breadcrumb,
}: CaseDetailShellProps) {
  // Derive normatives from props when not pre-resolved (convenience path).
  const resolvedNormatives =
    normatives ??
    getNormativesForCase(kind, {
      country: jurisdictionCountry,
      province: jurisdictionProvince ?? undefined,
      locality: jurisdictionLocality ?? undefined,
    });

  return (
    <div className="space-y-6">
      {breadcrumb}

      {/* ------------------------------------------------------------------ */}
      {/* Header (shared CaseHeader primitive)                                 */}
      {/* ------------------------------------------------------------------ */}
      <CaseHeader
        code={<OpCodeBadge tone="blue">{publicCode}</OpCodeBadge>}
        status={caseStatusDisplay(status)}
        title={caseKindLabel(kind)}
        meta={
          <>
            Abierto el {formatDateTime(openedAt)}
            {closedAt ? ` · Cerrado el ${formatDateTime(closedAt)}` : ""}
          </>
        }
      />

      {/* ------------------------------------------------------------------ */}
      {/* Subject card                                                         */}
      {/* ------------------------------------------------------------------ */}
      {subject && <SubjectCard subject={subject} />}

      {/* ------------------------------------------------------------------ */}
      {/* Contextual grid: parties · jurisdiction · normativa                 */}
      {/* ------------------------------------------------------------------ */}
      <div className="grid gap-4 md:grid-cols-3">
        {/* Parties */}
        <section
          aria-label="Partes del caso"
          className="rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-card p-4"
        >
          <h2 className="font-ln-mono text-xs font-semibold uppercase tracking-[.14em] text-ln-op-mute">
            Partes
          </h2>
          {parties.length === 0 ? (
            <p className="mt-2 text-md text-ln-op-mute">
              {isPublic ? "Datos de partes no disponibles" : "Apertura automática del sistema"}
            </p>
          ) : (
            <ul className="mt-2 space-y-1 text-md">
              {parties.map((party, idx) => (
                <PartyRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable short list
                  key={idx}
                  party={party}
                  isPublic={isPublic}
                />
              ))}
            </ul>
          )}
        </section>

        {/* Jurisdiction */}
        <section
          aria-label="Jurisdicción"
          className="rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-card p-4"
        >
          <h2 className="font-ln-mono text-xs font-semibold uppercase tracking-[.14em] text-ln-op-mute">
            Jurisdicción
          </h2>
          <p className="mt-2 text-md text-ln-op-ink">
            {jurisdictionLocality && jurisdictionProvince
              ? `${jurisdictionLocality}, ${jurisdictionProvince}`
              : (jurisdictionProvince ?? "Sin especificar")}
          </p>
        </section>

        {/* Normativa */}
        <section
          aria-label="Normativa aplicable"
          className="rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-card p-4"
        >
          <h2 className="font-ln-mono text-xs font-semibold uppercase tracking-[.14em] text-ln-op-mute">
            Normativa aplicable
          </h2>
          {resolvedNormatives.length === 0 ? (
            <p className="mt-2 text-md text-ln-op-mute">Sin norma específica catalogada</p>
          ) : (
            <ul className="mt-2 space-y-2 text-md">
              {resolvedNormatives.map((law) => (
                <li key={law.id}>
                  <span className="font-medium text-ln-op-ink">
                    {law.fullTextUrl ? (
                      <a
                        href={law.fullTextUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-ln-op-azul hover:underline"
                      >
                        {law.label}
                      </a>
                    ) : (
                      law.label
                    )}
                  </span>
                  <span className="block text-sm text-ln-op-mute">{law.scope}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Opened reason — internal only (may contain PII)                     */}
      {/* ------------------------------------------------------------------ */}
      {!isPublic && openedReason ? (
        <section
          aria-label="Motivo de apertura"
          className="rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-stripe p-4"
        >
          <h2 className="font-ln-mono text-xs font-semibold uppercase tracking-[.14em] text-ln-op-mute">
            Motivo de apertura
          </h2>
          <p className="mt-2 text-md text-ln-op-ink">
            {caseOpenedReasonDisplay({ openedReasonCode, openedReasonParams, openedReason })}
          </p>
        </section>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Slot for tab content (timeline, adjuntos, acciones, etc.)           */}
      {/* ------------------------------------------------------------------ */}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SubjectCard
// ---------------------------------------------------------------------------

// Exported for unit testing (BITE-NAME-HIDE render contract). Internal to the shell.
export function SubjectCard({ subject }: { subject: CaseSubjectDescriptor }) {
  // BITE-NAME-HIDE: a pet subject renders its card even when the NAME is redacted
  // (anonymous cruelty/bite view) — the photo + species/sex stay. With a name the
  // heading is the name and the species rides as a subline; without one the
  // species descriptor ("Perro · macho") becomes the heading, and no proper name
  // is emitted anywhere in the markup.
  if (subject.kind === "pet") {
    const heading = subject.petName ?? subject.petSpecies ?? "Mascota";
    const showSpeciesSubline = subject.petName != null && subject.petSpecies != null;
    return (
      <section
        aria-label="Mascota sujeto del caso"
        className="flex items-center gap-4 rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-card p-5"
      >
        {subject.petPhotoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={subject.petPhotoUrl}
            alt={subject.petName ?? "Mascota"}
            className="h-16 w-16 flex-shrink-0 rounded-full object-cover ring-2 ring-ln-op-line"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-full bg-ln-op-stripe text-ln-op-mute"
          >
            <Icon name="huella" size={28} decorative />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="font-ln-serif text-lg font-semibold text-ln-op-ink truncate">{heading}</p>
          {showSpeciesSubline ? (
            <p className="text-sm text-ln-op-mute">{subject.petSpecies}</p>
          ) : null}
        </div>
        {subject.petHref ? (
          <Link
            href={subject.petHref}
            className="inline-flex flex-shrink-0 items-center rounded-[var(--radius-pill)] bg-ln-op-azul px-4 py-2 text-sm font-semibold text-white no-underline transition-colors hover:opacity-90"
          >
            Ver mascota →
          </Link>
        ) : null}
      </section>
    );
  }

  // Unowned animal, location, or general — degrade gracefully.
  let descriptor: string;
  if (subject.kind === "unowned_animal") {
    descriptor = "Animal sin identificar (no registrado en miMAR)";
  } else if (subject.kind === "location" && subject.locationLabel) {
    descriptor = `Ubicación: ${subject.locationLabel}`;
  } else if (subject.kind === "location") {
    descriptor = "Ubicación específica";
  } else {
    descriptor = "Caso general (sin sujeto identificado)";
  }

  return (
    <section
      aria-label="Sujeto del caso"
      className="rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-card p-5"
    >
      <p className="text-md text-ln-op-mute">{descriptor}</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// PartyRow — single party in the parties list
// ---------------------------------------------------------------------------

function PartyRow({
  party,
  isPublic,
}: {
  party: CaseParty;
  isPublic: boolean;
}) {
  const roleLabel = PARTY_ROLE_LABEL[party.role];

  // Personal names are redacted for public viewers.
  // Org names stay visible (they're already public).
  const isPersonalRole =
    party.role === "opener" ||
    party.role === "closer" ||
    party.role === "applicant" ||
    party.role === "respondent" ||
    party.role === "reporter";

  if (isPersonalRole && isPublic) return null;

  const nameNode = party.orgPublicToken ? (
    <Link
      href={`/refugios/${party.orgPublicToken}`}
      className="text-ln-op-azul no-underline hover:underline"
    >
      {party.name}
    </Link>
  ) : (
    <span className="text-ln-op-ink">{party.name ?? "—"}</span>
  );

  return (
    <li>
      <span className="text-ln-op-mute">{roleLabel}: </span>
      {nameNode}
    </li>
  );
}
