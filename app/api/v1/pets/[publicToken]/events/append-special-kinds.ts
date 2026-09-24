// Los kinds que NO entran en el switch de `appendUniformKind`.
//
// EMPEZARON SIENDO SEIS Y LA CUENTA NO SE MANTIENE A MANO, porque un numero en
// prosa hay que editarlo cada vez que cruza un kind y nada falla cuando no se
// edita — la leccion que `EVENT_TYPE_OF_KIND` ya dejo escrita en `writers.ts`.
// La lista de abajo es la que importa.
//
// NO ES UN CORTE POR TAMANO, aunque una fence de tamano lo haya forzado: el
// router de `writers.ts` ya los nombraba como una categoria, uno por uno —
// "SINTOMA IS DISPATCHED FIRST AND SEPARATELY", "TWO MORE THAT DO NOT FIT THE
// SWITCH", "AND THE FOURTH", "AND THE FIFTH AND SIXTH", "AND THE SEVENTH". Lo
// que tienen en comun es preciso: ninguno contesta en
// `UseCaseResult<RecordedEvent>`, y cada uno necesita algo que el objeto
// `common` del switch no tiene donde poner.
//
//   · sintoma      — no tiene `occurredAt` propio que anclar.
//   · reemplazo    — necesita el chip CANONICO del animal, leido del servidor.
//   · atestacion   — necesita saber si el animal esta bajo el regimen PPP, y si
//                    su jurisdiccion admite el registro elegido.
//   · fallecimiento — necesita el CASO DE CUSTODIA abierto, contra el que se
//                    archiva el evento para que el episodio de un refugio cierre
//                    con el animal.
//   · embarazo     — refuta sobre hechos del animal (sexo, especie, estado) que
//                    la peticion no lleva y no debe llevar.
//   · mordedura    — abre un caso, arranca la observacion antirrabica con la
//                    ventana resuelta por jurisdiccion, y deja un fan-out a la
//                    autoridad que corre DESPUES de la transaccion.
//   · check-in     — el ultimo de los dieciocho (2026-09-09). No tiene dia
//                    propio, refuta sobre la adopcion y la ventana abierta, y
//                    avisa a los admins del refugio que la pidio.
//   · tatuaje      — el decimonoveno, y el UNICO que exige una foto (2026-09-10).
//                    Inserta una fila de `attachments` adentro de su propia
//                    transaccion cuyo id termina siendo el `photo_id` de la
//                    identificacion, y `common` manda `uploadedPath: null` en
//                    todas las demas ramas. Ademas es el unico con dia OPCIONAL.
//
// El router se quedo del otro lado y ahora es lo que dice ser: los despachos
// tempranos, un chequeo de dia, y el switch.

import { normalizeLocationForWrite } from "@/lib/domain/location-normalize";
import { findExistingByKey } from "@/lib/events/event-idempotency";
import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { findAuthoritiesForJurisdiction } from "@/lib/infra/approval-routing";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { notifyTitularOfCaretakerDeath } from "@/lib/infra/caretaker-activity-alert";
import { findOpenCaseForPetAndKind, openCase } from "@/lib/infra/case-helpers";
import { OWNER_AUTHORSHIP, type PetHolderAccess } from "@/lib/infra/pet-access";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { reportError } from "@/lib/infra/report-error";
import {
  claimStagedEventAttachment,
  discardClaimedAttachment,
} from "@/lib/infra/staged-event-attachment";

// `makeTransaction` Y NO `db.transaction` INLINE, y la fence de frontera
// app/→db es la que lo pidio: `writers.ts` tiene ese llamado apadrinado desde el
// 2026-09-02, y mover codigo apadrinado a un archivo nuevo convierte deuda
// tolerada en deuda nueva. El helper ya vivia del lado correcto de la frontera.
import { makeTransaction } from "@/src/modules/events/action-support";
import { createDangerousBreedAttestation } from "@/src/modules/events/application/identity/dangerous-breed-attestation-use-case";
import { validateAttestationRegistry } from "@/src/modules/events/application/identity/validate-attestation-registry";
import { createDeathRecord } from "@/src/modules/events/application/lifecycle/death-record-use-case";
import { createSymptomObservedWriter } from "@/src/modules/events/application/surveillance/symptom-observed-use-case";
// NOT a copy of the flush, and the export's own docblock says why moving it
// into a shared module is refused by two fences. Imported from the module that
// is already allowed to hold that insert.
import { flushNotifications } from "@/src/modules/events/application/writers";
import { resolveDeathReportable } from "@/src/modules/events/domain/death-rules";
import type { EventsRepository } from "@/src/modules/events/infrastructure/events-repository";
import { recordPostAdoptionCheckin } from "@/src/modules/pets/application/checkin/record-post-adoption-checkin";
import { replaceMicrochipForUser } from "@/src/modules/pets/application/microchip/replace-microchip";
import { recordPregnancyEndedWriter } from "@/src/modules/pets/application/pregnancy/record-pregnancy-ended";
import { recordPregnancyStartedWriter } from "@/src/modules/pets/application/pregnancy/record-pregnancy-started";
import { createTattooForUser } from "@/src/modules/pets/application/tattoo/create-tattoo";
import { reportBite } from "@/src/modules/surveillance/application/report-bite";
import { RABIES_OBSERVATION_DAYS } from "@/src/modules/surveillance/domain/rabies-observation";
import { SurveillanceRepository } from "@/src/modules/surveillance/infrastructure/surveillance-repository";
import type { EventRecordedV1 } from "@dim/contract/api";
import type { RecordEventInput } from "@dim/contract/input";

import { type WriteContext, parseWireDay } from "./write-context";

/**
 * SÍNTOMA — the one write on this endpoint that reaches past the animal.
 *
 * WHAT THE PHONE SENDS IS THREE FIELDS AND NOTHING ELSE: the free text, an
 * optional self-assessed severity, an optional onset. Everything the write
 * FANS OUT to — which reportable diseases the text matched, the
 * system-authored `outbreak_signal` rows, the ENO outbox entry, the
 * jurisdiction's recipients, the antirrabic escalation — is decided inside the
 * writer, off the pet's own record. A wire that carried a disease code would be
 * a client filing a claim; a wire that carried a recipient would be a client
 * choosing who gets woken up.
 *
 * THE ANIMAL'S SURVEILLANCE CONTEXT IS READ HERE, from the access query's own
 * pet row rather than re-fetched: species and jurisdiction decide which
 * authorities a signal reaches, and `rabiesObservationStatus` decides whether
 * this is an ordinary report or an escalation inside an open observation. Every
 * one of them already came back with the guard.
 */
export async function appendSymptom(
  ctx: WriteContext,
  access: Exclude<PetHolderAccess, { kind: "none" }>,
  input: Extract<RecordEventInput, { kind: "symptom" }>,
  repo: EventsRepository,
) {
  const pet = access.pet;

  const result = await createSymptomObservedWriter(
    {
      petId: pet.id,
      petPublicToken: pet.publicToken,
      petSpecies: pet.species,
      petJurisdictionCountry: pet.jurisdictionCountry,
      petJurisdictionProvince: pet.jurisdictionProvince ?? null,
      petJurisdictionLocality: pet.jurisdictionLocality ?? null,
      rabiesObservationStatus: pet.rabiesObservationStatus ?? null,
      recordedByUserId: ctx.userId,
      // Same rule as every other kind: the person path signs as the owner, the
      // org path as its member's resolved authorship. Never re-derived here.
      eventAuthorship: access.kind === "org" ? access.eventAuthorship : OWNER_AUTHORSHIP,
      freeText: input.freeText,
      severity: input.severity ?? null,
      onsetAt: input.onsetAt,
      clientIdempotencyKey: ctx.idempotencyKey,
    },
    {
      repo,
      transaction: makeTransaction(),
      // THE FAN-OUT'S LAST LEG, and an endpoint that dropped it would be the
      // quietest possible regression: every signal still written, every row
      // still on the spine, and nobody told. The web's action passes the same
      // function; this is not the endpoint's own notion of who to notify.
      flushNotifications,
    },
  );

  if (!result.ok) {
    reportError("api-v1-event", new Error(result.error), { userId: ctx.userId });
    return apiV1Error("event_failed", 500);
  }

  // THE SYMPTOM'S OWN EVENT ID, never a signal's. `signalEventIds` are
  // system-authored rows about a DISEASE in a jurisdiction; the asiento the
  // owner wrote is the one they can open, correct and see in the libreta.
  const payload: EventRecordedV1 = {
    eventId: result.symptomEventId,
    wasDuplicate: result.wasDuplicate,
  };
  return apiV1Json(payload, { status: 201 });
}

/**
 * Reemplazo o revocación de microchip.
 *
 * THE OLD CHIP IS READ HERE, NOT SENT. `replaceMicrochipForUser` needs
 * `previousChipNumber`, and the web's action gets it the same way: from the
 * animal's CANONICAL identifications, server-side. A wire field would be the
 * client asserting a fact the server already holds, and a disagreement between
 * the two would have to be adjudicated by somebody. There is nothing to
 * adjudicate — the canonical row is the answer.
 *
 * `actorContext` IS DERIVED FROM THE RESOLVED ACCESS AND NEVER FROM THE BODY.
 * The use-case re-verifies it (an org actor must hold the pet through that
 * organization; an admin must actually carry the role), so a caller who lied
 * would be refused there too — but the lie must not be expressible in the first
 * place, and on this endpoint it is not: `access` came from the bearer token.
 *
 * The owner subset of reasons is enforced twice over: the contract's enum only
 * admits five, and the use-case checks them again against the actor kind.
 */
export async function appendMicrochipReplace(
  ctx: WriteContext,
  access: Exclude<PetHolderAccess, { kind: "none" }>,
  input: Extract<RecordEventInput, { kind: "microchip_replace" }>,
) {
  const pet = access.pet;

  const canonical = await fetchActiveIdentifications(pet.id);
  if (!canonical.microchip) {
    // THE REPLAY CHECK RUNS BEFORE THE REFUSAL, and the order is the whole
    // point. A PURE REVOCATION (`newChipNumber: null`) leaves the animal with
    // no active chip, so the retry of the request that just SUCCEEDED arrives
    // at a pet whose canonical row is empty — and a bare 409 here would refuse
    // the one caller the `Idempotency-Key` exists to protect, forever, on a
    // write that already happened. Ask the ledger whether this key wrote before
    // concluding there is nothing to replace.
    const replayed = await findExistingByKey(pet.id, "microchip_replaced", ctx.idempotencyKey);
    if (replayed) {
      const replayPayload: EventRecordedV1 = { eventId: replayed.id, wasDuplicate: true };
      return apiV1Json(replayPayload, { status: 201 });
    }

    // NOT `invalid_request`: the body is well-formed and the caller could not
    // have known. This is a fact about the ANIMAL — it has no chip to replace.
    return apiV1Error("event_not_allowed", 409);
  }

  const result = await replaceMicrochipForUser(ctx.userId, {
    petId: pet.id,
    previousChipNumber: canonical.microchip.code,
    newChipNumber: input.newChipNumber,
    reason: input.reason,
    replacedBy: input.replacedBy,
    replacedAt: parseWireDay(input.occurredAt)?.toISOString() ?? input.occurredAt,
    notes: input.notes,
    clientIdempotencyKey: ctx.idempotencyKey,
    actorContext:
      access.kind === "org"
        ? { kind: "vet_in_org", organizationId: access.membership.organizationId }
        : { kind: "owner" },
  });

  if ("error" in result) {
    // A GATE REFUSAL IS NOT A FAULT. The writer's actor-pet gate rejects a
    // caller who holds the pet in a role this act does not allow — an
    // organization that OWNS the animal outright resolves to `vet_in_org`,
    // whose gate demands `shelter_custody` or `foster` — and that is a 403 the
    // client can read, not a 500 that also pages an engineer at 3am about a
    // request the system handled exactly as designed.
    if (result.denied) return apiV1Error("event_forbidden", 403);
    reportError("api-v1-event", new Error(result.error), { userId: ctx.userId });
    return apiV1Error("event_failed", 500);
  }

  // `wasDuplicate` now TRAVELS from the writer rather than being guessed here.
  // It resolves a replay by returning the original event id; until 2026-09-08
  // it did so silently and this line answered a flat `false`, which told a
  // client to draw "asiento creado" over a write that had not happened.
  const payload: EventRecordedV1 = {
    eventId: result.eventId,
    wasDuplicate: result.wasDuplicate,
  };
  return apiV1Json(payload, { status: 201 });
}

/**
 * Fallecimiento — el asiento terminal.
 *
 * THE ONLY KIND ON THIS ENDPOINT WHOSE WRITE CLOSES THINGS RATHER THAN ADDING
 * ONE. In one transaction it marks the animal deceased, ends every active
 * foster, closes up to three cases, undoes a re-homing sponsorship while
 * telling the applicants, and — when the animal was under an antirrabic
 * observation — closes it with an URGENT notice to the health authority. All of
 * that already exists and is tested; this function's whole job is to hand it
 * the two facts the request does not carry and to answer in the endpoint's
 * vocabulary.
 *
 * THE DECEASED GATE IS NOT EXEMPTED, and that IS the parity. Unlike nota and
 * reemplazo de microchip, the web's own door refuses here too — with its own
 * line rather than with a guard: `createDeathRecordAction` reads
 * `requirePetAccess` (accepting a non-alive pet) and then refuses at
 * actions.ts:1172 with "Esta mascota ya está registrada como fallecida." So a
 * second death on one animal answers 409 from `checkWriteGuard`, which is the
 * same refusal in a different sentence.
 *
 * TWO FACTS THE SERVER SUPPLIES, and neither may come off the wire:
 *
 *   · THE OPEN CUSTODY CASE. `findOpenCaseForPetAndKind(pet.id,
 *     "custody_episode")` — a client naming a case id would be a client
 *     choosing which episode a death closes.
 *   · WHETHER THE DEATH IS REPORTABLE. `resolveDeathReportable` reads the
 *     disease catalog; a client asserting `isReportable` would be a client
 *     deciding whether a health authority hears about a zoonosis.
 */
export async function appendDeath(
  ctx: WriteContext,
  access: Exclude<PetHolderAccess, { kind: "none" }>,
  input: Extract<RecordEventInput, { kind: "death" }>,
  repo: EventsRepository,
) {
  const pet = access.pet;

  const occurredAt = parseWireDay(input.occurredAt);
  if (!occurredAt) return apiV1Error("invalid_request", 400);

  // THE ANIMAL-SIDE REFUSAL, AND THE REPLAY CHECK THAT MUST PRECEDE IT.
  // `checkWriteGuard` exempts this kind precisely so these two can be ordered.
  // A death that succeeded left the animal deceased, so the retry of that very
  // request would meet the refusal below — forever, on a write that already
  // happened. Same remedy as the pure microchip revocation above; same reason.
  if (pet.status === "deceased") {
    const replayed = await findExistingByKey(pet.id, "death_recorded", ctx.idempotencyKey);
    if (replayed) {
      const replayPayload: EventRecordedV1 = { eventId: replayed.id, wasDuplicate: true };
      return apiV1Json(replayPayload, { status: 201 });
    }
    // A SECOND death under a NEW key. The web refuses this with its own
    // sentence ("Esta mascota ya está registrada como fallecida."); here it is
    // the same refusal in the endpoint's vocabulary.
    return apiV1Error("event_not_allowed", 409);
  }

  const custodyCase = await findOpenCaseForPetAndKind(pet.id, "custody_episode");

  const result = await createDeathRecord(
    {
      pet: {
        id: pet.id,
        name: pet.name,
        status: pet.status,
        rabiesObservationStatus: pet.rabiesObservationStatus ?? null,
        jurisdictionProvince: pet.jurisdictionProvince ?? null,
        jurisdictionLocality: pet.jurisdictionLocality ?? null,
      },
      recordedByUserId: ctx.userId,
      eventAuthorship: access.kind === "org" ? access.eventAuthorship : OWNER_AUTHORSHIP,
      cause: input.cause,
      causeDetail: input.causeDetail,
      confirmedByVet: input.confirmedByVet,
      vetName: input.vetName,
      dispositionMethod: input.dispositionMethod,
      facility: input.facility,
      occurredAt,
      notes: input.notes,
      deathAtClinic: input.deathAtClinic,
      clinicName: input.clinicName,
      vetContactedOwner: input.vetContactedOwner,
      vetDecidedAlone: input.vetDecidedAlone,
      ownerToPrivateCrematorium: input.ownerToPrivateCrematorium,
      // NULLED WHEN THE CAUSE IS NOT A DISEASE, exactly as the web action decides
      // it (`cause === "disease" && diseaseCodeRaw ? diseaseCodeRaw : null`).
      // The native form already clears it, but the FORM is not the authority:
      // any other client written to this contract could otherwise store
      // `cause: "accident", disease_code: "rabies_confirmed", is_reportable:
      // false` — a permanent assertion of a confirmed rabies death that raised
      // no authority signal, in a row that is append-only and that
      // `AMENDABLE_EVENT_TYPES` does not admit. Nobody could ever correct it.
      diseaseCode: input.cause === "disease" ? input.diseaseCode : null,
      confirmedByLab: input.confirmedByLab,
      // DERIVED HERE, never taken off the wire — see the header.
      isReportable: resolveDeathReportable(input.cause, input.diseaseCode),
      // No native upload path exists yet — see the file header.
      uploadedPath: null,
      uploadedMimeType: null,
      uploadedSize: null,
      clientIdempotencyKey: ctx.idempotencyKey,
      custodyEpisodeCaseId: custodyCase?.id ?? null,
    },
    {
      repo,
      transaction: makeTransaction(),
      flushNotifications,
    },
  );

  if (!result.ok) {
    reportError("api-v1-event", new Error(result.error), { userId: ctx.userId });
    return apiV1Error("event_failed", 500);
  }

  // THE TITULAR HEARS ABOUT IT WHEN SOMEBODY ELSE FILED IT.
  //
  // A caretaker holds the animal; the titular owns it. The web treats a
  // caretaker-filed death as urgent news for the titular
  // (`announceCaretakerDeathRecord`, caretaker-activity-alert.ts:133) and this
  // door shipped without it — so the one act a titular cannot undo, filed by
  // somebody who is not them, would have reached them through no channel at
  // all. `death_recorded` is not in `AMENDABLE_EVENT_TYPES`: there is no
  // correction path to discover it late.
  //
  // GUARDED ON `insertedEventId` AND NOT `eventId`, which is exactly the
  // distinction those two fields exist for: on a replay nothing was inserted
  // and no cascade ran, so re-notifying would tell a titular twice that their
  // animal died. Same guard the web applies (caretaker-activity-alert.ts:137).
  if (access.kind === "owner" && access.holderRole === "caretaker" && result.insertedEventId) {
    try {
      await notifyTitularOfCaretakerDeath({
        petId: pet.id,
        petName: pet.name,
        petPublicToken: pet.publicToken,
        caretakerUserId: ctx.userId,
        eventId: result.insertedEventId,
      });
    } catch (err) {
      // The record DID land. A failed notification must not turn a committed
      // death into a client-visible failure the person would retry.
      reportError("api-v1-event-caretaker-death", err, { userId: ctx.userId });
    }
  }

  // `eventId` AND NOT `insertedEventId`, and the difference is the whole reason
  // that field was added on 2026-09-08. `insertedEventId` is null on a replay —
  // correctly, because nothing was inserted and no cascade ran — and answering
  // a client with a null id would break the endpoint's own contract on exactly
  // the retry the `Idempotency-Key` exists to serve.
  const payload: EventRecordedV1 = {
    eventId: result.eventId,
    wasDuplicate: result.wasDuplicate,
  };
  return apiV1Json(payload, { status: 201 });
}

/**
 * Atestación de raza potencialmente peligrosa.
 *
 * TWO PRECONDITIONS THE SWITCH COULD NOT CARRY, both of them the web page's own:
 *
 *   1. THE REGIME HAS TO APPLY. `atestar-raza-peligrosa/page.tsx` redirects away
 *      unless `pet.potentiallyDangerousBreed` is set. An endpoint that appended
 *      the attestation anyway would let an animal nobody classified as PPP carry
 *      a legal declaration about a regime it is not under.
 *
 *   2. THE REGISTRY HAS TO BE ONE THIS JURISDICTION NAMES. The options come from
 *      the `ppp_attestation_required_registries` rule resolved for the pet's own
 *      province and locality, so they are ADMIN-EDITABLE and cannot be an enum
 *      in the contract. `validateAttestationRegistry` is the web action's own
 *      check, reused verbatim rather than re-implemented — a second copy is how
 *      the two surfaces would come to disagree about what a jurisdiction allows.
 */
/**
 * Embarazo — el inicio del seguimiento y su cierre, en una función.
 *
 * ONE FUNCTION FOR TWO KINDS, and the reason is that they are two halves of one
 * rule rather than two features. Everything around the writer call is identical:
 * the same day parse, the same pet row, the same authorship, the same
 * `RecordPregnancyResult` to read, and — the part that matters — the same
 * three-way answer to a refusal. Splitting them would duplicate that answer,
 * and the answer is where the thinking is.
 *
 * THE THREE-WAY READ OF A FAILURE is what this function exists for.
 * `RecordPregnancyResult`'s error arm carries an es-AR sentence written for a
 * web form, and api-invariants.md §3 forbids putting one of those on a wire.
 * Before `notAllowed` existed, every refusal here could only have become
 * `event_failed` 500 — so "esta perra ya tiene un embarazo en seguimiento",
 * which is a correct request about an animal in the wrong state, would have
 * told the app its server broke. Now:
 *
 *   · `notAllowed` → `event_not_allowed` 409, the same status a second death
 *     gets from `checkWriteGuard`, and for the same reason: the ANIMAL cannot
 *     have this event.
 *   · anything else → the transaction itself failed. Reported and 500, because
 *     that IS a server fault.
 *
 * THE START'S THREE PRECONDITIONS ARE NOT CHECKED HERE and must not be. Female,
 * a species with a known gestation, and no pregnancy already open are facts
 * about the pet row, and `recordPregnancyStartedWriter` reads that row itself.
 * Restating them at this layer would be a second definition of the rule, free
 * to drift — and the endpoint would be asserting from `access.pet` what the
 * writer re-reads anyway.
 *
 * `reminderCount` IS DELIBERATELY DROPPED. The writer answers how many biweekly
 * checkups it scheduled; `EventRecordedV1` has no field for it and should not
 * grow one for a single kind. The app reads the schedule back from the pet
 * detail, where it is authoritative — and on a replay this number is 0, which
 * is honest about the call and would be misread as "no reminders exist".
 */
export async function appendPregnancy(
  ctx: WriteContext,
  access: Exclude<PetHolderAccess, { kind: "none" }>,
  input: Extract<RecordEventInput, { kind: "pregnancy_start" | "pregnancy_end" }>,
) {
  const pet = access.pet;

  const occurredAt = parseWireDay(input.occurredAt);
  if (!occurredAt) return apiV1Error("invalid_request", 400);

  // THE REPLAY CHECK, AND IT MUST PRECEDE THE WRITERS' OWN STATE GUARDS.
  //
  // BOTH HALVES OF A PREGNANCY INVALIDATE THEIR OWN PRECONDITION BY SUCCEEDING,
  // which is the property `checkWriteGuard` used to attribute to fallecimiento
  // alone — its comment said "the only kind", and this branch made that false
  // for two more. A close that commits sets `pregnancy_status` to
  // `completed_*`; the retry of that very request then meets
  // `record-pregnancy-ended.ts`'s "no hay embarazo activo para cerrar" and is
  // refused FOREVER, on a write that already happened. The start is the mirror:
  // it succeeds, the status becomes `in_progress`, and its own retry is refused
  // as `pregnancy_already_open`.
  //
  // AND THE REFUSAL IS WORSE THAN A WRONG STATUS. Both sentences name a
  // corrective act — "cerralo primero", "registrá primero el inicio" — so a
  // person following the copy appends a SPURIOUS event to a spine that cannot
  // be edited. The endpoint would be instructing a permanent falsification of
  // the record it exists to protect.
  //
  // The guards themselves stay where they are: they are the animal's rule and
  // they are correct for a first attempt. What was missing is the question that
  // has to be asked first — "did THIS key already write?" — exactly as
  // `appendMicrochipReplace` and `appendDeath` ask it.
  //
  // ONE EVENT TYPE FOR BOTH PHASES, and the lookup does not try to tell them
  // apart. The spine has no `pregnancy_started` type: both writers file
  // `clinical_info_logged` carrying a `pregnancy_phase`. Distinguishing them
  // here would be answering a question idempotency does not ask — a key means
  // "this is the same request", so the event that key wrote IS the answer,
  // whichever phase it was. It is the same contract `insertEventIdempotent`
  // enforces one layer down, which keys on (pet, key) and not on the payload.
  const replayed = await findExistingByKey(pet.id, "clinical_info_logged", ctx.idempotencyKey);
  if (replayed) {
    const replayPayload: EventRecordedV1 = { eventId: replayed.id, wasDuplicate: true };
    return apiV1Json(replayPayload, { status: 201 });
  }

  const common = {
    recordedByUserId: ctx.userId,
    // The person path signs as the owner; the org path signs as its member's
    // resolved authorship. Never re-derived here.
    eventAuthorship: access.kind === "org" ? access.eventAuthorship : OWNER_AUTHORSHIP,
    occurredAt,
    vetConsulted: input.vetConsulted,
    notes: input.notes,
    // THE FIELD THAT LETS THIS KIND EXIST ON THIS ENDPOINT AT ALL. Both writers
    // were excluded from it until 2026-09-08 on the grounds that they could not
    // honour an `Idempotency-Key`, which this endpoint requires and promises;
    // they route through `insertEventIdempotent` when it is present and skip
    // every side effect on a replay.
    clientIdempotencyKey: ctx.idempotencyKey,
  };

  const result =
    input.kind === "pregnancy_start"
      ? await recordPregnancyStartedWriter({
          ...common,
          pet,
          weeksAtDiagnosis: input.weeksAtDiagnosis,
        })
      : await recordPregnancyEndedWriter({
          ...common,
          pet,
          outcome: input.outcome,
          liveBirthsCount: input.liveBirthsCount,
        });

  if (!result.ok) {
    // EACH REFUSAL ANSWERS THE CODE WHOSE COPY IS TRUE OF IT, which is the
    // whole reason `notAllowed` is a discriminator. `event_not_allowed` was the
    // obvious home for all three and is the wrong one: its client copy reads
    // "Esta mascota está registrada como fallecida…", so a male dog offered to
    // it would be told his life record is closed.
    switch (result.notAllowed) {
      case "not_applicable":
        return apiV1Error("pregnancy_not_applicable", 409);
      case "already_open":
        return apiV1Error("pregnancy_already_open", 409);
      case "none_open":
        return apiV1Error("pregnancy_none_open", 409);
      // UNREACHABLE FROM HERE, and left explicit rather than folded into the
      // default: `recordEventInputSchema` refuses an outcome/count mismatch on
      // the wire, so this arm can only fire if that schema stops doing so. 400
      // rather than 409 — the request contradicts itself, the animal is fine.
      case "births_mismatch":
        return apiV1Error("invalid_request", 400);
      default:
        break;
    }
    reportError("api-v1-event", new Error(result.error), { userId: ctx.userId });
    return apiV1Error("event_failed", 500);
  }

  const payload: EventRecordedV1 = {
    eventId: result.eventId,
    wasDuplicate: result.wasDuplicate,
  };
  return apiV1Json(payload, { status: 201 });
}

/**
 * Mordedura — el asiento que abre un caso y puede llegar a una autoridad.
 *
 * THE JURISDICTION IS THE INCIDENT'S, NOT THE ANIMAL'S. A mordedura in Cordoba
 * by a pet registered in CABA is Cordoba's sanitary authority's problem, and the
 * writer routes the case on `eventJurisdiction*` for exactly that reason. The
 * web captures those two from a map pin it reverse-geocodes; this app has no
 * map, so it sends what its locality picker already knows — a province CODE, a
 * locality name and the INDEC id that disambiguates it.
 *
 * AND IT CANONICALISES IN `strict` MODE, which is STRICTER THAN THE WEB'S OWN
 * PATH. `reportBiteAction` normalises with `locality: "none"` — province only,
 * no catalogue lookup — because free text out of a geocoder is all it has. The
 * app picked from the catalogue, so the pair can be verified, and a client that
 * invents a locality is refused here instead of writing a place that does not
 * exist into a record a jurisdiction acts on. The divergence is deliberate and
 * in the safe direction; the parity fence will want it stated, and this is the
 * statement.
 *
 * NO COORDINATES. The writer takes them nullable and a bite with none counts
 * into the "sin ubicacion exacta" residual rather than being drawn at a faked
 * centroid. Asking for GPS to write a libreta entry is a permission this form
 * has no business requesting.
 *
 * THE CASE CODE IS DROPPED, and it is the one real parity gap this kind ships
 * with. `reportBite` returns `casePublicCode` — the CAS-XXXX-XXXX a reporter
 * quotes later — and the web puts it on a receipt. `EventRecordedV1` has no
 * field for it and `OwnerPetCasesSection` carries only a count, so no v1 read
 * can hand it back either. Growing the write response would put the code in the
 * one place a person loses it: a single HTTP response they never see again. It
 * belongs in a read, and that is its own work unit.
 */
export async function appendBite(
  ctx: WriteContext,
  access: Exclude<PetHolderAccess, { kind: "none" }>,
  input: Extract<RecordEventInput, { kind: "bite" }>,
) {
  const pet = access.pet;

  const occurredAt = parseWireDay(input.occurredAt);
  if (!occurredAt) return apiV1Error("invalid_request", 400);

  // The contract already refused a partial trio, so these three are all present
  // or all absent. Absent means "no lo se", and the writer's own fallback to the
  // animal's home jurisdiction is the defined behaviour for it.
  let eventProvince: string | null = null;
  let eventLocality: string | null = null;
  if (input.provinceCode !== null) {
    try {
      const normalised = await normalizeLocationForWrite(
        {
          provinceCode: input.provinceCode,
          // `province` is the display-name half of the same field and the app
          // never sends one — the CODE is what a client may assert; the display
          // name is the catalogue's to decide.
          province: null,
          locality: input.localityName,
          localityIndecId: input.localityIndecId,
          // No map, no pin. See this function's header.
          lat: null,
          lng: null,
          address: null,
        },
        { locality: "strict" },
      );
      eventProvince = normalised.province;
      eventLocality = normalised.locality;
    } catch {
      // `strict` throws on a (province, locality) pair the INDEC catalogue does
      // not hold. That is a request problem and not an animal problem, so it is
      // a 400 rather than one of the 409s — the caller sent a place that does
      // not exist.
      return apiV1Error("invalid_request", 400);
    }
  }

  const surveillanceRepo = new SurveillanceRepository();

  const result = await reportBite(
    {
      pet: {
        id: pet.id,
        publicToken: pet.publicToken,
        name: pet.name,
        species: pet.species,
        status: pet.status,
        rabiesObservationStatus: pet.rabiesObservationStatus ?? null,
        jurisdictionProvince: pet.jurisdictionProvince ?? null,
        jurisdictionLocality: pet.jurisdictionLocality ?? null,
      },
      user: { id: ctx.userId },
      eventAuthorship: access.kind === "org" ? access.eventAuthorship : OWNER_AUTHORSHIP,
      occurredAt,
      victimKind: input.victimKind,
      severity: input.severity,
      locationDescription: input.locationDescription,
      context: input.context,
      victimContactName: input.victimContactName,
      victimContactPhone: input.victimContactPhone,
      victimAgeEstimate: input.victimAgeEstimate,
      clientIdempotencyKey: ctx.idempotencyKey,
      eventJurisdictionProvince: eventProvince,
      eventJurisdictionLocality: eventLocality,
      // See the header: no map, so no pin, so no dot. Null is the honest value
      // and the loader already knows what to do with it.
      locationLat: null,
      locationLng: null,
      locationSource: null,
    },
    {
      repo: surveillanceRepo,
      openCase: async (caseInput, tx) =>
        openCase(caseInput as Parameters<typeof openCase>[0], tx as Parameters<typeof openCase>[1]),
      transaction: makeTransaction(),
      // The route label is supplied at the composition root, exactly as the web
      // action supplies it — the use-case does not carry its own notion of who
      // to tell.
      findAuthoritiesForJurisdiction: (jurisdiction) =>
        findAuthoritiesForJurisdiction(jurisdiction, { route: "bite_reported_authority" }),
      resolveObservationWindow: async (jurisdiction) => {
        // Same two guarantees the web action gives this dep, and for the same
        // reasons: a rules-table hiccup must not turn bite reporting into an
        // outage, and a hand-patched rule row can never shrink the window below
        // one day.
        try {
          const r = await resolveBusinessRule("rabies_observation_window", {
            country: "AR",
            ...jurisdiction,
          });
          return { days: Math.max(1, r.payload.days) };
        } catch (err) {
          reportError("api-v1-event-bite-window", err, { userId: ctx.userId });
          return { days: RABIES_OBSERVATION_DAYS };
        }
      },
    },
  );

  if (!result.ok) {
    reportError("api-v1-event", new Error(result.error), { userId: ctx.userId });
    return apiV1Error("event_failed", 500);
  }

  // THE FAN-OUT'S LAST LEG, post-transaction and best-effort, exactly as the web
  // action runs it. An endpoint that dropped this would be the quietest possible
  // regression: the case opened, the observation started, the notification rows
  // built — and nobody told.
  await flushNotifications(result.notifications as Parameters<typeof flushNotifications>[0]);

  const payload: EventRecordedV1 = {
    eventId: result.value.eventId,
    wasDuplicate: result.value.wasDuplicate,
  };
  return apiV1Json(payload, { status: 201 });
}

/**
 * Seguimiento post-adopción — the adopter's answer to the refugio's window.
 *
 * THE RULES ARE NOT HERE, AND THAT IS THE POINT OF THIS KIND'S REFACTOR. Who
 * may write a check-in, what it requires and what it closes are decided inside
 * `recordPostAdoptionCheckin`, once, for the web action and for this door. This
 * function hands the writer the facts a JSON request carries and answers in
 * the endpoint's vocabulary. The web adapter's extras — the L1 location, the
 * attachment — are the two nulls and the three nulls below: the app has no map
 * and no photo module, and pretending otherwise would be a form that takes what
 * it cannot send.
 *
 * THE ORG PATH IS REFUSED AT THIS DOOR TOO, in the web shim's own words
 * ("Solo el adoptante puede registrar un check-in"): an organization is never
 * the adopter, so it gets the caller-side 403 before the writer runs. The
 * writer would refuse anyway (rule 2 compares user ids); saying it here keeps
 * the two doors' first line the same.
 *
 * THE REPLAY CHECK LIVES IN THE WRITER, NOT HERE, and that is a deliberate
 * difference from `appendPregnancy`. The pregnancy writers' guards could not
 * be reordered without touching two web forms, so the endpoint asked the
 * ledger first. This writer was being rewritten anyway, so the question "did
 * THIS key already write?" sits inside it, in front of the window guard, and
 * the web form gets the same protection for free — a retry of the write that
 * closed the last window answers `wasDuplicate: true` on both doors.
 *
 * THE THREE-WAY READ OF A FAILURE, same shape as the pregnancy's:
 *
 *   · `not_adopted`    → `checkin_not_adopted` 409. The ANIMAL cannot have it.
 *   · `not_adopter`    → `checkin_not_adopter` 403. The CALLER may not.
 *   · `no_open_window` → `checkin_no_open_window` 409. Not now; wait.
 *   · anything else    → the transaction (or a malformed adoption row) failed.
 *                        Reported and 500, because that IS a server fault.
 */
export async function appendPostAdoptionCheckin(
  ctx: WriteContext,
  access: Exclude<PetHolderAccess, { kind: "none" }>,
  input: Extract<RecordEventInput, { kind: "post_adoption_checkin" }>,
) {
  const pet = access.pet;

  if (access.kind === "org") return apiV1Error("checkin_not_adopter", 403);

  const result = await recordPostAdoptionCheckin({
    pet: { id: pet.id, name: pet.name },
    user: { id: ctx.userId },
    notes: input.notes,
    // The web runs its L1 capture through `normalizeLocationForWrite`, and an
    // untouched form resolves to this same pair of nulls.
    eventJurisdictionProvince: null,
    eventJurisdictionLocality: null,
    clientIdempotencyKey: ctx.idempotencyKey,
    // No native upload path exists yet — see the router's file header.
    uploadedPath: null,
    uploadedMimeType: null,
    uploadedSize: null,
  });

  if (!result.ok) {
    switch (result.notAllowed) {
      case "not_adopted":
        return apiV1Error("checkin_not_adopted", 409);
      case "not_adopter":
        return apiV1Error("checkin_not_adopter", 403);
      case "no_open_window":
        return apiV1Error("checkin_no_open_window", 409);
      default:
        break;
    }
    reportError("api-v1-event", new Error(result.error), { userId: ctx.userId });
    return apiV1Error("event_failed", 500);
  }

  const payload: EventRecordedV1 = {
    eventId: result.eventId,
    wasDuplicate: result.wasDuplicate,
  };
  return apiV1Json(payload, { status: 201 });
}

export async function appendDangerousBreedAttestation(
  ctx: WriteContext,
  access: Exclude<PetHolderAccess, { kind: "none" }>,
  input: Extract<RecordEventInput, { kind: "dangerous_breed_attestation" }>,
  repo: EventsRepository,
) {
  const pet = access.pet;

  if (!pet.potentiallyDangerousBreed) return apiV1Error("event_not_allowed", 409);

  const registryError = await validateAttestationRegistry(input.registry, {
    province: pet.jurisdictionProvince,
    locality: pet.jurisdictionLocality,
  });
  if (registryError) return apiV1Error("invalid_request", 400);

  const attestedAt = parseWireDay(input.occurredAt);
  if (!attestedAt) return apiV1Error("invalid_request", 400);

  const result = await createDangerousBreedAttestation(
    {
      pet: { id: pet.id },
      user: { id: ctx.userId },
      eventAuthorship: access.kind === "org" ? access.eventAuthorship : OWNER_AUTHORSHIP,
      registry: input.registry,
      registryId: input.registryId,
      attestedAt,
      notes: input.notes,
      // No native upload path exists yet — see the file header.
      uploadedPath: null,
      uploadedMimeType: null,
      uploadedSize: null,
      clientIdempotencyKey: ctx.idempotencyKey,
    },
    {
      repo,
      transaction: makeTransaction(),
    },
  );

  if (!result.ok) {
    reportError("api-v1-event", new Error(result.error), { userId: ctx.userId });
    return apiV1Error("event_failed", 500);
  }

  const payload: EventRecordedV1 = {
    eventId: result.value.eventId,
    wasDuplicate: result.value.wasDuplicate,
  };
  return apiV1Json(payload, { status: 201 });
}

/**
 * Un tatuaje — el noveno kind que no entra en el switch, y el UNICO de los
 * diecinueve que no puede escribirse sin una foto.
 *
 * IT ANSWERS ITS OWN SHAPE (`CreateTattooResult`) and it needs a fact the
 * `common` object has nowhere to put: an `attachments` row, inserted inside the
 * writer's own transaction alongside the event, whose id becomes
 * `pet_identifications.photo_id`.
 *
 * THE PHOTO IS REQUIRED HERE BECAUSE IT IS REQUIRED ON THE WEB, and the
 * consequence of relaxing it is worse than the asymmetry: `createTattooForUser`
 * SUPERSEDES the animal's active tattoo (`status: "replaced"`) before inserting
 * the new one, so a photo-less record written from a phone would retire a
 * photographed one on the identification row a public credential reads. The
 * column is nullable; that is not a permission. The contract states the rule and
 * this function could not honour it anyway — the writer's `TattooInput` has no
 * arm without an attachment.
 *
 * SO THE ORDER IS THE WEB'S ORDER, and each step is refusable:
 *
 *   1. CLAIM the staged object into `event-attachments` — outside the
 *      transaction, exactly as `createTattooAction` uploads before it calls the
 *      writer, so a failed insert never leaks orphan bytes it cannot see.
 *   2. APPEND. On failure, take the attachment back.
 *   3. ON A REPLAY, take it back too. `wasNoop` means the first attempt's event
 *      and ITS attachment already exist and are already linked; this request's
 *      bytes are a second copy nothing points at. `createTattooAction` performs
 *      the identical cleanup on the identical condition, and the reason it is
 *      not a bug to have uploaded them first is that the idempotency key is only
 *      consulted inside the transaction.
 *
 * THE TWO REFUSAL CODES ARE THE PET PHOTO'S, reused rather than widened:
 * `photo_not_an_image` is a 400 because the request was well formed and the
 * FILE is the problem — a different instruction to the person holding the phone
 * than "re-read your body" — and `photo_failed` is a 500 the caller may safely
 * retry with the same staged path.
 */
export async function appendTattoo(
  ctx: WriteContext,
  access: Exclude<PetHolderAccess, { kind: "none" }>,
  input: Extract<RecordEventInput, { kind: "tattoo" }>,
) {
  const pet = access.pet;

  // THE DAY IS OPTIONAL AND ITS ABSENCE IS A RECORDED FACT, not a default: the
  // writer stamps `tattoo_date_known: false` and anchors the event at the
  // moment of reporting. `writeEvent` already refused a day that does not exist
  // and already ran the plausibility rules against the pet's own record; this
  // re-parse is the backstop `parseWireDay`'s own docblock argues for.
  let recordedAt: Date | null = null;
  if (input.occurredAt !== null) {
    recordedAt = parseWireDay(input.occurredAt);
    if (!recordedAt) return apiV1Error("invalid_request", 400);
  }

  // THE LEDGER IS ASKED BEFORE THE CLAIM, AND THE ORDER IS THE FIX.
  //
  // It used to claim first and let `createTattooForUser` consult the key inside
  // its transaction — which is fine for every kind whose replay costs nothing,
  // and wrong for this one, because a SUCCESSFUL first request DELETES the
  // staged object on its way out (`claimStagedEventAttachment`'s cleanup). So:
  // request 1 commits, the app's 10s abort fires before the phone hears it, the
  // person presses again, the same stable `Idempotency-Key` and the same
  // `stagedPath` arrive, the download 404s — and they are told their photo is
  // not an image, about a tattoo that exists.
  //
  // THE SECOND HALF IS WHY THIS IS NOT COSMETIC. A person told that would open
  // a fresh form, which mints a NEW attempt key (`RecordEventScreen` remounts
  // per asiento, deliberately), pick the photo again, and succeed — and the
  // writer SUPERSEDES the active tattoo, so the animal ends with two
  // `tattoo_recorded` events and two `pet_identifications` rows on an
  // append-only spine, the second retiring the first, on the row a public
  // credential reads.
  //
  // Same remedy and same sentence as `appendMicrochipReplace` and `appendDeath`
  // above — ask the ledger before asking anything else. It differs from those
  // two only in being UNCONDITIONAL: their replay check guards a refusal that a
  // success made unreachable, and this one guards a side effect that a success
  // made unrepeatable.
  const replayed = await findExistingByKey(pet.id, "tattoo_recorded", ctx.idempotencyKey);
  if (replayed) {
    const replayPayload: EventRecordedV1 = { eventId: replayed.id, wasDuplicate: true };
    return apiV1Json(replayPayload, { status: 201 });
  }

  const claimed = await claimStagedEventAttachment({ petId: pet.id, stagedPath: input.stagedPath });
  if (!claimed.ok) {
    return apiV1Error(claimed.code, claimed.code === "photo_not_an_image" ? 400 : 500);
  }

  const result = await createTattooForUser(
    pet.id,
    ctx.userId,
    access.kind === "org" ? access.eventAuthorship : OWNER_AUTHORSHIP,
    {
      code: input.tattooCode,
      location: input.locationOnBody,
      description: input.description,
      recordedAt,
      recordedBy: input.recordedBy,
      uploadedAttachment: {
        path: claimed.attachment.path,
        mimeType: claimed.attachment.mimeType,
        size: claimed.attachment.size,
      },
      clientIdempotencyKey: ctx.idempotencyKey,
    },
  );

  if ("error" in result) {
    await discardClaimedAttachment(claimed.attachment.path);
    reportError("api-v1-event", new Error(result.error), { userId: ctx.userId });
    return apiV1Error("event_failed", 500);
  }

  // STILL HERE AFTER THE LEDGER CHECK ABOVE, AND NOT REDUNDANT. That check
  // catches the ordinary replay — the one whose first request already
  // committed. This one catches the RACE the check cannot: two requests under
  // one key in flight at once, where both read the ledger before either
  // committed, and `insertEventIdempotent`'s partial unique index is what
  // decides. The loser gets `wasNoop`, and its bytes are a second copy nothing
  // points at.
  const wasDuplicate = result.wasNoop === true;
  if (wasDuplicate) await discardClaimedAttachment(claimed.attachment.path);

  const payload: EventRecordedV1 = {
    eventId: result.eventId,
    wasDuplicate,
  };
  return apiV1Json(payload, { status: 201 });
}
