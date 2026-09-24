"use client";

// OpSortHeader — the URL-committing sortable <th> for operator tables
// (Lote Q, Q4). Client half of lib/ui/url-sort.ts.
//
// Renders a header cell with aria-sort + a plain <a href="?orden=&dir=">.
// An anchor is DELIBERATE, on two grounds:
//
//   1. Commit discipline — a sort mutation must be a full-document
//      navigation (the serverNavCommit rule; engram #621/#622 router-drop).
//      A plain anchor IS that navigation class natively — same outcome as
//      serverNavCommit's window.location.assign, zero client-router
//      involvement, and it works before hydration. Same idiom the queue
//      pagination footers already use (<a href={olderLink}>).
//   2. The raw-<button> ratchet (scripts/check-raw-buttons.mjs) — a header
//      toggle is neither an LnButton nor an OpButton shape, and the anchor
//      needs no button at all.
//
// The server component that owns the table re-sorts its rows from the same
// params (parseUrlSort + sortRowsByUrlSort) on the next render, so the order
// on screen is always the order the URL claims. Visual idiom mirrors
// PanoramaDataTable's header cells (label + chevron on the active column).
// The <th> typography is the CALLER's via `className` — this component owns
// semantics (scope, aria-sort) and the commit href.

import { useSearchParams } from "next/navigation";

import { Icon } from "@/components/Icon";
import { type UrlSort, type UrlSortDir, ariaSortValue, nextUrlSortParams } from "@/lib/ui/url-sort";

type Props = {
  /** This column's sort key — the value ?orden= carries. */
  sortKey: string;
  /** Visible es-AR column label. */
  label: string;
  /** The screen's parsed current sort (from parseUrlSort). */
  current: UrlSort;
  /** Direction a FIRST click on this column starts at. Default "desc" —
   * right for measures (biggest first); pass "asc" for name columns. */
  defaultDir?: UrlSortDir;
  /** Extra params to DROP on a sort commit (e.g. a pagination cursor a
   * re-order invalidates) — same contract as OpFilterBar's resetParamsOnChange. */
  resetParams?: readonly string[];
  /** <th> classes — the owning table's own header typography/alignment. */
  className?: string;
};

export function OpSortHeader({
  sortKey,
  label,
  current,
  defaultDir = "desc",
  resetParams = [],
  className = "",
}: Props) {
  const searchParams = useSearchParams();
  const active = current.key === sortKey;
  const next = nextUrlSortParams(current, sortKey, defaultDir);

  // Same param algebra as serverNavCommit (set updates, then drop stale
  // keys), rendered as an href instead of imperatively assigned.
  // useSearchParams() is nullable outside a live navigation context
  // (static prerender, renderToStaticMarkup in tests) — treat as empty.
  const params = new URLSearchParams(searchParams?.toString() ?? "");
  for (const [key, value] of Object.entries(next)) params.set(key, value);
  for (const key of resetParams) params.delete(key);

  return (
    <th scope="col" aria-sort={ariaSortValue(active, current.dir)} className={className}>
      <a
        href={`?${params.toString()}`}
        aria-label={`Ordenar por ${label}, ${next.dir === "asc" ? "ascendente" : "descendente"}`}
        className="inline-flex items-center gap-1 no-underline hover:text-ln-op-ink"
      >
        {label}
        {active && (
          <span aria-hidden="true" className="text-ln-op-mute">
            <Icon
              name={current.dir === "asc" ? "chevron-up" : "chevron-down"}
              size="sm"
              decorative
            />
          </span>
        )}
      </a>
    </th>
  );
}
