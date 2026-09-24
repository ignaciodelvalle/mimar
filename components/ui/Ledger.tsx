import type { ReactNode } from "react";
import type { LnVstampVariant } from "./StatusFlag";
import { LnVstamp } from "./StatusFlag";

/**
 * Libreta Nacional Ledger — ruled official table.
 *
 * Used for: vaccination records in the Libreta tab.
 * - Mono uppercase header on stripe background
 * - 1px hairline row borders
 * - LnVstamp in status column
 */

export type LnLedgerColumn<T> = {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  width?: string;
};

export type LnLedgerProps<T> = {
  columns: LnLedgerColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  className?: string;
  /**
   * Describes the table for screen readers, and names the scroll region so a
   * keyboard user landing on it knows what they are about to scroll through.
   */
  caption?: string;
};

export function LnLedger<T>({ columns, rows, rowKey, className = "", caption }: LnLedgerProps<T>) {
  return (
    // overflow-x-AUTO, not overflow-hidden.
    //
    // This wrapper exists to clip the table's corners to the rounded border,
    // and `overflow-hidden` did that — but it also clipped the table itself.
    // Four columns whose cells carry 16px of padding each, plus a 120px status
    // column, cannot fit a 390px phone: the intrinsic width lands well past the
    // ~358px of usable space, so the Profesional column and the right edge of
    // the Estado stamps were being cut off with no scrollbar and no other sign
    // that anything was missing. On a vaccination record that is not a cosmetic
    // bug — the reader cannot tell a blank column from a clipped one.
    //
    // `auto` keeps the corner clipping and makes the overflow reachable, which
    // is the project rule for wide content: tables scroll inside their own
    // container, the page body never scrolls sideways. Same pattern as
    // CaseQueue and EventLedgerTable.
    // <section>, not <div>: with an accessible name it is a `region` landmark
    // for free, which is what a horizontally scrollable data table should be.
    <section
      className={[
        "overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      // A scrollable container must be operable by keyboard (WCAG 2.1.1).
      // Without a tab stop a keyboard or switch user can read down the rows but
      // can never scroll across to the columns that are off-screen — which on
      // this table is the professional who signed the entry. The lint rule's
      // general advice about non-interactive elements does not cover scroll
      // containers, which are the documented exception.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region, see above
      tabIndex={0}
      aria-label={caption}
    >
      <table className="w-full border-collapse bg-[var(--color-ln-card)] text-md">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                // px-3 on phones, px-4 from sm: 4 columns x 2 sides of 16px is
                // 128px of pure gutter, a third of a 390px viewport. Trimming
                // to 12px buys back 32px of content width — it does not make
                // the table fit (see above), it just leaves less to scroll.
                className="border-b border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-3 py-2.5 text-left font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)] sm:px-4"
                style={col.width ? { width: col.width } : undefined}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="border-b border-[var(--color-ln-line-2)] last:border-b-0 hover:bg-[var(--color-ln-stripe)]"
            >
              {columns.map((col) => (
                <td key={col.key} className="px-3 py-[13px] align-top sm:px-4">
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ---------- Pre-built vaccine ledger row helpers -------------------------

export type LnVaccineRow = {
  id: string;
  name: string;
  dose?: string;
  appliedAt: string;
  nextDue?: string;
  status: LnVstampVariant;
  vet?: string;
  vetLicense?: string;
};

export function LnVaccineLedger({
  rows,
  className,
}: {
  rows: LnVaccineRow[];
  className?: string;
}) {
  const columns: LnLedgerColumn<LnVaccineRow>[] = [
    {
      key: "vaccine",
      header: "Vacuna / Dosis",
      render: (r) => (
        <div>
          <p className="font-semibold text-[var(--color-ln-ink)]">{r.name}</p>
          {r.dose && <p className="mt-px text-sm text-[var(--color-ln-mute)]">{r.dose}</p>}
        </div>
      ),
    },
    {
      key: "dates",
      header: "Fecha",
      render: (r) => (
        <div>
          <p className="font-ln-mono text-sm text-[var(--color-ln-ink-2)]">{r.appliedAt}</p>
          {r.nextDue && (
            <p className="mt-px font-ln-mono text-sm text-[var(--color-ln-mute)]">
              próx: {r.nextDue}
            </p>
          )}
        </div>
      ),
    },
    {
      key: "status",
      header: "Estado",
      render: (r) => <LnVstamp variant={r.status} />,
      width: "120px",
    },
    {
      key: "vet",
      header: "Profesional",
      render: (r) => (
        <div>
          <p className="text-sm text-[var(--color-ln-ink-2)]">{r.vet}</p>
          {r.vetLicense && (
            <p className="mt-px font-ln-mono text-sm text-[var(--color-ln-mute)]">{r.vetLicense}</p>
          )}
        </div>
      ),
    },
  ];

  return (
    <LnLedger
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      className={className}
      caption="Registro de vacunación: vacuna y dosis, fecha de aplicación y próximo refuerzo, estado, y profesional actuante."
    />
  );
}
