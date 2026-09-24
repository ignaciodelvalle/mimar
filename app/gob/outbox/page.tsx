// /gob/outbox — ENO SLA / notification monitor scoped to jurisdiction.
//
// Filter-building SQL is shared with /admin/outbox via
// lib/infra/outbox-query.ts (#26 D3, was a self-admitted copy-paste fork —
// see git history for the old duplicated inline builder). The ONLY
// difference between the two pages is the jurisdiction scope passed to
// buildOutboxWhere:
//
//   admin           → { cursor } (no `jurisdiction` key — universal, no clause)
//   /gob/outbox+govt → { jurisdiction: jurisdictions, cursor } — an OR of
//                      (targetJurisdictionProvince = j.province AND
//                       targetJurisdictionLocality = j.locality) over the
//                      govt's own active assignments (whole-province
//                      subsumption via jurisdictionPairClause)
//
// Privacy invariant: that jurisdiction clause is the cross-tenant-leak
// boundary. A govt with assignments [{province:"Buenos Aires",
// locality:"La Plata"}] will see ONLY rows where
// (targetJurisdictionProvince='Buenos Aires' AND
// targetJurisdictionLocality='La Plata'). They cannot widen this — an
// admin viewing THIS SAME page passes no jurisdiction scope (sees all rows),
// but a govt viewer always does (see the `profile.role === "govt"` branch
// below), and buildOutboxWhere fails CLOSED for an empty scope array.

import Link from "next/link";

import { LnEmptyState } from "@/components/ui/EmptyState";
import {
  OpBreach,
  OpCard,
  type OpFilterAxis,
  OpFilterBar,
  ViewScopeCaption,
} from "@/components/ui/dashboard";
import { DashboardFreshnessFooter } from "@/components/ui/dashboard/DashboardFreshnessFooter";
import { OutboxTable } from "@/components/ui/dashboard/OutboxTable";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { db, eventNotificationOutbox } from "@/db";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { buildBreachCue, describeEnoNotification } from "@/lib/infra/outbox-list";
import {
  OUTBOX_PAGE_LIMIT,
  type OutboxSearchParams,
  VALID_PROVINCE_NAMES,
  buildOutboxWhere,
  outboxOrderBy,
  outboxSupportsKeyset,
  parseOutboxFilters,
} from "@/lib/infra/outbox-query";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { PROVINCES } from "@/lib/reference/ar-provincias";
import { buildOutboxDomainAxes } from "@/lib/ui/outbox-filter-axes";
import { describeNarrowedView } from "@/lib/ui/view-scope-caption";
import { pluralizeEs } from "@/lib/utils/format";
import { decodeCursor, newerHref, olderHref } from "@/lib/utils/keyset-pagination";

export default async function GobOutboxPage({
  searchParams,
}: {
  searchParams: Promise<OutboxSearchParams & { cursor?: string }>;
}) {
  const { profile, jurisdictions } = await requireGobReadAccessOrRedirect();

  // Capability guard: requires admin OR (govt AND has assignments).
  const hasAccess =
    hasNationalReadScope(profile.role) || (profile.role === "govt" && jurisdictions.length > 0);

  if (!hasAccess) {
    return (
      <div className="space-y-6">
        <LnEmptyState
          icon="lock"
          title="Sin acceso"
          description="Tu rol no tiene acceso al outbox. Pedile al admin que te asigne jurisdicciones."
        />
      </div>
    );
  }

  const sp = await searchParams;
  const actor = { role: profile.role } as const;
  // Shared parser with /admin/outbox (Q1-safe on repeated params; an unknown
  // ?preset= is simply no preset). `preset=eno` is the legal-notification
  // queue — the same filter + order on both twins (lib/infra/outbox-query.ts).
  const filters = parseOutboxFilters(sp);
  const preset = filters.preset ?? null;

  // Build a scoped ProjectionContext for DashboardFreshnessFooter.
  // The outbox page has no period picker — trailing12m is the default window.
  // This page has no JurisdictionSwitcher/resolveJurisdictionScope — it uses its
  // own `province` filter axis (below) as the sole scope narrowing, applied directly
  // in the WHERE clause for BOTH roles. For an admin, that dropdown IS the
  // equivalent of the JurisdictionSwitcher's province drill-down elsewhere, so
  // it's threaded into the ctx too — otherwise the freshness footer's "último
  // evento" would silently stay national while the list above is narrowed.
  const universal = hasNationalReadScope(profile.role);
  const adminProvince =
    universal && filters.province && VALID_PROVINCE_NAMES.has(filters.province)
      ? filters.province
      : undefined;
  const ctx = buildProjectionContext(actor, jurisdictions, windows.trailing12m(), {
    adminProvince,
  });

  // C3 disclosure: caption when this page's filters narrow below the mandate.
  // This screen has no resolveJurisdictionScope/filteredJurisdictions — its
  // only narrowing mechanism is the admin-only province filter above, so the
  // effective set for govt always equals the mandate (no real narrowing).
  const narrowedView = describeNarrowedView({
    role: profile.role,
    mandateJurisdictions: jurisdictions,
    effectiveJurisdictions: jurisdictions,
    adminProvince,
  });

  // Keyset cursors are minted over the recency order only; a preset view is
  // deadline-ordered and renders ONE page (outboxSupportsKeyset).
  const paginates = outboxSupportsKeyset(preset);
  const rawCursor = paginates ? sp.cursor : undefined;
  const cursor = decodeCursor(rawCursor);

  const hasFilters = Object.values(filters).some(Boolean);

  // Shared builder with /admin/outbox (#26 D3). Jurisdiction scope (privacy
  // invariant, see module doc comment): govt passes its own active
  // assignments (hasAccess above already guarantees jurisdictions.length > 0
  // whenever profile.role === "govt" reaches this point); admin / national
  // pass `undefined` (omit the key) — no jurisdiction clause, universal
  // scope, identical to /admin/outbox.
  const whereClause = buildOutboxWhere(filters, {
    jurisdiction: universal ? undefined : jurisdictions,
    cursor,
  });

  const rawRows = await db
    .select()
    .from(eventNotificationOutbox)
    .where(whereClause)
    .orderBy(...outboxOrderBy(preset))
    .limit(OUTBOX_PAGE_LIMIT + 1);

  const hasMore = rawRows.length > OUTBOX_PAGE_LIMIT;
  const rows = hasMore ? rawRows.slice(0, OUTBOX_PAGE_LIMIT) : rawRows;

  const breachCount = rows.filter((r) => buildBreachCue(r.status, r.slaDueAt) === "breach").length;

  const filterParams: Record<string, string | undefined> = {
    ...(preset ? { preset } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.target_kind ? { target_kind: filters.target_kind } : {}),
    ...(filters.breach ? { breach: filters.breach } : {}),
    ...(filters.province ? { province: filters.province } : {}),
  };
  const lastRow = rows.at(-1);
  const olderLink =
    paginates && hasMore && lastRow
      ? olderHref("/gob/outbox", filterParams, { ts: lastRow.createdAt, id: lastRow.id })
      : null;
  const newerLink = rawCursor ? newerHref("/gob/outbox", filterParams) : null;

  // Build allowed provinces for the province filter dropdown.
  // Govt: only their assigned provinces. Admin: all provinces.
  const allowedProvinces = universal
    ? PROVINCES
    : PROVINCES.filter((p) => jurisdictions.some((j) => j.province === p.name));

  return (
    <div className="space-y-6">
      <ScreenHeader
        eyebrow="Gobierno"
        title={
          preset === "eno"
            ? "Cola ENO — avisos legales pendientes"
            : "Bandeja de salida — tu jurisdicción"
        }
        subtitle={
          <>
            {/* Subtítulo ESTABLE: filtrar no lo reemplaza. Antes el conteo lo
                pisaba con "N filas con los filtros aplicados" — reintroducía la
                voz de debug ("filas") que ya habíamos sacado, y decía algo que
                el estado vacío de abajo ya dice. El encabezado explica QUÉ es
                esta pantalla; cuántas filas quedaron lo cuenta la tabla. La
                vista ENO sí cambia la frase: es otra pregunta, no otro filtro. */}
            <p className="text-md text-ln-op-ink-2">
              {preset === "eno"
                ? "Notificaciones con plazo legal a la autoridad sanitaria y a tu sistema receptor, ordenadas por vencimiento: primero las ya vencidas."
                : "Envíos a autoridades y sistemas desde tu jurisdicción."}
            </p>
            <ViewScopeCaption scope={narrowedView} />
          </>
        }
      />

      {/* SLA breach banner */}
      {breachCount > 0 && (
        <OpBreach
          title={`${breachCount} ${pluralizeEs(breachCount, "envío", "envíos")} en incumplimiento de SLA`}
          detail="Revisá los envíos marcados en rojo y reintentá si es necesario."
        />
      )}

      {/* Unified filter bar — Estado/Destino/SLA/Provincia domain axes
          (migrated off the bespoke <form>, mirrors /admin/outbox so the two
          outbox twins render identically). status/target_kind/breach axis
          defs are shared via buildOutboxDomainAxes (#26 D3 lineage — same
          module the WHERE-clause builder already shares). A filter change
          drops the keyset `cursor` (page 1), matching the old form's implicit
          reset (it never carried `cursor` as a field). */}
      <OpFilterBar
        showPeriod={false}
        resetParamsOnChange={["cursor"]}
        axes={
          [
            ...buildOutboxDomainAxes(filters),
            {
              id: "province",
              label: "Provincia",
              paramKey: "province",
              options: allowedProvinces.map((p) => ({ value: p.name, label: p.name })),
              current: filters.province ?? null,
              allLabel: universal ? "Todas las provincias" : "Todas tus provincias",
            },
          ] satisfies OpFilterAxis[]
        }
      />

      {/* Table */}
      {rows.length === 0 ? (
        <LnEmptyState
          icon="mail"
          title={hasFilters ? "Sin envíos que coincidan" : "Sin envíos registrados"}
          description={
            hasFilters
              ? "Ajustá los filtros para ver más resultados."
              : "No hay envíos registrados en la bandeja de salida de tu jurisdicción."
          }
          action={
            hasFilters ? (
              <Link href="/gob/outbox" className="text-sm text-ln-op-azul hover:underline">
                Limpiar filtros
              </Link>
            ) : undefined
          }
        />
      ) : (
        <OpCard>
          {/* Detail page is admin-only (/admin/outbox/[id] is admin-gated). A
              scoped /gob/outbox/[id] is a follow-up; the list already carries
              status/SLA/target so govt has no dead-end link (detailHrefFor
              returns null for govt → an inert "—" cell). Govt does not resolve
              source-event → pet links, so petTokenBySourceEventId is omitted. */}
          <OutboxTable
            rows={rows}
            caption={
              preset === "eno"
                ? "Cola de avisos legales pendientes para tu jurisdicción, con enfermedad, plazo legal y estado SLA"
                : "Cola de notificaciones salientes para tu jurisdicción, con estado SLA, destino y acciones"
            }
            detailHrefFor={(row) => (profile.role === "admin" ? `/admin/outbox/${row.id}` : null)}
            enoDetailFor={
              preset === "eno" ? (row) => describeEnoNotification(row.payloadSnapshot) : undefined
            }
          />
          {/* A preset view is deadline-ordered and renders ONE page: say so when
              the queue is longer, instead of a "más antiguos" link that would
              re-sort on the next page (outboxSupportsKeyset). */}
          {!paginates && hasMore && (
            <p className="px-3 pt-3 text-sm text-ln-op-mute">
              Se muestran los {OUTBOX_PAGE_LIMIT} vencimientos más próximos. Acotá por estado o
              provincia para ver el resto.
            </p>
          )}
        </OpCard>
      )}

      {/* Pagination footer */}
      {(newerLink || olderLink) && (
        <nav
          aria-label="Paginación de la bandeja de salida"
          className="flex items-center justify-between gap-4 border-t border-ln-op-line pt-4"
        >
          <div>
            {newerLink && (
              <Link
                href={newerLink}
                className="text-sm font-medium text-ln-op-azul no-underline hover:underline"
              >
                ← Más recientes
              </Link>
            )}
          </div>
          <div>
            {olderLink && (
              <Link
                href={olderLink}
                className="text-sm font-medium text-ln-op-azul no-underline hover:underline"
              >
                Ver más antiguos →
              </Link>
            )}
          </div>
        </nav>
      )}

      <DashboardFreshnessFooter ctx={ctx} />
    </div>
  );
}
