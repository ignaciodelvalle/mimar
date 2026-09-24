// Admin-scope case index - universal view across all jurisdictions.

import Link from "next/link";
import { redirect } from "next/navigation";
import { type ReactNode, Suspense } from "react";

import {
  CasoEstadoFilter,
  CsvExportLink,
  type OpFilterAxis,
  OpFilterBar,
  parseCasoEstado,
} from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { CaseQueue, type CaseQueueRow } from "@/components/ui/dashboard/CaseQueue";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import {
  CASE_QUEUE_CSV_COLUMNS,
  caseQueueCsvOrderNote,
  caseQueueCsvRows,
} from "@/components/ui/dashboard/case-queue-csv";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { countCasesForAdmin, listCasesForAdmin } from "@/lib/infra/case-queries";
import { PROVINCES } from "@/lib/reference/ar-provincias";
import {
  CASE_QUEUE_POSITION_PARAMS,
  caseQueuePagerLabels,
  caseQueuePaginationHrefs,
  caseQueueSortHrefs,
  parseCaseQueuePage,
  parseCaseQueueSort,
} from "@/lib/ui/case-queue-order";
import { csvPageDisclosure } from "@/lib/ui/csv-export";
import { todayIsoInAr } from "@/lib/utils/format";
import { trimmedSearchParam } from "@/lib/utils/search-params";
import { CASE_KINDS, type CaseKind, caseKindLabel } from "@/src/modules/cases/domain/case-kinds";

const ADMIN_CASOS_PAGE_LIMIT = 50;

// Tipo/Provincia axis options — same shape as /gob/casos so the two casos
// twins render identically. Estado is NOT an axis option set anymore — see
// CasoEstadoFilter (BUGFIX opfilterbar-sweep-2026-07-21).
const KIND_OPTIONS = CASE_KINDS.map((k) => ({ value: k, label: caseKindLabel(k) }));
const PROVINCE_OPTIONS = PROVINCES.map((p) => ({ value: p.name, label: p.name }));

export default async function AdminCasosPage({
  searchParams,
}: {
  searchParams: Promise<{
    cursor?: string;
    /** 1-based OFFSET page, used only under `orden=urgencia` (SC-6). */
    pagina?: string;
    /** Active sort: "urgencia" (default) | "recientes" — reaches the SQL ORDER BY. */
    orden?: string;
    status?: string;
    kind?: string;
    province?: string;
  }>;
}) {
  const session = await requireAdminOrGovtOrRedirect();
  if (session.profile.role !== "admin") redirect("/gob/casos");

  const sp = await searchParams;
  // SC-6 (audit 2026-07-26, red #3) — identical contract to the /gob twin:
  // the sort lives in the URL so it reaches the SQL ORDER BY and ranks the
  // whole filtered set instead of re-ranking the page the server already
  // picked by date. Pagination mode follows the sort (offset for urgency,
  // keyset for date) because a score derived from now() cannot be encoded in
  // a stable cursor — see listCasesForAdmin.
  const sort = parseCaseQueueSort(sp.orden);
  const page = sort === "urgencia" ? parseCaseQueuePage(sp.pagina) : 1;
  const rawCursor = sort === "urgencia" ? undefined : sp.cursor;

  // Parse filters from searchParams — push them all into SQL, not JS.
  // WS-PERF P2: default to "open" when no explicit status param is present so
  // the triager's first paint is the actionable open-case view (fast + relevant)
  // rather than a 500-row full scan across all statuses. An explicit status=
  // (including the "all" sentinel value) overrides the default.
  // 3-way Estado value ("open" default / "all" / "closed") for the
  // CasoEstadoFilter control (BUGFIX opfilterbar-sweep-2026-07-21) — collapses
  // to the SQL-facing open|closed|null via statusFilter below.
  const rawStatus = sp.status;
  const casoEstado = parseCasoEstado(rawStatus);
  const statusFilter: "open" | "closed" | null = casoEstado === "all" ? null : casoEstado;
  const kindFilter =
    sp.kind && CASE_KINDS.includes(sp.kind as CaseKind) ? (sp.kind as CaseKind) : null;
  // Q1: a repeated ?province= hands Next a string[] — raw `.trim()` on that
  // throws (500).
  const provinceFilter = trimmedSearchParam(sp.province) ?? null;

  // Whether the user explicitly changed from the default (open, no kind, no province).
  // Used to show/hide the "Limpiar filtros" link — the default open view is not
  // considered an active filter.
  const statusExplicitlyOverridden = casoEstado !== "open";
  const hasActiveFilters =
    statusExplicitlyOverridden || kindFilter !== null || provinceFilter !== null;

  const filterParams: Record<string, string | undefined> = {
    // Carry status in pagination links only when it differs from the default (open).
    // For status=all (null filter), use the "all" sentinel so the paginator
    // preserves the user's explicit choice.
    ...(statusExplicitlyOverridden ? { status: casoEstado } : {}),
    ...(kindFilter ? { kind: kindFilter } : {}),
    ...(provinceFilter ? { province: provinceFilter } : {}),
  };

  // Chrome that depends on nothing the load returns — hoisted so the degraded
  // branch below renders the SAME header and filter bar as the success path
  // (lint:degraded-chrome). A timed-out queue must still let the operator
  // narrow the query that just timed out.
  const header = (
    <ScreenHeader
      eyebrow="Admin · Casos"
      title="Casos"
      subtitle={
        <p className="text-md text-ln-op-mute">
          Expedientes abiertos en el sistema. Vista universal admin.{" "}
          {!statusExplicitlyOverridden && (
            <a
              href="/admin/casos?status=all"
              className="underline underline-offset-2 hover:text-ln-op-ink"
            >
              Ver todos
            </a>
          )}
        </p>
      }
    />
  );

  // Unified filter bar — Estado/Tipo/Provincia (migrated off the bespoke
  // <form>, mirrors /gob/casos so the two casos twins render identically).
  // Estado renders as a plain child control (CasoEstadoFilter), NOT an `axis`:
  // an axis ALWAYS gets OpFilterBar's own injected blank "Todas" option
  // (mapping to "no status param" = the Abiertos default), which sat right
  // beside the explicit "all" option's OWN "Todos los estados" label — two
  // visually-identical "show everything" entries where only one actually did
  // (BUGFIX opfilterbar-sweep-2026-07-21: the injected blank silently reverted
  // to Abiertos instead of showing every case). A filter change drops the
  // keyset `cursor` (page 1), matching the old form's implicit reset.
  //
  // `actions` is the CSV export, which is made of the loaded rows — so the
  // degraded branch renders the bar without it: offering a download of
  // nothing would lie.
  const filterBar = (actions?: ReactNode) => (
    <OpFilterBar
      showPeriod={false}
      // Both position params (SC-6): a filter change must land on page 1 in
      // either pagination mode, keyset or offset.
      resetParamsOnChange={[...CASE_QUEUE_POSITION_PARAMS]}
      savedViewsKey="op-saved-views:casos:v1"
      actions={actions}
      axes={
        [
          {
            id: "kind",
            label: "Tipo",
            paramKey: "kind",
            options: KIND_OPTIONS,
            current: kindFilter,
            allLabel: "Todos los tipos",
          },
          {
            id: "province",
            label: "Provincia",
            paramKey: "province",
            options: PROVINCE_OPTIONS,
            current: provinceFilter,
            allLabel: "Todas las provincias",
          },
        ] satisfies OpFilterAxis[]
      }
    >
      <CasoEstadoFilter value={casoEstado} />
    </OpFilterBar>
  );

  // Fetch limit+1 to detect hasMore, plus the true total behind the cap (M4) so
  // the header reads "Mostrando los 50 más recientes de N" instead of "50 casos"
  // when more exist. The count uses the SAME filters as the list.
  //
  // BOUNDED (T1-L6). The /gob twin has raced this exact pair against a deadline
  // since the 2026-08-09 outage pass; this admin copy awaited it bare, so a
  // degraded pooler left the operator on the loading skeleton forever.
  const load = await loadWithTimeout(
    Promise.all([
      listCasesForAdmin({
        limit: ADMIN_CASOS_PAGE_LIMIT + 1,
        cursor: rawCursor,
        offset: (page - 1) * ADMIN_CASOS_PAGE_LIMIT,
        sort,
        filters: {
          status: statusFilter,
          kind: kindFilter,
          province: provinceFilter,
        },
      }),
      countCasesForAdmin({
        status: statusFilter,
        kind: kindFilter,
        province: provinceFilter,
      }),
    ]),
  );
  if (!load.ok) {
    return (
      <div className="space-y-6">
        {header}
        {filterBar()}
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref={analyticsRetryHref("/admin/casos", sp)}
        />
      </div>
    );
  }
  const [rawItems, totalCount] = load.value;
  const hasMore = rawItems.length > ADMIN_CASOS_PAGE_LIMIT;
  const items = hasMore ? rawItems.slice(0, ADMIN_CASOS_PAGE_LIMIT) : rawItems;

  // Sort links carry the filters and reset the position, so switching order
  // never lands the operator mid-list in a ranking they never scrolled.
  const sortHrefs = caseQueueSortHrefs("/admin/casos", filterParams);
  // From here the active sort rides with the filters across page turns.
  if (sort !== "urgencia") filterParams.orden = sort;

  const { newerLink, olderLink } = caseQueuePaginationHrefs("/admin/casos", filterParams, {
    sort,
    page,
    hasMore,
    cursor: rawCursor,
    lastRow: items.at(-1),
  });
  const pagerLabels = caseQueuePagerLabels(sort);

  // Map CaseListItem → CaseQueueRow for the shared queue table. The rich
  // status/kind/province filter form above owns filtering, so the queue's
  // built-in status chips are suppressed (showStatusChips={false}) to avoid a
  // duplicate status control. Cases are reachable via the in-shell operator
  // detail /admin/casos/[publicCode] — NOT the public /casos/[publicCode],
  // which renders under the citizen layout and strips the operator rail/topbar
  // (the shell-loss class fixed for /gob in task #47; the admin half landed
  // 2026-07-16 after QA ronda 5 caught it).
  const queueRows: CaseQueueRow[] = items.map((c) => ({
    id: c.id,
    publicCode: c.publicCode,
    caseKind: c.caseKind,
    status: c.status,
    primarySubjectKind: c.primarySubjectKind,
    primaryPetName: c.primaryPetName,
    primaryPetPublicToken: c.primaryPetPublicToken,
    jurisdictionProvince: c.jurisdictionProvince,
    jurisdictionLocality: c.jurisdictionLocality,
    openedAt: c.openedAt,
    closedAt: c.closedAt,
    detailHref: `/admin/casos/${c.publicCode}`,
  }));

  // Q1 (CSV export parity) — same shared CaseQueue CSV projection as
  // /gob/casos (case-queue-csv.ts), so the two casos twins export identically.
  const csvPageLine = csvPageDisclosure(queueRows.length, totalCount);
  const csvContextLines = [
    "miMAR · Casos — vista universal admin",
    caseQueueCsvOrderNote(sort),
    ...(csvPageLine ? [csvPageLine] : []),
  ];

  return (
    <div className="space-y-6">
      {header}

      {filterBar(
        <CsvExportLink
          filename={`casos-${todayIsoInAr()}`}
          columns={CASE_QUEUE_CSV_COLUMNS}
          rows={caseQueueCsvRows(queueRows)}
          contextLines={csvContextLines}
        />,
      )}

      <Suspense>
        <CaseQueue
          rows={queueRows}
          filters={{ status: statusFilter, kind: kindFilter }}
          showStatusChips={false}
          caption="Cola de casos — vista universal admin"
          sortMode={sort}
          sortHrefs={sortHrefs}
          // "Mostrando N de M" is a FIRST-PAGE affordance; past page 1 these
          // are the next 50 in the active order, not the top 50 of it. Both
          // pagination modes are checked (keyset cursor OR offset page).
          totalCount={rawCursor || page > 1 ? undefined : totalCount}
          // Same class /adoptar solved and /perdidas has now been fixed for:
          // "para los filtros aplicados" blamed filters nobody had applied. On
          // the untouched default view the honest reading is that the open
          // queue is empty — which is the good news, not a filtering accident.
          emptyMessage={
            hasActiveFilters
              ? "Ningún caso coincide con los filtros aplicados."
              : "No hay casos abiertos. Usá «Ver todos» para incluir los cerrados."
          }
          // P2-2: a filtered-empty queue must NOT be hidden — the operator has
          // to see that a filter, not the world, produced the silence. So it
          // gets the MINIMUM instead: the way out. Same treatment its twin
          // /gob/casos already ships; this admin copy never got it.
          emptyAction={
            hasActiveFilters ? (
              <Link href="/admin/casos" className="text-sm text-ln-op-azul hover:underline">
                Limpiar filtros
              </Link>
            ) : undefined
          }
        />
      </Suspense>

      {/* Pagination footer — keyset under "recientes", offset under
          "urgencia"; labels follow the sort (SC-6). */}
      {(newerLink || olderLink) && (
        <nav
          aria-label="Paginación de casos"
          className="flex items-center justify-between gap-4 border-t border-ln-op-line pt-4"
        >
          <div>
            {newerLink && (
              <Link
                href={newerLink}
                className="text-sm font-medium text-ln-op-azul no-underline hover:underline"
              >
                {pagerLabels.newer}
              </Link>
            )}
          </div>
          <div>
            {olderLink && (
              <Link
                href={olderLink}
                className="text-sm font-medium text-ln-op-azul no-underline hover:underline"
              >
                {pagerLabels.older}
              </Link>
            )}
          </div>
        </nav>
      )}
    </div>
  );
}
