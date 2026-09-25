// "Mis denuncias" — the pure half of the list and the detail (M16).
//
// Every word a status carries comes from the server (`statusLabel`, the web's
// own label). What lives here is the arithmetic around it: the count line, the
// one `not_found` sentence, the badge's colour family and the screen-reader
// label for a row. Pure, so it is tested without rendering.

import type { MyWelfareReportRowV1, MyWelfareReportStatusV1 } from "@dim/contract/api";

import { type ApiResult, apiFailureMessage } from "../api/client";

/**
 * The web's count line under "Mis denuncias", plus the one honest hedge the
 * web does not need: when more pages exist, the number is a floor.
 */
export function myReportsSummary(count: number, hasMore: boolean): string {
  if (count === 0) return "Sin denuncias enviadas.";
  const noun = count === 1 ? "denuncia enviada" : "denuncias enviadas";
  return hasMore ? `${count} ${noun} (hay más).` : `${count} ${noun}.`;
}

/**
 * The failure sentence. ONE override: `not_found` gets a sentence about a
 * DENUNCIA — and it is the same sentence for somebody else's, an anonymous one
 * and a code that does not exist, because the server cannot tell them apart
 * either. Every other outcome is `apiFailureMessage`'s.
 */
export function myReportFailureMessage(result: ApiResult<unknown>): string {
  if (result.outcome === "api-error" && result.code === "not_found") {
    return "No encontramos esta denuncia en tu cuenta. Las denuncias anónimas no quedan vinculadas a ninguna cuenta: se siguen con su código.";
  }
  return apiFailureMessage(result) ?? "No pudimos leer la denuncia.";
}

/** The badge's colour family — the web's `statusBadgeClass`, in four tones. */
export type StatusTone = "ok" | "progress" | "review" | "muted";

export function statusTone(status: MyWelfareReportStatusV1): StatusTone {
  switch (status) {
    case "closed":
      return "ok";
    case "in_progress":
      return "progress";
    case "triaged":
      return "review";
    case "open":
    case "duplicate":
    case "invalid":
      return "muted";
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

/** "dd/mm/aaaa", es-AR; a malformed date says so rather than "Invalid Date". */
export function reportDateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "fecha desconocida";
  return date.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** One row, read aloud in the order the eye reads it. */
export function reportRowAccessibilityLabel(row: MyWelfareReportRowV1): string {
  return [
    row.kindLabel,
    `Estado: ${row.statusLabel}`,
    `Enviada el ${reportDateLabel(row.filedAt)}`,
    row.place,
    `Código ${row.referenceCode}`,
  ]
    .filter(Boolean)
    .join(". ");
}
