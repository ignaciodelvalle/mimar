// The owner's casos, as the phone prints them (M11).
//
// PURE. Every fact comes from the server: which rows exist, what they say, and
// where each one opens (`route`, resolved server-side through the deep-link
// table). What is left for this file is presentation the wire does not carry —
// a date, a count, a sentence a screen reader can read as one.

import type { MyCaseRowV1, MyCasesV1 } from "@dim/contract/api";

/**
 * When the cycle opened (or was decided, for history rows), as a date.
 *
 * A DATE, NOT "hace 3 d." — the same call `notificationDateLabel` makes, for its
 * reason: the web's relative helper is not in the contract, and the row order
 * already carries the recency.
 */
export function caseDateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "fecha desconocida";
  return date.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Date and time, for a timeline entry — the web prints both. */
export function caseDateTimeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "fecha desconocida";
  const day = caseDateLabel(iso);
  const time = date.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}

/** "1 caso" / "3 casos" — the web's count beside the block title. */
export function caseCountLabel(count: number): string {
  return count === 1 ? "1 caso" : `${count} casos`;
}

/**
 * The row as ONE sentence for a screen reader: title, second line, date — and,
 * when the row opens nothing, that it opens nothing, so an inert row is not
 * announced as if it were a control that failed.
 */
export function caseRowAccessibilityLabel(row: MyCaseRowV1): string {
  const parts = [row.title, row.subtitle, caseDateLabel(row.since)];
  if (row.route === null) parts.push("Se ve en la web");
  return parts.filter((p) => p !== "").join(". ");
}

/** Whether the Mis mascotas block has anything to show. Empty → not drawn at all. */
export function hasOpenCases(payload: MyCasesV1 | null): payload is MyCasesV1 {
  return payload !== null && payload.open.length > 0;
}

/**
 * The history's honest ending. The app shows the page the server sent; when
 * older rows exist, it says so instead of presenting the page as the set.
 */
export function historyTruncationNote(payload: MyCasesV1): string | null {
  if (!payload.history.hasMore) return null;
  return `Mostramos los últimos ${payload.history.rows.length}. Los anteriores se ven desde la web.`;
}
