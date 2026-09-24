// Asentar — turning what a person typed into what the contract accepts.
//
// PURE, AND THAT IS THE WHOLE POINT. The screen owns text inputs and a `kind`;
// this owns the mapping from those strings to `RecordEventInput`, the es-AR
// sentence for every refusal, and the small amount of Argentine calendar a form
// needs to offer a sensible default. None of it touches the network, so all of
// it is testable without one.
//
// THE VALIDATION IS THE SERVER'S OWN SCHEMA, imported, not re-stated. The point
// of `@dim/contract/input` is that the two doors cannot disagree about what a
// weight or a frequency is; a second copy of "must be under 120" written here in
// the name of a nicer message would be the exact drift the package exists to
// stop. What lives here is the WORDS — the contract carries codes, the consumer
// owns its copy, the same division `intake.ts` states.

import {
  BITE_SEVERITIES,
  BITE_VICTIM_KINDS,
  type BiteSeverity,
  type BiteVictimKind,
  CLINICAL_SUB_KINDS,
  type ClinicalSubKind,
  DANGEROUS_BREED_REGISTRIES,
  DEWORMING_TYPES,
  type DeathCause,
  type DewormingType,
  type DispositionMethod,
  MAX_CUSTOM_HOURS,
  MAX_DURATION_DAYS,
  MAX_WEIGHT_KG,
  MEDICATION_FREQUENCIES,
  type MedicationFrequency,
  NOTE_CATEGORIES,
  type NoteCategory,
  type OwnerMicrochipReplaceReason,
  PREGNANCY_OUTCOMES,
  type PregnancyOutcome,
  type RecordEventInput,
  type RecordEventInputCode,
  STERILIZATION_PROCEDURES,
  SYMPTOM_SEVERITIES,
  type SterilizationProcedure,
  type SymptomSeverity,
  TATTOO_LOCATIONS,
  type TattooLocation,
  type VetContactValue,
  dangerousBreedRegistryLabel,
  firstRecordEventInputCode,
  recordEventInputSchema,
} from "@dim/contract/input";
import { diseasesForSpecies, findDisease } from "@dim/contract/reference";

import { dateInputToIso, isoToDateInput } from "../ui/date-input";

/**
 * The kinds the "Asentar" picker offers.
 *
 * MEDICACIÓN FIN IS NOT AMONG THEM, and its absence is a decision rather than an
 * omission. Ending a treatment needs the `medication_started` event it ends, and
 * the only place a person already holds that identifier is the asiento itself —
 * so the affordance lives on THAT screen, where picking is not required. A
 * picker here would have to invent a list of open treatments, and a list built
 * from a second read is a second source for something the ledger already says.
 *
 * THE ORDER IS BY HOW OFTEN A PERSON REACHES FOR IT, not by the order the kinds
 * were built. A vaccine, a weighing and an antiparasitic are the weekly acts; a
 * microchip is implanted about once in an animal's life and a sterilization
 * exactly once. A picker sorted by implementation history would put the
 * once-ever items in the same visual weight as the weekly ones.
 *
 * SÍNTOMA SITS WHERE THE STORY TURNS — after the three routine acts and before
 * the treatment and the consultation, because that is the order the day happens
 * in: something looks wrong, then a medication starts, then the vet sees it.
 */
export const RECORD_KINDS = [
  "vaccination",
  "weight",
  "deworming",
  "symptom",
  // JUSTO DESPUES DE SINTOMA, y por la misma razon que sintoma esta donde esta:
  // ahi es donde la historia gira. Una mordedura no es un acto de rutina, pero
  // tampoco es de los de "una vez en la vida" que cierran la lista — es el
  // momento en que algo salio mal y hay que registrarlo rapido. Al final de
  // todo quedaria enterrada abajo de microchip y nota.
  "bite",
  "medication_start",
  "vet_visit",
  "clinical_info",
  "sterilization",
  "microchip",
  // JUNTO AL MICROCHIP, porque es el otro acto de IDENTIDAD y ocurre con la
  // misma frecuencia: una vez en la vida del animal. El microchip va primero
  // porque es el que la ley pide; el tatuaje es el que se lee a simple vista.
  "tattoo",
  "note",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** Every kind this screen can write, including the one reached from an asiento. */
/**
 * Every kind this screen can write, including the ones NOT in the picker's
 * FIXED list.
 *
 * THREE ARE REACHED FROM SOMEWHERE ELSE, each for its own reason:
 *   · `medication_end` — from the `medication_started` asiento it closes.
 *   · `microchip_replace` — from the microchip the animal already has. There is
 *     nothing to replace otherwise, and the server refuses with 409.
 *   · `dangerous_breed_attestation` — from the compliance card that reads
 *     "Atestación requerida". The regime has to apply, and only the server
 *     knows whether it does; an unconditional row would be a form that refuses
 *     most animals.
 */
export type WritableKind =
  | RecordKind
  | "medication_end"
  | "microchip_replace"
  | "dangerous_breed_attestation"
  | "death"
  | "pregnancy_start"
  | "pregnancy_end"
  // The eighteenth and last owner kind (2026-09-09). Conditional, like the
  // two pregnancy halves: offered only while the refugio has a follow-up
  // window open for THIS person, which the pet detail says.
  | "post_adoption_checkin";

/**
 * A yes/no answer, and `null` for one nobody gave yet.
 *
 * NOT A `boolean` IN THE DRAFT, and the kit is the reason: it has no switch,
 * only `Choice`, and a `Choice` over two options is the better control here
 * anyway. A switch has two states and shows one of them as the default, so a
 * person who never touched it has still "answered". "¿El veterinario decidió
 * sin contactarte?" is not a question that may have a default answer — it is
 * the field a professional dispute would turn on.
 */
export type YesNo = "si" | "no";
export const YES_NO: readonly YesNo[] = ["si", "no"];

/**
 * Every kind that has a form, including the ones the picker does not offer.
 *
 * EXPORTED SO NOBODY RESTATES IT. The screen's test file kept its own copy and
 * it went stale THREE TIMES in one week — once per kind added — each time
 * failing with "expected exactly one submit control, found 0", which reads like
 * a broken screen and is a list that never learned a name. A fence that
 * enumerates the members instead of pointing at the list is the fence this repo
 * already has a rule about.
 */
export const WRITABLE_KINDS: ReadonlySet<WritableKind> = new Set<WritableKind>([
  ...RECORD_KINDS,
  "medication_end",
  "microchip_replace",
  "dangerous_breed_attestation",
  "death",
  "pregnancy_start",
  "pregnancy_end",
  "post_adoption_checkin",
]);

/**
 * The kinds a picker offers only when THIS ANIMAL can carry them.
 *
 * A THIRD CATEGORY, and it is neither of the two above. `RECORD_KINDS` is
 * unconditional — every animal can be weighed. The three reached from
 * elsewhere are unconditional too; they just have a better door than a menu.
 * These are different: the row itself is a claim about the animal, and showing
 * it to a male dog would be offering a form whose only possible outcome is a
 * refusal.
 *
 * `conditionalKinds` below is the one place that decides. It takes FACTS the
 * pet detail already carries — no new endpoint — and it is a pure function, so
 * the rule is testable without a screen.
 */
export const CONDITIONAL_KINDS = [
  "pregnancy_start",
  "pregnancy_end",
  "post_adoption_checkin",
] as const;

/**
 * What the animal's own facts say about the conditional rows.
 *
 * `null` FOR EVERY FIELD IS A REAL STATE and not a missing one: it is what a
 * DEGRADED read leaves behind. `conditionalKinds` reads it as "I could not find
 * out", which is deliberately NOT the same as "no" — see that function.
 */
export type PetFactsForMenu = {
  sex: string | null;
  species: string | null;
  pregnancyStatus: string | null;
  /**
   * Whether the refugio has a post-adoption follow-up window open for THIS
   * person. A fact about the viewer-and-animal pair rather than the animal
   * alone, and the server resolves it (`postAdoptionCheckin.pending`); `null`
   * is the degraded read, as everywhere on this type.
   */
  postAdoptionCheckinPending: boolean | null;
};

/**
 * The species this build can date a gestation for.
 *
 * A COPY OF THE SERVER'S TABLE, and the only honest way to say why: the keys of
 * `PREGNANCY_DURATION_DAYS` are not on any wire. The pet detail sends the
 * animal's species, not whether a pregnancy could be dated for it, so a client
 * that wants to decide BEFORE asking has to know the list. The drift this
 * creates is real and bounded in one direction: a species added on the server
 * and not here means a row that does not appear for an animal that could have
 * had it — a missing affordance, never a form that gets refused. The reverse
 * cannot happen silently, because the server refuses and the app now has a
 * sentence for exactly that (`pregnancy_not_applicable`).
 */
const PREGNANCY_SPECIES: ReadonlySet<string> = new Set([
  "dog",
  "cat",
  "rabbit",
  "guinea_pig",
  "ferret",
  "other",
]);

/**
 * Which conditional rows this animal earns.
 *
 * THE THREE-STATE READ IS THE WHOLE POINT, and it is why this returns an array
 * rather than booleans:
 *
 *   · FACTS SAY YES → offer it.
 *   · FACTS SAY NO → do not. The row is a claim about the animal.
 *   · FACTS ARE UNKNOWN (a degraded read, `null`) → OFFER IT ANYWAY.
 *
 * That last one is the decision worth defending. Hiding a capability because a
 * read failed is a dead end a person cannot get out of and cannot even see: the
 * app would silently stop being able to record a pregnancy, and nothing on
 * screen would say so. Offering it costs a round trip and a sentence that names
 * the real reason — the server's own refusal, which is authoritative where this
 * function is only a guess.
 *
 * NOT A MIRROR OF THE PPP AND DISEASE PICKERS, which narrow when their read
 * lands. Those reconcile a CHOICE ALREADY MADE against a list that shrank, and
 * clearing it is the honest repair. Here nothing has been chosen yet; the
 * menu is additive, and a row that appears late is fine where a row that
 * vanishes mid-scroll is not.
 */
export function conditionalKinds(facts: PetFactsForMenu): readonly WritableKind[] {
  return [...pregnancyRows(facts), ...checkinRows(facts)];
}

/** The pregnancy halves — see `conditionalKinds` for the three-state rule. */
function pregnancyRows(facts: PetFactsForMenu): readonly WritableKind[] {
  // A pregnancy needs a female of a species this build can date. `null` on
  // either is the unknown case and passes — see the header.
  const canCarry =
    (facts.sex === null || facts.sex === "female") &&
    (facts.species === null || PREGNANCY_SPECIES.has(facts.species));
  if (!canCarry) return [];

  // AND THEN THE TWO HALVES ARE MUTUALLY EXCLUSIVE, which is the same rule the
  // two writers enforce from the spine. Offering both at once would put a
  // "cerrar el embarazo" row in front of somebody whose animal has none.
  if (facts.pregnancyStatus === "in_progress") return ["pregnancy_end"];
  if (facts.pregnancyStatus === null) return ["pregnancy_start", "pregnancy_end"];
  return ["pregnancy_start"];
}

/**
 * The post-adoption check-in — the same three-state read, on one fact.
 *
 *   · `true`  → the refugio is waiting for one. Offer it.
 *   · `false` → nothing pending: the animal was not adopted through the
 *               platform, this person is not its adopter, or every window is
 *               closed. The row would be a form whose only outcome is a
 *               refusal, so it is withheld — exactly as the web's anotar menu
 *               withholds its "Check-in post-adopción" entry.
 *   · `null`  → the read did not answer. OFFER IT ANYWAY, for the reason
 *               `conditionalKinds` gives: a capability hidden behind a failed
 *               read is a dead end nobody can see, and the server's own
 *               refusal (`checkin_no_open_window` and its siblings) names the
 *               real reason where this function can only guess.
 */
function checkinRows(facts: PetFactsForMenu): readonly WritableKind[] {
  return facts.postAdoptionCheckinPending === false ? [] : ["post_adoption_checkin"];
}

/**
 * Is this string a kind THIS BUILD can write?
 *
 * NO COUNT IN THAT SENTENCE, and it used to say "one of the six" while the set
 * held ten. A number in a docblock has to be edited every time a kind crosses
 * and nothing fails when it is not — which is exactly how it came to be wrong
 * by four.
 *
 * Used at the ROUTE boundary, where `kind` arrives from a URL. A deep link
 * carrying a kind this build does not know must land on the picker — which is
 * where the person was going — rather than render a form for `undefined`.
 */
export function isWritableKind(value: string): value is WritableKind {
  // The cast, not a looser set type: the SET is typed by its members so a test
  // can spread it and get `WritableKind[]`, and this predicate is the one place
  // that asks about an unknown string.
  return (WRITABLE_KINDS as ReadonlySet<string>).has(value);
}

/** The title of the form for one kind. */
export function kindTitle(kind: WritableKind): string {
  switch (kind) {
    case "vaccination":
      return "Vacuna";
    case "weight":
      return "Peso";
    case "deworming":
      return "Antiparasitario";
    case "medication_start":
      return "Medicación · inicio";
    case "medication_end":
      return "Medicación · fin";
    case "vet_visit":
      return "Visita veterinaria";
    case "clinical_info":
      return "Información clínica";
    case "sterilization":
      return "Esterilización";
    case "microchip":
      return "Microchip";
    case "note":
      return "Nota";
    case "symptom":
      return "Síntoma";
    case "microchip_replace":
      return "Reemplazo de microchip";
    case "dangerous_breed_attestation":
      return "Atestación de raza peligrosa";
    case "death":
      return "Fallecimiento";
    // "Embarazo" and not "Gestación": the picker is read by the person who
    // lives with the animal, not by the vet who confirmed it.
    case "bite":
      return "Mordedura";
    // "Tatuaje" y no "Tatuaje identificatorio": la persona que abre este menu
    // sabe cual es el tatuaje del que se habla, y el adjetivo solo alarga la
    // fila.
    case "tattoo":
      return "Tatuaje";
    case "pregnancy_start":
      return "Embarazo · inicio";
    case "pregnancy_end":
      return "Embarazo · fin";
    // The web's own row label (anotar/handoff.ts) rather than the asiento's
    // name in the libreta ("Seguimiento post-adopción"): the picker is the
    // menu the web has, and a person who used one should recognise the other.
    case "post_adoption_checkin":
      return "Check-in post-adopción";
  }
}

/** One line under the title, saying what this asiento is for. */
export function kindSubtitle(kind: WritableKind): string {
  switch (kind) {
    case "vaccination":
      return "Una dosis aplicada. Queda en la libreta con la fecha del hecho.";
    case "weight":
      return "Un pesaje. Actualiza el peso que muestra la ficha.";
    case "deworming":
      return "Una desparasitación interna, externa o ambas.";
    case "medication_start":
      return "El comienzo de un tratamiento. Programa los recordatorios de cada dosis.";
    case "medication_end":
      return "El final de un tratamiento. Cancela los recordatorios que quedaban.";
    case "vet_visit":
      return "Una consulta. Queda con el motivo y lo que dijo el veterinario.";
    case "clinical_info":
      return "Un análisis, una radiografía, una cirugía o una alergia detectada.";
    case "sterilization":
      return "Una castración o una ovariectomía. Se asienta una sola vez.";
    case "microchip":
      return "La implantación de un microchip. Queda como identificación de tu mascota.";
    case "note":
      return "Algo que querés dejar anotado sobre tu mascota.";
    case "symptom":
      // SAYS THE FAN-OUT OUT LOUD, before the form and not after. This is the
      // one asiento whose write can reach the sanitary authority, and a person
      // is entitled to know that while they can still decide not to send it.
      return "Algo que le viste y no te cierra. Si coincide con una enfermedad de notificación obligatoria, se avisa a la autoridad sanitaria.";
    case "microchip_replace":
      // SAYS WHAT IT RETIRES, because this is the one asiento that supersedes a
      // previous identity rather than adding to the record. Somebody who read
      // "microchip" and expected the implant form has to be able to tell them
      // apart before they type a number.
      return "El chip actual deja de ser el válido. Si hay uno nuevo, pasa a ser la identificación de tu mascota.";
    case "dangerous_breed_attestation":
      return "La declaración ante el registro que exige tu jurisdicción para perros potencialmente peligrosos.";
    case "death":
      // SAYS WHAT SE CIERRA, and it is the only subtitle that warns rather than
      // describes. Este asiento termina el registro del animal: después sólo se
      // admiten notas. Una persona tiene derecho a saberlo antes, no después.
      return "Cierra el registro del animal. Se dan de baja los tránsitos abiertos y los casos en curso, y después sólo se pueden agregar notas.";
    case "tattoo":
      // DICE QUE LA FOTO ES OBLIGATORIA, ANTES y no despues de completar el
      // formulario. Es el unico asiento que exige un archivo, y descubrirlo al
      // apretar el boton seria descubrirlo tarde. Dice tambien que reemplaza al
      // anterior, porque el modelo es UN tatuaje activo por mascota y la
      // credencial muestra el ultimo.
      return "Necesita una foto del tatuaje. Reemplaza al que estuviera cargado: la credencial muestra el último.";
    case "bite":
      // DICE LO QUE SE ABRE, como fallecimiento dice lo que se cierra. Este
      // asiento no es solo una entrada en la libreta: abre un caso, arranca el
      // periodo de observacion antirrabica y puede llegar a la autoridad
      // sanitaria. Una persona tiene derecho a saberlo antes de completarlo.
      return "Abre un caso y el período de observación antirrábica. Según la jurisdicción, se avisa a la autoridad sanitaria.";
    case "pregnancy_start":
      return "El comienzo del seguimiento. Programa los controles quincenales hasta la fecha probable de parto.";
    case "pregnancy_end":
      // Says "cómo terminó" rather than "el parto", because four of the five
      // outcomes are not a birth and one of them is "no lo sé".
      return "Cómo terminó la gestación. Cierra el seguimiento y los controles que quedaban.";
    case "post_adoption_checkin":
      // SAYS WHO READS IT, as síntoma says who is told. This asiento is
      // addressed to somebody — the refugio that asked — and a person should
      // know that before typing how the animal is doing at home.
      return "Cómo está desde que llegó a casa. Le llega al refugio que pidió el seguimiento y cierra la ventana pendiente.";
  }
}

/**
 * The primary button's two labels, per kind (A2-alta-asentar-R05).
 *
 * THE FOUR-VERB RULE, WHICH THIS SCREEN WAS OUTSIDE OF. AGENTS.md §"Four verbs
 * for primary buttons" forbids a bare CTA by name — "Never bare ('Aceptar',
 * 'Guardar', 'Publicar' on its own)" — and this screen's button said "Guardar"
 * for all eleven forms, while the web says "Registrar vacuna" for the same act.
 * The rule's own two reservations are honoured rather than flattened:
 *
 *   · `Registrar X` is for LOGGING AN OBSERVABLE EVENT, which is what nine of
 *     these are.
 *   · `Confirmar X` is for the definitive ones, and the rule names this exact
 *     case as its example: "Closing a treatment is `Confirmar cierre`, not
 *     `Registrar fin`."
 *
 * A note is neither: nothing was observed and nothing is being confirmed. It
 * takes the fourth shape — a domain verb WITH its object — which is what keeps
 * it out of the banned bare "Guardar".
 *
 * The busy label is here too and not composed at the call site, because the two
 * have to agree about which verb this kind uses: "Guardando…" over "Registrar
 * vacuna" is the same mismatch in miniature.
 */
export function recordEventCta(kind: WritableKind): { label: string; busyLabel: string } {
  const registering = (object: string) => ({
    label: `Registrar ${object}`,
    busyLabel: "Registrando…",
  });
  switch (kind) {
    case "vaccination":
      return registering("vacuna");
    case "weight":
      return registering("peso");
    case "deworming":
      return registering("antiparasitario");
    case "medication_start":
      return registering("inicio de medicación");
    case "medication_end":
      return { label: "Confirmar cierre de medicación", busyLabel: "Confirmando…" };
    case "vet_visit":
      return registering("visita veterinaria");
    case "clinical_info":
      return registering("información clínica");
    case "sterilization":
      return registering("esterilización");
    case "microchip":
      return registering("microchip");
    case "note":
      return { label: "Guardar la nota", busyLabel: "Guardando…" };
    case "symptom":
      return registering("síntoma");
    case "microchip_replace":
      return { label: "Registrar el reemplazo", busyLabel: "Registrando…" };
    case "dangerous_breed_attestation":
      return { label: "Registrar la atestación", busyLabel: "Registrando…" };
    case "death":
      // NOT "Registrar el fallecimiento". The verb matters on the one form that
      // closes a life record: "asentar" is what a libreta does, and it does not
      // ask a grieving person to "registrar" their animal one last time.
      return { label: "Asentar el fallecimiento", busyLabel: "Asentando…" };
    case "bite":
      return { label: "Registrar la mordedura", busyLabel: "Registrando…" };
    case "tattoo":
      // "Subiendo…" Y NO "Registrando…" porque el primer paso REAL es la foto:
      // la app la sube antes de mandar el asiento, y en un plan de datos flojo
      // ese paso es el que tarda. Un boton que dijera "Registrando" mientras
      // sube 4 MB estaria nombrando la parte rapida.
      return { label: "Registrar el tatuaje", busyLabel: "Subiendo…" };
    case "pregnancy_start":
      return { label: "Registrar el embarazo", busyLabel: "Registrando…" };
    case "pregnancy_end":
      // "Cerrar" and not "Registrar el fin": the act is closing a follow-up
      // that has been open for weeks, and one of the five outcomes is a loss.
      return { label: "Cerrar el seguimiento", busyLabel: "Cerrando…" };
    case "post_adoption_checkin":
      // The web's own verb ("Enviar check-in", CheckinForm.tsx): nothing was
      // observed and nothing is confirmed — a message is SENT to the refugio.
      // The fourth shape of the four-verb rule, a domain verb with its object.
      return { label: "Enviar el check-in", busyLabel: "Enviando…" };
  }
}

/**
 * es-AR label for an owner's microchip-replacement motive.
 *
 * FIVE OF THE SPINE'S SEVEN — `duplicate_detected` and `fraud_detected` are
 * professional findings that open a remediation case, and the contract does not
 * admit them from an owner. There is nothing to label here that an owner cannot
 * choose.
 */
export function microchipReplaceReasonLabel(reason: OwnerMicrochipReplaceReason): string {
  switch (reason) {
    case "damaged":
      return "Chip dañado";
    case "unreadable":
      return "No se puede leer";
    case "owner_request":
      return "Solicitud del dueño";
    case "device_failure":
      return "Falla del dispositivo";
    case "other":
      return "Otro motivo";
  }
}

/** es-AR label for a sterilization procedure. */
export function sterilizationProcedureLabel(procedure: SterilizationProcedure): string {
  switch (procedure) {
    case "castration":
      return "Castración";
    case "spay":
      return "Ovariectomía";
  }
}

/**
 * es-AR label for a clinical sub-kind.
 *
 * FIVE OF THE SPINE'S SEVEN, and the two with no label here have none because
 * they are not in `CLINICAL_SUB_KINDS`: `disease_diagnosis`, whose writer
 * authorizes on a verified matrícula and checks no ownership at all, and
 * `pregnancy`, which has its own flow. The exhaustive switch is what keeps that
 * true: if the contract ever admitted either, this function would stop
 * compiling.
 */
export function clinicalSubKindLabel(subKind: ClinicalSubKind): string {
  switch (subKind) {
    case "lab_work":
      return "Análisis";
    case "imaging":
      return "Imágenes";
    case "surgery":
      return "Cirugía";
    case "allergy_detection":
      return "Alergia";
    case "other":
      return "Otro";
  }
}

/** es-AR label for an antiparasitic route. */
export function dewormingTypeLabel(type: DewormingType): string {
  switch (type) {
    case "internal":
      return "Interno";
    case "external":
      return "Externo";
    case "both":
      return "Ambos";
  }
}

/**
 * es-AR label for a dosing frequency.
 *
 * The same six words the web's `FREQUENCY_LABELS` uses. Repeated here rather
 * than imported because that table lives in `lib/reference/`, which is server
 * code — and the interval each one MEANS is still the server's arithmetic, so
 * this is copy and not a rule.
 */
export function frequencyLabel(frequency: MedicationFrequency): string {
  switch (frequency) {
    case "once_daily":
      return "1 vez al día";
    case "twice_daily":
      return "2 veces al día";
    case "three_times_daily":
      return "3 veces al día";
    case "four_times_daily":
      return "4 veces al día";
    case "single_dose":
      return "Dosis única";
    case "custom":
      return "Personalizada";
  }
}

/**
 * es-AR label for a self-assessed severity.
 *
 * DELIBERATELY NOT TRIAGE WORDS. "Leve / Moderado / Grave" is how a person
 * describes what they saw; "urgente" or "emergencia" would be the app implying
 * that picking one summons somebody, and nothing downstream reads this value —
 * the alert cascade is decided by what the FREE TEXT matched.
 */
export function symptomSeverityLabel(severity: SymptomSeverity): string {
  switch (severity) {
    case "mild":
      return "Leve";
    case "moderate":
      return "Moderado";
    case "severe":
      return "Grave";
  }
}

/** es-AR label for a note category. */
export function noteCategoryLabel(category: NoteCategory): string {
  switch (category) {
    case "comportamiento":
      return "Comportamiento";
    case "dieta":
      return "Dieta";
    case "grooming":
      return "Higiene";
    case "estado_de_animo":
      return "Estado de ánimo";
    case "otro":
      return "Otro";
  }
}

export const DEWORMING_TYPE_OPTIONS = DEWORMING_TYPES;
export const FREQUENCY_OPTIONS = MEDICATION_FREQUENCIES;
export const NOTE_CATEGORY_OPTIONS = NOTE_CATEGORIES;
export const STERILIZATION_PROCEDURE_OPTIONS = STERILIZATION_PROCEDURES;
export const CLINICAL_SUB_KIND_OPTIONS = CLINICAL_SUB_KINDS;
export const SYMPTOM_SEVERITY_OPTIONS = SYMPTOM_SEVERITIES;

/**
 * UTC-3, the whole year. Named rather than repeated because `timeInAr` further
 * down needs the same shift, and two hand-written `3 * 60 * 60 * 1000` would be
 * two places for the day and the hour of one timestamp to disagree.
 */
const AR_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Today, as an Argentine calendar day.
 *
 * ARGENTINA IS UTC-3 ALL YEAR — no DST since 2009 — so a fixed offset is exact
 * and needs no zone database, which is the same reasoning
 * `parseArDatetimeLocal` records on the server. Computed rather than taken from
 * the device's own locale because a phone that travels with its owner would
 * otherwise offer "yesterday" as today's default from a plane over the Atlantic,
 * and the server would refuse a day the owner never chose.
 */
export function todayInAr(now: Date = new Date()): string {
  return new Date(now.getTime() - AR_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/** The screen's raw text state. Every field is a string; empty means unstated. */
export type EventDraft = {
  occurredAt: string;
  notes: string;
  // vacuna
  vaccineName: string;
  brand: string;
  batch: string;
  administeredBy: string;
  nextDueAt: string;
  // peso
  kg: string;
  // antiparasitario
  product: string;
  dewormingType: DewormingType;
  // medicación
  drugName: string;
  dose: string;
  prescribedBy: string;
  frequency: MedicationFrequency;
  customHours: string;
  durationDays: string;
  firstDoseDay: string;
  firstDoseTime: string;
  reason: string;
  // microchip
  chipNumber: string;
  countryCode: string;
  implantedBy: string;
  locationOnBody: string;

  // microchip_replace — a DIFFERENT act on the same identity. `newChipNumber`
  // is deliberately not `chipNumber`: one form must not be able to send the
  // implant's field where the replacement's belongs.
  replaceReason: OwnerMicrochipReplaceReason;
  newChipNumber: string;
  replacedBy: string;

  // dangerous_breed_attestation — the registry list is resolved per
  // jurisdiction by the server, so the draft holds the CHOICE and not the
  // options.
  registry: string;
  registryId: string;

  // fallecimiento — el asiento terminal. `vetName` NO está acá: ya existe para
  // visita veterinaria y significa lo mismo, igual que `performedBy` lo comparten
  // esterilización e información clínica.
  cause: DeathCause | null;
  causeDetail: string;
  diseaseCode: string;
  confirmedByLab: YesNo | null;
  confirmedByVet: YesNo | null;
  deathAtClinic: YesNo | null;
  clinicName: string;
  vetContactedOwner: VetContactValue | null;
  vetDecidedAlone: YesNo | null;
  dispositionMethod: DispositionMethod | null;
  facility: string;
  ownerToPrivateCrematorium: YesNo | null;
  // mordedura — el unico asiento que pregunta por la jurisdiccion DEL HECHO y no
  // por la del animal. `biteContext` no es `context` a secas para que no se
  // confunda con nada mas, y `locationDescription` es texto libre en palabras de
  // la persona: la esquina, la plaza, el pasillo.
  victimKind: BiteVictimKind | null;
  /**
   * `biteSeverity` Y NO `severity`, aunque el campo del sintoma se llame asi.
   *
   * Son enums DISTINTOS — el sintoma va `mild|moderate|severe`, la mordedura
   * `minor|moderate|severe` — y comparten dos de los tres valores, que es la
   * peor de las coincidencias: un `severity` compartido compilaria para dos de
   * cada tres respuestas y mandaria "mild" adentro de la alerta que recibe una
   * autoridad sanitaria. La misma regla por la que `newChipNumber` no es
   * `chipNumber`: un formulario no puede poder mandar el campo del otro.
   */
  biteSeverity: BiteSeverity | null;
  locationDescription: string;
  biteContext: string;
  victimContactName: string;
  victimContactPhone: string;
  victimAgeEstimate: string;
  /** La trinidad del selector de localidad: viajan juntas o no viajan. */
  biteProvinceCode: string;
  biteLocalityName: string;
  biteLocalityIndecId: string;
  // tatuaje — el unico asiento que exige un archivo. La FOTO NO ESTA ACA: el
  // borrador es texto serializable que `useIsDirty` compara, y los bytes de una
  // imagen no son ninguna de las dos cosas. Viven en el estado de la pantalla,
  // junto al resto del paso de subida.
  tattooCode: string;
  /** Donde esta el tatuaje. `null` es "no lo dijeron", una respuesta valida. */
  tattooLocation: TattooLocation | null;
  tattooDescription: string;
  /** Quien lo hizo, en texto libre: la veterinaria, el refugio, "no sé". */
  tattooRecordedBy: string;
  // embarazo — `vetName` NO está acá, igual que en fallecimiento: ya existe y
  // significa lo mismo. `weeksAtDiagnosis` es texto porque el campo es texto;
  // el contrato juzga el número.
  weeksAtDiagnosis: string;
  outcome: PregnancyOutcome | null;
  liveBirthsCount: string;
  // esterilización
  procedure: SterilizationProcedure;
  // visita veterinaria
  visitReason: string;
  diagnosis: string;
  vetName: string;
  // información clínica
  clinicalSubKind: ClinicalSubKind;
  title: string;
  details: string;
  // esterilización + información clínica
  performedBy: string;
  // esterilización + visita veterinaria
  clinic: string;
  // nota
  text: string;
  category: NoteCategory | null;
  // síntoma
  freeText: string;
  severity: SymptomSeverity | null;
  /**
   * The onset, SEPARATE from `occurredAt` and blank by default.
   *
   * Not folded into `occurredAt` — which every other kind uses and which
   * `emptyDraft` pre-fills with today — because the two mean opposite things
   * here. `occurredAt` is a date the person is stating; this one is a date they
   * may not know, and the writer stamps the moment of reporting when it is
   * left empty. Pre-filling it with today would turn "I don't know when this
   * started" into a confident and probably wrong claim.
   */
  onsetAt: string;
};

/**
 * A blank draft, dated today.
 *
 * THE DATES ARE PRE-FILLED AS `DD/MM/AAAA`, which is what the field shows and
 * masks (forms-F2). `todayInAr` still speaks the wire format — it is also what
 * the caretaker form and the tests reason in — and `isoToDateInput` is the one
 * conversion between the two. A draft pre-filled with `2026-09-06` would be
 * read by the mask as eight digits and drawn as `20/26/0906`.
 */
export function emptyDraft(now: Date = new Date()): EventDraft {
  const today = isoToDateInput(todayInAr(now));
  return {
    occurredAt: today,
    notes: "",
    vaccineName: "",
    brand: "",
    batch: "",
    administeredBy: "",
    nextDueAt: "",
    kg: "",
    product: "",
    dewormingType: "internal",
    // NULL Y NO UN DEFAULT, la misma regla que `cause` y `outcome`: "leve" no
    // puede ser la respuesta de alguien a quien nadie le pregunto, porque la
    // gravedad viaja al caso y a la alerta que recibe una autoridad.
    victimKind: null,
    biteSeverity: null,
    locationDescription: "",
    biteContext: "",
    victimContactName: "",
    victimContactPhone: "",
    victimAgeEstimate: "",
    biteProvinceCode: "",
    biteLocalityName: "",
    biteLocalityIndecId: "",
    tattooCode: "",
    // NULL Y NO "other": "otro lugar" es una respuesta que alguien elige, no la
    // que le queda a quien no contesto. El valor viaja a la columna canonica
    // `pet_identifications.tattoo_location`.
    tattooLocation: null,
    tattooDescription: "",
    tattooRecordedBy: "",
    weeksAtDiagnosis: "",
    // NULL AND NOT A DEFAULT OUTCOME, the same reason `cause` is null on the
    // death form: a pre-selected "parto exitoso" would let somebody close a
    // gestation as a live birth without ever having been asked.
    outcome: null,
    liveBirthsCount: "",
    drugName: "",
    dose: "",
    prescribedBy: "",
    frequency: "once_daily",
    customHours: "",
    durationDays: "",
    firstDoseDay: today,
    firstDoseTime: "08:00",
    reason: "",
    chipNumber: "",
    countryCode: "",
    implantedBy: "",
    locationOnBody: "",
    replaceReason: "damaged",
    newChipNumber: "",
    replacedBy: "",
    registry: "",
    registryId: "",
    cause: null,
    causeDetail: "",
    diseaseCode: "",
    confirmedByLab: null,
    confirmedByVet: null,
    deathAtClinic: null,
    clinicName: "",
    vetContactedOwner: null,
    vetDecidedAlone: null,
    dispositionMethod: null,
    facility: "",
    ownerToPrivateCrematorium: null,
    // Pre-selected like `dewormingType` above, and for the same reason: these
    // are one-of-N chip rows whose active option is visible on screen, not a
    // hidden default. A blank required chooser is a form that refuses on submit
    // for something the person can see the whole time.
    procedure: "castration",
    visitReason: "",
    diagnosis: "",
    vetName: "",
    clinicalSubKind: "lab_work",
    title: "",
    details: "",
    performedBy: "",
    clinic: "",
    text: "",
    category: null,
    freeText: "",
    // NOT pre-selected, unlike `dewormingType` and `procedure` above, because
    // this chooser is OPTIONAL and the web's is a blank `<select>`. A default
    // "Leve" would put a judgement in the ledger that nobody made.
    severity: null,
    onsetAt: "",
  };
}

/** `""` → `null`, so an untouched optional field is "not stated" and not "". */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * A typed day → the wire's `YYYY-MM-DD`, or the text as typed when it is not a
 * day this app can read — so the SCHEMA refuses it with `*_MALFORMED` and the
 * person gets the format sentence, never a silent guess. See `date-input.ts`.
 */
function dayOrNull(value: string): string | null {
  const iso = dateInputToIso(value);
  return iso.length === 0 ? null : iso;
}

/** `""` → `null`, otherwise the number — leaving the SCHEMA to judge it. */
function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The draft as the contract's own shape, BEFORE validation.
 *
 * Deliberately not clever: it never decides a field is wrong — that is
 * `recordEventInputSchema`'s job and duplicating it here is how the app and the
 * server end up refusing different things. An unreadable weight still becomes
 * `NaN` here, because `kg` is a NUMBER on the wire and "abc" has no other
 * representation to send; what that `NaN` MEANS is settled by
 * `unreadableWeight` before the parse, for the reason written there.
 */
function draftToWire(
  kind: WritableKind,
  draft: EventDraft,
  sourceEventId: string | null,
  sameDayOverride: boolean,
  /**
   * The staged object the photo already landed in, for the ONE kind that needs
   * one. `null` while no photo has been uploaded yet — the contract then
   * refuses with `TATTOO_PHOTO_REQUIRED`, which is the same refusal the web
   * gives a form submitted with an empty file input.
   */
  stagedPath: string | null,
): unknown {
  switch (kind) {
    case "vaccination":
      return {
        kind,
        vaccineName: draft.vaccineName,
        occurredAt: dateInputToIso(draft.occurredAt),
        brand: orNull(draft.brand),
        batch: orNull(draft.batch),
        administeredBy: orNull(draft.administeredBy),
        nextDueAt: dayOrNull(draft.nextDueAt),
        notes: orNull(draft.notes),
        sameDayOverride,
      };
    case "weight":
      return {
        kind,
        kg: numberOrNull(draft.kg) ?? Number.NaN,
        occurredAt: dateInputToIso(draft.occurredAt),
        notes: orNull(draft.notes),
      };
    case "deworming":
      return {
        kind,
        product: draft.product,
        type: draft.dewormingType,
        occurredAt: dateInputToIso(draft.occurredAt),
        nextDueAt: dayOrNull(draft.nextDueAt),
        notes: orNull(draft.notes),
        sameDayOverride,
      };
    case "medication_start":
      return {
        kind,
        drugName: draft.drugName,
        dose: draft.dose,
        prescribedBy: orNull(draft.prescribedBy),
        occurredAt: dateInputToIso(draft.occurredAt),
        frequency: draft.frequency,
        customHours: draft.frequency === "custom" ? numberOrNull(draft.customHours) : null,
        durationDays: numberOrNull(draft.durationDays),
        // The two halves the form collects separately, joined into the one
        // string the contract describes. A single free-text
        // "AAAA-MM-DDTHH:mm" field would ask a person to type a `T`.
        firstDoseAt: `${dateInputToIso(draft.firstDoseDay)}T${draft.firstDoseTime.trim()}`,
        notes: orNull(draft.notes),
      };
    case "medication_end":
      return {
        kind,
        medicationStartedEventId: sourceEventId ?? "",
        occurredAt: dateInputToIso(draft.occurredAt),
        reason: orNull(draft.reason),
        notes: orNull(draft.notes),
      };
    case "microchip":
      return {
        kind,
        chipNumber: draft.chipNumber,
        occurredAt: dateInputToIso(draft.occurredAt),
        countryCode: orNull(draft.countryCode),
        implantedBy: orNull(draft.implantedBy),
        locationOnBody: orNull(draft.locationOnBody),
        notes: orNull(draft.notes),
      };
    case "microchip_replace":
      // NO `previousChipNumber`. The server reads the animal's canonical chip
      // itself; a field here would be this form asserting a fact it got from
      // the same server, and a disagreement between the two would have to be
      // adjudicated by somebody. `orNull` on the new number is what expresses a
      // pure revocation — the contract refuses it for the wrong motive.
      return {
        kind,
        reason: draft.replaceReason,
        newChipNumber: orNull(draft.newChipNumber),
        replacedBy: orNull(draft.replacedBy),
        occurredAt: dateInputToIso(draft.occurredAt),
        notes: orNull(draft.notes),
      };
    case "dangerous_breed_attestation":
      return {
        kind,
        registry: draft.registry,
        registryId: orNull(draft.registryId),
        occurredAt: dateInputToIso(draft.occurredAt),
        notes: orNull(draft.notes),
      };
    case "death":
      return {
        kind,
        // `cause` may be null here and the contract refuses it — that is the
        // point. A default would let somebody file "no la sé" without ever
        // having been asked.
        cause: draft.cause,
        causeDetail: orNull(draft.causeDetail),
        occurredAt: dateInputToIso(draft.occurredAt),
        confirmedByVet: draft.confirmedByVet === "si",
        vetName: orNull(draft.vetName),
        dispositionMethod: draft.dispositionMethod,
        facility: orNull(draft.facility),
        deathAtClinic: draft.deathAtClinic === "si",
        clinicName: orNull(draft.clinicName),
        vetContactedOwner: draft.vetContactedOwner,
        vetDecidedAlone: draft.vetDecidedAlone === "si",
        ownerToPrivateCrematorium: draft.ownerToPrivateCrematorium === "si",
        // ONLY WHEN THE CAUSE IS A DISEASE, exactly as the web action decides it
        // (`cause === "disease" && diseaseCodeRaw ? diseaseCodeRaw : null`).
        // Somebody who picks "Enfermedad", names one, then changes their mind to
        // "Accidente" must not ship the disease they abandoned.
        diseaseCode: draft.cause === "disease" ? orNull(draft.diseaseCode) : null,
        confirmedByLab: draft.confirmedByLab === "si",
        notes: orNull(draft.notes),
      };
    case "bite":
      return {
        kind,
        occurredAt: dateInputToIso(draft.occurredAt),
        // Pueden ser null y el contrato los rechaza — igual que `cause` en
        // fallecimiento. Un default aca pondria una gravedad que nadie eligio
        // adentro de la alerta que recibe una jurisdiccion.
        victimKind: draft.victimKind,
        severity: draft.biteSeverity,
        locationDescription: orNull(draft.locationDescription),
        context: orNull(draft.biteContext),
        victimContactName: orNull(draft.victimContactName),
        victimContactPhone: orNull(draft.victimContactPhone),
        victimAgeEstimate: orNull(draft.victimAgeEstimate),
        // LAS TRES O NINGUNA, y el contrato refuta cualquier subconjunto: el
        // escritor cae a la jurisdiccion del ANIMAL campo por campo, asi que una
        // provincia sin localidad rutearia el caso a (provincia nueva, localidad
        // de la mascota) — un par que no nombra ningun lugar real.
        provinceCode: orNull(draft.biteProvinceCode),
        localityName: orNull(draft.biteLocalityName),
        localityIndecId: orNull(draft.biteLocalityIndecId),
        notes: orNull(draft.notes),
      };
    case "tattoo":
      return {
        kind,
        // BLANCO ES "NO SE LA FECHA" y el contrato lo normaliza a null: el
        // escritor asienta `tattoo_date_known: false` en vez de inventar un dia.
        occurredAt: dateInputToIso(draft.occurredAt),
        tattooCode: draft.tattooCode,
        // PUEDE SER NULL y el contrato lo acepta; lo que el contrato NO acepta
        // es un lugar que no esta en la lista. La web coerce un valor
        // desconocido a null sin decir nada porque lee un <select> que ella
        // misma dibujo — un cliente JSON no es un <select>.
        locationOnBody: draft.tattooLocation,
        description: orNull(draft.tattooDescription),
        recordedBy: orNull(draft.tattooRecordedBy),
        stagedPath,
      };
    case "pregnancy_start":
      return {
        kind,
        occurredAt: dateInputToIso(draft.occurredAt),
        weeksAtDiagnosis: numberOrNull(draft.weeksAtDiagnosis),
        vetConsulted: orNull(draft.vetName),
        notes: orNull(draft.notes),
      };
    case "pregnancy_end":
      return {
        kind,
        occurredAt: dateInputToIso(draft.occurredAt),
        // May be null here and the contract refuses it — the same shape as
        // `cause` on the death form, for the same reason.
        outcome: draft.outcome,
        // ONLY UNDER "parto exitoso", exactly as the web action reads it
        // (pregnancy.ts:106-113). Somebody who typed 4 crías and then changed
        // the outcome to "pérdida" must not ship the number they abandoned —
        // and the contract refuses that combination outright, so shipping it
        // would turn a changed mind into a 400.
        liveBirthsCount:
          draft.outcome === "live_birth" ? numberOrNull(draft.liveBirthsCount) : null,
        vetConsulted: orNull(draft.vetName),
        notes: orNull(draft.notes),
      };
    case "sterilization":
      return {
        kind,
        procedure: draft.procedure,
        occurredAt: dateInputToIso(draft.occurredAt),
        performedBy: orNull(draft.performedBy),
        clinic: orNull(draft.clinic),
        notes: orNull(draft.notes),
      };
    case "vet_visit":
      return {
        kind,
        reason: draft.visitReason,
        occurredAt: dateInputToIso(draft.occurredAt),
        diagnosis: orNull(draft.diagnosis),
        vetName: orNull(draft.vetName),
        clinic: orNull(draft.clinic),
        notes: orNull(draft.notes),
      };
    case "clinical_info":
      return {
        kind,
        subKind: draft.clinicalSubKind,
        title: draft.title,
        occurredAt: dateInputToIso(draft.occurredAt),
        details: orNull(draft.details),
        performedBy: orNull(draft.performedBy),
        notes: orNull(draft.notes),
      };
    case "note":
      return {
        kind,
        text: draft.text,
        occurredAt: dateInputToIso(draft.occurredAt),
        category: draft.category,
      };
    case "symptom":
      // NO `occurredAt`. The contract's síntoma variant does not have one, and
      // sending the draft's pre-filled today would be this form answering a
      // question the person was never asked.
      return {
        kind,
        freeText: draft.freeText,
        severity: draft.severity,
        onsetAt: dayOrNull(draft.onsetAt),
      };
    case "post_adoption_checkin":
      // The smallest body on the endpoint: the text, or nothing. No date (the
      // server stamps the moment of reporting, as the web action does), no
      // refugio (read off the adoption), no photo (no module for one yet).
      return { kind, notes: orNull(draft.notes) };
  }
}

export type DraftResult =
  | { ok: true; input: RecordEventInput }
  | { ok: false; message: string; code: RecordEventInputCode | null };

/**
 * Is the weight field filled in with something that is not a number?
 *
 * THE ONE REFUSAL THE SCHEMA CANNOT WORD, and it took reading zod's own type
 * check to see why. `kg` is a NUMBER on the wire, so "abc" has no representation
 * to send and `draftToWire` sends `NaN` — and `z.number()` rejects `NaN` as an
 * INVALID TYPE, which is the very same issue a MISSING number raises. Both come
 * back `WEIGHT_REQUIRED`, so the person read "Falta el peso." underneath a field
 * with "abc" sitting visibly in it. The `WEIGHT_INVALID` refine below it never
 * runs, because a value that failed the type check never reaches a refinement.
 *
 * This is NOT the re-stated rule the file header warns about. The ceiling is
 * still `MAX_WEIGHT_KG` in the contract and the positivity is still the schema's
 * refine; what is decided here is whether the text is a number AT ALL — a fact
 * about the TEXT, which only the layer holding the text has. It answers with the
 * contract's own `WEIGHT_INVALID`, so there is still one vocabulary and one
 * message table.
 */
function unreadableWeight(kind: WritableKind, draft: EventDraft): boolean {
  if (kind !== "weight") return false;
  const trimmed = draft.kg.trim();
  return trimmed.length > 0 && numberOrNull(trimmed) === null;
}

/**
 * Validate a draft against the SERVER'S schema and hand back either the body to
 * send or the one sentence to show.
 *
 * One message, not a per-field map, because these forms are short enough that a
 * single line under the CTA is read and a scattered set is not — and because
 * `firstRecordEventInputCode` returns the issues in the schema's own declared
 * order, so the sentence names the first thing to fix rather than a random one.
 */
export function validateDraft(
  kind: WritableKind,
  draft: EventDraft,
  options: {
    sourceEventId?: string | null;
    sameDayOverride?: boolean;
    /** The staged photo, for `tattoo`. Ignored by every other kind. */
    stagedPath?: string | null;
  } = {},
): DraftResult {
  if (unreadableWeight(kind, draft)) {
    return { ok: false, code: "WEIGHT_INVALID", message: inputCodeMessage("WEIGHT_INVALID") };
  }

  const wire = draftToWire(
    kind,
    draft,
    options.sourceEventId ?? null,
    options.sameDayOverride ?? false,
    options.stagedPath ?? null,
  );
  const parsed = recordEventInputSchema.safeParse(wire);
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstRecordEventInputCode(parsed.error);
  return { ok: false, code, message: inputCodeMessage(code) };
}

/**
 * es-AR copy for every input code. Exhaustive: a code added to the contract is
 * a COMPILE error here, the same guarantee `apiErrorMessage` gives for the
 * failure vocabulary.
 */
export function inputCodeMessage(code: RecordEventInputCode | null): string {
  if (code === null) {
    // The parse failed on something the contract does not name — a client and a
    // contract out of step. Honest about being unable to say more.
    return "Revisá los datos: hay un campo que la app no pudo interpretar.";
  }
  switch (code) {
    case "KIND_REQUIRED":
      return "Esta versión de la app no puede registrar este tipo de asiento. Actualizá la app.";
    case "OCCURRED_AT_REQUIRED":
      return "Falta la fecha.";
    // TWO SENTENCES FOR TWO FACTS (forms-F2). One code used to cover both and
    // a person who typed the date in the wrong shape read that the day did
    // not exist.
    case "OCCURRED_AT_MALFORMED":
      return "Escribí la fecha como DD/MM/AAAA.";
    case "OCCURRED_AT_INVALID":
      return "Esa fecha no existe. Revisá el día y el mes.";
    case "VACCINE_NAME_REQUIRED":
      return "Falta el nombre de la vacuna.";
    case "NEXT_DUE_AT_MALFORMED":
      return "Escribí la fecha de la próxima dosis como DD/MM/AAAA.";
    case "NEXT_DUE_AT_INVALID":
      return "La fecha de la próxima dosis no existe. Revisá el día y el mes.";
    case "WEIGHT_REQUIRED":
      return "Falta el peso.";
    case "WEIGHT_INVALID":
      return "El peso tiene que ser un número mayor que cero.";
    case "WEIGHT_TOO_HIGH":
      return `El peso no puede superar los ${MAX_WEIGHT_KG} kg.`;
    case "PRODUCT_REQUIRED":
      return "Falta el nombre del producto.";
    case "DEWORMING_TYPE_INVALID":
      return "Elegí si el antiparasitario es interno, externo o ambos.";
    case "DRUG_NAME_REQUIRED":
      return "Falta el nombre del medicamento.";
    case "DOSE_REQUIRED":
      return "Falta la dosis.";
    case "FREQUENCY_INVALID":
      return "Elegí cada cuánto se da el medicamento.";
    case "CUSTOM_HOURS_INVALID":
      return `El intervalo tiene que estar entre 1 y ${MAX_CUSTOM_HOURS} horas.`;
    case "DURATION_DAYS_INVALID":
      return `La duración tiene que estar entre 1 y ${MAX_DURATION_DAYS} días.`;
    case "FIRST_DOSE_AT_REQUIRED":
      return "Falta la fecha y la hora de la primera dosis.";
    case "FIRST_DOSE_AT_MALFORMED":
      return "Escribí el día de la primera dosis como DD/MM/AAAA y la hora como HH:MM.";
    case "FIRST_DOSE_AT_INVALID":
      return "El día o la hora de la primera dosis no existen. Revisá los dos.";
    case "MEDICATION_SOURCE_REQUIRED":
      // Reachable only if the app opened this form without the asiento it ends.
      return "No pudimos identificar la medicación que estás terminando. Abrila desde su asiento.";
    case "TEXT_REQUIRED":
      return "Falta el contenido de la nota.";
    case "NOTE_CATEGORY_INVALID":
      return "Esa categoría no existe. Elegí una de la lista.";
    case "CHIP_NUMBER_REQUIRED":
      return "Falta el número de microchip.";
    case "STERILIZATION_PROCEDURE_INVALID":
      return "Elegí si fue una castración o una ovariectomía.";
    case "VISIT_REASON_REQUIRED":
      return "Falta el motivo de la visita.";
    case "CLINICAL_SUB_KIND_INVALID":
      // Reachable from a build out of step with the contract, not from the
      // chips: the picker only ever offers the five the contract accepts.
      return "Ese tipo de información clínica no existe. Elegí uno de la lista.";
    case "CLINICAL_TITLE_REQUIRED":
      return "Falta el nombre del estudio o procedimiento.";
    case "SYMPTOM_TEXT_REQUIRED":
      return "Contá qué le viste.";
    case "SYMPTOM_SEVERITY_INVALID":
      // Reachable from a build out of step with the contract, not from the
      // chips: the chooser only ever offers the three the contract accepts.
      return "Esa gravedad no existe. Elegí una de la lista.";
    case "ONSET_AT_MALFORMED":
      return "Escribí la fecha de inicio como DD/MM/AAAA.";
    case "ONSET_AT_INVALID":
      return "La fecha de inicio no existe. Revisá el día y el mes.";
    case "MICROCHIP_REPLACE_REASON_INVALID":
      return "Elegí un motivo de la lista.";
    // NAMES THE WAY OUT, not just the refusal. The rule is a cross-field one —
    // "sin chip nuevo" is only valid for two of the five motives — and a
    // sentence that said "falta el número" would send the person to type one
    // when what they may have wanted was the other motive.
    case "MICROCHIP_REPLACE_NEW_CHIP_REQUIRED":
      return "Con ese motivo hace falta el número del chip nuevo. Para dejar a tu mascota sin chip, elegí «Solicitud del dueño» o «Falla del dispositivo».";
    case "PPP_REGISTRY_REQUIRED":
      return "Elegí el registro donde hiciste la atestación.";
    case "DEATH_CAUSE_INVALID":
      return "Elegí la causa del fallecimiento.";
    case "DEATH_DISPOSITION_INVALID":
      return "Esa opción de destino del cuerpo no es válida.";
    case "DEATH_VET_CONTACT_INVALID":
      return "Esa respuesta sobre el contacto del veterinario no es válida.";
    case "DEATH_CLINIC_REQUIRES_AT_CLINIC":
      return "Pusiste el nombre de una clínica pero no marcaste que falleció en una veterinaria.";
    case "DEATH_VET_CONTACT_REQUIRES_AT_CLINIC":
      return "El contacto del veterinario sólo aplica si falleció en una veterinaria.";
    case "DEATH_VET_DECIDED_REQUIRES_NO_CONTACT":
      return "Solo podés marcar que el veterinario decidió sin consultarte si no logró contactarte.";
    case "DEATH_DISEASE_CODE_REQUIRED":
      return "Elegí de qué enfermedad murió.";
    case "DEATH_DISEASE_CODE_UNKNOWN":
      return "No reconocemos esa enfermedad. Elegila de la lista.";
    case "PREGNANCY_WEEKS_INVALID":
      // NAMES THE CEILING, because the field cannot: a person who typed 14 has
      // no way to guess that 12 is the limit or why. It is not species-aware
      // and the sentence does not pretend it is — the server clamps, and the
      // real fix is a bound this form does not have yet.
      return "Las semanas al diagnóstico van de 0 a 12.";
    case "PREGNANCY_OUTCOME_INVALID":
      return "Elegí cómo terminó la gestación.";
    case "PREGNANCY_BIRTHS_INVALID":
      return "La cantidad de crías va de 1 a 20.";
    case "PREGNANCY_BIRTHS_REQUIRED":
      return "Indicá cuántas crías nacieron con vida.";
    case "TATTOO_CODE_REQUIRED":
      return "Falta el código del tatuaje.";
    case "TATTOO_LOCATION_INVALID":
      return "Elegí dónde está el tatuaje.";
    case "TATTOO_PHOTO_REQUIRED":
      // NOMBRA EL PASO QUE FALTA, no el campo del cuerpo. La persona nunca
      // escribe un `stagedPath`: lo produce la subida. Si este codigo llega, lo
      // que no paso es la foto.
      return "Falta la foto del tatuaje. Elegí una imagen antes de registrarlo.";
    case "BITE_VICTIM_KIND_INVALID":
      return "Elegí a quién mordió.";
    case "BITE_SEVERITY_INVALID":
      return "Elegí qué tan grave fue.";
    case "BITE_JURISDICTION_INCOMPLETE":
      // NOMBRA EL ARREGLO Y NO EL ERROR. La persona no eligio mandar media
      // ubicacion — el selector devuelve las tres juntas — asi que este codigo
      // solo puede llegar por un borrador a medio armar. La salida es volver a
      // elegir la localidad, o borrarla y dejar que cuente donde vive el animal.
      return "Elegí la localidad de nuevo, o dejala vacía para que cuente donde vive tu mascota.";
    case "PREGNANCY_BIRTHS_REQUIRES_LIVE_BIRTH":
      // UNREACHABLE FROM THIS FORM — `draftToWire` drops the count under any
      // other outcome, precisely so a changed mind never becomes a 400. The
      // sentence exists because the code does, and because the day that guard
      // is edited away this is what the person would read.
      return "La cantidad de crías solo va cuando nacieron con vida.";
  }
}

/**
 * Which draft fields a refusal is ABOUT, so the screen can draw the red border
 * on them (forms-F3: the kit's `invalid` prop existed and four sites used it).
 *
 * A SET, because one code can name two boxes: the first dose is a day and an
 * hour collected in two fields and refused as one string. Empty for the codes
 * that are not about a field a person can see — a kind this build does not
 * know, or a medication end opened without its asiento. Exhaustive over the
 * contract, like `inputCodeMessage`: a new code without a row here is a compile
 * error, not a refusal with no red box.
 */
export function invalidFields(code: RecordEventInputCode | null): ReadonlySet<keyof EventDraft> {
  if (code === null) return new Set();
  const fields = ((): ReadonlyArray<keyof EventDraft> => {
    switch (code) {
      case "KIND_REQUIRED":
      case "MEDICATION_SOURCE_REQUIRED":
        return [];
      case "OCCURRED_AT_REQUIRED":
      case "OCCURRED_AT_MALFORMED":
      case "OCCURRED_AT_INVALID":
        return ["occurredAt"];
      case "VACCINE_NAME_REQUIRED":
        return ["vaccineName"];
      case "NEXT_DUE_AT_MALFORMED":
      case "NEXT_DUE_AT_INVALID":
        return ["nextDueAt"];
      case "WEIGHT_REQUIRED":
      case "WEIGHT_INVALID":
      case "WEIGHT_TOO_HIGH":
        return ["kg"];
      case "PRODUCT_REQUIRED":
        return ["product"];
      case "DEWORMING_TYPE_INVALID":
        return ["dewormingType"];
      case "DRUG_NAME_REQUIRED":
        return ["drugName"];
      case "DOSE_REQUIRED":
        return ["dose"];
      case "FREQUENCY_INVALID":
        return ["frequency"];
      case "CUSTOM_HOURS_INVALID":
        return ["customHours"];
      case "DURATION_DAYS_INVALID":
        return ["durationDays"];
      case "FIRST_DOSE_AT_REQUIRED":
      case "FIRST_DOSE_AT_MALFORMED":
      case "FIRST_DOSE_AT_INVALID":
        return ["firstDoseDay", "firstDoseTime"];
      case "TEXT_REQUIRED":
        return ["text"];
      case "NOTE_CATEGORY_INVALID":
        return ["category"];
      case "CHIP_NUMBER_REQUIRED":
        return ["chipNumber"];
      case "STERILIZATION_PROCEDURE_INVALID":
        return ["procedure"];
      case "VISIT_REASON_REQUIRED":
        return ["visitReason"];
      case "CLINICAL_SUB_KIND_INVALID":
        return ["clinicalSubKind"];
      case "CLINICAL_TITLE_REQUIRED":
        return ["title"];
      case "SYMPTOM_TEXT_REQUIRED":
        return ["freeText"];
      case "SYMPTOM_SEVERITY_INVALID":
        return ["severity"];
      case "ONSET_AT_MALFORMED":
      case "ONSET_AT_INVALID":
        return ["onsetAt"];
      case "MICROCHIP_REPLACE_REASON_INVALID":
        return ["replaceReason"];
      case "MICROCHIP_REPLACE_NEW_CHIP_REQUIRED":
        return ["newChipNumber"];
      case "PPP_REGISTRY_REQUIRED":
        return ["registry"];
      case "DEATH_CAUSE_INVALID":
        return ["cause"];
      case "DEATH_DISPOSITION_INVALID":
        return ["dispositionMethod"];
      case "DEATH_VET_CONTACT_INVALID":
      case "DEATH_VET_CONTACT_REQUIRES_AT_CLINIC":
        return ["vetContactedOwner"];
      case "DEATH_CLINIC_REQUIRES_AT_CLINIC":
        return ["clinicName"];
      case "DEATH_VET_DECIDED_REQUIRES_NO_CONTACT":
        return ["vetDecidedAlone"];
      case "DEATH_DISEASE_CODE_REQUIRED":
      case "DEATH_DISEASE_CODE_UNKNOWN":
        return ["diseaseCode"];
      case "PREGNANCY_WEEKS_INVALID":
        return ["weeksAtDiagnosis"];
      case "PREGNANCY_OUTCOME_INVALID":
        return ["outcome"];
      case "PREGNANCY_BIRTHS_INVALID":
      case "PREGNANCY_BIRTHS_REQUIRED":
      case "PREGNANCY_BIRTHS_REQUIRES_LIVE_BIRTH":
        return ["liveBirthsCount"];
      case "TATTOO_CODE_REQUIRED":
        return ["tattooCode"];
      case "TATTOO_LOCATION_INVALID":
        return ["tattooLocation"];
      case "TATTOO_PHOTO_REQUIRED":
        // NINGUN CAMPO DEL BORRADOR. La foto no vive en el borrador — vive en
        // el estado de la pantalla — asi que no hay recuadro que poner en rojo,
        // y devolver uno cualquiera dejaria marcado un campo que esta bien.
        return [];
      case "BITE_VICTIM_KIND_INVALID":
        return ["victimKind"];
      case "BITE_SEVERITY_INVALID":
        return ["biteSeverity"];
      case "BITE_JURISDICTION_INCOMPLETE":
        return ["biteLocalityName"];
    }
  })();
  return new Set(fields);
}

/** The sentence shown after a successful append. */
export const RECORD_DONE_LABEL = "Asiento registrado.";

/**
 * The sentence for a REPLAY.
 *
 * Said out loud rather than folded into the success copy, because the two are
 * different facts and the second one explains something the owner can otherwise
 * only find confusing: they pressed Guardar again and the libreta did not grow.
 */
export const RECORD_DUPLICATE_LABEL =
  "Este asiento ya estaba registrado — no se duplicó. Abrí la libreta para verlo.";

/** The prompt for the same-day soft gate. */
export const SAME_DAY_PROMPT_LABEL =
  "Ya hay un registro igual para esta mascota en esta fecha. ¿Querés registrar otro?";

/**
 * The note the immutability of the ledger deserves, shown on every form.
 *
 * The web says the same thing on its own forms, and it is not decoration: a
 * person about to write into an append-only registry should know that before
 * they press the button, not after they want it back.
 */
export const RECORD_IMMUTABILITY_NOTE =
  "Los asientos no se editan ni se borran. Si te equivocás, se corrige agregando una corrección encima.";

/**
 * The heading over a draft this phone had kept.
 *
 * A RESTORE IS ANNOUNCED AND NOT SILENT, and on this screen that is not a
 * nicety. Silent recovery has one failure mode and it is the serious one:
 * somebody opens the form, does not read text they do not remember writing,
 * and presses the button — and what they appended to a national registry is a
 * sentence from a week ago about a different day. The same reasoning
 * `credential-cache.ts` applies to a cached credential, which is ALWAYS drawn
 * with its age rather than passed off as fresh.
 *
 * IT IS A CALLOUT AND NOT AN ALERT, though. This screen is opened in a crisis —
 * a symptom, a bite — and a modal between a frightened person and the form is a
 * cost paid on every recovery to solve a confusion that happens on some of
 * them. The banner is unmissable, says when, offers the way out, and does not
 * stand in the way.
 */
export const RESTORED_DRAFT_TITLE = "Recuperamos lo que estabas escribiendo";

/** Time of day in Argentine time, `HH:MM`. Same fixed offset as `todayInAr`. */
function timeInAr(at: Date): string {
  return new Date(at.getTime() - AR_UTC_OFFSET_MS).toISOString().slice(11, 16);
}

/**
 * When the recovered draft was written, in words somebody can place.
 *
 * "HOY A LAS 14:30" AND NOT A DATE, for anything inside the last two days.
 * Most recoveries are minutes or hours old — the call that came in, the app the
 * OS reclaimed while the person answered the door — and telling that person the
 * calendar date of today reads as if the app had dug up something ancient. The
 * bare date is right for the older ones, where the day is the fact that matters
 * and the hour is noise.
 *
 * ARGENTINE TIME ON BOTH SIDES, computed the way `todayInAr` computes it and
 * for the same reason: a phone that travelled would otherwise be told "ayer"
 * about something written this morning.
 */
export function restoredDraftNote(savedAt: number, now: Date = new Date()): string {
  const at = new Date(savedAt);
  const day = todayInAr(at);
  const today = todayInAr(now);
  const yesterday = todayInAr(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const when =
    day === today
      ? `hoy a las ${timeInAr(at)}`
      : day === yesterday
        ? `ayer a las ${timeInAr(at)}`
        : `el ${isoToDateInput(day)}`;
  // NAMES THE ONE FACT THAT MATTERS BEFORE ANYTHING ELSE: nothing was
  // registered. A person who was interrupted mid-form is being told both halves
  // at once — we kept your writing, AND the asiento still does not exist — and
  // the second half is the one that stops a draft from reading like a receipt.
  return `Lo escribiste ${when} y quedó guardado en este teléfono. Todavía no se registró nada: revisalo antes de confirmar.`;
}

// ---------------------------------------------------------------------------
// Atestación PPP — the registries a person may choose from
// ---------------------------------------------------------------------------

/**
 * The option set for the attestation's "Registro" field.
 *
 * ONE FUNCTION BECAUSE THE FORM NEEDS THE SAME ANSWER TWICE, and the first
 * version computed it once — inline in the render — which is what let a defect
 * in. The jurisdiction's list arrives from a background read AFTER the form is
 * already on screen, and a registry the person had already picked from the
 * fallback stayed in the draft while disappearing from the chips: no highlight
 * above the fold, a draft that still held `caba_4078`, and a server that
 * answered `PPP_REGISTRY_NOT_ALLOWED` on submit. The reconciliation needs to
 * ask "is this id still on offer", and it must ask the SAME question the chips
 * answer, not a second copy of it.
 *
 * `resolved` empty means the jurisdiction named none — the FALLBACK case, and
 * a fact rather than a failure: `ppp_attestation_required_registries` defaults
 * to an empty list everywhere, so this is the common path, and the national
 * pair is exactly what `buildRegistryOptions` offers on the web.
 *
 * "Otro registro" is appended unconditionally, as the web appends it
 * (DangerousBreedAttestationForm.tsx:56) and the server accepts it
 * (`allowedAttestationRegistries`). A jurisdiction naming two registries must
 * not take away the answer of an owner registered in a third province.
 */
export function attestationRegistryOptions(
  resolved: readonly { id: string; label: string; required: boolean }[],
): { id: string; label: string; required: boolean }[] {
  const other = {
    id: "other",
    label: dangerousBreedRegistryLabel("other"),
    required: false,
  };
  if (resolved.length === 0) {
    return DANGEROUS_BREED_REGISTRIES.map((id) => ({
      id,
      label: dangerousBreedRegistryLabel(id),
      required: false,
    }));
  }
  return resolved.some((r) => r.id === "other") ? [...resolved] : [...resolved, other];
}

// ---------------------------------------------------------------------------
// Fallecimiento — las etiquetas
// ---------------------------------------------------------------------------

/** es-AR label for a cause of death. The nine the web offers, in its own words. */
export function deathCauseLabel(cause: DeathCause): string {
  switch (cause) {
    case "known":
      return "La conozco";
    case "unknown":
      return "No la sé";
    case "natural":
      return "Natural / vejez";
    case "disease":
      return "Enfermedad";
    case "accident":
      return "Accidente";
    case "euthanasia":
      return "Eutanasia";
    case "sudden":
      return "Muerte súbita";
    case "violent":
      return "Violenta";
    case "other":
      return "Otra";
  }
}

/** es-AR label for what was done with the body. */
export function dispositionMethodLabel(method: DispositionMethod): string {
  switch (method) {
    case "cremation_collective":
      return "Cremación colectiva";
    case "cremation_individual_ashes":
      return "Cremación individual (con cenizas)";
    case "authorized_cemetery":
      return "Cementerio habilitado";
    case "owner_burial":
      return "Entierro propio";
    case "household_waste":
      return "Residuos domiciliarios";
    case "rendering":
      return "Recolección sanitaria";
    case "unknown":
      return "No sé";
  }
}

/** es-AR label for whether the vet reached the owner. */
export function vetContactLabel(value: VetContactValue): string {
  switch (value) {
    case "yes":
      return "Sí, me contactó";
    case "no":
      return "No me contactó";
    case "not_applicable":
      return "No aplica";
  }
}

/** es-AR label for a yes/no answer. */
/**
 * How a pregnancy ended, in the words the person would use.
 *
 * NOT THE CLINICAL WORDS. The wire says `stillbirth` and `miscarriage`; a
 * libreta read by somebody who lost a litter says "nacieron sin vida" and
 * "se perdió el embarazo". "Interrupción" is the one that stays close to the
 * clinical term, because a euphemism there would read as judgement.
 *
 * `unknown` IS LAST AND IS NOT "otro". A person who was not there — the common
 * case for an animal that was in tránsito — still has to close the follow-up,
 * and "no lo sé" is the answer that keeps them from inventing one.
 */
export function pregnancyOutcomeLabel(outcome: PregnancyOutcome): string {
  switch (outcome) {
    case "live_birth":
      return "Nacieron con vida";
    case "stillbirth":
      return "Nacieron sin vida";
    case "miscarriage":
      return "Se perdió el embarazo";
    case "termination":
      return "Interrupción";
    case "unknown":
      return "No lo sé";
  }
}

/** The five outcomes, as the chip row draws them. */
export const PREGNANCY_OUTCOME_OPTIONS: readonly PregnancyOutcome[] = PREGNANCY_OUTCOMES;

/**
 * A quien mordio, en las palabras de quien reporta.
 *
 * "No lo sé" no es un relleno: quien llega despues del hecho no puede elegir
 * entre persona y animal, y forzarlo pondria una suposicion adentro de lo que
 * una jurisdiccion despues actua.
 */
export function biteVictimKindLabel(kind: BiteVictimKind): string {
  switch (kind) {
    case "human":
      return "Una persona";
    case "animal":
      return "Otro animal";
    case "unknown":
      return "No lo sé";
  }
}

/**
 * Cuan grave.
 *
 * DESCRIBE LA LESION Y NO LA CULPA. "Leve / moderada / grave" a secas invita a
 * minimizar; nombrar lo que se ve —si hubo que coser, si hubo que ir a una
 * guardia— le da a la persona una vara que no depende de como se sienta con su
 * propio animal. La gravedad viaja al caso y a la alerta.
 */
export function biteSeverityLabel(severity: BiteSeverity): string {
  switch (severity) {
    case "minor":
      return "Leve · no necesitó atención";
    case "moderate":
      return "Moderada · la vio un profesional";
    case "severe":
      return "Grave · guardia o internación";
  }
}

/** Los tres valores de cada fila de chips, como el formulario los dibuja. */
/**
 * Donde esta el tatuaje, en las palabras de quien mira al animal.
 *
 * "Oreja izquierda" Y NO "pabellon auricular izquierdo": la persona que carga
 * esto es la que vive con el animal, no la veterinaria que lo tatuo. Las dos
 * orejas se nombran por separado porque en la credencial la diferencia es lo
 * que hace que alguien encuentre la marca.
 */
export function tattooLocationLabel(location: TattooLocation): string {
  switch (location) {
    case "inner_ear_left":
      return "Oreja izquierda, por dentro";
    case "inner_ear_right":
      return "Oreja derecha, por dentro";
    case "inner_thigh":
      return "Ingle o cara interna del muslo";
    case "belly":
      return "Panza";
    case "other":
      return "Otro lugar";
  }
}

/** Los cinco lugares, como la fila de chips los dibuja. */
export const TATTOO_LOCATION_OPTIONS: readonly TattooLocation[] = TATTOO_LOCATIONS;

export const BITE_VICTIM_KIND_OPTIONS: readonly BiteVictimKind[] = BITE_VICTIM_KINDS;
export const BITE_SEVERITY_OPTIONS: readonly BiteSeverity[] = BITE_SEVERITIES;

export function yesNoLabel(value: YesNo): string {
  return value === "si" ? "Sí" : "No";
}

/**
 * The diseases this animal's species can be recorded as having died of.
 *
 * READS THE CONTRACT'S OWN CATALOG, which is why the picker can exist at all:
 * `DEATH_DISEASE_CODE_UNKNOWN` is checked on the wire against this same list,
 * so a code this function offers is a code the server accepts. It moved into
 * `@dim/contract/reference` with this kind (2026-09-08) for exactly that.
 *
 * `species` null or unknown returns the full catalog — the same widening the
 * server's `diseasesForSpecies` applies, and for the same reason: with no
 * species to filter by, hiding options would be inventing a constraint.
 */
export function deathDiseaseOptions(species: string | null): { id: string; label: string }[] {
  return diseasesForSpecies(species).map((d) => ({ id: d.code, label: d.label }));
}

/** The es-AR label of a disease code, or the code when the catalog does not know it. */
export function diseaseLabel(code: string): string {
  return findDisease(code)?.label ?? code;
}
