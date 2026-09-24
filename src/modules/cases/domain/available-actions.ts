// available-actions.ts — qué puede hacer un operador sobre un expediente.
//
// LA REGLA: las acciones se DERIVAN del ciclo de vida, nunca se inventan.
//
// El detalle de caso (`components/casos/CaseDetailView.tsx`) tuvo cero controles
// de operador desde que existe — ni cerrar, ni escalar, ni asentar una nota —
// mientras la cola de `/gob/casos` ordena por urgencia en SQL y manda al
// funcionario derecho al expediente más urgente de su jurisdicción. Arreglar el
// orden hizo el callejón MÁS visible, no menos (#41, abierto desde 2026-08-07).
//
// Poner botones era la parte fácil y la trampa: cada uno de los doce kinds
// declara sus propios eventos terminales en
// `src/modules/cases/domain/lifecycles/<kind>.ts`, y un botón que ofrezca una
// transición que el ciclo no declara es peor que no tener botón — le miente al
// operador sobre lo que el sistema va a hacer con un expediente legal.
//
// Este módulo es la única fuente de esa respuesta. Es dominio puro: entra
// (kind, status), sale la lista de acciones. Sin DB, sin framework, sin sesión.
// La autorización va aparte y aguas arriba — esto dice qué es POSIBLE, no quién
// puede.

import type { EventType } from "@dim/contract/events";
import type { CaseKind } from "./case-kinds";
import { getLifecycle } from "./lifecycles";
import type { CaseStatus } from "./lifecycles/types";

/**
 * El HECHO que cierra un expediente, dicho en es-AR.
 *
 * POR QUÉ EXISTE ESTE MAPA. La primera versión interpolaba
 * `lifecycle.terminalEvents` directo en la frase, y un funcionario en staging
 * leía textual: *"se cierra solo cuando ocurre el hecho que lo termina
 * (custody_dispute_resolved)"*. Un identificador de evento en inglés, crudo, en
 * la copia de un expediente legal — contra el invariante #4 del proyecto y
 * justo en la frase que existe para que la ausencia del botón se ENTIENDA.
 * Encontrado mirando la pantalla en staging, no leyendo el código.
 *
 * Cada entrada describe el hecho desde donde lo vive el operador, no desde el
 * nombre de la tabla.
 */
const TERMINAL_EVENT_PROSE: Partial<Record<EventType, string>> = {
  rabies_observation_ended: "termina el período de observación antirrábica",
  custody_dispute_resolved: "se resuelve la disputa de custodia",
  custody_transferred: "el animal cambia de responsable",
  adoption_finalized: "se concreta la adopción",
  death_recorded: "se registra el fallecimiento del animal",
  adoption_application_resolved: "se resuelve la postulación",
  foster_ended: "termina el tránsito",
  adoption_eligibility_set: "cambia la elegibilidad para adopción",
  foster_proposal_resolved: "se resuelve la propuesta de tránsito",
  status_changed: "cambia el estado del animal",
};

/**
 * Une los hechos terminales en una enumeración legible, o devuelve `null` si
 * alguno no tiene prosa.
 *
 * FALLA CERRADO A PROPÓSITO: ante un evento sin traducir prefiere la frase
 * genérica antes que filtrar el identificador. Un evento nuevo agregado a un
 * ciclo de vida degrada la explicación; nunca la convierte en jerga.
 */
export function describeTerminalEvents(events: readonly EventType[]): string | null {
  if (events.length === 0) return null;
  const prose = events.map((e) => TERMINAL_EVENT_PROSE[e]);
  if (prose.some((p) => p === undefined)) return null;
  const parts = prose as string[];
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} o ${parts[parts.length - 1]}`;
}

export type CaseAction =
  /** Asentar texto libre. No cambia el estado. Legítima para los doce kinds. */
  | "note"
  /** Cerrar a mano, sin esperar un evento terminal. Sólo donde el ciclo lo declara. */
  | "close"
  /**
   * Subir el expediente a la autoridad, ahora, sin esperar al reloj.
   *
   * Sólo donde el ciclo de vida declara `escalated` entre sus `statusValues` —
   * hoy cinco de trece. Los otros ocho NO tienen ese estado, y ofrecerles el
   * botón sería la falla que este módulo existe para no cometer: prometer una
   * transición que el ciclo no declara.
   *
   * Decisión del PO 2026-09-17, y ahí pidió "los doce tipos". Se entrega
   * derivado y no literal porque lo literal es imposible: un expediente que no
   * puede estar `escalated` no se puede escalar, y un botón que lo ofreciera
   * fallaría en el servidor después de prometerle al operador que iba a andar.
   */
  | "escalate";

export type CaseActionAvailability = {
  action: CaseAction;
  available: boolean;
  /**
   * Por qué NO está disponible, en es-AR, listo para mostrar. `null` cuando sí
   * lo está.
   *
   * No es adorno: la lección repetida de este producto es que una acción que
   * desaparece sin explicación se lee como un error del usuario. Si el operador
   * no puede cerrar, la pantalla tiene que decirle qué lo cierra.
   */
  unavailableReason: string | null;
};

/**
 * Las acciones que el ciclo de vida de `kind` admite sobre un caso en `status`.
 *
 * Devuelve SIEMPRE las tres entradas, disponibles o no, y SIEMPRE en el orden
 * nota · cierre · escalada. Un llamador que quiera ocultar lo indisponible puede
 * filtrar; uno que quiera explicar por qué falta tiene el motivo a mano.
 * Devolver sólo lo disponible haría imposible lo segundo.
 *
 * El orden es parte del contrato: hay tests que desestructuran por índice, y la
 * escalada se agregó AL FINAL por eso. Los consumidores de UI usan `.find()`.
 */
export function availableCaseActions(kind: CaseKind, status: CaseStatus): CaseActionAvailability[] {
  const lifecycle = getLifecycle(kind);
  const isTerminal = status === "closed" || status === "merged";

  // Un kind sin ciclo de vida declarado no habilita NADA que toque el estado.
  // Fallar cerrado es lo único defendible: si el registro no sabe cómo termina
  // este expediente, el producto no puede ofrecerse a terminarlo.
  if (!lifecycle) {
    return [
      isTerminal
        ? {
            action: "note",
            available: false,
            unavailableReason: "El expediente está cerrado.",
          }
        : { action: "note", available: true, unavailableReason: null },
      {
        action: "close",
        available: false,
        unavailableReason:
          "Este tipo de expediente no tiene un ciclo de vida declarado, así que el sistema no sabe cómo se cierra.",
      },
      {
        action: "escalate",
        available: false,
        unavailableReason:
          "Este tipo de expediente no tiene un ciclo de vida declarado, así que el sistema no sabe si admite escalada.",
      },
    ];
  }

  const note: CaseActionAvailability = isTerminal
    ? {
        action: "note",
        available: false,
        unavailableReason:
          status === "merged"
            ? "Este expediente se fusionó con otro. Las notas van en el expediente que quedó abierto."
            : "El expediente está cerrado. Para dejar constancia de algo nuevo, hay que reabrir el caso o abrir uno nuevo.",
      }
    : { action: "note", available: true, unavailableReason: null };

  let close: CaseActionAvailability;
  if (isTerminal) {
    close = {
      action: "close",
      available: false,
      unavailableReason: "El expediente ya está cerrado.",
    };
  } else if (!lifecycle.manualCloseAllowed && lifecycle.dedicatedCloseProse) {
    // Un kind que SÍ se cierra a mano, pero en OTRA pantalla. Va antes de la
    // rama de abajo porque las dos frases que esa rama sabe decir son falsas
    // acá: no lo cierra un hecho, y la política no está sin escribir.
    //
    // `outbreak_investigation` cayó en la frase genérica por sumar dos flags
    // — `terminalEvents: []` y `manualCloseAllowed: false` — y concluir que no
    // había cierre. Los dos flags son correctos y el cierre existe igual: el
    // segundo está en false JUSTAMENTE porque el cierre dedicado es más
    // exigente que el genérico que ese flag habilitaría.
    //
    // A quién le costaba: a una autoridad sanitaria mirando un expediente
    // legalmente sensible, a la que la pantalla le pedía que reclamara una
    // política ya escrita. Esperar por algo que no va a llegar es peor que no
    // encontrar el botón.
    close = {
      action: "close",
      available: false,
      unavailableReason: `Este expediente no se cierra desde acá: ${lifecycle.dedicatedCloseProse}`,
    };
  } else if (!lifecycle.manualCloseAllowed) {
    // El motivo nombra QUÉ lo cierra, no sólo que el botón no está. Un
    // funcionario que sabe que el expediente se cierra solo cuando el animal
    // sale de custodia no vuelve tres veces a buscar el botón.
    //
    // Un kind cerrado por ACCIÓN de las partes (rehome_request: la org
    // responde, el titular cancela) lo declara en `actionCloseProse`, y esa
    // cláusula va en la misma frase que un hecho terminal: para quien mira el
    // expediente, "se cierra solo cuando la organización responde" es tan
    // informativo como "cuando se resuelve la postulación".
    const terminals =
      describeTerminalEvents(lifecycle.terminalEvents) ?? lifecycle.actionCloseProse ?? null;
    close = {
      action: "close",
      available: false,
      unavailableReason: terminals
        ? `Este tipo de expediente no se cierra a mano: se cierra solo cuando ${terminals}.`
        : // Sin eventos terminales Y sin cierre manual, este expediente HOY no
          // tiene ninguna vía de cierre. Decir sólo "no admite cierre manual"
          // insinuaría que algo más lo cierra, y no es cierto: es el caso de
          // microchip_remediation y outbreak_investigation, donde nadie escribió
          // todavía la política. Un operador que se queda esperando un cierre
          // automático que no existe es peor que uno que sabe que tiene que
          // pedir la decisión.
          "Este expediente todavía no tiene una vía de cierre definida: no se cierra a mano ni hay un hecho declarado que lo termine. Si necesitás darlo por terminado, escribilo en una nota y pedí que se defina la política.",
    };
  } else {
    close = { action: "close", available: true, unavailableReason: null };
  }

  // ESCALAR: subir el expediente a la autoridad ahora, sin esperar al cron.
  //
  // Se deriva de `statusValues`, que es donde cada ciclo declara si `escalated`
  // existe para él. Hoy lo declaran cinco de trece. Para los otros ocho la
  // respuesta no es "todavía no": es que ese estado NO EXISTE en su ciclo, y la
  // frase lo dice así en vez de sugerir que falta una decisión.
  let escalate: CaseActionAvailability;
  if (isTerminal) {
    escalate = {
      action: "escalate",
      available: false,
      unavailableReason:
        status === "merged"
          ? "Este expediente se fusionó con otro. La escalada va sobre el que quedó abierto."
          : "El expediente está cerrado.",
    };
  } else if (status === "escalated") {
    // Ya escalado. Decirlo así y no "no se puede" — el operador que aprieta dos
    // veces necesita saber que la primera funcionó, no creer que ninguna lo hizo.
    escalate = {
      action: "escalate",
      available: false,
      unavailableReason: "Este expediente ya está escalado.",
    };
  } else if (!lifecycle.statusValues.includes("escalated")) {
    escalate = {
      action: "escalate",
      available: false,
      unavailableReason:
        "Este tipo de expediente no tiene estado de escalada: no hay una autoridad por encima a la que subirlo. Si necesitás que alguien más lo mire, dejá una nota.",
    };
  } else {
    escalate = { action: "escalate", available: true, unavailableReason: null };
  }

  return [note, close, escalate];
}

/** Atajo para el caso más frecuente: ¿puede este operador hacer X acá? */
export function canPerformCaseAction(
  kind: CaseKind,
  status: CaseStatus,
  action: CaseAction,
): boolean {
  return availableCaseActions(kind, status).some((a) => a.action === action && a.available);
}
