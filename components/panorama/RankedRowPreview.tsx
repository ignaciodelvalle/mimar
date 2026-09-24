"use client";

// RankedRowPreview — A2 (map plan): the hover/focus preview body for a ranking
// row. The unit's key numbers where the eye already is, so reading the detail
// costs zero clicks.
//
// The CARD (positioning, anchoring, aria wiring) belongs to PanoramaDataTable,
// which owns the row DOM; this is only what goes inside it. Extracted from
// PanoramaConsole so the console does not keep growing — it is already past its
// file-size budget (scripts/check-file-size.ts).
//
// The closing hint NAMES what a click will actually do, and takes that from the
// SAME resolver the click handler uses (resolveRowDrillTarget), so an
// affordance can never promise an outcome the click doesn't deliver.

import { formatNegativeGap } from "@/components/panorama/map-popup";
import type { RankingKind } from "@/src/modules/panorama/domain/ranking";
import type { RankedUnit } from "@/src/modules/panorama/domain/ranking";

export function RankedRowPreview({
  row,
  measureLabel,
  kind,
  drills,
}: {
  row: RankedUnit;
  /** es-AR label of the ranked measure ("denuncias de bienestar"). */
  measureLabel: string;
  /** rate → percentage; density → raw count. */
  kind: RankingKind;
  /** Whether clicking this row drills into the unit (vs opening its detail). */
  drills: boolean;
}) {
  return (
    <>
      <p className="font-semibold text-ln-op-ink">{row.label}</p>
      <p className="mt-1 text-ln-op-ink-2">
        {measureLabel}:{" "}
        <span className="tabular-nums">
          {kind === "rate" ? `${Math.round(row.value)}%` : row.value.toLocaleString("es-AR")}
        </span>
      </p>
      {row.gap !== null && (
        <p className="text-ln-op-warn">
          {/* One decimal, not Math.round: a real 0.4-point gap printed as "−0"
              reports a unit that is BELOW target as having no gap. "pts" because
              the number sits under a percentage and is itself percentage POINTS. */}
          Brecha vs meta: <span className="tabular-nums">{formatNegativeGap(row.gap)} pts</span>
        </p>
      )}
      <p className="mt-2 text-ln-op-mute">
        {drills ? "Clic para entrar" : "Clic para ver el detalle"}
      </p>
    </>
  );
}
