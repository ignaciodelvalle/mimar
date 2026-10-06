// The owner's casos, as the phone prints them (M11).
//
// PURE. Every fact comes from the server: which rows exist, what they say, and
// where each one opens (`route`, resolved server-side through the deep-link
// table). What is left for this file is presentation the wire does not carry —
// a date, a count, a sentence a screen reader can read as one.

import { type MyCaseRowV1, type MyCasesV1, caseKindNeedsAction } from "@dim/contract/api";

/**
 * A row as it may arrive from a server that predates the grouped casos (PO
 * 2026-10-06): the pet and turn fields are additive, so `payloadVersion` stayed
 * 1 and an older deployment answers without them.
 */
type WireCaseRow = Omit<
  MyCaseRowV1,
  "petId" | "petName" | "petPhotoUrl" | "needsAction" | "dueAt"
> &
  Partial<Pick<MyCaseRowV1, "petId" | "petName" | "petPhotoUrl" | "needsAction" | "dueAt">>;

/**
 * Every row with every field, whatever server answered. A missing pet is no pet
 * (the row is drawn on its own, like an account-level one), a missing deadline
 * is no deadline, and a missing turn falls back to the contract's own table —
 * the one the server decides it from — rather than to a guess.
 */
export function normalizeCaseRow(row: WireCaseRow): MyCaseRowV1 {
  return {
    ...row,
    petId: row.petId ?? null,
    petName: row.petName ?? null,
    petPhotoUrl: row.petPhotoUrl ?? null,
    needsAction:
      typeof row.needsAction === "boolean" ? row.needsAction : caseKindNeedsAction(row.kind),
    dueAt: row.dueAt ?? null,
  };
}

/** `normalizeCaseRow` over a whole payload. */
export function normalizeMyCases(payload: MyCasesV1): MyCasesV1 {
  return {
    ...payload,
    open: payload.open.map(normalizeCaseRow),
    history: { ...payload.history, rows: payload.history.rows.map(normalizeCaseRow) },
  };
}

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

/** "Vence el 09/10/2026" — the owner's deadline, or `null` when there is none. */
export function caseDueLabel(row: Pick<MyCaseRowV1, "dueAt">): string | null {
  if (row.dueAt === null || row.dueAt === undefined) return null;
  return `Vence el ${caseDateLabel(row.dueAt)}`;
}

/**
 * The row as ONE sentence for a screen reader: title, second line, the pet when
 * the row shows it, date, the deadline when there is one — and, when the row
 * opens nothing, that it opens nothing, so an inert row is not announced as if
 * it were a control that failed. Inside a pet's cluster (`withPet: false`) the
 * cluster's head already names the pet.
 */
export function caseRowAccessibilityLabel(
  row: MyCaseRowV1,
  { withPet = true }: { withPet?: boolean } = {},
): string {
  const parts = [row.title, row.subtitle];
  if (withPet && row.petName) parts.push(row.petName);
  parts.push(caseDateLabel(row.since));
  const due = caseDueLabel(row);
  if (due !== null) parts.push(due);
  if (row.route === null) parts.push("Se ve en la web");
  return parts.filter((p) => p !== "").join(". ");
}

/** "Pampa, 2 casos" — the head of one pet's cluster, read as one sentence. */
export function petClusterAccessibilityLabel(petName: string | null, count: number): string {
  return `${petName ?? "Mascota"}, ${caseCountLabel(count)}`;
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
