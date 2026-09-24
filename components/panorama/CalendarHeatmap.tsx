"use client";

// CalendarHeatmap — GitHub-style day-cell grid for the Panorama dock's
// Estadísticas pane (viz-suite Wave 1, item 1). Columns are ISO weeks, rows are
// weekdays; each cell's fill encodes that day's SCOPE-TOTAL event count for the
// active temporal layer(s). Answers "¿cuándo?" at a glance — summer bites,
// post-fireworks losses.
//
// PURE PRESENTATIONAL: it takes { date, count }[] plus the window bounds and a
// label — it never fetches. The console feeds it the SAME per-day series the
// TimeScrubber histogram tracks (signal-histogram.ts), so the two never diverge.
//
// PRIVACY: the counts are scope-total (one number per day across the whole
// visible scope), never per-unit — strictly coarser than the per-unit
// aggregation k-anon already governs, so NO suppression applies here (same
// posture loadScopeDailyCounts / signal-histogram.ts document).
//
// A11y: the grid is a visual/mouse affordance; the keyboard + screen-reader path
// is the <details> fallback table (per-day rows), mirroring TimeSeriesChart. Each
// cell still carries an aria-label ("7 de julio: 3 eventos"). Placed as a
// self-contained <section> so a later regroup into a "Tendencias" dock family is
// a move, not a rewrite (viz-suite organizing principle).
//
// English identifiers, es-AR user copy (project invariant #4).

import { memo, useId } from "react";

import {
  type CalendarCell,
  type DailyCount,
  buildCalendarGrid,
  cellAriaLabel,
  clampSinceToRecentMonths,
} from "@/components/panorama/calendar-heatmap-grid";
import { formatDate, parseDateInput, pluralizeEs } from "@/lib/utils/format";
import { SCALE_BLUE_SEQ } from "@dim/contract/viz";

/** Widest window the day-cell grid renders before clamping to the recent tail. */
const CALENDAR_CAP_MONTHS = 12;

type Props = {
  /** Per-day scope-total counts (from loadScopeDailyCounts / client timestamps). */
  data: ReadonlyArray<DailyCount>;
  /** Window start, "YYYY-MM-DD". */
  since: string;
  /** Window end, "YYYY-MM-DD". */
  until: string;
  /** Section title. Default "Eventos por día". */
  title?: string;
  /**
   * C3: suppress the internal `<h3>` title when a parent (PanoramaStatSection)
   * already supplies a bounded header for this widget — avoids a double heading.
   * The methodNote/capped context lines still render. Default false (standalone).
   */
  hideHeading?: boolean;
  /** Honesty line under the title (scope + basis), following the methodNote idiom. */
  methodNote?: string;
  /** es-AR reason shown when `data` is empty (non-temporal layer, no events, …). */
  emptyMessage?: string;
  /** 0 = Sunday-first, 1 = Monday-first (default, es-AR). */
  weekStartsOn?: 0 | 1;
  /**
   * Optional single-day filter. Clicking a day cell (or a table row's date)
   * fires with that day's "YYYY-MM-DD" — the console routes it through its
   * EXISTING period-change path as a single-day custom window (no new state
   * axis). Omit to render a read-only heatmap.
   */
  onDayClick?: (date: string) => void;
};

function DayCell({
  cell,
  color,
  onDayClick,
}: {
  cell: CalendarCell;
  color: string;
  onDayClick?: (date: string) => void;
}) {
  const label = cellAriaLabel(cell);
  if (onDayClick) {
    // Day cells are a mouse-only affordance; the keyboard + screen-reader filter
    // path is the per-day buttons in the <details> table below (mirrors
    // TimeSeriesChart's chart-vs-table split — a focusable cell per day would
    // flood the tab order on a multi-year window).
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only affordance; keyboard/SR path is the <details> table buttons (see note above)
      <div
        role="img"
        aria-label={label}
        title={label}
        onClick={() => onDayClick(cell.date)}
        className="size-3 cursor-pointer rounded-[var(--radius-sm)]"
        style={{ backgroundColor: color }}
      />
    );
  }
  return (
    <div
      role="img"
      aria-label={label}
      title={label}
      className="size-3 rounded-[var(--radius-sm)]"
      style={{ backgroundColor: color }}
    />
  );
}

function CalendarHeatmapImpl({
  data,
  since,
  until,
  title = "Eventos por día",
  hideHeading = false,
  methodNote,
  emptyMessage,
  weekStartsOn = 1,
  onDayClick,
}: Props) {
  const titleId = useId();
  // PO cap (2026-07-14): a multi-year panorama window would render an
  // unreadably wide day-cell grid, so clamp to the most recent 12 months and
  // note the truncation. Windows ≤ 12 months are byte-identical to before.
  const { since: effectiveSince, capped } = clampSinceToRecentMonths(
    since,
    until,
    CALENDAR_CAP_MONTHS,
  );
  const grid = buildCalendarGrid({ since: effectiveSince, until, counts: data, weekStartsOn });
  // The a11y table mirrors the shown window — drop days outside the cap so it
  // never lists dates absent from the heatmap above.
  const tableData = capped ? data.filter((d) => d.date >= effectiveSince) : data;
  const isEmpty = tableData.length === 0 || grid.columns.length === 0;

  return (
    <section
      aria-labelledby={hideHeading ? undefined : titleId}
      aria-label={hideHeading ? title : undefined}
      className="space-y-2"
    >
      <div className="space-y-0.5">
        {!hideHeading && (
          <h3
            id={titleId}
            className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute"
          >
            {title}
          </h3>
        )}
        {methodNote && <p className="text-xs leading-snug text-ln-op-faint">{methodNote}</p>}
        {capped && (
          <p className="text-xs leading-snug text-ln-op-faint">
            Últimos {CALENDAR_CAP_MONTHS} meses del período activo.
          </p>
        )}
      </div>

      {isEmpty ? (
        <p className="text-sm leading-snug text-ln-op-mute">
          {emptyMessage ?? "Sin actividad temporal para mostrar en este período y alcance."}
        </p>
      ) : (
        <>
          <div className="flex gap-1">
            {/* Weekday initials — fixed while the columns scroll. The h-3.5 spacer
                aligns the labels with the cell rows below the month-label row. */}
            <div
              aria-hidden="true"
              className="flex flex-col gap-0.5 text-xs leading-none text-ln-op-faint"
            >
              <div className="h-3.5" />
              {grid.weekdayLabels.map((w, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed 7-row weekday axis, position IS the identity
                <div key={r} className="flex size-3 items-center justify-center">
                  {w}
                </div>
              ))}
            </div>

            {/* Month labels + day-cell columns (horizontally scrollable for long
                windows, e.g. the multi-year panorama default). */}
            <div className="overflow-x-auto">
              <div className="flex min-w-max flex-col gap-0.5">
                <div className="flex h-3.5 gap-0.5">
                  {grid.columns.map((col, i) => (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional (week index) and never reorder
                      key={i}
                      className="w-3 whitespace-nowrap text-xs leading-none text-ln-op-faint"
                    >
                      {col.monthLabel ?? ""}
                    </div>
                  ))}
                </div>
                <div className="flex gap-0.5">
                  {grid.columns.map((col, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional (week index) and never reorder
                    <div key={i} className="flex flex-col gap-0.5">
                      {col.cells.map((cell, r) =>
                        cell ? (
                          <DayCell
                            key={cell.date}
                            cell={cell}
                            color={SCALE_BLUE_SEQ[cell.level]}
                            onDayClick={onDayClick}
                          />
                        ) : (
                          // biome-ignore lint/suspicious/noArrayIndexKey: absent (out-of-window) padding slot, position IS the identity
                          <div key={r} aria-hidden="true" className="size-3" />
                        ),
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Sequential-intensity legend (SCALE_BLUE_SEQ, colorblind-safe). */}
          <div className="flex items-center gap-1 text-xs text-ln-op-faint">
            <span>Menos</span>
            {SCALE_BLUE_SEQ.map((c, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed 5-swatch ramp, position IS the identity
                key={i}
                aria-hidden="true"
                className="size-3 rounded-[var(--radius-sm)]"
                style={{ backgroundColor: c }}
              />
            ))}
            <span>Más</span>
          </div>
        </>
      )}

      {/* A11y fallback table — the keyboard/screen-reader path. Rows mirror the
          INPUT series (days with data); each date filters when onDayClick is set. */}
      {tableData.length > 0 && (
        <details className="text-sm">
          {/* RA-9 BR-7: the sr-only suffix disambiguates N "Ver datos" toggles on
              a multi-chart dashboard (WCAG 2.4.6). */}
          <summary className="cursor-pointer text-xs font-medium text-ln-op-azul hover:underline">
            Ver datos<span className="sr-only"> — {title}</span>
          </summary>
          <table className="mt-2 w-full border-collapse text-xs">
            <caption className="sr-only">
              Eventos por día — {grid.total} en total sobre {grid.dayCount}{" "}
              {pluralizeEs(grid.dayCount, "día")}
            </caption>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="border border-ln-op-line bg-ln-op-card px-3 py-1.5 text-left font-semibold text-ln-op-ink-2"
                >
                  Día
                </th>
                <th
                  scope="col"
                  className="border border-ln-op-line bg-ln-op-card px-3 py-1.5 text-left font-semibold text-ln-op-ink-2"
                >
                  Eventos
                </th>
              </tr>
            </thead>
            <tbody>
              {[...tableData]
                .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
                .map((d) => {
                  const display = formatDate(parseDateInput(d.date));
                  return (
                    <tr key={d.date}>
                      <td className="border border-ln-op-line px-3 py-1.5 text-ln-op-ink">
                        {onDayClick ? (
                          <button
                            type="button"
                            onClick={() => onDayClick(d.date)}
                            className="text-ln-op-azul hover:underline"
                          >
                            {display}
                          </button>
                        ) : (
                          display
                        )}
                      </td>
                      <td className="border border-ln-op-line px-3 py-1.5 tabular-nums text-ln-op-ink">
                        {d.count}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

// memo(): always-mounted dock pane, same rationale as PanoramaDockRegistros.
// NOTE: the call site (PanoramaConsole.tsx ~3877) passes `onDayClick` as an
// inline arrow function and `data={scopeDailyCounts}` which falls back to a
// fresh `[]` literal when both sources are empty — neither is memoized, so
// they defeat the shallow-equal bailout on those renders. Flagged, not fixed
// here (perf sweep 2026-08-02) — deeper than a memo wrap.
export const CalendarHeatmap = memo(CalendarHeatmapImpl);
