// microchip_remediation lifecycle.
//
// Opens: microchip_replaced with reason='fraud_detected' OR 'duplicate_detected'.
// Branching enforced in lib/case-attachment.ts:119.
// Terminal: explicit close by admin/govt (no event opener for close — admin marks
// the case resolved with closed_reason='resolved' | 'cancelled' | 'merged').
// No auto-close cron.
// No reopen — once resolved, a new microchip_replaced opens a fresh case.

import type { CaseLifecycle } from "./types";

export const microchipRemediationLifecycle: CaseLifecycle = {
  kind: "microchip_remediation",
  statusValues: ["open", "escalated", "closed"],
  opensEvents: [
    {
      eventType: "microchip_replaced",
      whenPayload: (p) => p.reason === "fraud_detected" || p.reason === "duplicate_detected",
    },
  ],
  // NO terminal events: no clinical fact ends a remediation. What ends it is
  // somebody deciding the record is straight again, which is why the close is
  // manual — see `manualCloseAllowed` below.
  terminalEvents: [],
  cronCloseRoute: null,
  cronCloseScheduleHours: 24,
  manualOpenAllowed: true,
  // TRUE desde el 2026-09-17, decisión del PO. Hasta ese día este kind no tenía
  // NINGUNA vía de cierre — ni un hecho que lo terminara ni un operador que
  // pudiera darlo por terminado (L-22).
  //
  // La decisión casi fue la contraria: el PO se inclinaba por retirar el tipo y
  // preguntó si tenía uso real. Lo tiene, y está vivo. Lo abre un
  // `microchip_replaced` con razón `fraud_detected` o `duplicate_detected`
  // (lib/infra/case-attachment.ts), las dos razones son seleccionables hoy en el
  // formulario de admin y en el de la organización veterinaria, tiene
  // notificación propia (`microchip_fraud_detected`) y un cuadro en
  // /gob/usuarios que cuenta esos reemplazos de los últimos 12 meses.
  //
  // LAS CERO FILAS NO DICEN QUE SOBRE: dicen que nadie declaró fraude de
  // microchip todavía, que es el estado deseable de un camino de fraude.
  //
  // Por qué el genérico y no una pantalla propia como brotes: el argumento que
  // mantiene el cierre manual apagado allá es no darle una segunda puerta, más
  // débil, a un acto legalmente sensible. Una remediación de microchip es
  // administrativa — corregir el registro de un identificador — no sanitaria,
  // así que ese argumento no la alcanza.
  manualCloseAllowed: true,
  reopenAllowed: false,
};
