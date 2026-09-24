// One asiento's detail, turned into es-AR sentences — and the diff its
// correction form submits.
//
// PURE. Same discipline as its siblings: every rule below is a product decision,
// and the correction diff in particular is the kind of logic that must be
// checkable without mounting a form.

import type {
  EventAmendmentV1,
  EventAttachmentV1,
  EventFactV1,
  PetEventDetailV1,
} from "@dim/contract/api";
import {
  AMEND_REASON_MIN_LENGTH,
  type AmendEventInput,
  type AmendEventInputCode,
  amendEventInputSchema,
  firstAmendEventInputCode,
} from "@dim/contract/input";

import { AR_TIME_ZONE, formatArDate } from "./libreta-view-model";
import { type SectionView, sectionView } from "./owner-face-view-model";

export type EventDetailView = {
  eventId: string;
  /**
   * The spine's own `event_type`, unworded.
   *
   * `kind` beside it is COMPOSED es-AR for a human; this is the machine name,
   * and the two are not interchangeable. It crosses because one affordance
   * needs it: "Terminar medicación" may only be offered on a
   * `medication_started` asiento, and matching on a display string would break
   * the day somebody rewords one.
   */
  eventType: string;
  kind: string;
  title: string;
  subtitle: string | null;
  occurredAt: string;
  recordedAt: string;
  notes: string | null;
  location: { lat: number; lng: number } | null;
  authorLine: string;
  facts: EventFactV1[];
  amendments: SectionView<{ items: EventAmendmentV1[] }>;
  attachments: SectionView<{ items: EventAttachmentV1[] }>;
  canAmend: boolean;
  amendRefusal: string | null;
};

export function buildEventDetailView(payload: PetEventDetailV1): EventDetailView {
  return {
    eventId: payload.eventId,
    eventType: payload.eventType,
    kind: payload.kind,
    title: payload.title,
    subtitle: payload.subtitle,
    occurredAt: payload.occurredAt,
    recordedAt: payload.recordedAt,
    notes: payload.notes,
    location: payload.location,
    authorLine: authorLine(payload.author),
    facts: payload.facts,
    amendments: sectionView(payload.amendments),
    attachments: sectionView(payload.attachments),
    canAmend: payload.amend.canAmend,
    amendRefusal: payload.amend.refusal,
  };
}

/**
 * May this asiento offer "Terminar medicación"?
 *
 * ONLY A TYPE CHECK, not a permission one — deliberately. Whether this person
 * may write the end is the SERVER's answer (`event_forbidden` on the org path
 * without `event.write`, `event_not_allowed` on a deceased animal), and the
 * form renders that refusal in the person's words. The same posture the
 * libreta's own "Asentar" button takes: the client offers what the screen is
 * ABOUT, the door decides who gets through it.
 *
 * `medication_stopped` is deliberately not amendable in this product, and this
 * is the affordance that makes that survivable: a treatment that ended by
 * mistake is ended again, or corrected upstream — never by editing a row.
 */
export function canEndMedication(view: EventDetailView): boolean {
  return view.eventType === "medication_started";
}

/**
 * May this asiento offer "Reemplazar el microchip"?
 *
 * THE KIND HAD A FORM AND NO DOOR. `microchip_replace` is in `WRITABLE_KINDS`
 * with a complete, tested form, and until 2026-09-11 nothing in this app
 * navigated to it. `WRITABLE_KINDS`' own docblock names the home it was always
 * meant to have, verbatim:
 *
 *   · `microchip_replace` — from the microchip the animal already has. There is
 *     nothing to replace otherwise, and the server refuses with 409.
 *
 * SO WHERE DOES THIS APP SHOW THE MICROCHIP THE ANIMAL ALREADY HAS? Exactly
 * one place, and it is this screen. The owner face's compliance card renders
 * `card.state` and NOT `card.detail` (`OwnerFace.tsx`, `ComplianceCardRow`), so
 * the chip NUMBER the web prints as that card's pill never reaches the native
 * card; the public credential deliberately prints "Microchip: Sí/No" and never
 * the code. The number appears in this app only as a fact on the
 * `microchip_implanted` asiento — the server labels it "Número" from
 * `chip_number` (`lib/events/events.ts`, `eventPayloadDetails`). This screen is
 * where a person is holding the chip, which is what the docblock asked for.
 *
 * IT IS THEREFORE THE SAME SHAPE AS `canEndMedication` ABOVE — an act reached
 * from the asiento that originated it, not from the picker — and for the same
 * reason: the picker would have to assert that a chip exists before offering
 * the form, and the only honest source for that is the ledger this screen is
 * already showing.
 *
 * ONLY `microchip_implanted`, AND NOT `microchip_replaced`. Three reasons, in
 * the order they decided it:
 *   1. `microchip_replaced` is the umbrella for replacement AND revocation
 *      (contract `event-types.ts` says so). A pure revocation's whole meaning
 *      is that the animal now has NO chip, so a door there would 409 BY
 *      CONSTRUCTION rather than by bad luck.
 *   2. The server emits no `facts` at all for `microchip_replaced`
 *      (`eventPayloadDetails` has no case for it; it falls through to `[]`), so
 *      that screen is not a place a person "already has" the number in hand.
 *   3. Nothing is lost. The implant asiento never leaves the libreta, and the
 *      endpoint reads the animal's CANONICAL chip itself rather than anything
 *      this screen sends — the payload deliberately carries no
 *      `previousChipNumber`. So the door still works after any number of
 *      replacements, and it always acts on the current chip.
 *
 * A TYPE CHECK AND NOT A PERMISSION ONE, the posture `canEndMedication` states
 * at length: whether THIS person may write it, and whether there is a chip left
 * to replace, are the server's answers, and the form renders the refusal in the
 * person's words.
 */
export function canReplaceMicrochip(view: EventDetailView): boolean {
  return view.eventType === "microchip_implanted";
}

/**
 * WHO signed the record, as one line.
 *
 * The role and the organization arrive already worded; this composes them and
 * marks verification. It never prints a person's name because the payload never
 * carries one — the privacy convention is enforced at the source, and this is
 * the surface that would otherwise be tempted to reconstruct it.
 */
export function authorLine(author: PetEventDetailV1["author"]): string {
  const who = author.orgDisplayName
    ? `${author.roleLabel} · ${author.orgDisplayName}`
    : author.roleLabel;
  return author.verified ? `${who} · firma verificada` : who;
}

// ---------------------------------------------------------------------------
// The correction history
// ---------------------------------------------------------------------------

/**
 * One changed field, as a sentence.
 *
 * The three shapes are genuinely different facts and must not collapse into
 * one: a value REPLACED, a value ADDED where there was none, and a value
 * CLEARED. "Lote: «L-42» → «»" reads as a typo; "Lote: se borró «L-42»" reads as
 * what happened.
 */
export function amendmentChangeLine(change: EventAmendmentV1["changes"][number]): string {
  if (change.from === null && change.to === null) return `${change.label}: sin cambios visibles`;
  if (change.from === null) return `${change.label}: se agregó «${change.to}»`;
  if (change.to === null) return `${change.label}: se borró «${change.from}»`;
  return `${change.label}: «${change.from}» → «${change.to}»`;
}

/**
 * The header of one correction in the history.
 *
 * A correction that moved nothing the libreta SHOWS still appears, and says so
 * plainly — see the contract's `EventAmendmentV1`. Hiding it would be worse than
 * being unable to name what it touched.
 */
export function amendmentHeadline(step: EventAmendmentV1): string {
  return `${formatArDate(step.occurredAt)} · ${step.actorRoleLabel}`;
}

export const AMENDMENT_NO_VISIBLE_CHANGE =
  "Esta corrección no cambió ninguno de los datos que se muestran acá.";

export const AMENDMENTS_EMPTY_LABEL = "Este registro nunca se corrigió.";

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export const ATTACHMENTS_EMPTY_LABEL = "Este registro no tiene archivos adjuntos.";

/** A file the server could not hand over. The web says exactly this. */
export const ATTACHMENT_UNAVAILABLE_LABEL = "Adjunto no disponible";

/**
 * What a non-image attachment does when tapped, said BEFORE it is tapped.
 *
 * This app has no PDF viewer. Opening the system browser is the honest handoff;
 * a tap that silently did nothing, or a viewer that showed a blank page, would
 * be worse than saying where the file is going.
 */
export const ATTACHMENT_EXTERNAL_HINT = "Se abre en el navegador";

/**
 * How long the link has left, or that it is gone.
 *
 * THE EXPIRY IS RENDERED RATHER THAN ASSUMED because the link genuinely stops
 * working: it is a short-lived capability over a private file, and a thumbnail
 * that silently 400s after fifteen minutes teaches people the app is broken.
 * Saying "actualizá" turns a dead link into a one-tap fix.
 */
export function attachmentExpiryLabel(expiresAtIso: string | null, now: Date): string {
  if (expiresAtIso === null) return ATTACHMENT_UNAVAILABLE_LABEL;
  const expires = new Date(expiresAtIso);
  if (Number.isNaN(expires.getTime())) return ATTACHMENT_UNAVAILABLE_LABEL;
  if (expires.getTime() <= now.getTime()) {
    return "El enlace venció. Actualizá para volver a verlo.";
  }
  const minutes = Math.ceil((expires.getTime() - now.getTime()) / 60_000);
  // `hour12: false` STATED, not inherited. es-AR resolves to a 12-hour clock in
  // some ICU builds and to 24 in others, so leaving it to the locale means the
  // same expiry reads "12:15" on one device and "12:15 p. m." on another —
  // measured, not theorised (this printed the second under Node's ICU). Argentina
  // reads a 24-hour clock; the format says so.
  const clock = new Intl.DateTimeFormat("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: AR_TIME_ZONE,
  }).format(expires);
  return minutes === 1
    ? `El enlace vence en 1 minuto (${clock})`
    : `El enlace vence a las ${clock}`;
}

/** True when the link is past its stated expiry and must not be requested. */
export function attachmentExpired(attachment: EventAttachmentV1, now: Date): boolean {
  if (attachment.url === null || attachment.expiresAt === null) return true;
  const expires = new Date(attachment.expiresAt);
  return Number.isNaN(expires.getTime()) || expires.getTime() <= now.getTime();
}

// ---------------------------------------------------------------------------
// The correction form
// ---------------------------------------------------------------------------

export const AMEND_NO_CHANGES_LABEL =
  "No modificaste ningún campo. Hacé al menos un cambio antes de corregir.";

export const AMEND_IMMUTABILITY_NOTE =
  "La libreta es inmutable. Esta corrección agrega un registro nuevo que reemplaza el valor mostrado. El registro original queda visible en el historial.";

export const AMEND_CONFIRM_LABEL = "Confirmar corrección";

// ---------------------------------------------------------------------------
// WHICH ROWS THIS APP MAY CORRECT — A2-alta-asentar-02
// ---------------------------------------------------------------------------
//
// THE DEFECT. `EventFactV1` is `{ field, label, value }` and `value` is the
// DISPLAY string: `eventPayloadDetails` (the server's curated projection) renders
// a date through `toLocaleDateString("es-AR")`, an enum through a label table and
// a weight through `formatWeightKg`. The correction form pre-filled that text and
// posted it back as the RAW payload value. So "Próxima dosis 12/03/2026" edited to
// 15/03/2026 wrote the STRING `"15/03/2026"` into `next_due_at` — the projection
// then drops the row and the history reads "se borró" — and edited to 12/04/2026
// it is parsed US-style as 4 December, which nothing downstream can tell from a
// date somebody meant. On a desparasitación, "interno" → "externo" writes the
// es-AR LABEL into an enum key. On a peso, "13 kg" writes `"13 kg"` where a
// parseable number-as-string lives.
//
// WHY THAT IS WORSE THAN A NORMAL BUG. The spine is APPEND-ONLY (CLAUDE.md
// invariant 2). A wrong value written here is permanent; only another correction
// can sit on top of it, and the mis-dated case is not recognisable as wrong
// afterwards. The spine's own schema is no defence either — `next_due_at` is
// `z.string().nullable()`, so `"15/03/2026"` validates.
//
// THE RULE, AND WHY IT IS SHAPED THIS WAY. A row is editable ONLY when this app
// can NAME it as one the projection renders VERBATIM **AND** whose value is FREE
// TEXT. That is an allowlist, and the direction matters more than its contents:
// everything absent from it is read-only, so an event type or a fact key that
// appears next month is SAFE by default instead of dangerous by default. The
// alternative — banning "dates and enums" — is this repo's standing failure (a
// fence that enumerates spellings misses one): the next transform will not be a
// date or an enum.
//
// VERBATIM IS NECESSARY AND NOT SUFFICIENT, and the first draft of this list got
// that wrong. `to_country` is pushed with no transform, so the phone drew a text
// box labelled "País de destino" containing `AR` — an ISO-3166 code the writer
// hardcodes, not prose. An owner "correcting" it to `Argentina` would land:
// nothing re-validates an amended payload. Then
// `refresh-pet-cache-after-amendment.ts` gates canonicalisation on
// `toCountry === "AR"`, which is now false, so `pets.jurisdictionCountry` becomes
// "Argentina", `pets.localityId` becomes null, and province and locality stop
// being canonical. `origin_country` is the same shape (`z.string().length(2)`,
// rendered raw as `ES`). A code rendered verbatim is still a code.
//
// THE SECOND CUT IS IDENTITY. `to_province` and `to_locality` ARE free text and
// ARE pass-through, and they are still refused: the destination of a jurisdiction
// move is identified by `to_locality_id` (a catalogue row), and a box that edits
// only the NAME leaves the id pointing at the original row — an event that
// contradicts itself on the identity its own schema refinement calls
// authoritative. Correcting where an animal lives is a MOVE, not a text edit.
//
// IT IS A CACHE OF A SERVER FACT, AND IT SAYS SO. Only `lib/events/events.ts`
// decides what is rendered verbatim, and a phone cannot see it. So this list is
// declared a cache with a drift detector, exactly as CLAUDE.md invariant 3
// requires: `__tests__/mobile-amend-passthrough-fence.test.ts` reads that switch
// and fails the moment an entry here stops being a bare two-argument `push`.
// Without the fence this would be a second copy of the whitelist, which is how
// two doors onto one spine stop agreeing.
//
// SCOPE. Only the nine types in `AMENDABLE_EVENT_TYPES` can reach a correction
// form at all, and two of them (`medication_started`, `clinical_info_logged`)
// render no curated rows, so they are absent here rather than empty.
const PASS_THROUGH_FACTS: Readonly<Record<string, readonly string[]>> = {
  vaccination_administered: ["vaccine_name", "brand", "batch", "administered_by"],
  deworming_administered: ["product"],
  sterilization_performed: ["performed_by", "clinic"],
  vet_visit_logged: ["reason", "vet_name", "clinic", "diagnosis"],
  note_added: ["text"],
  movement_recorded: ["reason", "cvi_number", "issuing_authority", "purpose"],
};

/**
 * WHICH OF THOSE ROWS MAY NOT BE EMPTIED.
 *
 * THE ALLOWLIST ABOVE GOVERNS WHICH ROWS, NEVER WHICH VALUES — and an emptied box
 * is a value. `buildAmendChanges` sends `null` for one, because clearing a field
 * and blanking it are different facts; but six of the keys it may touch are
 * `z.string()` in the spine, not `z.string().nullable()`. Nothing re-validates an
 * amended payload, so emptying "Vacuna" wrote `null` into a required field and the
 * projection then dropped the row — visible and re-correctable, unlike the
 * mis-dating this file exists for, but still a write the schema would have
 * refused.
 *
 * A SECOND CACHE OF A SERVER FACT, with the same detector. The nullability lives
 * in `lib/events/event-schemas.ts`; this is the phone's copy, and
 * `__tests__/mobile-amend-passthrough-fence.test.ts` parses BOTH lists out of this
 * file and parses a real payload through the real schema to prove each side still
 * holds. A type with no required allowlisted key is ABSENT here rather than empty,
 * the same convention the list above uses.
 */
const NON_NULLABLE_FACTS: Readonly<Record<string, readonly string[]>> = {
  vaccination_administered: ["vaccine_name"],
  deworming_administered: ["product"],
  vet_visit_logged: ["reason"],
  note_added: ["text"],
  movement_recorded: ["cvi_number", "issuing_authority"],
};

/**
 * Would clearing this row write `null` where the spine refuses one?
 *
 * `false` for an unknown type or an unknown key, like every other question this
 * module asks — but here the safe default is the OTHER way round, so it is only
 * ever consulted about a key the allowlist already admitted.
 */
export function isRequiredFact(eventType: string, field: string): boolean {
  return NON_NULLABLE_FACTS[eventType]?.includes(field) ?? false;
}

/**
 * The first allowlisted row the person emptied that may not be empty, or `null`.
 *
 * SURFACED, not swallowed. `buildAmendChanges` refuses to emit the `null` on its
 * own — that is the guarantee, and it lives at the layer that persists — but a
 * box that quietly ignores what somebody typed (or deleted) is the same silence
 * this whole change is about. The screen asks this first and names the field.
 */
export function clearedRequiredFact(
  eventType: string,
  current: EventFactV1[],
  edits: Record<string, string>,
): EventFactV1 | null {
  for (const fact of current) {
    if (!isPassThroughFact(eventType, fact.field)) continue;
    if (!isRequiredFact(eventType, fact.field)) continue;
    if ((edits[fact.field] ?? "").trim().length === 0) return fact;
  }
  return null;
}

/** What the person is told when they emptied a box the spine requires. */
export function amendRequiredFactMessage(label: string): string {
  return `«${label}» no puede quedar vacío. Escribí un valor o dejá el que estaba.`;
}

/**
 * Is this row's DISPLAYED text the value the spine actually holds?
 *
 * The only question the correction form is allowed to ask. An unknown event
 * type, an unknown key, or a key this app has not proven answers `false` — and
 * `false` means read-only, never "probably fine".
 */
export function isPassThroughFact(eventType: string, field: string): boolean {
  return PASS_THROUGH_FACTS[eventType]?.includes(field) ?? false;
}

/** The rows this app may put in a text box. */
export function amendableFacts(eventType: string, facts: EventFactV1[]): EventFactV1[] {
  return facts.filter((fact) => isPassThroughFact(eventType, fact.field));
}

/**
 * The rows it may not — SHOWN, not hidden.
 *
 * A capability that disappears with no trace reads as a missing feature, and the
 * person is left believing the app simply cannot correct anything. Naming the
 * rows and naming the destination is what turns a removal into a handoff.
 */
export function readOnlyFacts(eventType: string, facts: EventFactV1[]): EventFactV1[] {
  return facts.filter((fact) => !isPassThroughFact(eventType, fact.field));
}

/**
 * The sentence under the rows this app will not edit.
 *
 * IT NAMES THE DESTINATION, and the destination was verified rather than
 * assumed: the web's own correction form seeds every input from
 * `stringifyValue(currentPayload[key])` — the RAW payload value — so somebody
 * there sees `2026-03-12` and `internal` and edits them in the shape the spine
 * holds. That is the one surface where these fields are expressible at all.
 */
export const AMEND_READ_ONLY_NOTE =
  "Estos datos se muestran con formato (una fecha como 12/03/2026, un tipo como «interno»), así que la app no puede guardarlos sin arruinar el registro. Corregilos desde miMAR en la web: abrí el asiento y usá «Corregir registro», que edita el valor tal como está guardado.";

/** The heading over that group. Says what the rows ARE, not what they lack. */
export const AMEND_READ_ONLY_TITLE = "Se corrigen desde la web";

/**
 * When NOTHING on the record is editable from here.
 *
 * A peso is the whole case: its only row is the formatted weight, so the form
 * would have zero boxes and its submit could only ever answer "no modificaste
 * ningún campo" — the contract requires at least one change. A dead-end form is
 * worse than an honest handoff, so the form is not offered at all.
 */
export const AMEND_NO_EDITABLE_FACTS_NOTE =
  "Este asiento no tiene datos que se puedan corregir desde la app: los que tiene se muestran con formato. Corregilo desde miMAR en la web, con «Corregir registro» en el asiento.";

/**
 * The same handoff, for an asiento with NO curated rows at all.
 *
 * THE SENTENCE ABOVE STATES A REASON, AND THE REASON IS FALSE HERE.
 * `medication_started` and `clinical_info_logged` are amendable and have no arm
 * in `eventPayloadDetails`, so they render zero rows — the screen has already
 * said "Sin campos adicionales" — and telling that person "los que tiene se
 * muestran con formato" is a false statement on a citizen surface, about a very
 * common asiento. The DESTINATION is unchanged and still true: the web's form
 * lists every key of the raw payload, so `drug_name` and `dose` genuinely are
 * correctable there even though this screen shows none of them.
 */
export const AMEND_NO_CURATED_FACTS_NOTE =
  "Este asiento no muestra campos que la app pueda corregir. Corregilo desde miMAR en la web, con «Corregir registro» en el asiento: ahí se ven todos los datos guardados del registro.";

/** Which of the two sentences this asiento gets. */
export function amendNoEditableFactsNote(facts: EventFactV1[]): string {
  return facts.length === 0 ? AMEND_NO_CURATED_FACTS_NOTE : AMEND_NO_EDITABLE_FACTS_NOTE;
}

/**
 * The change list a correction submits: the fields whose text the user actually
 * moved, and nothing else.
 *
 * WHY IT DIFFS INSTEAD OF SENDING THE WHOLE FORM. A correction names what
 * CHANGED — it becomes a line in a history somebody reads. Submitting every
 * field would write "Lote: «L-42» → «L-42»" into a ledger and make the real
 * change impossible to find.
 *
 * An emptied input sends `null` rather than `""`, because the two mean different
 * things: `null` clears the field, and an empty string would store a blank value
 * that later reads as a fact somebody entered.
 *
 * The comparison is on TRIMMED text: a trailing space a keyboard inserted is not
 * a correction, and appending an event to say so would be noise in a legal-ish
 * record.
 *
 * THE PASS-THROUGH FILTER LIVES HERE AND NOT ONLY IN THE SCREEN (A2-alta-asentar-02),
 * because this is the layer that decides what gets WRITTEN. A screen that renders
 * only the safe boxes is a screen; a screen plus a state map plus a submit is
 * three places a formatted value could re-enter, and the one that matters is the
 * last. `eventType` is taken as an argument for the same reason `canEndMedication`
 * matches on it: the spine's own name is the only stable key, and matching on a
 * worded label would break the day somebody rewords one.
 */
export function buildAmendChanges(
  eventType: string,
  current: EventFactV1[],
  edits: Record<string, string>,
): AmendEventInput["changes"] {
  const changes: AmendEventInput["changes"] = [];
  for (const fact of current) {
    if (!isPassThroughFact(eventType, fact.field)) continue;
    const next = (edits[fact.field] ?? "").trim();
    if (next === fact.value.trim()) continue;
    // THE ROW WAS ALLOWED; THIS VALUE IS NOT. See `NON_NULLABLE_FACTS`: the
    // allowlist decides which rows get a box, and an emptied box is a `null` the
    // spine's own schema would refuse. Dropped here rather than posted, so a
    // caller that skipped `clearedRequiredFact` still cannot write it.
    if (next.length === 0 && isRequiredFact(eventType, fact.field)) continue;
    changes.push({ field: fact.field, value: next.length === 0 ? null : next });
  }
  return changes;
}

/**
 * The form's starting text, one entry per EDITABLE curated row.
 *
 * THE FORM EDITS THE CURATED ROWS AND NOTHING ELSE, which is narrower than the
 * web — its form lists every key of the raw payload, including ones no screen
 * renders. Narrower on purpose: a field the ledger does not show is a field
 * nobody can see themselves correcting, and `firma_hash` appearing in a
 * correction form is an invitation to break a record.
 *
 * NARROWER AGAIN SINCE A2-alta-asentar-02: a row whose displayed text is a
 * TRANSFORMATION of the wire value never becomes an entry here, so the form's
 * state cannot hold a formatted date waiting to be posted as a raw one.
 */
export function initialAmendEdits(eventType: string, facts: EventFactV1[]): Record<string, string> {
  return Object.fromEntries(
    amendableFacts(eventType, facts).map((fact) => [fact.field, fact.value]),
  );
}

/**
 * One es-AR sentence per way the CONTRACT can refuse a correction.
 *
 * IT EXISTS BECAUSE THE WIRE CANNOT SAY WHICH BOX (A2-alta-asentar-07). The
 * error envelope is one key (§2), so a 400 from this write arrives as
 * `invalid_request` — whose copy is "Esta versión de la app no entiende…
 * Actualizá la app", which is false and unactionable: the app understood
 * perfectly, the reason was four characters long. Every other form in this app
 * runs the contract's own schema locally first, for exactly this.
 */
export function amendInputMessage(code: AmendEventInputCode): string {
  switch (code) {
    case "CHANGES_REQUIRED":
      return AMEND_NO_CHANGES_LABEL;
    case "CHANGE_FIELD_REQUIRED":
      return "Una de las correcciones no dice qué campo cambia.";
    case "CHANGE_FIELD_NOT_AMENDABLE":
      return "Ese campo no se puede corregir desde acá.";
    case "REASON_TOO_SHORT":
      return `El motivo tiene que tener al menos ${AMEND_REASON_MIN_LENGTH} caracteres, o dejalo vacío.`;
  }
}

/**
 * Build and validate the correction, with the contract's own schema.
 *
 * THE EMPTY REASON IS `null` AND NOT `""`: the schema asks for five characters
 * when a reason is PRESENT, and a blank string would be refused for a field the
 * owner deliberately left alone.
 */
export function buildAmendEventCommand(values: {
  reason: string;
  changes: AmendEventInput["changes"];
}):
  | { ok: true; input: AmendEventInput }
  | { ok: false; code: AmendEventInputCode; message: string } {
  const trimmed = values.reason.trim();
  const parsed = amendEventInputSchema.safeParse({
    reason: trimmed.length === 0 ? null : trimmed,
    changes: values.changes,
  });
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstAmendEventInputCode(parsed.error) ?? "CHANGES_REQUIRED";
  return { ok: false, code, message: amendInputMessage(code) };
}
