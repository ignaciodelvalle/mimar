// Shared types for case lifecycle declarations. Each
// `src/modules/cases/domain/lifecycles/<kind>.ts` exports one `CaseLifecycle`
// whose shape lets the rest of the system answer:
// "Which events open / close this kind? Which states are admitted?
// Is there an auto-close cron? Is reopen allowed?"

import type { EventType } from "@dim/contract/events";
import type { CaseKind } from "../case-kinds";

export type CaseStatus = "open" | "escalated" | "closed" | "merged";

export interface OpenTrigger {
  /** The event_type whose INSERT may open this kind of case. */
  eventType: EventType;
  /**
   * Optional payload-guard. The event opens the case only when this
   * predicate is true for its payload. Use to express the
   * "incident_type='bite_inflicted'" branch of `incident_reported`,
   * the "to_status='lost'" branch of `status_changed`, etc.
   *
   * Type the input as `unknown` and narrow inside — server actions
   * already type their payloads via Zod before calling.
   */
  whenPayload?: (payload: Record<string, unknown>) => boolean;
}

export interface CaseLifecycle {
  kind: CaseKind;

  /** Which `status` values the kind is allowed to transition through. */
  statusValues: readonly CaseStatus[];

  /** Events that may open a case of this kind (attachment mode `opens`). */
  opensEvents: readonly OpenTrigger[];

  /**
   * Events that close the case at INSERT time. The server action that
   * emits the event also flips `cases.status` and sets `closed_*`.
   */
  terminalEvents: readonly EventType[];

  /** Auto-close cron route, if the kind has one. null = no cron. */
  cronCloseRoute: string | null;

  /**
   * Cron cadence in hours. Most kinds run daily (24); rabies is 12.
   * Ignored when cronCloseRoute is null.
   */
  cronCloseScheduleHours: number;

  /** True for kinds an admin/govt can open without an event (welfare_denuncia). */
  manualOpenAllowed: boolean;

  /**
   * True for kinds an admin/govt can CLOSE by hand, without waiting for a
   * terminal event.
   *
   * Added 2026-08-10, y vale explicar por qué era necesario. `custody-episode.ts`
   * decía en prosa "Manual close: allowed (admin/govt can cancel decomiso per DC
   * authority)" — una frase correcta que ningún código podía leer. Cuando el
   * detalle de caso ganó su botón de cerrar, la regla de la casa era que las
   * acciones se DERIVAN del ciclo de vida y no se inventan; con la política
   * viviendo en un comentario, "derivar" habría sido imposible y el botón habría
   * quedado apoyado en que alguien se acuerde.
   *
   * Arranca en `true` SÓLO para `custody_episode`, que es el único de los doce
   * cuya política estaba documentada. Los otros once son `false` no porque se
   * haya decidido prohibirlo, sino porque nadie lo escribió — y un cierre manual
   * cierra un expediente legal. Habilitar uno nuevo es una línea acá más la
   * razón al lado, que es exactamente la fricción que corresponde.
   */
  manualCloseAllowed: boolean;

  /** Re-open from closed back to open. Only adoption_listing allows it. */
  reopenAllowed: boolean;

  /**
   * For a kind that is closed by an ACTION rather than by a terminal event or
   * an operator's manual close: the es-AR clause naming what closes it, in the
   * shape "se cierra solo cuando {actionCloseProse}". Read by
   * `availableCaseActions` so the case detail can say "this is closed by the
   * parties" instead of "nobody wrote the policy yet".
   *
   * Added for `rehome_request` (rehome-by-titular): with `terminalEvents: []`
   * and `manualCloseAllowed: false` the detail told org members to escalate a
   * request only they could answer. Leave it unset where the policy really is
   * unwritten — the generic sentence there is the honest one.
   *
   * As of 2026-09-17 NO kind is in that state: microchip_remediation got a
   * manual close by PO decision and welfare_denuncia got `dedicatedCloseProse`.
   * The generic "no hay vía de cierre" branch is therefore unreachable today,
   * and `__tests__/case-available-actions.test.ts` pins that it stays so. The
   * branch is kept on purpose: it is what a NEW kind added without a close
   * policy would fall into, and saying so honestly beats guessing.
   *
   * NOT for a kind closed by hand on ITS OWN screen — that is
   * `dedicatedCloseProse` below. This one says "the parties close it"; that one
   * says "you close it, elsewhere".
   */
  actionCloseProse?: string;

  /**
   * For a kind whose close IS a manual act, but lives on a dedicated screen
   * instead of the generic case-detail button: the es-AR clause naming where
   * and how, in the shape "no se cierra desde acá: {dedicatedCloseProse}".
   *
   * Added for `outbreak_investigation` on 2026-09-17, correcting a false
   * statement shown to sanitary authorities. Reading `terminalEvents: []` plus
   * `manualCloseAllowed: false` and concluding "no closing path exists" is the
   * inference this field exists to stop: the flags are both correct, and the
   * close exists anyway. `manualCloseAllowed` stays false ON PURPOSE there,
   * because the dedicated close is STRICTER than the generic one it would open
   * — turning the flag on to "fix" the message would add a weaker second door
   * to a legally sensitive act.
   *
   * So the rule: two false flags do not add up to an absent capability. Before
   * telling an operator that a policy is unwritten, look for the screen.
   */
  dedicatedCloseProse?: string;
}
