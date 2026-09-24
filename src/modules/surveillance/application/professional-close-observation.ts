// Use-case: professional-close rabies observation (spec §D).
//
// Migrated from app/actions/bite.ts::professionalCloseRabiesObservationAction.
// Auth (requireAdminOrGovtOrRedirect) handled by caller (actions.ts).
//
// CRITICAL auth scope:
//   - admin = universal scope (any pet)
//   - govt  = ONLY pets where (province,locality) ∈ jurisdictions
//     → out-of-jurisdiction govt MUST be rejected (cross-org bypass lesson)
//   - vet   = matrícula VALIDADA + la mascota delante. Ver abajo.
//
// EL VETERINARIO ENTRA EL 2026-09-17, por decisión del PO, y lo que se corrige
// es una mentira y no una carencia: dos notificaciones le decían al dueño "pedí
// el cierre a tu veterinario" y ningún veterinario podía cerrar. El comentario
// de `surveillance-repository.ts` sobre la carrera de cierres ya hablaba de "dos
// veterinarios", y `closed_by_role` ya aceptaba `"vet"` en el esquema de eventos.
// El diseño siempre lo contempló; la autorización era la que faltaba.
//
// QUÉ RELACIÓN CON LA MASCOTA, porque la que uno imagina no existe como dato.
// El sistema NO registra qué veterinario conduce una observación: las
// observaciones son `in_situ` (domicilio del dueño) y el campo para la clínica
// oficial está declarado y sin implementar. Así que "el matriculado que observó
// diez días" no es expresable.
//
// La relación que SÍ existe es la de Atender, y es la que se usa: el dueño trae
// al animal y muestra la credencial. La prueba es `event.write` sobre ESA
// organización más conocer el código DIM (31^8 ≈ posesión física), resuelta
// aguas arriba por `resolveAtenderPet`. Lo que el PO acepta explícitamente con
// eso: cualquier matriculado que tenga el animal delante puede cerrar, no sólo
// el que la condujo. La barrera real es física — hay que llevar el animal a esa
// clínica — y es la misma que ya protege cada evento clínico de walk-in (PO-3).
//
// LA MATRÍCULA NO SE CHEQUEA ACÁ. Viene resuelta en `eventAuthorship`, que la
// ata al FIRMANTE y no a la organización — el keystone de provenance #43: una
// organización verificada cuyo miembro no es matriculado NO firma como
// profesional. El llamador rechaza antes de llegar hasta acá.
//
// THE VETERINARIAN WAITS FOR THE WINDOW (PO decisions 2026-09-18, incl. D1): a
// vet may not close NEGATIVE or DEAD before the observation's deadline, and may
// never close LOST TO FOLLOW-UP — step 5b. Admin and govt keep every outcome at
// any time; their path does not pass the gate.
//
// authorRole: 'govt' para admin y govt (el enum de petEvents no tiene 'admin'),
// 'vet' para el veterinario, con su organización y `authorVerified` en true.
// payload.closed_by_role mantiene la distinción precisa (admin|govt|vet).
//
// AUDIT_LOG: YES since 2026-08-17 — `rabies_observation_closed_professional`,
// written INSIDE the transaction. The whole Ley 22.953 surface wrote no audit
// rows, and for the reporting paths that is defensible: the pet_events spine
// already carries the author of every assertion. This close is different now.
// After removing the cron and owner paths it is the ONLY way a clinical outcome
// enters the record, it is performed by an identified operator exercising
// jurisdiction power, and it terminates a legal obligation and flips a
// public-facing banner. The event row records the ASSERTION; the audit row
// records the ADMINISTRATIVE ACT with its before/after state, which is what an
// accountability query over audit_log is expected to find. Note that
// scripts/check-audit-log-coverage.ts could never have caught the absence: the
// mutation sits two hops down (action → use-case → repo) and the fence
// documents ONE HOP as a known blind spot.

import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { formatDate, formatTime, rabiesObservationOutcomeLabel } from "@/lib/utils/format";

import {
  PROFESSIONAL_OUTCOMES,
  type VetCloseRefusal,
  isObservationOpen,
  outcomeToStatus,
  resolveObservationDeadline,
  vetCloseRefusal,
} from "../domain/rabies-observation";
import type { RabiesObservationOutcome } from "../domain/rabies-observation";
import type { SurveillanceRepository } from "../infrastructure/surveillance-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProfessionalCloseObservationInput = {
  petPublicToken: string;
  outcome: RabiesObservationOutcome;
  closureNotes: string | null;
  actor: {
    profile: { id: string; role: "admin" | "govt" | "vet" };
    /** Vacío para el veterinario: su alcance no es territorial. */
    jurisdictions: Array<{ province: string; locality: string }>;
    /**
     * Sólo el camino veterinario. La organización sobre la que el firmante tiene
     * `event.write` y desde la que atendió al animal.
     *
     * Es OBLIGATORIA para `role: "vet"` — sin ella el evento quedaría firmado
     * como profesional verificado sin decir de qué clínica, que es la mitad del
     * valor de esa firma. El paso 4 lo exige en vez de confiar en el llamador.
     */
    organizationId?: string;
    /**
     * Veterinary path only, and REQUIRED there like `organizationId`: how that
     * organization is named to the owner. A walk-in close is written by a clinic
     * that holds no custody of the animal, and naming it to the owner is the
     * only mitigation the PO accepted for that (detection, not prevention).
     */
    organizationName?: string;
  };
};

/**
 * What the owner is told about the close, as CONTENT rather than rows.
 *
 * Structurally the walk-in completion's owner-notice override
 * (lib/infra/notify-owners-of-clinical-event.ts), which is who delivers it on
 * the veterinary path: to EVERY active owner and co-owner, through the durable
 * notification service, linked to the ended event.
 */
export type ProfessionalCloseOwnerNotice = {
  // no-cta: this is the notice CONTENT, not a delivered row. Both deliverers
  // attach the destination: completeAtenderSignature links the ended event on
  // the veterinary path, and the State path pushes ctaLabel/ctaUrl with it.
  notificationType: "rabies_observation_completed_professional_owner";
  severity: "info" | "urgent";
  title: string;
  body: string;
  relatedCaseId: string | null;
};

export type ProfessionalCloseObservationValue = {
  /** The `rabies_observation_ended` row this close appended. */
  endedEventId: string;
  /** When the close happened — the ended event's occurredAt. */
  closedAt: Date;
  /**
   * The owner's notice, for the VETERINARY path only, which delivers it through
   * the walk-in completion. Null for the State's paths, whose owner notice still
   * travels in `notifications` exactly as before.
   */
  ownerNotice: ProfessionalCloseOwnerNotice | null;
};

type Deps = {
  repo: Pick<
    SurveillanceRepository,
    | "findPetByToken"
    | "findLatestObservationStarted"
    | "findOpenBiteCase"
    | "insertObservationEnded"
    | "closeObservationIfOpen"
    | "findActiveOwnerUserIds"
    | "insertObservationCloseAuditLog"
  >;
  closeCase: (
    input: { caseId: string; reason: "resolved" | "cancelled"; closedByUserId: string },
    tx: unknown,
  ) => Promise<void>;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  /**
   * Authority fan-out for a POSITIVE rabies close — the public-health escalation
   * hook. Optional so unit tests that don't exercise escalation can omit it; the
   * action layer always supplies it. Returns authority user ids for the pet's
   * jurisdiction.
   */
  findAuthoritiesForJurisdiction?: (jurisdiction: {
    province: string;
    locality: string;
  }) => Promise<string[]>;
  /**
   * Who hears a POSITIVE close when the jurisdiction lookup THROWS: every
   * active, human, institutional administrator — the same set the resolver
   * itself falls back to when a jurisdiction has no authority
   * (lib/infra/approval-routing.ts -> activeHumanInstitutionalAdminIds). The
   * action layer supplies both; a caller that supplies the resolver without
   * this one gets the old behaviour, which is a lost alert.
   */
  findNationalAdminIds?: () => Promise<string[]>;
};

export type ProfessionalCloseObservationResult = UseCaseResult<ProfessionalCloseObservationValue>;

/**
 * Cómo se nombra a quien cerró, en el aviso que lee el dueño.
 *
 * Un mapa y no un ternario: un ternario con tres roles obliga a anidar, y el
 * anidado es donde se cuela la rama que dice lo que no es. El tipo garantiza
 * que un rol nuevo no compile sin su frase.
 */
const ACTOR_PROSE: Record<"admin" | "govt" | "vet", string> = {
  admin: "un administrador",
  govt: "una autoridad sanitaria",
  vet: "un veterinario matriculado",
};

/**
 * How the end of an observation is named to a person — "24 de septiembre de
 * 2026 a las 09:00", Argentine time, 24-hour clock.
 *
 * Exported so the Atender screen names the date with the same words the refusal
 * below uses: a screen saying "disponible desde el 24" next to a server saying
 * "termina el 25" would leave the veterinarian guessing which one is the law.
 */
export function formatObservationEnd(deadline: Date): string {
  return `${formatDate(deadline)} a las ${formatTime(deadline)}`;
}

/**
 * What the veterinarian is told when the close is refused, per refusal.
 *
 * Exported so the Atender screen explains a withheld option with the same
 * reason the server would give.
 */
export function vetRefusalMessage(
  refusal: VetCloseRefusal,
  deadline: Date,
  petName: string,
): string {
  switch (refusal) {
    case "negative_before_deadline":
      return `Todavía no podés registrar un resultado negativo: el período de observación termina el ${formatObservationEnd(deadline)}, y los signos de rabia pueden aparecer hasta el último día. Antes de esa fecha sólo podés registrar un resultado positivo.`;
    case "lost_to_followup_never":
      return `Desde la clínica no podés cerrar la observación como “sin seguimiento”: ${petName} está con vos. Si el dueño deja de traerlo, avisá a la autoridad sanitaria de tu localidad, que es quien cierra una observación sin seguimiento.`;
    // PO D8 (2026-09-18): the clinic now HAS a door for a death during the
    // observation — atenderRecordDeathInObservationAction records the death
    // itself, closes the observation with it and sends the urgent alert to the
    // authority. A bare "dead" close before the deadline stays refused: it
    // would end the observation with no death on the record.
    case "dead_before_deadline":
      return `Si ${petName} murió durante la observación, usá “Registrar muerte durante la observación”: registra el fallecimiento, cierra la observación y avisa de urgencia a la autoridad sanitaria, que puede necesitar tomar la muestra para el laboratorio. Cerrar como “Fallecido” sin registrar la muerte se habilita recién desde el ${formatObservationEnd(deadline)}.`;
  }
}

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function professionalCloseObservation(
  input: ProfessionalCloseObservationInput,
  deps: Deps,
): Promise<ProfessionalCloseObservationResult> {
  const { repo, closeCase, transaction, findAuthoritiesForJurisdiction, findNationalAdminIds } =
    deps;
  const { actor } = input;

  // 1. Validate outcome.
  if (!PROFESSIONAL_OUTCOMES.includes(input.outcome)) {
    return { ok: false, error: "Outcome inválido." };
  }

  // 2. Load pet.
  const pet = await repo.findPetByToken(input.petPublicToken);
  if (!pet) return { ok: false, error: "Mascota no encontrada." };

  // 3. Guard: observation must still be OPEN — either running (`in_progress`)
  // or past its window with nobody having closed it (`window_expired_unclosed`).
  // The expired state is precisely the queue this close exists to drain, so
  // refusing it would strand every observation the sweep hands over.
  if (!isObservationOpen(pet.rabiesObservationStatus)) {
    return { ok: false, error: "Esta mascota no tiene una observación abierta." };
  }

  // 4. Alcance, que es de una forma distinta para cada actor.
  //
  // admin — universal.
  //
  // govt — territorial, y con subsunción: una asignación de provincia entera
  // (por ejemplo CABA entera) gobierna cada barrio adentro, así que una mascota
  // geocodificada a un barrio está cubierta. Ver jurisdictionScopeContains.
  if (actor.profile.role === "govt") {
    const inScope = jurisdictionScopeContains(
      actor.jurisdictions,
      pet.jurisdictionProvince,
      pet.jurisdictionLocality,
    );
    if (!inScope) {
      return { ok: false, error: "Esta mascota no está dentro de tu cobertura asignada." };
    }
  }

  // vet — NO territorial. Su alcance es la mascota que tiene delante, y esa
  // relación la resolvió `resolveAtenderPet` aguas arriba: `event.write` sobre
  // esta organización más el código DIM. Acá no se re-resuelve; lo que sí se
  // exige es que la organización HAYA LLEGADO, porque un evento firmado como
  // profesional verificado sin decir de qué clínica pierde la mitad de su valor
  // — y este caso de uso no puede distinguir "el llamador se la olvidó" de "no
  // había ninguna". Falla cerrado.
  // The name fails closed for the same reason: the owner's notice on this path
  // exists to say WHICH clinic wrote on their animal.
  if (actor.profile.role === "vet" && (!actor.organizationId || !actor.organizationName)) {
    return {
      ok: false,
      error: "Falta la organización del profesional que cierra la observación.",
    };
  }

  // 5. Load started event.
  const startedEvent = await repo.findLatestObservationStarted(pet.id);
  if (!startedEvent) {
    return { ok: false, error: "Inconsistencia: status in_progress sin evento started." };
  }

  const startedPayload = startedEvent.payload as Record<string, unknown>;
  // Coalesce to null: an observation may legitimately lack a linked bite event
  // (older/seed rows). The rabies_observation_ended schema now accepts null, so
  // the close no longer throws a raw zod "bite_event_id invalid_type" error.
  const biteEventId = (startedPayload.bite_event_id as string | undefined) ?? null;
  const now = new Date();

  // 5b. The legal window binds the VETERINARIAN (PO decisions 2026-09-18: "tiene
  // que esperar, es un tema de plazos legales", and D1).
  //
  // Rabies signs can appear up to the last day of the window, so a negative
  // before it ends is medically empty and legally terminal. A death before it
  // is the authority's (lab sample), and "lost to follow-up" is never true from
  // a clinic that has the animal in front of it. Only a result that reports
  // signs goes through early — see vetCloseRefusal. The State's closers keep
  // every outcome at any time, which is why this branches on the role and not
  // on the outcome alone.
  //
  // The deadline goes through resolveObservationDeadline, the ONE fallback rule
  // for payloads written before `observation_until` existed: without it, an
  // older observation would carry no deadline and the gate would silently open.
  // No extra I/O — the started event is already loaded.
  if (actor.profile.role === "vet") {
    const deadline = resolveObservationDeadline(
      startedPayload.observation_until,
      startedEvent.occurredAt,
    );
    // D1 (security review of this door, 2026-09-18): the negative was not the
    // only early exit. `dead` and `lost_to_followup` ended the observation the
    // same way — banner gone, case closed, no authority told. vetCloseRefusal
    // names all three; the words below are what the vet reads.
    const refusal = vetCloseRefusal(input.outcome, deadline, now);
    if (refusal !== null) {
      return { ok: false, error: vetRefusalMessage(refusal, deadline, pet.name) };
    }
  }

  // 6. Determine close reason: lost_to_followup → cancelled; else → resolved.
  const closedReason: "resolved" | "cancelled" =
    input.outcome === "lost_to_followup" ? "cancelled" : "resolved";

  const biteCase = await repo.findOpenBiteCase(pet.id);
  const pendingNotifications: NewNotification[] = [];
  const esVet = actor.profile.role === "vet";

  // What the owner is told. QUIÉN CERRÓ, dicho bien: esto era un ternario de
  // dos ramas —administrador o autoridad sanitaria— y al entrar el veterinario
  // habría dicho "una autoridad sanitaria" sobre un cierre hecho por su
  // veterinario, una afirmación falsa al dueño acerca de quién actuó en el
  // registro legal de su animal.
  //
  // On the veterinary path the notice NAMES THE CLINIC and ends with the
  // owner's recourse, as every walk-in notice does: a clinic without custody
  // wrote on the animal, and telling the owner who did is the mitigation the PO
  // accepted. The recourse is the sanitary authority and not "corregir el
  // registro": a rabies close is not an event the owner can amend.
  const quienCerro = esVet
    ? `${ACTOR_PROSE.vet} de ${actor.organizationName}`
    : ACTOR_PROSE[actor.profile.role];
  const ownerNotice: ProfessionalCloseOwnerNotice = {
    // no-cta: content only — even a positive (urgent) reaches the owner WITH a
    // destination, because the deliverer adds it: completeAtenderSignature links
    // the ended event on the veterinary path, the State path pushes ctaUrl.
    notificationType: "rabies_observation_completed_professional_owner",
    severity: input.outcome === "positive_rabies" ? "urgent" : "info",
    title: `Observación cerrada profesionalmente — ${pet.name}`,
    body: `La observación antirrábica de ${pet.name} fue cerrada por ${quienCerro} con ${rabiesObservationOutcomeLabel(input.outcome)}.${input.closureNotes ? ` Notas: ${input.closureNotes}` : ""}${esVet ? " Si no reconocés esta atención, avisá a la autoridad sanitaria de tu localidad." : ""}`,
    relatedCaseId: biteCase?.id ?? null,
  };

  let endedEventId: string;
  try {
    endedEventId = await transaction(async (tx) => {
      // 7. Insert rabies_observation_ended.
      const endedPayload = validateEventPayload("rabies_observation_ended", {
        bite_event_id: biteEventId,
        observation_started_event_id: startedEvent.id,
        outcome: input.outcome,
        closed_by_role: actor.profile.role,
        closure_notes: input.closureNotes,
        death_event_id: null,
      });
      // LA FIRMA DEL EVENTO, que es distinta de quién autorizó el acto.
      //
      // El Estado firma como 'govt' — el enum de petEvents no tiene 'admin', así
      // que admin y govt colapsan ahí y `closed_by_role` guarda la distinción
      // precisa en el payload.
      //
      // El veterinario firma como 'vet', con su organización y `authorVerified`
      // en true. Ese true no es una afirmación de este módulo: el llamador sólo
      // llega hasta acá con `role: "vet"` cuando `eventAuthorship` lo resolvió
      // como profesional verificado, o sea con la matrícula del FIRMANTE
      // validada (keystone #43). Una organización verificada cuyo miembro no es
      // matriculado no llega.
      const ended = await repo.insertObservationEnded(
        {
          petId: pet.id,
          eventType: "rabies_observation_ended",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: actor.profile.id,
          authorRole: esVet ? "vet" : "govt",
          authorOrganizationId: esVet ? (actor.organizationId ?? null) : null,
          authorVerified: esVet,
          payload: endedPayload,
          caseId: biteCase?.id ?? null,
        } as Parameters<typeof repo.insertObservationEnded>[0],
        tx as Parameters<typeof repo.insertObservationEnded>[1],
      );

      // 8. Cerrar el estado de la mascota, con la guarda adentro del UPDATE.
      //
      // El chequeo de isObservationOpen que hace el paso 2 se evalua ANTES de
      // esta transaccion. Dos cierres casi simultaneos --dos veterinarios, o un
      // veterinario contra el cron-- lo pasaban los dos. Y como el evento
      // rabies_observation_ended se inserta en el paso 7, ANTES de esto, el
      // perdedor ya habia dejado en el espinazo un resultado clinico que
      // contradice al del ganador: uno negativo y otro positive_rabies sobre el
      // mismo animal, append-only, imposibles de corregir. Abortar aca revierte
      // ese evento junto con todo lo demas.
      const cerro = await repo.closeObservationIfOpen(
        pet.id,
        outcomeToStatus(input.outcome),
        now,
        tx as Parameters<typeof repo.closeObservationIfOpen>[3],
      );
      if (!cerro) {
        throw new Error(
          "otra persona cerro esta observacion mientras tanto — recarga para ver el resultado asentado",
        );
      }

      // 8b. Accountability row for the administrative act, in the SAME tx as
      // the mutation it describes — a rollback takes it with the close.
      await repo.insertObservationCloseAuditLog(
        {
          action: "rabies_observation_closed_professional",
          actorUserId: actor.profile.id,
          payload: {
            pet_id: pet.id,
            pet_public_token: pet.publicToken,
            case_id: biteCase?.id ?? null,
            observation_started_event_id: startedEvent.id,
            outcome: input.outcome,
            closed_by_role: actor.profile.role,
            closure_notes: input.closureNotes,
          },
          before: { rabies_observation_status: pet.rabiesObservationStatus },
          after: { rabies_observation_status: outcomeToStatus(input.outcome) },
        },
        tx as Parameters<typeof repo.insertObservationCloseAuditLog>[1],
      );

      // 9. Close bite case.
      if (biteCase) {
        await closeCase(
          { caseId: biteCase.id, reason: closedReason, closedByUserId: actor.profile.id },
          tx,
        );
      }

      // 10. The State's paths notify here: one row per ACTIVE owner and
      // co-owner. Until 2026-09-18 this read `findActiveOwnership` — a single
      // `role = 'owner'` row — so a co-owner never heard that the observation
      // on their animal had closed, a positive included. The action delivers
      // these rows through the durable service keyed on the ended event, so a
      // close with no open bite case no longer loses them either.
      //
      // The veterinary path does NOT push rows: its notice goes back as content
      // (`value.ownerNotice`) and the walk-in completion delivers it to the same
      // set of owners through the same durable service.
      if (!esVet) {
        const ownerIds = await repo.findActiveOwnerUserIds(
          pet.id,
          tx as Parameters<typeof repo.findActiveOwnerUserIds>[1],
        );
        for (const ownerUserId of new Set(ownerIds)) {
          pendingNotifications.push({
            userId: ownerUserId,
            ...ownerNotice,
            relatedPetId: pet.id,
            ctaLabel: "Ver mascota",
            ctaUrl: `/mis-mascotas/${pet.publicToken}`,
          });
        }
      }

      return ended.id;
    });
  } catch (err) {
    // NEVER surface a raw zod / internal error to the operator (spec: friendly
    // es-AR message only). Log the real detail for diagnostics.
    console.error("professionalCloseObservation tx failed:", err);
    return {
      ok: false,
      error: "No se pudo cerrar la observación. Reintentá; si persiste, avisá al equipo técnico.",
    };
  }

  // POSITIVE rabies escalation hook (public-health critical): fan out an urgent
  // alert to the jurisdiction's sanitary authorities. Best-effort and post-tx —
  // like the bite-report fan-out — a routing miss NEVER undoes a recorded close.
  // A null jurisdiction does NOT skip the resolver (2026-08-17): a CONFIRMED
  // RABIES case reaching nobody because the animal's home was never geocoded is
  // the worst instance of the null-jurisdiction short-circuit in the codebase.
  // Coerced to "" so the resolver's admin fallback runs.
  //
  // A LOOKUP THAT THROWS IS NOT "NOBODY TO TELL" (2026-09-18). The catch used to
  // wrap the lookup and the push together, so a failed jurisdiction query (a
  // pool hiccup, a bad row) queued nothing and logged one line: a confirmed
  // rabies case, recorded, and announced to no one. It now falls back to the
  // national administrators — the set the resolver itself uses when a
  // jurisdiction has no authority — so the alert lands SOMEWHERE a human reads.
  if (input.outcome === "positive_rabies" && findAuthoritiesForJurisdiction) {
    let authorityIds: string[] = [];
    try {
      authorityIds = await findAuthoritiesForJurisdiction({
        province: pet.jurisdictionProvince ?? "",
        locality: pet.jurisdictionLocality ?? "",
      });
    } catch (lookupErr) {
      console.error(
        "[professionalCloseObservation] authority lookup failed; falling back to national admins:",
        lookupErr,
      );
      try {
        authorityIds = findNationalAdminIds ? await findNationalAdminIds() : [];
      } catch (fallbackErr) {
        console.error(
          "[professionalCloseObservation] national-admin fallback failed too; positive rabies alert has no recipient:",
          fallbackErr,
        );
      }
    }
    for (const authorityId of new Set(authorityIds)) {
      pendingNotifications.push({
        userId: authorityId,
        notificationType: "rabies_observation_positive_authority",
        severity: "urgent",
        title: `RABIA CONFIRMADA — ${pet.name}`,
        body: `Se cerró una observación antirrábica con resultado POSITIVO para ${pet.name}. Activá el protocolo de salud pública para la jurisdicción.${input.closureNotes ? ` Notas: ${input.closureNotes}` : ""}`,
        relatedPetId: pet.id,
        relatedCaseId: biteCase?.id ?? null,
        ctaLabel: "Ver vigilancia",
        ctaUrl: "/gob/vigilancia",
      });
    }
  }

  return {
    ok: true,
    value: { endedEventId, closedAt: now, ownerNotice: esVet ? ownerNotice : null },
    notifications: pendingNotifications,
  };
}
