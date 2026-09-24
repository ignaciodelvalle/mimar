// EL ROUTER de `POST /api/v1/pets/{publicToken}/events`.
//
// LOS SEIS KINDS QUE NO ENTRAN EN EL SWITCH SE MUDARON a
// `append-special-kinds.ts` el 2026-09-09, cuando el kind de mordedura llevo
// este archivo a 1608 lineas y la fence de tamano lo refuto. El corte NO se
// eligio por el numero: los comentarios de `append` mas abajo ya nombraban a
// esas seis como una categoria, una por una, y lo que las une es preciso —
// ninguna contesta en `UseCaseResult<RecordedEvent>`. Lo que quedo aca es lo que
// el nombre promete: el guard, el gate del mismo dia, siete despachos tempranos
// y el switch.
//
// El encabezado historico sigue abajo porque nada de lo que dice dejo de ser
// cierto; solo dejo de estar todo en un archivo.
//
// The thirteen owner writers, behind `POST /api/v1/pets/{publicToken}/events`.
//
// Split out of `route.ts` for the reason the amend endpoint split its own
// handler: that file's subject is "is this request well formed", and this one's
// is "may this event be written, and what exactly does it say". They are
// different questions with different failure vocabularies, and the linter's
// complexity ceiling agrees.
//
// WHO MAY WRITE — VERIFIED AGAINST THE WEB, NOT ASSUMED, AND NOT UNIFORM
// ---------------------------------------------------------------------------
// ELEVEN OF THE THIRTEEN are guarded on the web by `requireAlivePetAccess(publicToken)`,
// cited at the GUARD CALL rather than at the function that contains it — a
// function's first line drifts every time somebody adds a parameter, and the
// line that matters is the one naming the rule:
//
//   vacuna              `createVaccinationAction`     actions-medical.ts:71
//   peso                `createWeightAction`          actions-medical.ts:170
//   antiparasitario     `createDewormingAction`       actions-medical.ts:243
//   esterilización      `createSterilizationAction`   actions-medical.ts:337
//   medicación inicio   `createMedicationStartAction` actions-medical.ts:412
//   medicación fin      `createMedicationEndAction`   actions-medical.ts:519
//   microchip           `createMicrochipAction`       actions.ts:108
//   visita veterinaria  `createVetVisitAction`        actions.ts:361
//   información clínica `createClinicalInfoAction`    actions.ts:448
//   síntoma             `createSymptomObservedAction` actions.ts:762
//   atestación PPP      `createDangerousBreedAttestationAction` actions.ts:186
//
// THE LAST ROW MOVED HERE ON 2026-09-08, out of the "different door" list
// below, and the correction is worth keeping because the citation it replaced
// was the kind this file exists to forbid. It pointed at
// `atestar-raza-peligrosa/page.tsx:22`, a `redirect()` in a server component —
// which a direct POST to the server action never executes, so it is a page
// nicety and not a guard. A maintainer applying this file's own method to that
// line would have concluded the web has no life-status check for the kind and
// moved it into the exempt list, widening the endpoint to accept a legal PPP
// declaration on a deceased animal that `actions.ts:186` refuses. The 409 was
// right; the reason recorded for it was not.
//
// Read literally, that guard is:
//
//   · Any CURRENT HOLDER on the person path — owner, co_owner, foster OR
//     caretaker. Not titular-only.
//   · An ORG-path member whose membership grants `event.write`.
//   · Never on a DECEASED animal: a closed life record accepts no new clinical
//     events.
//
// THE OTHER TWO EACH ANSWER TO A DIFFERENT DOOR, and neither to that one. They
// are listed here rather than folded into the table above, because what they
// share is only that the table does not describe them:
//
//   nota                `createNoteAction`             actions.ts:257
//   reemplazo microchip `replaceMicrochipOwnerAction`  microchip-reemplazo/action.ts:25
//
// THE SECOND NAME WAS WRONG UNTIL 2026-09-08 and the line was right, which is
// the worse of the two mistakes: `replaceMicrochipAction` DOES exist, at
// app/actions/microchip.ts:38, and it is a DIFFERENT door whose only edge check
// is `requireLiveUser()` (:46) — the ownership check for that one lives inside
// the writer instead. A reader who greps the name they were given lands there
// and concludes the owner's replacement door performs no pet-access check at
// all. The door meant here is `replaceMicrochipOwnerAction`, whose guard call
// is `requireOwnedPetByToken` on the cited line.
//
// NOTA IS GUARDED BY `requirePetAccess` PLUS AN ORG CAPABILITY CHECK THE ACTION
// PERFORMS ITSELF, and the asymmetry that remains is now HALF of what it used
// to be.
//
// It used to be both halves. `requirePetAccess` checks neither capability nor
// life status, so a nota needed no `event.write` on the org path AND was
// accepted on a deceased animal, and this file mirrored both — on the grounds
// that the server actions are themselves addressable endpoints, so narrowing
// here would only make the two doors disagree. That reasoning was right about
// the doors and wrong about which way to resolve it: the org ficha has always
// GATED the note form on `event.write`, and the two writers behind it (the
// action and this route) both let an ungated member through. The PO ratified
// the gate as the rule on 2026-08-26, so BOTH doors close, in the same commit,
// rather than one of them narrowing alone.
//
// WHAT SURVIVES, AND IT IS THE HALF THAT MATTERED: a nota is still accepted on
// a DECEASED animal, on both doors. A memorial note is the one thing a grieving
// owner may still write into the libreta, and an endpoint that "tidied up" the
// thirteen into one guard would take it away. The PO ratified a rule about the
// CALLER; the closed life record is a fact about the ANIMAL, and widening that
// would be a second, unratified behaviour change.
//
// REEMPLAZO DE MICROCHIP JOINED IT THERE ON 2026-09-08, from the same evidence
// and not from a family resemblance: its owner door is `requireOwnedPetByToken`
// (microchip-reemplazo/action.ts:25), which checks life status no more than
// `requirePetAccess` does. A chip recovered from an animal that died still has
// to stop pointing at it, and that revocation is exactly what a blanket 409
// here refused while the web accepted it.
//
// ATESTACIÓN PPP DID NOT, and it is the near miss worth naming: it arrived in
// the same work unit and its 409 IS the parity — because its write door,
// `createDangerousBreedAttestationAction`, guards with `requireAlivePetAccess`
// (actions.ts:186) like the other ten. The page's redirect is a courtesy on top
// of that, not the reason. The cohort was never the unit of this decision: two
// kinds that arrived together resolve OPPOSITELY, and only reading each one's
// own door tells you which way.
//
// The remaining asymmetry is enforced BY CONSTRUCTION rather than by
// resemblance: both doors resolve through one query
// (`resolvePetHolderAccess`), and the only branch below is the
// `kind === "note" || kind === "microchip_replace"` early return in
// `checkWriteGuard` — which sits AFTER the capability check rather than in
// front of it, so the exemption is from the ANIMAL's half of the guard only.
//
// SÍNTOMA IS THE ONE WHOSE WRITE LEAVES THE ANIMAL'S OWN RECORD
// ---------------------------------------------------------------------------
// Twelve of these thirteen append a fact and, at most, schedule a reminder or
// notify the household. `createSymptomObservedWriter` runs the free text through the
// disease matcher and, for every REPORTABLE disease flagged alertable, appends
// a system-authored `outbreak_signal`, enqueues an ENO outbox row and routes
// notifications to the jurisdiction's authorities — and when the animal is
// already under an antirrabic observation, escalates.
//
// THAT IS THE REASON TO OFFER IT, not a reason to hesitate. The fan-out is the
// point of the kind; a person noticing something at 23:00 with a phone in their
// hand is the fastest surveillance input this product has, and it was reachable
// from a browser and not from the app. What the phone must NOT do is invent any
// of it: the matcher, the signals, the outbox row and the routing all run
// SERVER-SIDE off the free text, exactly as they do for the web form, and the
// wire carries no disease code, no signal and no recipient.
//
// IT DOES NOT OPEN A CASE, which is the line that separates it from mordedura
// below. The rabies escalation fires only when `pets.rabiesObservationStatus`
// is ALREADY `in_progress` — a lifecycle somebody else started.
//
// WHAT DELIBERATELY DID NOT CROSS, AND ON WHAT EVIDENCE
// ---------------------------------------------------------------------------
//   · DIAGNÓSTICO DE ENFERMEDAD (`recordDiseaseDiagnosisAction`,
//     actions.ts:601 — the line naming ITS rule, same convention). NOT AN OWNER
//     WRITER AT ALL: it performs no ownership check whatsoever and authorizes on
//     `role === "vet" && matriculaVerified`.
//     It shares an `event_type` with información clínica —
//     `clinical_info_logged`, sub_kind `disease_diagnosis` — which is one of the
//     two reasons the contract's `CLINICAL_SUB_KINDS` holds five of the spine's
//     SEVEN. An owner's bearer token must not sign a professional's claim.
//   · MORDEDURA (`reportBiteAction`, surveillance/actions.ts:191) IS an owner
//     writer under this same guard, and is still not here: it does not append a
//     fact, it OPENS A CASE — a `rabies_observation_started` cascade, a
//     10-day observation lifecycle and an authority fan-out across
//     jurisdictions. That belongs in its own work unit with its own contract,
//     not as a fourteenth branch of a switch whose other thirteen only append.
//   · PERDIDA / ENCONTRADA (`setPetLostAction` actions.ts:851,
//     `setPetFoundAction` actions.ts:1005) mutate `pets.status` and carry
//     disclosure preferences, an enriched description and an alert fan-out.
//     Lost mode is a FEATURE and not an asiento: it belongs behind its own
//     endpoints with their own shapes, not as branches of a switch whose whole
//     job is to append one row.
//   · FALLECIMIENTO (`createDeathRecordAction`, actions.ts:1054) is guarded by
//     `requirePetAccess` like nota, and is deferred for shape rather than for
//     reach: five cross-field rules, a disease-code lookup and a custody-episode
//     stamp read before the transaction.
//   · EMBARAZO (app/actions/pregnancy.ts:41, :86) is an owner writer whose
//     use-case DOES NOT ROUTE THROUGH `insertEventIdempotent` — it inserts
//     plainly, with no `clientIdempotencyKey` parameter to pass. This endpoint
//     REQUIRES an `Idempotency-Key` and promises it is honoured; accepting a
//     kind that silently could not honour it would make that promise false,
//     which is worse than not offering the kind. Closing that gap is a change to
//     that writer, not to this file.
//
//     ATESTACIÓN PPP WAS ON THIS LINE UNTIL 2026-09-08 AND ON EXACTLY THAT
//     GROUND. The ground was true and the remedy was to remove it:
//     `createDangerousBreedAttestation` now takes a `clientIdempotencyKey` and
//     branches to `insertEventIdempotent` when one is given, skipping the
//     attachment and the reminder mark on a replay. The kind is accepted below.
//     Embarazo is the same one-file change away and is not made here.
//
//     SÍNTOMA WAS LISTED HERE ON EXACTLY THAT GROUND AND THE GROUND WAS FALSE.
//     `createSymptomObservedWriter` has taken a `clientIdempotencyKey` and
//     branched to `insertEventIdempotent` since the W-1 fix of 2026-06-07, with
//     parity tests, and `createSymptomObservedAction` reads the field off its
//     own form (actions.ts:789) and passes it (:811). The exclusion outlived
//     its reason by two work units because nobody re-read the writer — which is
//     the argument for citing a LINE and not a belief.
//
// WHAT THE SERVER DECIDES AND THE CLIENT MAY NOT
// ---------------------------------------------------------------------------
//   · THE DATE'S MEANING. `occurredAt` arrives as `"YYYY-MM-DD"` and is anchored
//     at noon UTC by the same `parseDateInput` the web uses. The plausibility
//     rules (not in the future, not before the animal's registered birth) run
//     against the PET'S RECORD, which a client does not hold and must not be
//     asked to.
//   · THE SCHEDULE. A medication's dose times come out of `parseFrequencyFields`
//     + `generateDoseSchedule` here, never off the wire. A client that computed
//     its own would be a second source for the reminder rows.
//   · THE SIGNATURE. The person path signs as the owner; the org path signs as
//     its member's resolved authorship, which is `vet` only when that member
//     holds a validated matrícula. Re-deriving either would be a native write
//     claiming a verification nobody gave it.
//
// THE EIGHTEENTH AND LAST OWNER KIND CROSSED ON 2026-09-09: the post-adoption
// check-in. It was the one left because its use-case was coupled to the web
// request — it took a `FormData` and a Supabase client — and the remedy was
// the one the other six took: the writer now receives facts
// (`RecordPostAdoptionCheckinInput`), the web action is the form adapter, and
// the three rules (adopted, by this caller, with a window open) run in the
// writer for both doors. Its door on the web is `requirePetAccess`
// (app/actions/checkin.ts), which is why it joins the deceased-exempt list in
// `checkWriteGuard` below; its own refusals answer `checkin_not_adopted`,
// `checkin_not_adopter` and `checkin_no_open_window`.
//
// NO ATTACHMENTS ON THIS PATH. Eleven of the thirteen web forms offer a file and
// every call below passes `uploadedPath: null`, because a native upload needs a
// signed URL and that whole path is blocked. Stated here rather than left as
// three nulls a reader has to interpret. It costs the four WU-L kinds more than
// it costs the first six — a lab result and a sterilization certificate are the
// kind of asiento a person photographs — and that is an argument for unblocking
// the upload, not for a native form that pretends to take one. Síntoma is the
// exception that does not pay it: its web form takes no file either, so the
// native one loses nothing.

import { assertOccurredAtPlausible } from "@/lib/events/plausibility";
import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import {
  OWNER_AUTHORSHIP,
  type PetHolderAccess,
  isTitularHolder,
  resolvePetHolderAccess,
} from "@/lib/infra/pet-access";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { reportError } from "@/lib/infra/report-error";

import { findDrugByLabel } from "@/lib/reference/drugs";
import {
  FREQUENCY_LABELS,
  generateDoseSchedule,
  intervalHoursForFrequency,
  parseFrequencyFields,
} from "@/lib/reference/medication-schedule";
import { createClinicalInfo } from "@/src/modules/events/application/clinical/clinical-info-use-case";
import { createVetVisit } from "@/src/modules/events/application/clinical/vet-visit-use-case";
import { createMicrochip } from "@/src/modules/events/application/identity/microchip-use-case";
import { createNote } from "@/src/modules/events/application/identity/note-use-case";
import { createDeworming } from "@/src/modules/events/application/medical/deworming-use-case";
import { createMedicationEnd } from "@/src/modules/events/application/medical/medication-end-use-case";
import { createMedicationStart } from "@/src/modules/events/application/medical/medication-start-use-case";
import { createSterilization } from "@/src/modules/events/application/medical/sterilization-use-case";
import { createVaccination } from "@/src/modules/events/application/medical/vaccination-use-case";
import { createWeight } from "@/src/modules/events/application/medical/weight-use-case";
import type { RecordedEvent, UseCaseResult } from "@/src/modules/events/application/types";
// NOT a copy of the flush, and the export's own docblock says why moving it
// into a shared module is refused by two fences. Imported from the module that
// is already allowed to hold that insert.
import { EventsRepository } from "@/src/modules/events/infrastructure/events-repository";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";
import type { EventRecordedV1 } from "@dim/contract/api";
import type { RecordEventInput } from "@dim/contract/input";
// LOS SEIS QUE NO ENTRAN EN EL SWITCH viven en su propio modulo desde que la
// fence de tamano refuto este archivo con 1608 lineas. El corte esta explicado
// en `write-context.ts`; lo que queda aca es el router.
import {
  appendBite,
  appendDangerousBreedAttestation,
  appendDeath,
  appendMicrochipReplace,
  appendPostAdoptionCheckin,
  appendPregnancy,
  appendSymptom,
  appendTattoo,
} from "./append-special-kinds";
import { type WriteContext, parseWireDay } from "./write-context";

import { db } from "@/db";

/**
 * The pre-write reads: the access query, the org capability lookup, the
 * same-day probe and the medication-source lookup.
 *
 * The WRITE is deliberately outside any budget, for the reason `POST
 * /api/v1/pets` records and the amend endpoint repeats: `withDbBudgetOrThrow`
 * races a promise against a timer and rejects, which does not abort a Postgres
 * transaction. Wrapping the append would produce a 503 for a transaction that
 * then COMMITS — the client sees failure, the ledger has the event, and the two
 * disagree forever. The honest bound is the platform's function timeout and the
 * honest recovery is the retry the `Idempotency-Key` guarantees is safe.
 */
const RESOLVE_BUDGET_MS = 8_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The 503 this endpoint answers for every degraded pre-write read. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

/**
 * The `pet_events.event_type` each wire `kind` becomes.
 *
 * EVERY KIND, though only two are ever indexed — the same-day gate is the one
 * reader and it applies to vaccination and deworming alone. The rest are here
 * because this is the table a person asks for ("which spine row is a
 * `medication_end`?") and answering a fraction of that question would send them
 * hunting through the use-cases for the remainder. The `kind → event_type`
 * mapping is otherwise implicit in the dispatch below, which is not a place to
 * read it.
 *
 * NO COUNT IN THIS SENTENCE, deliberately, for the reason `RecordedEvent`'s doc
 * dropped its own: it said "all six" while listing ten, because a number in
 * prose has to be edited every time a kind crosses and nothing fails when it is
 * not. The property is that the map is TOTAL over the union — which the
 * `satisfies` below states to the typechecker instead of to a reader.
 */
const EVENT_TYPE_OF_KIND = {
  vaccination: "vaccination_administered",
  weight: "weight_recorded",
  deworming: "deworming_administered",
  medication_start: "medication_started",
  medication_end: "medication_stopped",
  note: "note_added",
  microchip: "microchip_implanted",
  sterilization: "sterilization_performed",
  vet_visit: "vet_visit_logged",
  clinical_info: "clinical_info_logged",
  symptom: "symptom_observed",
  microchip_replace: "microchip_replaced",
  dangerous_breed_attestation: "dangerous_breed_attested",
  death: "death_recorded",
  // BOTH HALVES OF A PREGNANCY ARE `clinical_info_logged`, which is not a
  // shortcut: the spine has no `pregnancy_started` type. Both writers file a
  // `clinical_info_logged` row carrying `sub_kind: "pregnancy"` and a
  // `pregnancy_phase` of "started" or "ended", and `replayPetPregnancy` reads
  // the phase — the event type alone was never what distinguished them.
  //
  // TWO KINDS SHARING ONE VALUE IS SAFE HERE ONLY BECAUSE OF WHO READS THIS MAP.
  // Its one consumer is the same-day soft gate, which runs for `vaccination`
  // and `deworming` and returns before touching anything else
  // (`checkSameDayGate`, first line). Were that gate ever widened, these two
  // would collide with each other AND with a plain `clinical_info` on the same
  // day — a pregnancy start refused as a duplicate of an unrelated lab result.
  // Widen it kind-by-kind, not by dropping the early return.
  pregnancy_start: "clinical_info_logged",
  pregnancy_end: "clinical_info_logged",
  bite: "incident_reported",
  post_adoption_checkin: "post_adoption_checkin",
  tattoo: "tattoo_recorded",
} as const satisfies Record<RecordEventInput["kind"], string>;

/**
 * THE DAY THIS EVENT IS ABOUT, or `null` for the kinds entitled not to name
 * one. Most kinds state it outright; síntoma carries an OPTIONAL `onsetAt`, and
 * when it is absent the use-case stamps the moment of REPORTING — the same
 * shape `createSymptomObservedAction` has. The post-adoption check-in carries
 * no day at all: it is "how things are", stamped at the moment of reporting,
 * exactly as its web action stamps it.
 */
function wireDayOf(input: RecordEventInput): string | null {
  if (input.kind === "symptom") return input.onsetAt;
  if (input.kind === "post_adoption_checkin") return null;
  // EL TATUAJE NECESITA NINGUNA RAMA ACA Y ESO ES LO QUE HAY QUE NOTAR: su
  // `occurredAt` ya es `string | null` en el contrato, asi que el retorno de
  // abajo lo devuelve tal cual y `writeEvent` saltea las dos guardas de fecha
  // cuando no hay dia. Que un tatuaje pueda no tener fecha es un hecho
  // registrado y no un default — la web deja el campo vacio y el escritor
  // asienta `tattoo_date_known: false`. Un tatuaje leido de un animal adoptado
  // no tiene dia conocido, y stampear hoy seria inventarlo.
  return input.occurredAt;
}

/** Everything from the access guard to the append. */
export async function writeEvent(ctx: WriteContext) {
  let access: PetHolderAccess;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(ctx.publicToken, ctx.userId),
      RESOLVE_BUDGET_MS,
      "api-v1-event-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not touch and a pet that does not exist answer
  // IDENTICALLY, exactly as every read endpoint on this surface does.
  if (access.kind === "none") return apiV1Error("not_found", 404);

  const guard = await checkWriteGuard(access, ctx.input.kind);
  if (guard) return guard;

  const day = wireDayOf(ctx.input);

  let occurredAt: Date | null = null;
  if (day !== null) {
    occurredAt = parseWireDay(day);
    if (!occurredAt) return apiV1Error("invalid_request", 400);
  }

  const repo = new EventsRepository();

  // BOTH GATES NEED A DAY, and the two kinds that may lack one pass through
  // both untouched anyway: neither síntoma nor the check-in is one of the two
  // the same-day gate reads, nor a medicación fin. Skipping them when there is
  // no day is therefore not a carve-out — it is the same answer, reached
  // without asking the database a question with a `null` in it.
  if (occurredAt) {
    const plausible = assertOccurredAtPlausible({
      occurredAt,
      // The wire carries a DAY, so the future check compares ARGENTINE CALENDAR
      // DAYS and not instants — comparing the noon-UTC anchor against `now`
      // would refuse every same-day entry made before 09:05 AR.
      isDateOnly: true,
      petDateOfBirth: access.pet.dateOfBirth,
    });
    if (!plausible.ok) {
      return apiV1Error(
        plausible.error === "FUTURE_DATE" ? "event_date_future" : "event_date_before_birth",
        400,
      );
    }

    const softGate = await checkSameDayGate(repo, access.pet.id, ctx.input, occurredAt);
    if (softGate) return softGate;
  }

  const sourceCheck = await checkMedicationSource(repo, access.pet.id, ctx.input);
  if (sourceCheck) return sourceCheck;

  return append(ctx, access, occurredAt, repo);
}

/**
 * The access refusals, and the one place the note's looser rule is decided.
 *
 * `null` means "write it". Both refusals are named by WHOSE fact they are: the
 * closed life record is about the ANIMAL (409, and nothing the caller can
 * retry or reword), the missing capability is about the CALLER (403).
 *
 * THE ORDER OF THE TWO CHECKS IS THE RULE, and it changed on 2026-08-26. The
 * caller-side check now runs FIRST and applies to all thirteen kinds; only the
 * animal-side one is skipped, and for two of them. Written this way rather than as a
 * second `kind === "note"` branch inside the org arm because the asymmetry is
 * now exactly one line long, and a reader can see which half of the guard the
 * nota is exempt from without holding two conditions in their head.
 */
async function checkWriteGuard(
  access: Exclude<PetHolderAccess, { kind: "none" }>,
  kind: RecordEventInput["kind"],
) {
  // ABOUT THE CALLER — every kind, nota included since the PO ratified the org
  // ficha's gate as the rule (2026-08-26). `createNoteAction` performs this
  // same check at the cookie door, so the two still agree by construction.
  if (access.kind === "org") {
    const granted = await getGrantedCapabilities(access.membership);
    if (!granted.has("event.write")) return apiV1Error("event_forbidden", 403);
  }

  // ALSO ABOUT THE CALLER, and narrower than the capability above: the PPP
  // attestation is TITULAR-ONLY (deny-list row `ppp-attestation`,
  // lib/domain/titular-only.ts; T4-I1 / #753). The registries inscribe the
  // PROPIETARIO — Ley CABA 4078 via APrA, Ley PBA 14.107 via the Registro
  // Provincial — so a caretaker asserting the inscription is asserting a legal
  // fact about somebody else, into an append-only ledger, and it is exactly the
  // assertion that moves a dog out of the non-compliant cohort `/gob` reads.
  //
  // `isTitularHolder` and not a hand-written `holderRole === "caretaker"`: it is
  // the same predicate `requireTitularAccess` itself calls, exported for bearer
  // callers that have already resolved the holder and cannot open a cookie
  // session. The web's door is `requireTitularAccess` on both the page and the
  // action, so the two surfaces refuse the same person by construction rather
  // than by two people remembering the same rule.
  //
  // 403 and not 404: the caller demonstrably holds this animal. Pretending it
  // does not exist to someone legitimately caring for it is the lie
  // `NotTitularNotice` exists to avoid on the web.
  if (kind === "dangerous_breed_attestation") {
    const holderRole = access.kind === "owner" ? access.holderRole : null;
    if (!isTitularHolder(access.kind, holderRole)) {
      return apiV1Error("event_forbidden", 403);
    }
  }

  // ABOUT THE ANIMAL — and TWO kinds are exempt, on BOTH doors. A closed life
  // record refuses clinical facts; a memorial note is the one thing a grieving
  // owner (or the shelter that held the animal when it died) may still write,
  // and a microchip replacement is a REGISTRY act rather than a clinical one —
  // a chip recovered from an animal that died still has to stop pointing at it,
  // which is precisely the `device_failure` / `owner_request` revocation.
  // `createNoteAction` guards with `requirePetAccess` and the owner's
  // replacement door with `requireOwnedPetByToken` (microchip-reemplazo/
  // action.ts:25), neither of them an alive variant — that is what keeps these
  // two names honest rather than chosen.
  //
  // THE PPP ATTESTATION IS NOT AMONG THEM, and it is the near miss worth
  // naming: it is the other kind added the same day, and its page redirects a
  // deceased pet away (atestar-raza-peligrosa/page.tsx:22). For that one the
  // 409 below IS the parity, so exempting the cohort would have been wrong.
  //
  // FALLECIMIENTO IS THE THIRD NAME HERE SINCE 2026-09-08, and it is exempt for
  // a reason opposite to the other two. Nota and reemplazo are exempt because
  // their web doors ACCEPT a deceased animal. A death does not — but it is the
  // only kind whose own SUCCESS invalidates its own precondition: the write
  // sets `pets.status = 'deceased'`, so the retry of the request that just
  // committed arrives at an animal this gate refuses. That is a 409 answered to
  // the one caller the `Idempotency-Key` exists to protect, on the one write
  // nobody can repeat, and the app's 10s abort makes it reachable rather than
  // theoretical.
  //
  // NO LONGER THE ONLY ONE, and the sentence above is kept rather than reworded
  // because it records what was true when it was written. Both halves of a
  // pregnancy joined this shape on 2026-09-09: each one's success moves
  // `pregnancy_status` past its own precondition. They are not exempted HERE —
  // this guard is about a deceased animal and a pregnancy on a corpse is
  // correctly refused — they carry the same remedy inside `appendPregnancy`,
  // which asks the ledger before it asks the animal.
  //
  // `appendDeath` therefore refuses a deceased animal ITSELF,
  // after asking the ledger whether this key already wrote — which is also
  // closer to the web, whose door is `requirePetAccess` plus its own refusal
  // line (actions.ts:1172) rather than an alive-gated guard.
  //
  // THE POST-ADOPTION CHECK-IN IS THE FOURTH NAME, SINCE 2026-09-09, and for
  // the first reason rather than the third: its web door is `requirePetAccess`
  // (app/actions/checkin.ts, the guard call at the top of the action), not
  // the alive variant, and the page in front of it gates on the adoption and
  // the open window — never on life status. A refugio that asked "¿cómo está?"
  // is owed the answer even when the answer is that the animal died; the
  // web accepts that check-in and this door must not be the one that refuses
  // it. Its OWN three refusals live in the writer, and they are about the
  // adoption and the window, not the animal's life record.
  if (
    kind === "note" ||
    kind === "microchip_replace" ||
    kind === "death" ||
    kind === "post_adoption_checkin"
  ) {
    return null;
  }

  if (access.pet.status === "deceased") return apiV1Error("event_not_allowed", 409);

  return null;
}

/**
 * The same-day soft gate, for the two kinds the web asks about.
 *
 * NOT A REFUSAL THE CALLER CANNOT PASS: it answers 409 once, the client asks
 * "¿registrar otra igual?", and a caller who means it re-sends the identical
 * body with `sameDayOverride: true`. Two doses of one product on one day are
 * unusual and not impossible — a hard rule here would be this endpoint claiming
 * to know the animal better than the person holding it.
 *
 * Runs BEFORE the append, as the web's does, so a prompt round trip never
 * leaves anything behind.
 */
async function checkSameDayGate(
  repo: EventsRepository,
  petId: string,
  input: RecordEventInput,
  occurredAt: Date,
) {
  if (input.kind !== "vaccination" && input.kind !== "deworming") return null;
  if (input.sameDayOverride) return null;

  try {
    const duplicate = await withDbBudgetOrThrow(
      repo.findSameDayEventOfType(petId, EVENT_TYPE_OF_KIND[input.kind], occurredAt),
      RESOLVE_BUDGET_MS,
      "api-v1-event-sameday",
    );
    if (duplicate) return apiV1Error("same_day_duplicate_suspected", 409);
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  return null;
}

/**
 * That a medication END names a real START on THIS animal.
 *
 * Checked here so the refusal carries a status a client can switch on, and
 * checked AGAIN inside the use-case, which is where it belongs — the same
 * belt-and-braces the amend endpoint applies to its allowlist.
 *
 * NOT `not_found`: on this surface that code always means the PET, and
 * answering 404 to a bad medication reference would tell a client its animal
 * had vanished.
 */
async function checkMedicationSource(
  repo: EventsRepository,
  petId: string,
  input: RecordEventInput,
) {
  if (input.kind !== "medication_end") return null;

  try {
    const source = await withDbBudgetOrThrow(
      repo.findSourceMedicationEvent(petId, input.medicationStartedEventId),
      RESOLVE_BUDGET_MS,
      "api-v1-event-medsource",
    );
    if (!source || source.eventType !== "medication_started") {
      return apiV1Error("medication_source_invalid", 400);
    }
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  return null;
}

/** Dispatch to the use-case for this kind, then answer. */
async function append(
  ctx: WriteContext,
  access: Exclude<PetHolderAccess, { kind: "none" }>,
  occurredAt: Date | null,
  repo: EventsRepository,
) {
  const { input } = ctx;

  // SÍNTOMA IS DISPATCHED FIRST AND SEPARATELY, because it shares neither of the
  // two things every other branch below shares: it has no `occurredAt` of its
  // own to anchor, and its writer answers in its own shape rather than in
  // `UseCaseResult<RecordedEvent>`. Folding it into the switch would mean a
  // `common` object with a nullable date nine branches must not have, and a
  // result variable typed as a union of two shapes.
  if (input.kind === "symptom") return appendSymptom(ctx, access, input, repo);

  // TWO MORE THAT DO NOT FIT THE SWITCH, and for the same reason síntoma does
  // not: neither answers in `UseCaseResult<RecordedEvent>`.
  //
  // Reemplazo de microchip answers `{ ok, eventId, caseId, wasDuplicate }` from a use-case
  // that lives outside the events module entirely, and it needs a fact this
  // request does not carry — the animal's CANONICAL chip, read server-side.
  //
  // Atestación PPP answers `UseCaseResult<{ eventId, wasDuplicate }>` and needs
  // two checks the `common` object has nowhere to put: that the animal is under
  // the regime at all, and that the named registry is one its jurisdiction
  // allows.
  if (input.kind === "microchip_replace") {
    return appendMicrochipReplace(ctx, access, input);
  }
  if (input.kind === "dangerous_breed_attestation") {
    return appendDangerousBreedAttestation(ctx, access, input, repo);
  }

  // AND THE FOURTH, for the same reason as the other three plus one of its own:
  // `createDeathRecord` answers in its own shape, and it needs a fact this
  // request does not carry — the pet's OPEN CUSTODY CASE, which the event is
  // filed against so a shelter's intake episode closes with the animal.
  if (input.kind === "death") {
    return appendDeath(ctx, access, input, repo);
  }

  // AND THE FIFTH AND SIXTH. Both pregnancy writers answer
  // `RecordPregnancyResult` — their own shape — and both refuse on facts about
  // THE ANIMAL that this request does not carry and must not: her sex, her
  // species, and whether a pregnancy is already in follow-up. `common` has
  // nowhere to put any of the three, and a client sending them would be a
  // client asserting what the pet row already says.
  if (input.kind === "pregnancy_start" || input.kind === "pregnancy_end") {
    return appendPregnancy(ctx, access, input);
  }

  // AND THE SEVENTH, which needs more from its surroundings than any of the
  // others. `reportBite` answers its own shape, opens a CASE, starts a rabies
  // observation whose window is resolved per jurisdiction from the rules table,
  // and hands back notifications for an authority fan-out that runs AFTER the
  // transaction. None of that fits `common`, and the fan-out is the part an
  // endpoint would silently drop: every signal still written, every row still on
  // the spine, and no jurisdiction told.
  if (input.kind === "bite") {
    return appendBite(ctx, access, input);
  }

  // AND THE EIGHTH — the last of the eighteen owner kinds to cross, on
  // 2026-09-09. It answers in its own shape, refuses on three facts the
  // request does not carry (the adoption, the adopter, the open window), and
  // has no day of its own to anchor: the writer stamps the moment of reporting,
  // as the web's action does.
  if (input.kind === "post_adoption_checkin") {
    return appendPostAdoptionCheckin(ctx, access, input);
  }

  // AND THE NINTH, THE ONLY ONE THAT REFUSES TO BE WRITTEN WITHOUT A PHOTO.
  // `createTattooForUser` answers its own shape and inserts an `attachments`
  // row inside its transaction whose id becomes the identification's
  // `photo_id`; `common` has nowhere to put an attachment, and every other
  // branch on this surface passes `uploadedPath: null`. It also carries the
  // only OPTIONAL day of the eighteen. See `appendTattoo` for why the photo is
  // a requirement and not strictness.
  if (input.kind === "tattoo") {
    return appendTattoo(ctx, access, input);
  }

  // Every remaining kind states its day outright, and `writeEvent` refused the
  // request before reaching here if that day did not parse.
  if (!occurredAt) return apiV1Error("invalid_request", 400);

  return appendUniformKind(ctx, access, input, occurredAt, repo);
}

/**
 * The kinds whose writer answers in `UseCaseResult<RecordedEvent>` and whose
 * call is the same shape but for its own fields.
 *
 * SPLIT OUT OF `append` ON 2026-09-08, and the reason is the linter's rather
 * than an aesthetic one: adding reemplazo de microchip and atestación PPP took
 * that function past the cognitive-complexity ceiling (26, max 25). The
 * alternative was to add this file to `biome.json`'s override list, which
 * raises the ceiling to 160 for the WHOLE file — a general loosening bought to
 * settle one function. The router above is now a router: three early dispatches
 * and a day check, none of which is the switch's business.
 *
 * THE PARAMETER TYPE IS THE SPLIT'S OWN GUARD. `append` narrows `input` by
 * returning on the three kinds that do not belong here, and narrowing does not
 * survive a function boundary — so the exclusion is restated in the signature.
 * The `never` default at the bottom of the switch then still fails the build
 * the day a fourteenth kind is added and forgotten.
 */
async function appendUniformKind(
  ctx: WriteContext,
  access: Exclude<PetHolderAccess, { kind: "none" }>,
  input: Exclude<
    RecordEventInput,
    {
      kind:
        | "symptom"
        | "microchip_replace"
        | "dangerous_breed_attestation"
        | "death"
        | "pregnancy_start"
        | "pregnancy_end"
        | "bite"
        | "post_adoption_checkin"
        | "tattoo";
    }
  >,
  occurredAt: Date,
  repo: EventsRepository,
) {
  const pet = access.pet;

  const common = {
    user: { id: ctx.userId },
    // The person path signs as the owner; the org path signs as its member's
    // resolved authorship. Never re-derived here.
    eventAuthorship: access.kind === "org" ? access.eventAuthorship : OWNER_AUTHORSHIP,
    occurredAt,
    // No native upload path exists yet — see the file header.
    uploadedPath: null,
    uploadedMimeType: null,
    uploadedSize: null,
    clientIdempotencyKey: ctx.idempotencyKey,
  };
  const deps = {
    repo,
    transaction: async <T>(cb: (tx: unknown) => Promise<T>) =>
      db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>,
  };

  let result: UseCaseResult<RecordedEvent>;

  switch (input.kind) {
    case "vaccination":
      result = await createVaccination(
        {
          ...common,
          pet: { id: pet.id },
          vaccineName: input.vaccineName,
          brand: input.brand,
          batch: input.batch,
          administeredBy: input.administeredBy,
          nextDueAt: input.nextDueAt ? parseWireDay(input.nextDueAt) : null,
          notes: input.notes,
          // The web's "this dose completes that reminder" field. Absent until
          // the app grows the affordance that would produce one.
          sourceReminderId: null,
        },
        deps,
      );
      break;

    case "weight":
      result = await createWeight(
        {
          ...common,
          pet: { id: pet.id },
          // The SAME normalization the web applies before the write, so one
          // animal weighed from two surfaces reads the same in the ledger.
          kgStr: input.kg.toFixed(2),
          notes: input.notes,
        },
        deps,
      );
      break;

    case "deworming":
      result = await createDeworming(
        {
          ...common,
          pet: { id: pet.id, name: pet.name },
          product: input.product,
          type: input.type,
          nextDueAt: input.nextDueAt ? parseWireDay(input.nextDueAt) : null,
          notes: input.notes,
        },
        deps,
      );
      break;

    case "medication_start": {
      // The schema already checked these bounds; this is the web's own parser,
      // run as the backstop AND as the converter — `firstDoseAt` becomes an
      // instant here, read as Argentine wall clock, because a dose at 08:00
      // means 08:00 where the animal lives.
      const freq = parseFrequencyFields(
        input.frequency,
        input.customHours == null ? null : String(input.customHours),
        input.durationDays == null ? null : String(input.durationDays),
        input.firstDoseAt,
      );
      if (freq.error !== null) return apiV1Error("invalid_request", 400);

      const schedule = generateDoseSchedule({
        firstDoseAt: freq.firstDoseAt,
        intervalHours: intervalHoursForFrequency(freq.frequency, freq.customHours),
        durationDays: freq.durationDays,
      });

      result = await createMedicationStart(
        {
          ...common,
          pet: { id: pet.id, name: pet.name },
          drugName: input.drugName,
          dose: input.dose,
          prescribedBy: input.prescribedBy,
          notes: input.notes,
          frequency: freq.frequency,
          customHours: freq.customHours,
          durationDays: freq.durationDays,
          firstDoseAt: freq.firstDoseAt,
          schedule,
          matchedDrugCode: findDrugByLabel(input.drugName)?.code ?? null,
          frequencyLabel: FREQUENCY_LABELS[freq.frequency] ?? freq.frequency,
        },
        deps,
      );
      break;
    }

    case "medication_end":
      result = await createMedicationEnd(
        {
          ...common,
          pet: { id: pet.id },
          medicationStartedEventId: input.medicationStartedEventId,
          reason: input.reason,
          notes: input.notes,
        },
        deps,
      );
      break;

    case "note":
      result = await createNote(
        {
          ...common,
          pet: { id: pet.id },
          text: input.text,
          category: input.category ?? null,
        },
        deps,
      );
      break;

    case "microchip": {
      // THE CANONICAL CHIP, read here because the use-case needs the NUMBER and
      // not a boolean. `createMicrochipAction` resolves it the same way and its
      // own header says why: a boolean collapses "re-submitted the same chip"
      // and "implanted a different one" into one branch, and that branch wrote
      // the event while skipping the canonical row.
      let canonicalChipNumber: string | null;
      try {
        const existing = await withDbBudgetOrThrow(
          fetchActiveIdentifications(pet.id),
          RESOLVE_BUDGET_MS,
          "api-v1-event-chip",
        );
        canonicalChipNumber = existing.microchip?.code ?? null;
      } catch (err) {
        if (err instanceof DbBudgetExceededError) return unavailable();
        throw err;
      }

      result = await createMicrochip(
        {
          ...common,
          pet: { id: pet.id, canonicalChipNumber },
          chipNumber: input.chipNumber,
          countryCode: input.countryCode,
          implantedBy: input.implantedBy,
          locationOnBody: input.locationOnBody,
          notes: input.notes,
        },
        deps,
      );
      break;
    }

    case "sterilization":
      result = await createSterilization(
        {
          ...common,
          pet: { id: pet.id },
          procedure: input.procedure,
          performedBy: input.performedBy,
          clinic: input.clinic,
          notes: input.notes,
        },
        deps,
      );
      break;

    case "vet_visit":
      result = await createVetVisit(
        {
          ...common,
          pet: { id: pet.id },
          reason: input.reason,
          diagnosis: input.diagnosis,
          vetName: input.vetName,
          clinic: input.clinic,
          notes: input.notes,
          // NOT a narrowing: the web runs its capture through
          // `normalizeLocationForWrite`, and an untouched form resolves to this
          // same pair of nulls. See the contract header for why the app has no
          // location to send yet.
          eventJurisdictionProvince: null,
          eventJurisdictionLocality: null,
        },
        deps,
      );
      break;

    case "clinical_info":
      result = await createClinicalInfo(
        {
          ...common,
          pet: { id: pet.id },
          subKind: input.subKind,
          title: input.title,
          details: input.details,
          performedBy: input.performedBy,
          notes: input.notes,
          // Same pair of nulls, same reason, as visita veterinaria above.
          eventJurisdictionProvince: null,
          eventJurisdictionLocality: null,
        },
        deps,
      );
      break;

    default: {
      const unhandled: never = input;
      throw new Error(`Unhandled event kind: ${JSON.stringify(unhandled)}`);
    }
  }

  if (!result.ok) {
    // ONE generic code, for the reason `pet_registration_failed` is one: these
    // six use-cases carry an untyped `string` failure arm holding es-AR prose
    // written for a web form, and it can name internal constraints. Every
    // branch a client can act on differently was decided ABOVE, before the
    // write — which is what makes a single code here honest rather than lazy.
    reportError("api-v1-event", new Error(result.error), { userId: ctx.userId });
    return apiV1Error("event_failed", 500);
  }

  // 201 on both paths. A replay answers with the FIRST attempt's event and
  // `wasDuplicate: true`: the caller asked for an asiento to exist and one
  // exists, which is a success and not a conflict.
  const payload: EventRecordedV1 = {
    eventId: result.value.eventId,
    wasDuplicate: result.value.wasDuplicate,
  };
  return apiV1Json(payload, { status: 201 });
}
