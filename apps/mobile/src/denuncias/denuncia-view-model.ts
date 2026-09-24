// Denunciar maltrato — the words for every option, and the shape of every ask.
//
// PURE, like every other view-model in this app: it owns the es-AR sentence for
// each state and the mapping from what somebody filled in into a
// `WelfareReportCommandInput`. Nothing here touches the network.
//
// THE VALIDATION IS THE SERVER'S OWN SCHEMA, imported and not re-stated — the
// rule `claim-view-model.ts`, `transfers-view-model.ts` and `turnos-view-model.ts`
// all follow. What lives here is the WORDS: the contract carries codes, the
// consumer owns its copy.
//
// THE NINE KIND LABELS ARE THIS FILE'S AND NOT THE CONTRACT'S, and that is the
// package's rule rather than a duplication: `@dim/contract` carries no es-AR at
// all — it is installable by any client and its opinions stop at
// `@dim/contract/tokens`. The web's own labels live in
// `src/modules/welfare/domain/types.ts`, which a React Native app cannot import.
// So the strings are copied and the KEYS are not: the `switch` below is
// exhaustive over `WelfareReportKind`, so a kind added to the catalogue fails to
// compile here rather than rendering as `dog_fighting` on a phone. That is the
// same gap `welfare-report-kind-catalog.test.ts` closes for the server's own
// label table, closed the way a client can close it.
//
// THE SEVERITY WORDS ARE THE ONES THE REPORTER WILL BE QUOTED BACK
// ---------------------------------------------------------------------------
// Blind QA 2026-08-19 (O2): somebody picked the card labelled "Grave / urgente"
// and the follow-up screen told them "Gravedad que indicaste: Crítica — peligro
// inmediato" — the same severity, in a word they had never seen, under copy
// claiming to quote them. `WELFARE_SEVERITY_CITIZEN_LABEL` is the repair on the
// web and these three strings are its citizen half, copied deliberately: a
// fourth word invented here would re-open that exact defect on a second surface.

import type {
  WelfareReportCitizenSeverity,
  WelfareReportInputCode,
  WelfareReportKind,
  WelfareReportSubjectKind,
} from "@dim/contract/input";
import {
  firstWelfareReportInputCode,
  welfareReportFileInputSchema,
  welfareReportResolveLocationInputSchema,
} from "@dim/contract/input";
import type { WelfareReportCommandInput } from "@dim/contract/input";

/**
 * The nine kinds, in the reporter's words.
 *
 * EXHAUSTIVE WITH NO `default`, which is the whole reason this is a `switch` and
 * not a `Record` with a fallback: a `Record<string, string>` keyed loosely would
 * render the enum value for a kind nobody labelled, and the operator queues have
 * already shipped that bug once (see `welfareReportKindLabel`'s `default`).
 */
export function denunciaKindLabel(kind: WelfareReportKind): string {
  switch (kind) {
    case "abandonment":
      return "Abandono";
    case "neglect":
      return "Negligencia (sin agua, comida o refugio)";
    case "physical_abuse":
      return "Maltrato físico, golpes o lesiones";
    case "chained":
      return "Animal encadenado o sin poder moverse";
    case "no_shelter":
      return "Sin refugio del clima";
    case "hoarding":
      return "Acumulación de animales";
    case "dog_fighting":
      return "Peleas de perros";
    case "trafficking":
      return "Tráfico o venta clandestina";
    case "other":
      return "Otra";
  }
}

/** The three severity cards, in the words the reporter will be quoted back. */
export function denunciaSeverityLabel(severity: WelfareReportCitizenSeverity): string {
  switch (severity) {
    case "critical":
      return "Grave / urgente";
    case "medium":
      return "Moderado";
    case "low":
      return "Sospecha";
  }
}

/** What each severity card says underneath, copied from the web's three. */
export function denunciaSeverityHint(severity: WelfareReportCitizenSeverity): string {
  switch (severity) {
    case "critical":
      return "El animal está en peligro inmediato o hay heridas visibles";
    case "medium":
      return "Condiciones de vida malas, abandono, descuido sostenido";
    case "low":
      return "Creo que algo no está bien, pero no estoy seguro/a";
  }
}

/**
 * What the denuncia is about.
 *
 * THREE OPTIONS AND NOT THE COLUMN'S FOUR. `registered_pet` is not on this
 * transport: naming a registered animal means sending its public token, which is
 * printed on the tag and published for every lost animal on `/perdidas`. The
 * contract drops the member, so this `switch` cannot be asked about it.
 */
export function denunciaSubjectLabel(kind: WelfareReportSubjectKind): string {
  switch (kind) {
    case "unowned_animal":
      return "Un animal sin dueño identificado";
    case "location":
      return "Un lugar o una situación";
    case "general":
      return "Otra cosa";
  }
}

/** The hint under the subject description field, which differs by subject. */
export function denunciaSubjectPlaceholder(kind: WelfareReportSubjectKind): string {
  switch (kind) {
    case "unowned_animal":
      return "Perro mestizo marrón, mediano, atado en el fondo de una casa";
    case "location":
      return "Casa con muchos perros en el patio, se escuchan llantos";
    case "general":
      return "Describí brevemente lo que viste";
  }
}

/**
 * The es-AR sentence for a local input refusal.
 *
 * EXHAUSTIVE over `WelfareReportInputCode` with no `default`, so a code added to
 * the contract is a compile error here rather than a blank line under a heading.
 * `null` is the shape a parse failure the vocabulary does not cover takes, and it
 * gets a sentence too — silence is the one answer a form may not give.
 */
export function denunciaInputMessage(code: WelfareReportInputCode | null): string {
  if (code === null) return "Revisá los datos: hay algo que no pudimos interpretar.";
  switch (code) {
    case "COMMAND_REQUIRED":
      // Unreachable from this screen — it names its own command — and it still
      // needs a sentence, because "unreachable" is a claim about today's code.
      return "No pudimos preparar el pedido. Volvé a intentar.";
    case "CONTACT_MODE_REQUIRED":
      return "Elegí si querés enviarla de forma anónima o dejar un contacto.";
    case "KIND_REQUIRED":
      return "Elegí qué tipo de situación estás denunciando.";
    case "SEVERITY_REQUIRED":
      return "Elegí qué tan grave es la situación.";
    case "DESCRIPTION_REQUIRED":
      return "Contanos qué pasó.";
    case "DESCRIPTION_TOO_SHORT":
      // THE NUMBER, IN WORDS, because the server refuses on it and a person
      // whose paragraph is rejected needs to know what to add. The web's own
      // action says "al menos 20 caracteres para poder ser actuable" — the
      // second half is the part that explains the rule rather than stating it.
      return "La descripción tiene que tener al menos 20 caracteres: con menos, no hay nada que un inspector pueda ir a ver.";
    case "SUBJECT_KIND_REQUIRED":
      return "Elegí si estás denunciando un animal, un lugar u otra cosa.";
    case "SUBJECT_DESCRIPTION_REQUIRED":
      return "Describí brevemente al animal o el lugar denunciado.";
    case "ADDRESS_REQUIRED":
      return "Escribí la dirección o el lugar para poder buscarlo.";
    case "COORDS_REQUIRED":
      return "Elegí el lugar de la lista para que la denuncia llegue a la autoridad correcta.";
    case "COORDS_OUT_OF_RANGE":
      return "El lugar elegido no es válido. Buscá la dirección de nuevo.";
    case "OCCURRED_AT_INVALID":
      return "La fecha del hecho no es válida.";
    case "CONTACT_REQUIRED":
      return "Dejá un correo o un teléfono, o elegí enviarla de forma anónima.";
  }
}

/**
 * The required fields, IN THE ORDER THE SCREEN DRAWS THEM.
 *
 * B-07, measured on the shipped build 10 (shots 133-134). Submitting an empty
 * denuncia answered "Elegí qué tipo de situación estás denunciando." while
 * "¿DÓNDE ESTÁ PASANDO? *", the field ABOVE it, was equally empty. That is not
 * a wrong sentence — it is the right sentence about the wrong field, and it
 * happens because the only ordering in play was zod's, which follows the schema
 * object's key order and knows nothing about where anything is on a phone.
 *
 * A person fixing one field at a time, from an error that keeps pointing
 * somewhere other than the first gap, learns that the form is arguing with them.
 */
export const DENUNCIA_FIELD_ORDER = [
  "ADDRESS_REQUIRED",
  "COORDS_REQUIRED",
  "KIND_REQUIRED",
  "SEVERITY_REQUIRED",
  "SUBJECT_KIND_REQUIRED",
  "SUBJECT_DESCRIPTION_REQUIRED",
  "DESCRIPTION_REQUIRED",
  "CONTACT_REQUIRED",
] as const satisfies readonly WelfareReportInputCode[];

type DenunciaFieldCode = (typeof DENUNCIA_FIELD_ORDER)[number];

/**
 * The heading each missing field wears on screen, verbatim.
 *
 * TRANSCRIBED, NOT INVENTED: a summary that renames the fields makes the person
 * hunt for a label the screen does not contain. `DenunciaScreen.tsx` draws these
 * exact strings.
 */
const DENUNCIA_FIELD_HEADING: Record<DenunciaFieldCode, string> = {
  ADDRESS_REQUIRED: "¿Dónde está pasando?",
  COORDS_REQUIRED: "¿Dónde está pasando?",
  KIND_REQUIRED: "¿Qué está pasando?",
  SEVERITY_REQUIRED: "¿Qué tan grave es?",
  SUBJECT_KIND_REQUIRED: "¿Sobre qué es la denuncia?",
  SUBJECT_DESCRIPTION_REQUIRED: "¿Qué o a quién estás denunciando?",
  DESCRIPTION_REQUIRED: "Contanos qué pasó",
  CONTACT_REQUIRED: "¿Cómo querés enviarla?",
};

/**
 * Is this field still blank? One predicate per code, keyed by the code.
 *
 * THE ARRAY ABOVE IS NOW THE MECHANISM AND NOT A COMMENT (finding L3, review
 * 2026-09-07). `DENUNCIA_FIELD_ORDER` was documented as "the order the screen
 * draws them" and used only for its `[number]` type: the list was actually built
 * by hand-written `push` order in `missingDenunciaFields`, so the two agreed by
 * transcription and could drift in silence — and `ADDRESS_REQUIRED` sat in the
 * array unreachable, because nothing ever pushed it.
 *
 * A `Record` keyed by `DenunciaFieldCode` is what makes that impossible: the
 * compiler demands a predicate for every code in the array, the ORDER comes from
 * the array, and neither can move without the other.
 */
const DENUNCIA_FIELD_BLANK: Record<
  DenunciaFieldCode,
  (values: DenunciaFormValues, addressText: string) => boolean
> = {
  // The place is one heading with two failure modes, and only one can be true:
  // nothing typed at all, and typed but never confirmed against the geocoder's
  // list. They earn DIFFERENT sentences — "escribí la dirección" is useless
  // advice to somebody looking at the address they just typed.
  ADDRESS_REQUIRED: (values, addressText) => values.place === null && addressText.trim() === "",
  COORDS_REQUIRED: (values, addressText) => values.place === null && addressText.trim() !== "",
  KIND_REQUIRED: (values) => values.kind === null,
  SEVERITY_REQUIRED: (values) => values.severity === null,
  SUBJECT_KIND_REQUIRED: (values) => values.subjectKind === null,
  SUBJECT_DESCRIPTION_REQUIRED: (values) => values.subjectDescription.trim() === "",
  DESCRIPTION_REQUIRED: (values) => values.description.trim() === "",
  CONTACT_REQUIRED: (values) =>
    !values.anonymous && values.contactEmail.trim() === "" && values.contactPhone.trim() === "",
};

/**
 * Every required field still blank, top to bottom.
 *
 * DELIBERATELY ONLY "BLANK", never "wrong". A description of eleven characters
 * is not missing — it is too short, and that is the contract's judgement to make
 * (`DESCRIPTION_TOO_SHORT` carries the number and the reason). This function
 * answers one question, "what has the person not filled in yet", and leaves
 * every rule about CONTENT to the single validation door below.
 *
 * `addressText` IS A SECOND ARGUMENT because the screen holds it outside
 * `DenunciaFormValues`: it is what the person typed into the search box, and it
 * only ever becomes a `place` once the geocoder answers and they TAP a
 * candidate. Without it this function cannot tell the two place failures apart,
 * which is why `ADDRESS_REQUIRED` was unreachable. It defaults to `""` — the
 * "nothing typed" reading — so a caller that has no box to read from gets the
 * sentence that asks for one.
 */
export function missingDenunciaFields(
  values: DenunciaFormValues,
  addressText = "",
): DenunciaFieldCode[] {
  return DENUNCIA_FIELD_ORDER.filter((code) => DENUNCIA_FIELD_BLANK[code](values, addressText));
}

/**
 * What to say about everything that is missing, or `null` when nothing is.
 *
 * ONE missing field keeps its own sentence, unchanged — it already says what to
 * do and says it better than a list of one would.
 *
 * SEVERAL KEEP THE FIRST FIELD'S SENTENCE AND LIST THE REST (finding L4, review
 * 2026-09-07). The list used to be headings ALL the way down, and that flattened
 * the one distinction the codes carry: `COORDS_REQUIRED` — an address typed and
 * never resolved — appeared as "¿Dónde está pasando?", so somebody staring at a
 * filled-in box read that it was missing. The heading says WHERE; only the code's
 * own sentence says WHAT TO DO, and the field a person will fix first is the one
 * that deserves it. The rest stay headings, because an empty form is a person
 * who has not started rather than a person who made a mistake, and naming seven
 * fields one at a time turns filling it in into a guessing game with seven
 * rounds.
 */
export function denunciaMissingMessage(missing: readonly DenunciaFieldCode[]): string | null {
  if (missing.length === 0) return null;
  const first = missing[0];
  if (first === undefined) return null;
  if (missing.length === 1) return denunciaInputMessage(first);
  const headings = missing.slice(1).map((code) => DENUNCIA_FIELD_HEADING[code]);
  const last = headings.pop();
  const rest = headings.length === 0 ? `${last}` : `${headings.join(", ")} y ${last}`;
  // Singular and plural, because "Faltan además: Contanos qué pasó." about one
  // field is a sentence nobody would write by hand.
  const lead = missing.length === 2 ? "Falta además" : "Faltan además";
  return `${denunciaInputMessage(first)} ${lead}: ${rest}.`;
}

/**
 * Build and validate the `resolve_location` command.
 *
 * Separate from the file command rather than one builder with a mode, because
 * the two asks share no field: this one carries an address and nothing else.
 */
export type DenunciaDraft =
  | { ok: true; input: WelfareReportCommandInput }
  | { ok: false; code: WelfareReportInputCode | null };

export function buildResolveLocationCommand(addressText: string): DenunciaDraft {
  return parseDraft(welfareReportResolveLocationInputSchema, {
    command: "resolve_location",
    addressText,
  });
}

/** Everything the form holds, before it is a request. */
export type DenunciaFormValues = {
  kind: WelfareReportKind | null;
  severity: WelfareReportCitizenSeverity | null;
  description: string;
  subjectKind: WelfareReportSubjectKind | null;
  subjectDescription: string;
  /** The candidate the person TAPPED, never one this app resolved for them.
   * Carries the candidate's OWN jurisdiction pair (nullable on the wire) so
   * `file` can echo it — dropping it here was walkthrough 2026-08-31 §2: the
   * server geocoded the pair, the person picked it, and every mobile denuncia
   * still landed "jurisdicción sin verificar". */
  place: {
    label: string;
    lat: number;
    lng: number;
    province: string | null;
    locality: string | null;
  } | null;
  anonymous: boolean;
  contactEmail: string;
  contactPhone: string;
};

/**
 * Build and validate the `file` command from the form.
 *
 * THE CONTACT FIELDS ARE NOT SENT WHEN THE SUBMISSION IS ANONYMOUS, and this is
 * the client half of a property the server does not depend on. The wire shape
 * has nowhere to put them (`welfare-report.ts`'s discriminated union) and the
 * handler reads them off the branch, so nothing here can leak one — but a client
 * that BUILT a body carrying an address it then had stripped would still have
 * held that address one function longer than necessary, and somebody reading
 * this file should see the two states as two objects rather than as one object
 * with a flag.
 */
export function buildFileDenunciaCommand(values: DenunciaFormValues): DenunciaDraft {
  const facts = {
    command: "file" as const,
    kind: values.kind,
    severity: values.severity,
    description: values.description,
    subjectKind: values.subjectKind,
    subjectDescription: values.subjectDescription,
    // `place === null` reaches the schema as `undefined`, which is
    // `COORDS_REQUIRED` — the same refusal a bad number would get, and the
    // message says "elegí el lugar de la lista", because that is the only way
    // this app can produce one.
    locationLat: values.place?.lat,
    locationLng: values.place?.lng,
    locationAddress: values.place?.label,
    // The picked candidate's jurisdiction, echoed. Absent (typed address, no
    // geocoder confirmation) the server's D.11 gate infers from text and marks
    // the row unverified — which is then true.
    locationProvince: values.place?.province,
    locationLocality: values.place?.locality,
  };

  if (values.anonymous) {
    return parseDraft(welfareReportFileInputSchema, { ...facts, contactMode: "anonymous" });
  }
  // Trimmed at the same point the web's wizard trims (DenunciaWizard.tsx:365) —
  // a trailing space from mobile autocomplete otherwise reaches the case record
  // as part of the address someone will try to write to.
  const email = values.contactEmail.trim();
  const phone = values.contactPhone.trim();
  return parseDraft(welfareReportFileInputSchema, {
    ...facts,
    contactMode: "with_contact",
    // A BOX NOBODY TYPED IN IS OMITTED, NOT SENT AS "" (A5-ciudadanas-01).
    // Somebody who chose "Con mi contacto" and left a phone could not send the
    // denuncia at all: `""` reached `z.email()`, which runs before the schema's
    // nullable/optional and before its at-least-one rule, so the form answered
    // "dejanos un contacto" to a person who had just left one. The contract now
    // normalises the blank too (welfare-report.ts) — that half is deployed with
    // the server; this one is what makes the SHIPPED build stop sending it.
    ...(email === "" ? {} : { reporterContactEmail: email }),
    ...(phone === "" ? {} : { reporterContactPhone: phone }),
  });
}

/**
 * One parse, using the CONTRACT'S schema for the command being sent.
 *
 * A success carries the PARSED input — trimmed and normalised by the schema —
 * and not what was typed, so the value the server sees is the value the client
 * validated. Same rule as `buildClaimCommand`.
 *
 * IT TAKES THE MEMBER, NOT `welfareReportCommandInputSchema`, and the difference
 * is a per-field message that is about the right field. The top-level union is a
 * plain `z.union` — it has to be, because `file` is itself a discriminated union
 * — so it tries EVERY member and collects EVERY member's complaints. A `file`
 * body with no point came back carrying `ADDRESS_REQUIRED`, the `resolve_location`
 * member objecting to a field this caller never meant to send, and the screen
 * would have told somebody to write an address into a field they had already
 * filled. Measured, not reasoned about.
 *
 * The SERVER still parses the union, and correctly: it does not know which
 * command arrived, and it answers one `invalid_request` either way.
 */
function parseDraft(
  schema: { safeParse: (value: unknown) => SafeParseResult },
  body: unknown,
): DenunciaDraft {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, input: parsed.data as WelfareReportCommandInput };
  return { ok: false, code: firstWelfareReportInputCode(parsed.error) };
}

/** What both member schemas answer. Narrower than zod's generic, on purpose. */
type SafeParseResult =
  | { success: true; data: unknown; error?: undefined }
  | { success: false; error: Parameters<typeof firstWelfareReportInputCode>[0] };

/**
 * What to say when the geocoder comes back with nothing.
 *
 * NEVER "esa dirección no existe". `lib/infra/geocoding.ts` makes a miss, a
 * timeout and a rate-limit refusal deliberately indistinguishable, and the
 * shared limiter answers with an empty list rather than raising — so an empty
 * `matches` is three different facts wearing one shape, and only one of them is
 * about the address.
 */
export const DENUNCIA_NO_MATCHES =
  "No pudimos encontrar esa dirección. Probá escribirla de otra forma — por ejemplo, calle y número, o una esquina.";

/**
 * What the phone tells somebody who needs to be untraceable, not merely
 * unnamed.
 *
 * THIS SENTENCE IS THE HONEST HALF OF "anónima" ON THIS TRANSPORT. Choosing
 * anonymous here means the RECORD carries nothing about the reporter: no user
 * id on the row, no opener on the case, nothing in the response or the logs.
 * What it cannot mean is that the request was unattributable in flight, because
 * every `/api/v1` door authenticates before it reads a body. The web's form
 * accepts a denuncia from a browser with no session at all, which is the
 * stronger property, and a person who needs it deserves to be told where it is
 * rather than reassured.
 */
export const DENUNCIA_ANONYMOUS_CAVEAT =
  "Anónima significa que no guardamos ningún dato tuyo en la denuncia: ni tu cuenta, ni tu nombre, ni tu contacto. Como estás usando la app, iniciaste sesión para llegar hasta acá. Si necesitás que ni siquiera eso quede registrado, podés denunciar desde el navegador sin iniciar sesión.";

/**
 * What the phone tells somebody who has a photo and nowhere to put it.
 *
 * IT SENDS THEM TO THE WEB BEFORE THEY START, AND THE FIRST DRAFT OF THIS STRING
 * DID NOT — it said "sumalas desde la web con el código que te damos al final",
 * which is a promise this product cannot keep. Evidence can ONLY be attached at
 * CREATION, and there is no "add evidence later" path on any surface — not on
 * `/denuncias/codigo`, not on `/denuncias/seguimiento`, not for an authenticated
 * reporter. `addReporterCommentAction` adds TEXT to the case and nothing else.
 *
 * `uploadWelfareEvidence` has THREE call sites in the repo, and this docblock
 * said two until the count was actually run. The two denuncia ones are
 * `createWelfareReportAction` and `createOrgWelfareReportAction` in
 * `welfare/actions.ts`; the third is
 * `src/modules/pets/application/claim/submit-claim-dispute.ts`, which predates
 * this screen and uploads under `claims/{reportId}` for a CUSTODY DISPUTE rather
 * than a denuncia. The miscount does not move the conclusion — the third is also
 * a creation path, and it is not a denuncia at all — but the sentence above is
 * the reason this screen's copy exists, so it does not get to be approximately
 * true. Re-derive it with `rg uploadWelfareEvidence` rather than trusting this
 * number.
 *
 * So the honest instruction is to file from the browser in the first place, and
 * the copy has to arrive BEFORE somebody spends five minutes filling in a form
 * whose evidence they cannot attach afterwards. This string is rendered at the
 * top of the screen for that reason, not at the end.
 */
export const DENUNCIA_NO_ATTACHMENTS_CAVEAT =
  "Todavía no se pueden adjuntar fotos ni videos desde la app, y no se pueden sumar después: las pruebas se adjuntan sólo al momento de denunciar. Si tenés fotos o videos, hacé la denuncia desde el navegador.";
