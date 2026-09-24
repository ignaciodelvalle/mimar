// welfare_denuncia lifecycle (lifecycles spec §7).
//
// Opens: INSERT of a welfare_reports row → cases row created in the same
// transaction. NO direct pet_events opener (the bridge events
// `maltreatment_reported` / `abandonment_reported` / `symptom_observed`
// require the case to exist already — they're `requires-open` per
// attachment spec §7.9).
// Terminal: status transitions of the welfare_reports.status field —
// specifically when it lands on 'closed'. The case action does the
// dual-write.
// Escalation cron: NO auto-close. The cron only emits notifications to
// the assigned officer for in_progress reports with no events >90d.
// Manual open: ALLOWED — admin/govt can open a welfare_denuncia for an
// off-channel report.

import type { CaseLifecycle } from "./types";

export const welfareDenunciaLifecycle: CaseLifecycle = {
  kind: "welfare_denuncia",
  statusValues: ["open", "escalated", "closed", "merged"],
  // The kind is opened atomically with `welfare_reports` row creation,
  // not by a pet_events row. opensEvents stays empty so the attachment
  // helper doesn't try to auto-open from a pet_events insert.
  opensEvents: [],
  // No pet_events row "terminates" the case — the action updates
  // welfare_reports.status, which dual-writes to cases.status.
  terminalEvents: [],
  cronCloseRoute: null,
  cronCloseScheduleHours: 24,
  manualOpenAllowed: true,
  // Sigue en false, y ahora por un motivo escrito en vez de por omisión: el
  // cierre de una denuncia NO es un botón genérico, es un acto con notas de
  // resolución sobre la fila de `welfare_reports`, que además dual-escribe al
  // expediente. Prenderlo agregaría una segunda puerta que saltearía esas notas.
  manualCloseAllowed: false,
  // Machine-readable, no un comentario. Sin esto, `availableCaseActions` sumaba
  // `terminalEvents: []` + `manualCloseAllowed: false` y le decía al operador
  // que este tipo de expediente "todavía no tiene una vía de cierre definida" y
  // que pidiera una política — sobre el kind con MÁS TRÁFICO de la cola, y con
  // la política escrita y desplegada desde hace meses:
  // `closeWelfareReport` (use-case) ← `closeWelfareReportAction` (server action,
  // admin/govt con alcance de jurisdicción) ← `app/gob/maltrato/[id]`.
  //
  // Es exactamente el defecto que este campo se creó para arreglar en
  // `outbreak_investigation` el 2026-09-17, encontrado el mismo día en el kind
  // de al lado. Dos flags en falso no suman una capacidad ausente: antes de
  // decirle a alguien que la política no está escrita, buscá la pantalla.
  dedicatedCloseProse:
    "lo cierra la autoridad desde la denuncia misma, en Maltrato, dejando las notas de resolución que quedan asentadas en el expediente.",
  reopenAllowed: false,
};
