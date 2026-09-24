// operator-actions.ts — las dos acciones que el detalle de caso le devuelve al
// operador (#41).
//
// CONTEXTO. `components/casos/CaseDetailView.tsx` tuvo CERO controles desde que
// existe, mientras la cola de `/gob/casos` ordena por urgencia en SQL y manda al
// funcionario derecho al expediente más urgente de su jurisdicción. Abierto
// desde 2026-08-07, bloqueado por una decisión de alcance que el PO tomó el
// 2026-08-10: nota para todos, cierre manual sólo donde el ciclo de vida lo
// declara.
//
// EL ORDEN IMPORTA, Y ES AL REVÉS DEL INTUITIVO.
//
// Primero la MUTACIÓN, después el evento — y el evento sólo si la mutación ganó.
// El instinto es "asentá el evento y después cambiá el estado", y es justamente
// el que rompe: `case_events` es **append-only por trigger** en Postgres
// (`case_events_no_update`, `case_events_no_delete`). Un cierre que pierde la
// carrera con otro cierre concurrente y ya insertó su evento deja un segundo
// `case_closed` con otro motivo y otro actor, imposible de borrar o corregir,
// mientras `closed_by_user_id` guarda sólo al primero. El expediente terminaría
// contando dos cierres de un caso que se cerró una vez — en un sistema cuyo
// invariante es que el registro no miente.
//
// Por eso el cierre usa `closeCaseOwned`, que dice si ESTE llamador fue el que
// cerró, y no `closeCase`, que devuelve lo mismo al ganador y al perdedor.

import { and, eq } from "drizzle-orm";

import { caseEvents, cases, db } from "@/db";
import { findAuthoritiesForJurisdiction } from "@/lib/infra/approval-routing";
import { writeAuditLog } from "@/lib/infra/audit-log";
import { activeHumanInstitutionalAdminIds } from "@/lib/infra/notification-recipients";
import { createNotificationsBulk } from "@/lib/infra/notification-service";
import { availableCaseActions, canPerformCaseAction } from "../domain/available-actions";
import type { CaseKind } from "../domain/case-kinds";
import type { CaseStatus } from "../domain/lifecycles/types";
import { CasesRepository } from "../infrastructure/cases-repository";

export type OperatorActionResult = { ok: true } | { ok: false; error: string };

/** Mínimo para que una nota sea una nota y no un enter accidental. */
export const NOTE_MIN_LENGTH = 10;
export const NOTE_MAX_LENGTH = 2000;

/** Mínimo del motivo de cierre — proporcional a lo que un cierre significa. */
export const CLOSE_REASON_MIN_LENGTH = 20;
export const CLOSE_REASON_MAX_LENGTH = 500;

/**
 * Mínimo del motivo de escalada.
 *
 * Igual que el cierre y no como la nota, porque escalar TAMBIÉN es un acto: le
 * llega a una autoridad que no estaba mirando este expediente, y lo primero que
 * esa persona va a querer saber es por qué la llamaron.
 */
export const ESCALATE_REASON_MIN_LENGTH = 20;
export const ESCALATE_REASON_MAX_LENGTH = 500;

type CaseRow = {
  id: string;
  caseKind: CaseKind;
  status: CaseStatus;
  publicCode: string;
  /** Nullable en el esquema: un expediente puede no tener jurisdicción todavía. */
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

async function loadCase(publicCode: string): Promise<CaseRow | null> {
  const [row] = await db
    .select({
      id: cases.id,
      caseKind: cases.caseKind,
      status: cases.status,
      publicCode: cases.publicCode,
      jurisdictionProvince: cases.jurisdictionProvince,
      jurisdictionLocality: cases.jurisdictionLocality,
    })
    .from(cases)
    .where(eq(cases.publicCode, publicCode))
    .limit(1);
  return (row as CaseRow | undefined) ?? null;
}

/**
 * Asienta una nota de operador en el expediente.
 *
 * No toca el estado, así que es legítima para los doce kinds — y es la única
 * acción que sirve al 100% de la cola real (`custody_episode` 215,
 * `lost_pet_episode` 41, `adoption_listing` 1, medido 2026-08-10).
 */
export async function addOperatorNote(input: {
  publicCode: string;
  actorUserId: string;
  text: string;
}): Promise<OperatorActionResult> {
  const text = input.text.trim();
  if (text.length < NOTE_MIN_LENGTH) {
    return {
      ok: false,
      error: `La nota tiene que decir algo: al menos ${NOTE_MIN_LENGTH} caracteres.`,
    };
  }
  if (text.length > NOTE_MAX_LENGTH) {
    return { ok: false, error: `La nota no puede pasar los ${NOTE_MAX_LENGTH} caracteres.` };
  }

  const row = await loadCase(input.publicCode);
  if (!row) return { ok: false, error: "Expediente no encontrado." };

  // El permiso sale del dominio, no de un if acá. Si el ciclo de vida cambia,
  // la respuesta cambia sola.
  if (!canPerformCaseAction(row.caseKind, row.status, "note")) {
    return { ok: false, error: "Este expediente ya no admite notas." };
  }

  // EL EVENTO Y LA FILA DE AUDITORÍA, EN UNA TRANSACCIÓN. Antes era un insert
  // suelto. La fila de auditoría llegó el 2026-09-17 y con ella la transacción:
  // dos escrituras que describen el mismo acto no pueden quedar una sin la otra,
  // porque la ausencia de una fila de auditoría es permanentemente
  // indistinguible de la ausencia del acto que habría descrito.
  //
  // POR QUÉ SE AUDITA UNA NOTA, que el baseline dejaba como decisión pendiente:
  // el hecho ya está en la espina `case_events`, que carga su propio autor, así
  // que el argumento de "otro libro ya lo cubre" era real. Se resuelve hacia la
  // trazabilidad porque el costo es asimétrico — una fila de más no le hace daño
  // a nadie, y una consulta de rendición de cuentas que no encuentra en
  // `audit_log` un asiento de una autoridad sobre un expediente legal sí.
  await db.transaction(async (tx) => {
    await tx.insert(caseEvents).values({
      caseId: row.id,
      entryType: "operator_note",
      notes: text,
      recordedByUserId: input.actorUserId,
      payload: {},
    });
    await writeAuditLog(tx, {
      action: "case_note_recorded",
      actorUserId: input.actorUserId,
      payload: {
        case_id: row.id,
        case_public_code: row.publicCode,
        case_kind: row.caseKind,
        note_length: text.length,
      },
    });
  });

  return { ok: true };
}

/**
 * Cierra un expediente a mano.
 *
 * Sólo donde el ciclo de vida declara `manualCloseAllowed`. Hoy es un solo kind
 * (`custody_episode`, por autoridad DC del spec de decomiso) — y ese uno se
 * verifica leyendo la declaración, no una lista escrita acá.
 */
export async function closeCaseManually(input: {
  publicCode: string;
  actorUserId: string;
  reason: string;
}): Promise<OperatorActionResult> {
  const reason = input.reason.trim();
  if (reason.length < CLOSE_REASON_MIN_LENGTH) {
    return {
      ok: false,
      error: `Cerrar un expediente necesita un motivo de al menos ${CLOSE_REASON_MIN_LENGTH} caracteres — queda en el registro.`,
    };
  }
  if (reason.length > CLOSE_REASON_MAX_LENGTH) {
    return {
      ok: false,
      error: `El motivo no puede pasar los ${CLOSE_REASON_MAX_LENGTH} caracteres.`,
    };
  }

  const row = await loadCase(input.publicCode);
  if (!row) return { ok: false, error: "Expediente no encontrado." };

  // El motivo del dominio, no uno genérico. `canPerformCaseAction` devuelve
  // false por DOS razones muy distintas —"este kind no admite cierre manual" y
  // "ya está cerrado"— y confundirlas es un defecto real: el perdedor de una
  // carrera de cierre leería "no se puede cerrar a mano" y concluiría que el
  // producto no soporta la acción, cuando en verdad acaba de perderla por un
  // segundo. Es exactamente el error que este módulo existe para no cometer.
  const close = availableCaseActions(row.caseKind, row.status).find((a) => a.action === "close");
  if (!close?.available) {
    return { ok: false, error: close?.unavailableReason ?? "Este expediente no se puede cerrar." };
  }

  const repo = new CasesRepository();

  return db.transaction(async (tx) => {
    // 1. MUTACIÓN primero. `closeCaseOwned` dice si ganamos la carrera.
    //
    // `cases.closed_reason` es una CATEGORÍA de tres valores, no texto libre —
    // así lo declara CloseCaseInput. Un cierre manual de operador es
    // `cancelled`: la autoridad da por terminado el expediente, que es distinto
    // de `resolved` (el hecho que lo cerraba ocurrió) y de `auto_expired` (lo
    // cerró un cron). La prosa del operador va al evento, donde se lee.
    const outcome = await repo.closeCaseOwned(
      { caseId: row.id, reason: "cancelled", closedByUserId: input.actorUserId },
      tx,
    );

    // 2. Si perdimos, NO escribimos el evento. Ese es el punto entero de este
    //    orden: el `case_closed` del perdedor sería permanente.
    if (!outcome.won) {
      return {
        ok: false as const,
        error:
          "Alguien más cerró este expediente mientras lo estabas cerrando. Recargá para ver quién y con qué motivo.",
      };
    }

    // 3. Recién ahora el evento, dentro de la misma transacción.
    await tx.insert(caseEvents).values({
      caseId: row.id,
      entryType: "case_closed",
      notes: reason,
      recordedByUserId: input.actorUserId,
      payload: { closed_manually: true },
    });

    // 4. Y el ACTO ADMINISTRATIVO, con su estado anterior. El evento registra la
    //    afirmación; esta fila registra que una autoridad identificada terminó
    //    un expediente legal, que es lo que se busca en `audit_log` y no en la
    //    espina. Adentro de la transacción: si el cierre se deshace, el rastro
    //    de que ocurrió se deshace con él.
    await writeAuditLog(tx, {
      action: "case_closed_manually",
      actorUserId: input.actorUserId,
      payload: {
        case_id: row.id,
        case_public_code: row.publicCode,
        case_kind: row.caseKind,
        status_before: row.status,
        status_after: "closed",
        closed_reason: "cancelled",
      },
    });

    return { ok: true as const };
  });
}

/**
 * Escala un expediente a la autoridad, a mano, sin esperar al reloj.
 *
 * QUÉ PROBLEMA RESUELVE. Escalar ya existía, pero SÓLO por cron: una disputa de
 * custodia sube a los 365 días, un handoff de decomiso trabado a los 7. Un
 * operador que hoy ve que un expediente necesita otra mirada no tenía cómo
 * pedirla — su única salida era una nota, que nadie recibe. Decisión del PO,
 * 2026-09-17, cerrando lo último que le faltaba a #41.
 *
 * LO QUE HAY QUE SABER ANTES DE TOCAR ESTO, y está medido en el cron hermano
 * (`escalate-stale-disputes.ts`): **`escalated` no tiene cola propia**. Ninguna
 * pantalla lista "los expedientes escalados". Entonces un escalado que no le
 * avisa a nadie no es un escalado — es una columna que cambió de valor y que
 * nadie va a mirar nunca. Por eso el fan-out no es un extra de este caso de uso:
 * es la mitad que lo vuelve real, y cuando sale vacío queda una fila de
 * auditoría diciéndolo, igual que en el cron.
 *
 * EL ORDEN ES EL MISMO QUE EN EL CIERRE Y POR EL MISMO MOTIVO. Primero la
 * mutación guardada (`AND status = 'open'`), que dice si ganamos la carrera;
 * recién después el evento. `case_events` es append-only por trigger, así que un
 * `case_escalated` escrito por el perdedor de una carrera sería permanente e
 * incorregible.
 *
 * DIFERENCIA CON EL CRON, a favor: el cron inserta notificaciones directo. Acá
 * van por `createNotificationsBulk`, que es el camino canónico — idempotente por
 * `dedupeKey` y con cola de fallidos. La reja `lint:notifications` lo exige para
 * todo archivo nuevo, y tiene razón.
 */
export async function escalateCaseManually(input: {
  publicCode: string;
  actorUserId: string;
  reason: string;
}): Promise<OperatorActionResult> {
  const reason = input.reason.trim();
  if (reason.length < ESCALATE_REASON_MIN_LENGTH) {
    return {
      ok: false,
      error: `Escalar necesita un motivo de al menos ${ESCALATE_REASON_MIN_LENGTH} caracteres — es lo primero que va a leer quien lo reciba.`,
    };
  }
  if (reason.length > ESCALATE_REASON_MAX_LENGTH) {
    return {
      ok: false,
      error: `El motivo no puede pasar los ${ESCALATE_REASON_MAX_LENGTH} caracteres.`,
    };
  }

  const row = await loadCase(input.publicCode);
  if (!row) return { ok: false, error: "Expediente no encontrado." };

  // El motivo del dominio, no uno genérico: "este kind no tiene estado de
  // escalada" y "ya está escalado" son respuestas muy distintas para el
  // operador, y el dominio ya sabe decir cuál es cuál.
  const escalate = availableCaseActions(row.caseKind, row.status).find(
    (a) => a.action === "escalate",
  );
  if (!escalate?.available) {
    return {
      ok: false,
      error: escalate?.unavailableReason ?? "Este expediente no se puede escalar.",
    };
  }

  // Destinatarios FUERA de la transacción, como el cron: son dos consultas que
  // no necesitan el lock y que alargarían la ventana de la carrera.
  //
  // LA JURISDICCIÓN NULA SE COERCIONA, NO SE SALTEA, y la primera versión de
  // este caso de uso hacía lo contrario: `province && locality ? resolver : []`.
  // Se ve razonable y es un agujero, por dos motivos que se suman:
  //
  //   · `jurisdictionLocality` es nullable en el esquema, y
  //   · `WHOLE_PROVINCE_SENTINEL` es la CADENA VACÍA — una asignación de
  //     provincia entera es exactamente lo que ese ternario descarta.
  //
  // Y el costo no es no avisarle a nadie: es que las dos mitades del sistema
  // discrepan. Del lado de la LECTURA, `jurisdictionScopeContains` con una
  // asignación de provincia entera devuelve true sin mirar la localidad, así que
  // la autoridad provincial SÍ puede abrir ese expediente. Del lado del RUTEO,
  // no se enteraba nunca. Es el defecto que el encabezado de `approval-routing`
  // documenta — "wording, query y ROUTING no pueden discrepar" — reintroducido
  // por un chequeo de veracidad.
  //
  // Los tres crones hermanos coercionan a propósito desde el 2026-08-17. Esta es
  // la misma forma.
  const govtAuthorities = await findAuthoritiesForJurisdiction(
    {
      province: row.jurisdictionProvince ?? "",
      locality: row.jurisdictionLocality ?? "",
    },
    // La etiqueta de ruta NO es decorativa: sin ella el resolver escribe su
    // propia traza de fan-out vacío como `approval_routing_unlabelled`, FUERA de
    // esta transacción — dos filas para un acto, una con la ruta equivocada, y la
    // de afuera sobreviviría a un rollback. Los tres crones hermanos la pasan.
    { route: "case_escalated_by_operator" },
  );
  // Humanos activos, no cuentas de servicio ni desactivadas. Contarlas haría
  // el conjunto no-vacío y saltearía en silencio la traza de fan-out vacío —
  // el defecto exacto que este helper compartido se creó para cerrar.
  const adminIds = await activeHumanInstitutionalAdminIds();
  const recipients = Array.from(new Set<string>([...govtAuthorities, ...adminIds])).filter(
    // Avisarle al que acaba de apretar el botón es ruido: ya sabe.
    (id) => id !== input.actorUserId,
  );

  return db.transaction(async (tx) => {
    // 1. MUTACIÓN guardada. Si otro escaló o cerró mientras tanto, 0 filas.
    const updated = await tx
      .update(cases)
      .set({ status: "escalated", updatedAt: new Date() })
      .where(and(eq(cases.id, row.id), eq(cases.status, "open")))
      .returning({ id: cases.id });

    if (updated.length === 0) {
      return {
        ok: false as const,
        error: "El expediente cambió de estado mientras lo escalabas. Recargá para ver cómo quedó.",
      };
    }

    // 2. El evento, dentro de la misma transacción. Se pide el id de vuelta
    //    porque el aviso lo usa como clave de deduplicación — ver abajo.
    const [evento] = await tx
      .insert(caseEvents)
      .values({
        caseId: row.id,
        entryType: "case_escalated",
        notes: reason,
        recordedByUserId: input.actorUserId,
        payload: { escalated_manually: true, recipient_count: recipients.length },
      })
      .returning({ id: caseEvents.id });

    // 3. El acto administrativo. Va SIEMPRE, no sólo cuando el fan-out sale
    //    vacío: la primera versión de este caso de uso sólo escribía la traza de
    //    `notification_fanout_empty`, o sea que una escalada que SÍ avisaba no
    //    dejaba ninguna fila en `audit_log` — auditando exactamente el caso raro
    //    y dejando el común sin rastro.
    await writeAuditLog(tx, {
      action: "case_escalated_manually",
      actorUserId: input.actorUserId,
      payload: {
        case_id: row.id,
        case_public_code: row.publicCode,
        case_kind: row.caseKind,
        status_before: row.status,
        status_after: "escalated",
        recipient_count: recipients.length,
      },
    });

    // 4. Y el aviso, que es lo que vuelve real la escalada.
    if (recipients.length === 0) {
      await writeAuditLog(tx, {
        action: "notification_fanout_empty",
        actorUserId: input.actorUserId,
        payload: {
          route: "case_escalated_by_operator",
          province: row.jurisdictionProvince ?? "",
          locality: row.jurisdictionLocality ?? "",
          reason: "no_govt_no_admin",
          case_id: row.id,
          case_public_code: row.publicCode,
        },
      });
      return { ok: true as const };
    }

    await createNotificationsBulk(
      recipients.map((userId) => ({
        userId,
        notificationType: "case_escalated_by_operator",
        severity: "warning" as const,
        title: "Expediente escalado",
        body: `${row.publicCode} fue escalado por un operador. Motivo: ${reason}`,
        ctaLabel: "Ver expediente",
        ctaUrl: `/casos/${row.publicCode}`,
        relatedCaseId: row.id,
        // LA CLAVE VA CONTRA EL EVENTO, NO CONTRA EL EXPEDIENTE, y la diferencia
        // importa. La primera versión usaba `{caseId}:{userId}` justificándose en
        // que "un expediente se escala una vez, la guarda de estado lo
        // garantiza". La guarda garantiza que no haya dos escaladas
        // CONCURRENTES; no garantiza una sola en la vida del expediente.
        // `reopenCase` devuelve un caso a `open` desde cualquier estado, incluido
        // `escalated`, sin consultar `reopenAllowed`. Hoy no tiene llamadores de
        // producción — pero el día que los tenga, escalar → reabrir → escalar
        // dejaría el evento y la fila de auditoría escritos y el aviso TRAGADO en
        // silencio por el ON CONFLICT DO NOTHING. Con el id del evento adentro,
        // cada escalada es su propia clave y el segundo aviso sale.
        dedupeKey: `case_escalated_by_operator:${evento.id}:${userId}`,
      })),
      tx,
    );

    return { ok: true as const };
  });
}

/** Sólo para tests: confirma que el caso quedó cerrado una vez y no dos. */
export async function countCloseEvents(caseId: string): Promise<number> {
  const rows = await db
    .select({ id: caseEvents.id })
    .from(caseEvents)
    .where(and(eq(caseEvents.caseId, caseId), eq(caseEvents.entryType, "case_closed")));
  return rows.length;
}
