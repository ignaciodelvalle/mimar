// Modo perdida — turning the server's answer into what a person reads, and what
// they typed into what the contract accepts.
//
// PURE, like every other view-model in this app. It owns the es-AR sentence for
// every state and every refusal, and the mapping from a filled-in form to a
// `LostCommandInput`. Nothing here touches the network, so all of it is testable
// without one.
//
// THE VALIDATION IS THE SERVER'S OWN SCHEMA, imported and not re-stated. A
// second copy of "both coordinates or neither" written here for a nicer message
// would be the exact drift `@dim/contract` exists to stop. What lives here is
// the WORDS — the contract carries codes, the consumer owns its copy.
//
// THE CAPABILITIES ARE THE SERVER'S TOO, AND THIS FILE NEVER RECOMPUTES THEM.
// `payload.capabilities` says which of the five STATE commands this caller may
// send. A screen that derived "can mark found" from `status === "lost"` would get
// four of five right and reactivation — refused on the ORG path alone, which
// nothing in the payload's status hints at — silently wrong.
//
// THE SIXTH COMMAND HAS NO FLAG, and `feedItemReportable` explains why at its own
// definition: reporting takes an ITEM rather than the animal, the right to do it
// is co-extensive with the right to read the feed, and a boolean that is `true`
// on every payload teaches a reader to stop checking it.

import type { LostDisclosureV1, LostFeedItemV1, PetLostV1 } from "@dim/contract/api";
import type { ContentReportCategory } from "@dim/contract/events";
import { CONTENT_REPORT_CATEGORIES } from "@dim/contract/events";
import type {
  LostCommandInput,
  LostCommandInputCode,
  DisclosureKey as WireDisclosureKey,
} from "@dim/contract/input";
import { firstLostCommandInputCode, lostCommandInputSchema } from "@dim/contract/input";

export type DisclosureKey = WireDisclosureKey;

/**
 * "perdido" / "perdida" / "perdido/a", from the animal's sex.
 *
 * The SAME switch `lostLabel` runs on the server, repeated here rather than
 * imported because that helper lives in `lib/utils/format.ts`, which is web
 * code. It is COPY and not a rule: nothing branches on the answer.
 */
export function lostAdjective(sex: string | null): string {
  switch (sex) {
    case "male":
      return "perdido";
    case "female":
      return "perdida";
    default:
      return "perdido/a";
  }
}

/** "encontrado" / "encontrada" / "encontrada/o" — the same call for recovery. */
export function foundAdjective(sex: string | null): string {
  switch (sex) {
    case "male":
      return "encontrado";
    case "female":
      return "encontrada";
    default:
      return "encontrada/o";
  }
}

/**
 * The one-line headline for the animal's current situation.
 *
 * SAYS WHICH OF THE THREE STATES IT IS, including the one people find
 * confusing: an animal whose `status` is `lost` and whose search was closed for
 * inactivity is still lost, and a screen that only said "perdida" would leave
 * somebody wondering why they cannot log a sighting.
 */
export function situationHeadline(view: PetLostV1): string {
  if (view.status === "deceased") return "Esta mascota está registrada como fallecida.";
  if (view.status !== "lost") return `${view.petName} no está ${lostAdjective(view.petSex)}.`;
  if (view.episode === null) {
    return `La búsqueda de ${view.petName} se cerró por inactividad, pero sigue marcada como ${lostAdjective(view.petSex)}.`;
  }
  return `${view.petName} está ${lostAdjective(view.petSex)}. La búsqueda está activa.`;
}

/** es-AR label for one disclosure preference. */
export function disclosureLabel(key: DisclosureKey): string {
  switch (key) {
    case "discloseFirstNameWhenLost":
      return "Mostrar mi nombre";
    case "disclosePhoneWhenLost":
      return "Mostrar mi teléfono";
    case "discloseEmailWhenLost":
      return "Mostrar mi email";
    case "discloseLastLocationWhenLost":
      return "Mostrar dónde la vieron por última vez";
    case "allowFinderFormWhenLost":
      return "Permitir que quien la encuentre me escriba";
    case "discloseCaretakerContactWhenLost":
      return "Mostrar el contacto de su cuidador/a";
  }
}

/**
 * One sentence saying what a preference actually publishes.
 *
 * SAYS WHO SEES IT, because that is the whole decision. Every one of these
 * governs a field on the PUBLIC credential — the page a stranger who scanned the
 * QR is looking at — and a toggle labelled only "Mostrar mi teléfono" does not
 * say to whom.
 */
export function disclosureHelp(key: DisclosureKey): string {
  switch (key) {
    case "discloseFirstNameWhenLost":
      return "Aparece en la credencial pública mientras la búsqueda esté activa.";
    case "disclosePhoneWhenLost":
      return "Cualquiera que escanee el QR puede llamarte.";
    case "discloseEmailWhenLost":
      return "Cualquiera que escanee el QR puede escribirte.";
    case "discloseLastLocationWhenLost":
      return "Se publica el lugar y el momento del último avistaje.";
    case "allowFinderFormWhenLost":
      return "Sin esto, quien la encuentre solo puede reportar un avistaje.";
    case "discloseCaretakerContactWhenLost":
      return "Solo se publica si además tu cuidador/a dio su consentimiento.";
  }
}

/**
 * Whether NOBODY can reach the person if this animal is found (A4-custodia-09).
 *
 * The three keys below are the only channels a finder has. Every one off means
 * the credential shows a search notice and no way to answer it: whoever is
 * holding the dog can log a sighting and nothing else. The web's wizard says so
 * (`MarkLostWizard.tsx:489-497`) and this app did not, so the phone shipped a
 * quieter version of a decision that costs somebody their animal.
 *
 * `discloseFirstNameWhenLost` and `discloseLastLocationWhenLost` are NOT in the
 * set on purpose: a name and a place are things a finder reads, not ways to
 * write back. `discloseCaretakerContactWhenLost` is out too, and that one is the
 * judgement call — it needs the caretaker's own consent to publish anything, so
 * the titular cannot know from this screen whether it is a live channel, and a
 * warning that quietly disappeared on an unverifiable maybe would be worse than
 * one that is occasionally over-cautious.
 */
const FINDER_CHANNELS = [
  "disclosePhoneWhenLost",
  "discloseEmailWhenLost",
  "allowFinderFormWhenLost",
] as const satisfies readonly DisclosureKey[];

/**
 * Takes ONLY the three keys it reads, not a whole `LostDisclosureV1`. The
 * mark-lost DRAFT carries five of the six preferences — the caretaker one is
 * the caretaker's to consent to and is not on the form — so a parameter typed
 * as the full payload shape would have refused the caller that needs it most.
 */
export function noWayToReachYou(
  disclosure: Pick<LostDisclosureV1, (typeof FINDER_CHANNELS)[number]>,
): boolean {
  return FINDER_CHANNELS.every((key) => disclosure[key] === false);
}

/**
 * The line a NON-editable preference shows instead of a switch.
 *
 * A row that simply disappeared would leave a caretaker wondering whether the
 * setting exists; a switch that answered 403 would be a control that lies. The
 * third option is the honest one: show the value, say whose decision it is.
 *
 * Declared HERE rather than below the rows it labels because `noContactWarning`
 * ends its read-only arm with it (finding F11).
 */
export const DISCLOSURE_TITULAR_ONLY_NOTE = "Solo el titular puede cambiar esto.";

export const NO_CONTACT_TITLE = "Nadie va a poder contactarte";

/**
 * The same fact, for a reader who cannot act on it (finding F11, review
 * 2026-09-07).
 *
 * "contactarTE" and "te recomendamos habilitar" both address the person reading
 * as the one the finder would reach and the one who can open a channel. A
 * caretaker or a co-owner is neither: `editableDisclosureKeys` comes back
 * without the three finder channels for them, so the rows above the callout have
 * no switches at all and they were being told to flip one.
 */
export const NO_CONTACT_TITLE_READ_ONLY = "Nadie va a poder avisar";

/**
 * Can this reader open any of the three channels the warning is about?
 *
 * Not "can they edit anything": a caretaker may hold
 * `discloseCaretakerWhenLost` and still none of the finder channels, and the
 * recommendation is specifically about those three.
 */
export function canOpenFinderChannel(editableKeys: readonly DisclosureKey[]): boolean {
  const editable = new Set<string>(editableKeys);
  return FINDER_CHANNELS.some((key) => editable.has(key));
}

/**
 * The web's own sentence, with the animal's name in it.
 *
 * `canOpenChannel` decides whether it ends in an INSTRUCTION or in whose
 * decision it is. Defaults to `true` because the mark-lost form's caller is by
 * construction somebody who may set every one of these — it is drafting them.
 */
export function noContactWarning(petName: string, canOpenChannel = true): string {
  if (!canOpenChannel) {
    return `Sin teléfono, email ni formulario habilitados, quien encuentre a ${petName} no tiene forma de avisar. ${DISCLOSURE_TITULAR_ONLY_NOTE}`;
  }
  return `Sin teléfono, email ni formulario habilitados, quien encuentre a ${petName} no tiene forma de avisarte. Te recomendamos habilitar al menos el formulario: no muestra ninguno de tus datos.`;
}

/** The six preferences, in the order the web's own card lists them. */
export function disclosureRows(
  disclosure: LostDisclosureV1,
  editableKeys: readonly DisclosureKey[],
): Array<{ key: DisclosureKey; value: boolean; editable: boolean }> {
  const editable = new Set<string>(editableKeys);
  return (Object.keys(disclosure) as DisclosureKey[]).map((key) => ({
    key,
    value: disclosure[key],
    editable: editable.has(key),
  }));
}

/** The title of one feed row. */
export function feedItemTitle(item: LostFeedItemV1): string {
  switch (item.kind) {
    case "scan":
      // A burst is ONE row carrying its count, so the copy has to be able to say
      // "4 escaneos" without the screen counting rows itself.
      return item.count === 1 ? "Escanearon su QR" : `Escanearon su QR ${item.count} veces`;
    case "sighting":
      return "Alguien la vio";
    case "finder":
      // THE ONE THAT ENDS THE SEARCH. Named as strongly as it deserves: the web
      // sorts it to the top of the feed for the same reason.
      return `${item.finderName} dice que la tiene`;
  }
}

/** The second line of one feed row, or `null` when there is nothing to add. */
export function feedItemDetail(item: LostFeedItemV1): string | null {
  switch (item.kind) {
    case "scan":
      return item.localityLabel;
    case "sighting":
      return [item.description, item.localityLabel].filter(Boolean).join(" · ") || null;
    case "finder":
      return (
        [item.localityLabel, item.petCondition, item.message].filter(Boolean).join(" · ") || null
      );
  }
}

/** The contact a feed row carries, when the person left one. */
export function feedItemContact(item: LostFeedItemV1): string | null {
  if (item.kind === "scan") return null;
  return item.finderContact;
}

/**
 * May this row be reported?
 *
 * THE ANSWER IS THE KIND AND NOTHING ELSE, and it is not a recomputation of a
 * server decision — it is the contract read literally. A `sighting` and a
 * `finder` were typed by an anonymous stranger; a `scan` is a machine reading a
 * QR, with no author and no text, so there is nothing anybody could have written
 * wrongly. The server refuses a scan target regardless, with
 * `lost_report_target_invalid`; this is what keeps the app from offering a
 * control that would be refused.
 *
 * NOT A CAPABILITY FLAG, deliberately. `capabilities` carries the five conditions
 * a client would get WRONG on its own — whether an episode is open, whether this
 * caller came through an organization. The right to report is co-extensive with
 * the right to read the feed, so a flag would be `true` on every payload that
 * ever reached a screen, and a boolean that never varies teaches a reader to
 * stop checking it.
 */
export function feedItemReportable(item: LostFeedItemV1): boolean {
  return item.kind !== "scan";
}

/** The affordance's label. "Reportar", never "Denunciar" — see REPORT_INTRO. */
export const REPORT_ACTION_LABEL = "Reportar";

/**
 * What the person is told before they report something.
 *
 * SAYS WHAT ACTUALLY HAPPENS, in the two directions people assume wrongly: the
 * message leaves THEIR feed (not the internet), and nothing is deleted from the
 * record. The second half matters more than it looks — this app tells people
 * everywhere else that events are never edited or erased, and an affordance that
 * appeared to contradict that would undermine the promise that makes the whole
 * credential worth anything.
 */
export const REPORT_INTRO =
  "El mensaje deja de aparecer en tu búsqueda. No se borra del historial y quien lo escribió no recibe ningún aviso.";

/** es-AR label for one report category. Exhaustive over the contract's list. */
export function reportCategoryLabel(category: ContentReportCategory): string {
  switch (category) {
    case "spam":
      return "Publicidad o me piden plata";
    case "harassment":
      return "Me insultan o me amenazan";
    case "false_information":
      return "Es información inventada";
    case "personal_data":
      return "Publica datos de otra persona";
    case "other":
      return "Otro motivo";
  }
}

export const REPORT_CATEGORY_OPTIONS: readonly ContentReportCategory[] = CONTENT_REPORT_CATEGORIES;

export const FEED_EMPTY_LABEL = "Todavía no hay avistajes ni escaneos.";

/**
 * The text handed to the OS share sheet when the owner spreads the search.
 *
 * NO PII AND NO LAST-SEEN PLACE, deliberately. The message travels to WhatsApp
 * groups and beyond the owner's control the moment it is sent, so everything a
 * disclosure toggle governs stays OFF it — the credential URL is the message's
 * whole payload, and that page already obeys the toggles at read time. A place
 * name pasted here would outlive the owner turning `discloseLastLocationWhenLost`
 * off.
 *
 * "La" is the codebase's article for `la mascota` (see `disclosureLabel`'s
 * "dónde la vieron"); only the adjective carries the animal's sex.
 */
export function shareSearchMessage(view: PetLostV1, url: string): string {
  return `Estamos buscando a ${view.petName}, está ${lostAdjective(view.petSex)}. Si la viste, avisá desde su credencial: ${url}`;
}

/**
 * The note a CAPPED feed owes.
 *
 * A list that shows some of what exists and does not say so is the same
 * dishonesty as an empty state over a failed read.
 */
export function feedTruncationNote(truncated: boolean): string | null {
  return truncated ? "Mostramos los más recientes. Puede haber más." : null;
}

/** The screen's raw text state for the two forms. Every field is a string. */
export type LostDraft = {
  /** Where the animal was last seen, in words. */
  locationDescription: string;
  /**
   * WHERE IT WENT MISSING, from the INDEC catalogue — the case is routed on it.
   *
   * Not the same fact as `locationDescription`, which is prose a finder reads.
   * This is the pair that decides which jurisdiction owns the case and which
   * organisations are alerted. Until 2026-09-11 both followed the animal's HOME
   * address, so a dog lost in Córdoba opened a CABA case and alerted CABA.
   * Same decision the bite form already records, same three fields, same
   * all-or-nothing rule.
   */
  provinceCode: string;
  localityName: string;
  /** Which of the 68 homonyms. Without it the server picks one nobody chose. */
  localityIndecId: string;
  /** The owner's own note — the reason on marcar perdida, the note on avistaje. */
  note: string;
  /** The incident snapshot the web's wizard collects on its later steps. */
  color: string;
  distinguishingFeatures: string;
  accessoriesWhenLost: string;
  behaviorNotes: string;
  lastSeenContext: string;
  microchipId: string;
  /** The five disclosure toggles, stated rather than inherited. */
  disclosure: {
    discloseFirstNameWhenLost: boolean;
    disclosePhoneWhenLost: boolean;
    discloseEmailWhenLost: boolean;
    discloseLastLocationWhenLost: boolean;
    allowFinderFormWhenLost: boolean;
  };
};

/**
 * A blank draft.
 *
 * THE FIVE TOGGLES START WHERE THE WEB'S WIZARD STARTS THEM, and that is not
 * "all on": publishing an owner's phone to anyone who scans a QR is a decision
 * somebody makes, not a default they discover afterwards. `allowFinderFormWhenLost`
 * is the exception and it is the column's own default (`true`) — it publishes
 * nothing about the owner, it only decides whether a finder can write to them at
 * all, and starting it off would make the fast path useless.
 */
export function emptyLostDraft(): LostDraft {
  return {
    locationDescription: "",
    provinceCode: "",
    localityName: "",
    localityIndecId: "",
    note: "",
    color: "",
    distinguishingFeatures: "",
    accessoriesWhenLost: "",
    behaviorNotes: "",
    lastSeenContext: "",
    microchipId: "",
    disclosure: {
      discloseFirstNameWhenLost: false,
      disclosePhoneWhenLost: false,
      discloseEmailWhenLost: false,
      discloseLastLocationWhenLost: false,
      allowFinderFormWhenLost: true,
    },
  };
}

/** `""` → `null`, so an untouched optional field is "not stated" and not "". */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export type CommandResult =
  | { ok: true; input: LostCommandInput }
  | { ok: false; message: string; code: LostCommandInputCode | null };

function validated(wire: unknown): CommandResult {
  const parsed = lostCommandInputSchema.safeParse(wire);
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstLostCommandInputCode(parsed.error);
  return { ok: false, code, message: lostInputCodeMessage(code) };
}

/**
 * THE JURISDICTION TRIO, or nothing at all.
 *
 * `LocalityPicker` writes all three in one `onSelect` and clears all three in
 * one tap, so a partial set should be impossible — and this refuses it anyway,
 * because the writer falls back to the animal's home jurisdiction FIELD BY
 * FIELD. A province with no locality would route the case to (new province,
 * pet's locality): a pair naming nowhere, on a record an authority acts on.
 * The contract refuses the same shape with `LOST_JURISDICTION_INCOMPLETE`; this
 * is the client not bothering to send a request that cannot be accepted.
 */
function jurisdictionTrio(draft: LostDraft) {
  const provinceCode = orNull(draft.provinceCode);
  const localityName = orNull(draft.localityName);
  const localityIndecId = orNull(draft.localityIndecId);
  const complete = provinceCode !== null && localityName !== null && localityIndecId !== null;
  return complete
    ? { provinceCode, localityName, localityIndecId }
    : { provinceCode: null, localityName: null, localityIndecId: null };
}

/**
 * MARCAR PERDIDA, from the draft.
 *
 * NO COORDINATES, and that is a decision this work unit records rather than
 * hides: the app has no map affordance and no location permission, so it sends
 * the last-seen place as TEXT — which is exactly what an untouched web wizard
 * sends too. The contract's pair is optional and both-or-neither, so adding a
 * pin later is a map widget here and nothing at all on the server.
 *
 * IT DOES SEND A JURISDICTION SINCE 2026-09-11, which is the other half of the
 * same question and a cheaper one to answer: no permission, no map, no GPS —
 * the locality picker this app already ships. Without it the case was opened at
 * the animal's home address no matter where it disappeared, which is the defect
 * the bite form fixed for `record-event` and the same one, here.
 */
export function buildMarkLost(draft: LostDraft): CommandResult {
  const enriched = {
    color: orNull(draft.color),
    distinguishingFeatures: orNull(draft.distinguishingFeatures),
    accessoriesWhenLost: orNull(draft.accessoriesWhenLost),
    behaviorNotes: orNull(draft.behaviorNotes),
    lastSeenContext: orNull(draft.lastSeenContext),
    microchipId: orNull(draft.microchipId),
  };
  const hasEnriched = Object.values(enriched).some((value) => value !== null);

  return validated({
    command: "mark_lost",
    locationDescription: orNull(draft.locationDescription),
    ...jurisdictionTrio(draft),
    reason: orNull(draft.note),
    disclosure: draft.disclosure,
    // OMITTED ENTIRELY when nothing was filled in, rather than sent as six
    // nulls. The writer branches on whether the section exists to decide if it
    // builds a `lost_description`, and a block of nulls is not the same fact as
    // no block.
    enrichedDescription: hasEnriched ? enriched : null,
  });
}

/** ACTUALIZAR EL AVISTAJE, from the draft. */
export function buildReportLastSeen(draft: LostDraft): CommandResult {
  return validated({
    command: "report_last_seen",
    locationDescription: orNull(draft.locationDescription),
    note: orNull(draft.note),
  });
}

export function buildMarkFound(): CommandResult {
  return validated({ command: "mark_found" });
}

export function buildReactivateSearch(): CommandResult {
  return validated({ command: "reactivate_search" });
}

export function buildSetDisclosure(key: DisclosureKey, value: boolean): CommandResult {
  return validated({ command: "set_disclosure", key, value });
}

/**
 * REPORTAR UN MENSAJE, from the row the person tapped.
 *
 * `targetEventId` IS THE FEED ITEM'S OWN `id`, echoed — never constructed. The
 * screen holds the row; the contract holds the uuid rule; nothing here invents
 * an identifier.
 */
export function buildReportContent(
  targetEventId: string,
  category: ContentReportCategory,
  reason: string,
): CommandResult {
  return validated({ command: "report_content", targetEventId, category, reason: orNull(reason) });
}

/**
 * es-AR copy for every input code. Exhaustive: a code added to the contract is
 * a COMPILE error here, the same guarantee `apiErrorMessage` gives for the
 * failure vocabulary.
 */
export function lostInputCodeMessage(code: LostCommandInputCode | null): string {
  if (code === null) {
    // The parse failed on something the contract does not name — a client and a
    // contract out of step. Honest about being unable to say more.
    return "Revisá los datos: hay un campo que la app no pudo interpretar.";
  }
  switch (code) {
    case "COMMAND_REQUIRED":
      return "Esta versión de la app no puede hacer esta acción. Actualizá la app.";
    case "DISCLOSURE_REQUIRED":
      return "Falta elegir qué datos tuyos se muestran mientras la búsqueda esté activa.";
    case "DISCLOSURE_KEY_INVALID":
      return "Esa preferencia no existe. Actualizá la app.";
    case "DISCLOSURE_VALUE_REQUIRED":
      return "No pudimos leer el valor de esa preferencia. Actualizá la app.";
    case "COORDS_INVALID":
      return "La ubicación no se pudo leer.";
    case "COORDS_OUT_OF_RANGE":
      return "La ubicación está fuera de rango.";
    case "COORDS_INCOMPLETE":
      return "Falta una de las dos coordenadas del punto.";
    case "LOST_JURISDICTION_INCOMPLETE":
      // `LocalityPicker` writes its three fields together and clears them
      // together, and `jurisdictionTrio` drops a partial set before it is ever
      // sent — so a person cannot reach this. It means this build and the
      // contract disagree about the shape, which is not a field anybody can go
      // and fix.
      return "Esta versión de la app no pudo enviar la localidad. Actualizá la app.";
    case "REPORT_TARGET_REQUIRED":
      // The app sends the row's own id, so a person can never cause this. It is
      // a build out of step with the contract, and the sentence says so rather
      // than asking somebody to fix a field they never saw.
      return "Esta versión de la app no pudo identificar el mensaje. Actualizá la app.";
    case "REPORT_CATEGORY_INVALID":
      return "Elegí uno de los motivos de la lista.";
    case "REPORT_REASON_TOO_LONG":
      return "El motivo es muy largo. Contalo en 500 caracteres o menos.";
  }
}

/** The sentence shown after a command that CHANGED something. */
export function commandDoneLabel(command: LostCommandInput["command"], petSex: string | null) {
  switch (command) {
    case "mark_lost":
      return "Listo. La credencial pública ya muestra el aviso de búsqueda.";
    case "report_last_seen":
      return "Avistaje registrado.";
    case "mark_found":
      return `Listo. La marcamos como ${foundAdjective(petSex)} y avisamos a quienes la estaban buscando.`;
    case "reactivate_search":
      return "Búsqueda reactivada.";
    case "set_disclosure":
      return "Preferencia guardada.";
    case "report_content":
      // Says the two things a person needs and neither of them is "gracias por
      // reportar": what changed (it is gone from their list) and what did not
      // (the record still has it).
      return "Listo. Ese mensaje ya no aparece en tu búsqueda.";
  }
}

/**
 * The sentence shown when a command changed NOTHING.
 *
 * Said out loud rather than folded into the success copy, because the two are
 * different facts and telling somebody they just did something they did not is
 * how an interface teaches people to distrust it.
 */
export function commandUnchangedLabel(command: LostCommandInput["command"]) {
  switch (command) {
    case "mark_lost":
      // Unreachable: the server refuses an animal already lost rather than
      // answering `changed: false`. Answered anyway because this switch is
      // exhaustive over the command union and a blank line under a button is the
      // failure this file exists to prevent.
      return "No hubo cambios.";
    case "report_last_seen":
      return "Este avistaje ya estaba registrado — no se duplicó.";
    case "mark_found":
      return "Ya estaba marcada como encontrada.";
    case "reactivate_search":
      return "La búsqueda ya estaba activa.";
    case "set_disclosure":
      return "Esa preferencia ya estaba así.";
    case "report_content":
      // Reachable in one real situation: a caretaker and the titular are both
      // looking at the feed and both report the same message. Nothing was
      // written twice and the item is gone either way.
      return "Ese mensaje ya estaba reportado.";
  }
}

/**
 * THE POSTER, and why it is not here.
 *
 * Not an apology and not a TODO: the printable cartel resolves the TITULAR's own
 * name and phone with a query narrower than this screen's guard, filters them
 * through the disclosure preferences, and embeds a server-generated QR — none of
 * which is exposed as JSON. A native copy would be a second implementation of a
 * privacy filter, which is the one kind of duplication this codebase never
 * accepts. Shown to the person rather than left as a gap they hunt for.
 */
export const POSTER_UNAVAILABLE_NOTE =
  "El cartel para imprimir se arma desde la web, en el perfil de tu mascota. Todavía no se puede generar desde la app.";
