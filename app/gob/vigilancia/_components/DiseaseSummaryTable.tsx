// Period rollup table grouped by disease, with sub-counts for 7d and 24h.
// Server component — receives the pre-computed (and, since Q4, pre-SORTED)
// summary from the page. `windowDays` labels the total column (the fetch
// window); defaults to 30.
//
// Q4 (URL sort): when `sort` is provided the headers render as OpSortHeader
// cells (?orden=&dir=, aria-sort, full-document commit) and the PAGE re-sorts
// the summary server-side via sortRowsByUrlSort — this component never sorts,
// it only reports which column the URL claims. Without `sort` the headers
// stay static (backward compatible).

import { LnEmptyState } from "@/components/ui/EmptyState";
import { OpSortHeader } from "@/components/ui/dashboard/OpSortHeader";
import type { DiseaseSummary } from "@/lib/analytics/govt-dashboards";
import type { UrlSort } from "@/lib/ui/url-sort";

/** Closed sort-key set for ?orden= — one per column, fail-closed upstream. */
export const DISEASE_SUMMARY_SORT_KEYS = ["enfermedad", "h24", "d7", "d30"] as const;
export type DiseaseSummarySortKey = (typeof DISEASE_SUMMARY_SORT_KEYS)[number];

const HEADER_TH = "px-3 py-2 text-right text-xs uppercase tracking-wider text-ln-op-mute";
const HEADER_TH_LEFT = "px-4 py-2 text-left text-xs uppercase tracking-wider text-ln-op-mute";

export function DiseaseSummaryTable({
  summary,
  windowDays = 30,
  sort,
}: {
  summary: DiseaseSummary[];
  windowDays?: number;
  /** Current URL sort (parseUrlSort result). Absent → static headers. */
  sort?: UrlSort<DiseaseSummarySortKey>;
}) {
  if (summary.length === 0) {
    // C4 (2026-07-22, §S4): same signal-reporting dependency as the parent
    // page's "Señales recientes" panel — a disease-summary row only exists
    // if someone reported a case. no-signal, not "all clear".
    return (
      <LnEmptyState
        icon="eye-off"
        nature="no-signal"
        title="Sin señales registradas en miMAR"
        description={`Ningún caso fue reportado en los últimos ${windowDays} días — la ausencia de reportes no implica ausencia de enfermedad.`}
      />
    );
  }
  return (
    <div className="overflow-x-auto rounded-[var(--radius-md)] border border-ln-op-line">
      <table className="min-w-full text-md">
        <caption className="sr-only">
          Resumen de señales por enfermedad en los últimos {windowDays} días
          {sort ? " (ordenable por columna)" : ""}
        </caption>
        <thead className="bg-ln-op-stripe">
          <tr className="text-left text-xs uppercase tracking-wider text-ln-op-mute">
            {sort ? (
              <>
                <OpSortHeader
                  sortKey="enfermedad"
                  label="Enfermedad"
                  defaultDir="asc"
                  current={sort}
                  className={HEADER_TH_LEFT}
                />
                <OpSortHeader sortKey="h24" label="24h" current={sort} className={HEADER_TH} />
                <OpSortHeader sortKey="d7" label="7 días" current={sort} className={HEADER_TH} />
                <OpSortHeader
                  sortKey="d30"
                  label={`${windowDays} días`}
                  current={sort}
                  className={HEADER_TH}
                />
              </>
            ) : (
              <>
                <th scope="col" className="px-4 py-2">
                  Enfermedad
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  24h
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  7 días
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  {windowDays} días
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-ln-op-line-2">
          {summary.map((row) => (
            <tr key={row.diseaseCode}>
              <td className="px-4 py-2 text-ln-op-ink">{row.diseaseName}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ln-op-ink-2">{row.count24h}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ln-op-ink-2">{row.count7d}</td>
              <td className="px-3 py-2 text-right tabular-nums font-semibold text-ln-op-ink">
                {row.count30d}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
