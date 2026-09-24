// The case-queue ORDER contract: the `?orden=` / `?pagina=` URL vocabulary the
// casos screens speak, shared by the server query, the pagination footer and
// the client toggle.
//
// WHY THIS IS A PURE MODULE AND NOT PART OF CaseQueue.tsx. CaseQueue is
// "use client"; a plain function exported from a "use client" file becomes a
// client-reference Proxy when a Server Component imports it, and throws on
// use — the same trap CASE_SLA_WARNING_DAYS was moved out of (see the note in
// CaseQueue.tsx). The casos screens are server components and must parse
// `?orden=` before they query, so the vocabulary has to live somewhere both
// tiers can import.
//
// SC-6 (audit 2026-07-26, red #3), 2026-08-07.

import { newerHref, olderHref } from "@/lib/utils/keyset-pagination";

/** The sort vocabulary. These strings ARE the `?orden=` URL values. */
export const CASE_QUEUE_SORTS = ["urgencia", "recientes"] as const;

export type CaseQueueSort = (typeof CASE_QUEUE_SORTS)[number];

/** es-AR labels for the toggle and for the row-count caption. */
export const CASE_QUEUE_SORT_LABELS: Record<CaseQueueSort, string> = {
  urgencia: "Urgencia",
  recientes: "Recientes",
};

/**
 * Default sort. Urgency since the PO interview 2026-07-23 (item 6): the queue
 * should lead with what most needs action, not with what is newest.
 */
export const CASE_QUEUE_DEFAULT_SORT: CaseQueueSort = "urgencia";

/**
 * Params that identify a POSITION in the queue rather than a filter. Both
 * pagination modes are listed because a screen can switch between them
 * (`cursor` for `recientes`, `pagina` for `urgencia`), and a leftover param
 * from the OTHER mode is at best dead weight and at worst a stale cursor that
 * reappears when the operator toggles back. Filter controls reset all of them.
 */
export const CASE_QUEUE_POSITION_PARAMS = ["cursor", "pagina"] as const;

/** Narrow an untrusted `?orden=`; anything unrecognised falls back to the default. */
export function parseCaseQueueSort(raw: string | string[] | undefined): CaseQueueSort {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (CASE_QUEUE_SORTS as readonly string[]).includes(value ?? "")
    ? (value as CaseQueueSort)
    : CASE_QUEUE_DEFAULT_SORT;
}

/**
 * Narrow an untrusted `?pagina=` to a 1-based page number.
 *
 * Anything not a finite integer ≥ 1 collapses to page 1 — including "0", "-3",
 * "1e9" and "abc". This value is multiplied into a SQL OFFSET, so a permissive
 * parse here is a way to make an operator's typo cost a sequential scan.
 */
export function parseCaseQueuePage(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d{1,6}$/.test(value)) return 1;
  const n = Number.parseInt(value, 10);
  return n >= 1 ? n : 1;
}

function withParams(
  base: string,
  params: Record<string, string | undefined>,
  overrides: Record<string, string | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...overrides })) {
    if (v !== undefined) search.set(k, v);
  }
  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * One href per sort option, preserving the active filters and RESETTING the
 * position (both `cursor` and `pagina`).
 *
 * Resetting is not a nicety: page 3 of the date order and page 3 of the urgency
 * order are different sets of cases, so carrying a position across a sort change
 * would land the operator at an arbitrary point in a list they never scrolled.
 * The default sort is emitted WITHOUT the param so the canonical URL stays clean
 * and equals the one the screen links to from elsewhere.
 */
export function caseQueueSortHrefs(
  base: string,
  filterParams: Record<string, string | undefined>,
): Record<CaseQueueSort, string> {
  const hrefs = {} as Record<CaseQueueSort, string>;
  for (const sort of CASE_QUEUE_SORTS) {
    hrefs[sort] = withParams(base, filterParams, {
      orden: sort === CASE_QUEUE_DEFAULT_SORT ? undefined : sort,
      cursor: undefined,
      pagina: undefined,
    });
  }
  return hrefs;
}

/**
 * Prev/next hrefs for the queue footer, in whichever pagination mode the active
 * sort requires — the ONE place the keyset/offset split is decided, so the two
 * casos twins cannot drift into different pagination for the same order.
 *
 *   urgencia  → OFFSET (`?pagina=`). A score derived from `now()` cannot be
 *               encoded in a stable cursor (see listCasesForAdmin's note).
 *               Page 1 drops the param so the first page has exactly one URL.
 *   recientes → the exact (openedAt, id) KEYSET cursor this codebase already
 *               uses everywhere else (PERF-5), untouched.
 *
 * `lastRow` is the last RENDERED row and is only read in keyset mode.
 */
export function caseQueuePaginationHrefs(
  base: string,
  filterParams: Record<string, string | undefined>,
  state: {
    sort: CaseQueueSort;
    page: number;
    hasMore: boolean;
    cursor?: string;
    lastRow?: { openedAt: Date; id: string };
  },
): { newerLink: string | null; olderLink: string | null } {
  if (state.sort === "urgencia") {
    const at = (p: number) =>
      withParams(base, filterParams, { pagina: p > 1 ? String(p) : undefined });
    return {
      newerLink: state.page > 1 ? at(state.page - 1) : null,
      olderLink: state.hasMore ? at(state.page + 1) : null,
    };
  }
  return {
    newerLink: state.cursor ? newerHref(base, filterParams) : null,
    olderLink:
      state.hasMore && state.lastRow
        ? olderHref(base, filterParams, { ts: state.lastRow.openedAt, id: state.lastRow.id })
        : null,
  };
}

/**
 * Labels for the pagination footer. "Más recientes / más antiguos" describes a
 * DATE walk and reads as a lie under urgency ordering, where the next page is
 * simply less urgent — so the words follow the sort.
 */
export function caseQueuePagerLabels(sort: CaseQueueSort): { newer: string; older: string } {
  return sort === "urgencia"
    ? { newer: "← Más urgentes", older: "Ver menos urgentes →" }
    : { newer: "← Más recientes", older: "Ver más antiguos →" };
}
