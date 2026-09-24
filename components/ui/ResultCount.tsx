// ResultCount — the shared "cuántos estoy viendo, de cuántos" line for any
// capped or paginated list (dashboards milestone, Track B item 3).
//
// Before this, ~12 screens each phrased it their own way: "Mostrando N de M
// mascotas", "Mostrando las primeras 200. Hay más — usá los filtros de arriba",
// "Mostrando los primeros N usuarios ordenados por rol y nombre". Same job,
// twelve wordings — and, worse, two DIFFERENT epistemic claims wearing the same
// clothes.
//
// That distinction is the whole point of this primitive, so it is modelled
// explicitly rather than flattened:
//
//   - `total` KNOWN     → "Mostrando N de M casos."   (an exact, checkable claim)
//   - `total` UNKNOWN   → "Mostrando los primeros N casos — hay más."
//                         (the list was capped and nobody counted the rest;
//                          saying "de N" here would invent a total)
//
// A screen that only capped its query must NOT be able to render the first form
// by accident — hence `total?: number` rather than a `total: number` a caller
// could satisfy with `items.length`.

import type { ReactNode } from "react";

export function ResultCount({
  shown,
  total,
  /** es-AR plural noun for the rows ("casos", "mascotas", "usuarios"). */
  noun,
  /**
   * What the operator can DO about a capped list ("usá los filtros de arriba
   * para acotar"). Only meaningful when the list is capped; omitted otherwise
   * because there is nothing to act on.
   */
  hint,
  /** Extra ordering context ("ordenados por rol y nombre"). */
  ordering,
  className,
}: {
  shown: number;
  total?: number;
  noun: string;
  hint?: ReactNode;
  ordering?: string;
  className?: string;
}) {
  const n = shown.toLocaleString("es-AR");
  const capped = total === undefined || total > shown;

  return (
    <p className={className ?? "text-sm text-ln-op-mute"}>
      {total !== undefined ? (
        <>
          Mostrando {n} de {total.toLocaleString("es-AR")} {noun}
          {ordering ? `, ${ordering}` : ""}.
        </>
      ) : (
        <>
          {/* "el primer 1 servicio" is broken Spanish — the numeral is implied
              by the ordinal, so the singular drops it. The ordering clause sits
              INSIDE the sentence: after the "— hay más" coda it would read as
              if the unseen rows were the ordered ones. */}
          Mostrando{" "}
          {shown === 1 ? (
            <>el primer {noun}</>
          ) : (
            <>
              los primeros {n} {noun}
            </>
          )}
          {ordering ? `, ${ordering}` : ""} — hay más.
        </>
      )}
      {capped && hint ? <> {hint}</> : null}
    </p>
  );
}
