// /admin/libro — Libro de eventos (WS-L). Read-only, admin universal scope.
//
// Makes event-sourcing tangible in three beats:
//   1. Stream      — chronological, append-only feed of pet_events (es-AR
//                    labels, actor, jurisdiction, occurredAt + recordedAt).
//   2. Amendment   — rows with an amendment expand to show the event_amended
//                    chain ABOVE the original; "el original se conserva".
//   3. Replay      — each row deep-links to /admin/panorama?asOf=<occurredAt>.
//
// Pure projection over lib/metrics/event-ledger — NO schema, NO new event types,
// NO migrations. Every list view writes a pii_queried audit row (oversight).

import Link from "next/link";

import { EventLedgerTable } from "@/components/admin/EventLedgerTable";
import {
  OpCard,
  OpCardBody,
  OpCardHead,
  type OpFilterAxis,
  OpFilterBar,
} from "@/components/ui/dashboard";
import { DashboardFreshnessFooter } from "@/components/ui/dashboard/DashboardFreshnessFooter";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import type { EventType } from "@/db/schema";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { buildProjectionContext } from "@/lib/metrics";
import {
  type AuthorRole,
  type EventLedgerFilters,
  type LedgerCursor,
  fetchEventLedger,
  logEventLedgerView,
} from "@/lib/metrics/event-ledger";
import { windows } from "@/lib/metrics/period";
import { eventTypeLabel } from "@/lib/utils/format";

import { LibroFilterFields } from "./_components/LibroFilterFields";
import { toLedgerRowView } from "./view";

export const dynamic = "force-dynamic";

// Curated event-type options for the filter dropdown (the most meaningful for an
// auditor; "todos" leaves it unfiltered). Labels come from the single canonical
// es-AR map — never hardcode raw enums.
const FILTER_EVENT_TYPES: EventType[] = [
  "vaccination_administered",
  "deworming_administered",
  "sterilization_performed",
  "weight_recorded",
  "vet_visit_logged",
  "clinical_info_logged",
  "microchip_implanted",
  "death_recorded",
  "incident_reported",
  "outbreak_signal",
  "disease_reported",
  "event_amended",
];

const FILTER_AUTHOR_ROLES: AuthorRole[] = [
  "owner",
  "vet",
  "shelter",
  "govt",
  "system",
  "scanner",
  "finder",
];

const AUTHOR_ROLE_OPTION_LABELS: Record<AuthorRole, string> = {
  owner: "Dueño/a",
  vet: "Veterinario/a",
  shelter: "Refugio",
  govt: "Autoridad pública",
  system: "Sistema",
  scanner: "Lector de chip",
  finder: "Hallador",
};

type SearchParams = {
  tipo?: string;
  provincia?: string;
  localidad?: string;
  desde?: string;
  hasta?: string;
  rol?: string;
  cursor?: string;
};

function parseDateParam(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const d = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function parseCursor(raw: string | undefined): LedgerCursor | undefined {
  if (!raw) return undefined;
  // Cursor is "<iso>|<id>" (URL-encoded). Validate both halves.
  const sep = raw.lastIndexOf("|");
  if (sep <= 0) return undefined;
  const occurredAt = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (Number.isNaN(new Date(occurredAt).getTime()) || !id) return undefined;
  return { occurredAt, id };
}

function encodeCursor(cursor: LedgerCursor): string {
  return `${cursor.occurredAt}|${cursor.id}`;
}

/** Build a querystring for the "Cargar más" link, preserving active filters. */
function buildLoadMoreHref(sp: SearchParams, cursor: LedgerCursor): string {
  const params = new URLSearchParams();
  if (sp.tipo) params.set("tipo", sp.tipo);
  if (sp.provincia) params.set("provincia", sp.provincia);
  if (sp.localidad) params.set("localidad", sp.localidad);
  if (sp.desde) params.set("desde", sp.desde);
  if (sp.hasta) params.set("hasta", sp.hasta);
  if (sp.rol) params.set("rol", sp.rol);
  params.set("cursor", encodeCursor(cursor));
  return `/admin/libro?${params.toString()}`;
}

export default async function AdminLibroPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const session = await requireAdminOrRedirect();

  const sp = searchParams ? await searchParams : {};

  // Build filters from searchParams.
  const eventType =
    sp.tipo && (FILTER_EVENT_TYPES as string[]).includes(sp.tipo)
      ? (sp.tipo as EventType)
      : undefined;
  const authorRole =
    sp.rol && (FILTER_AUTHOR_ROLES as string[]).includes(sp.rol)
      ? (sp.rol as AuthorRole)
      : undefined;

  const filters: EventLedgerFilters = {
    eventTypes: eventType ? [eventType] : undefined,
    province: sp.provincia || undefined,
    locality: sp.localidad || undefined,
    from: parseDateParam(sp.desde),
    to: parseDateParam(sp.hasta),
    authorRole,
  };

  const hasActiveFilters = Boolean(
    eventType || sp.provincia || sp.localidad || sp.desde || sp.hasta || authorRole,
  );

  // Admin universal scope, trailing-12m freshness window for the footer.
  const ctx = buildProjectionContext({ role: "admin" }, [], windows.trailing12m());

  const cursor = parseCursor(sp.cursor);
  const { rows, nextCursor } = await fetchEventLedger(ctx, filters, cursor);

  // Mandatory PII-oversight audit row (fire-and-forget; modeled on outreach).
  void logEventLedgerView(session.profile.id, filters, rows.length).catch(() => {
    // Best-effort: an audit failure must not break the read-only view.
  });

  const viewRows = rows.map(toLedgerRowView);

  return (
    <div className="space-y-6">
      {/* Header */}
      <ScreenHeader
        className="space-y-2"
        eyebrow="Admin · Gobernanza"
        title="Libro de eventos"
        subtitle={
          <p className="text-md text-ln-op-mute">
            Registro append-only — nada se edita, todo se anexa. Las correcciones son eventos nuevos
            que referencian al original; el original se conserva.
          </p>
        }
      />

      {/* Unified filter bar (F-migration 2026-07-21, off the bespoke GET
          <form>) — Tipo/Rol are registered axes (both no-param defaults are
          genuinely "todos", no blank-option trap). Provincia/Localidad and
          Desde/Hasta render as ONE `children` control (LibroFilterFields):
          OpFilterBar's own `jurisdiction` prop targets <JurisdictionSwitcher>
          (ISO code + locality slug); this screen's existing filter is keyed
          on NAMES (JurisdictionFilter's wire contract), and Desde/Hasta has NO
          default bound (genuinely unbounded, same as /admin/alertas +
          /admin/auditoria), so neither is the bar's own axis/`period`
          mechanism. LibroFilterFields commits EACH of the four params on
          change (no "Aplicar" button, PO consistency fix 2026-07-21), always
          preserving the other three and dropping the keyset `cursor` on
          commit (resetParamsOnChange). "Limpiar" (clears every filter,
          including this non-axis child — axis-only "Limpiar todo" can't
          reach it) stays a plain link in the header actions slot. */}
      <OpFilterBar
        showPeriod={false}
        resetParamsOnChange={["cursor"]}
        axes={
          [
            {
              id: "tipo",
              label: "Tipo de evento",
              paramKey: "tipo",
              options: FILTER_EVENT_TYPES.map((t) => ({ value: t, label: eventTypeLabel(t) })),
              current: eventType ?? null,
              allLabel: "Todos",
            },
            {
              id: "rol",
              label: "Rol del actor",
              paramKey: "rol",
              options: FILTER_AUTHOR_ROLES.map((r) => ({
                value: r,
                label: AUTHOR_ROLE_OPTION_LABELS[r],
              })),
              current: authorRole ?? null,
              allLabel: "Todos",
            },
          ] satisfies OpFilterAxis[]
        }
        actions={
          hasActiveFilters ? (
            <Link
              href="/admin/libro"
              className="text-sm font-medium text-ln-op-azul no-underline hover:underline"
            >
              Limpiar
            </Link>
          ) : null
        }
      >
        <LibroFilterFields
          provinceValue={sp.provincia}
          localityValue={sp.localidad}
          fromValue={sp.desde}
          toValue={sp.hasta}
          resetParamsOnChange={["cursor"]}
        />
      </OpFilterBar>

      {/* Stream + amendment + replay */}
      <OpCard>
        <OpCardHead
          title="Flujo de eventos"
          actions={
            <span className="text-sm text-ln-op-mute">
              {viewRows.length} {viewRows.length === 1 ? "evento" : "eventos"} en esta página
            </span>
          }
        />
        <OpCardBody>
          {viewRows.length === 0 ? (
            <p className="text-md text-ln-op-mute">
              {hasActiveFilters
                ? "Sin eventos con estos filtros. Probá ampliar el rango o quitar filtros."
                : "El libro está vacío — todavía no hay eventos registrados."}
            </p>
          ) : (
            <>
              <EventLedgerTable rows={viewRows} />
              {nextCursor && (
                <div className="mt-4 flex justify-center">
                  <Link
                    href={buildLoadMoreHref(sp, nextCursor)}
                    className="h-11 rounded-[var(--radius-md)] border border-ln-op-line px-4 text-md leading-[44px] text-ln-op-ink hover:bg-ln-op-stripe"
                  >
                    Cargar más
                  </Link>
                </div>
              )}
            </>
          )}
        </OpCardBody>
      </OpCard>

      <DashboardFreshnessFooter ctx={ctx} />
    </div>
  );
}
