// The owner face, turned into es-AR sentences.
//
// PURE. No React, no React Native, no fetch — the same discipline
// `credential-view-model.ts` keeps, and for the same reason: every label rule
// below is a product decision, and a product decision that can only be checked
// by rendering a screen is one that drifts.
//
// WHAT THIS FACE IS. Not the credential. `/pets/{token}/credential` is the
// anonymous public document and renders identically for the owner and for a
// stranger who scanned the QR. This is what the person RESPONSIBLE for the
// animal sees. Since the two-face rewrite the public document is a ROUTE one
// tap from this face's QR block; neither replaces the other.

import type {
  CredentialSection,
  OwnerPetAlertV1,
  OwnerPetBannersSection,
  OwnerPetCarouselSection,
  OwnerPetCaseV1,
  OwnerPetCasesSection,
  OwnerPetComplianceSection,
  OwnerPetDetailV1,
  OwnerPetDetailViewerRole,
  OwnerPetIdentitySection,
  OwnerPetObligationCardV1,
  OwnerPetPppRegistriesSection,
  OwnerPetPregnancySection,
  OwnerPetRemindersSection,
  OwnerPetStatusSection,
  VaccineReminderCommandAckV1,
} from "@dim/contract/api";
import type { PetProfileIconName } from "@dim/contract/icons";
import type {
  VaccineReminderCommandInput,
  VaccineReminderCommandInputCode,
} from "@dim/contract/input";
import {
  firstVaccineReminderCommandInputCode,
  vaccineReminderCommandInputSchema,
} from "@dim/contract/input";
import {
  type DerivedPetAction,
  PET_ACTION_INERT_CAPTIONS,
  type PetActionContext,
  type PetActionGroupId,
  type PetActionId,
  derivePetActions,
  findPetAction,
} from "@dim/contract/reference";

import { dateInputToIso } from "../ui/date-input";
import { unknownEnumLabel } from "../ui/enum-label";
import {
  caretakerPetRoute,
  editPetRoute,
  lostModeRoute,
  petPhotoRoute,
  physicalTagInterestRoute,
  recordEventRoute,
  rehomeRoute,
  returnPetRoute,
  serviceDogRoute,
  sharesRoute,
  transferPetRoute,
  travelRoute,
  vaccineRemindersRoute,
} from "../ui/routes";

/** The es-AR sentence every unavailable section shows. Decided once. */
export const SECTION_UNAVAILABLE_MESSAGE = "No se pudo leer esta sección.";

export type SectionView<T> = { state: "ok"; data: T } | { state: "unavailable"; message: string };

/**
 * A section, as the renderer sees it.
 *
 * The `unavailable` arm carries its copy rather than a bare tag so a screen
 * cannot render the failure as an empty view without noticing it threw a string
 * away. `unavailable` means the server could not read it — NOT that it is empty,
 * and the difference is the whole reason the wrapper exists.
 */
export function sectionView<T>(section: CredentialSection<T>): SectionView<T> {
  return section.status === "ok"
    ? { state: "ok", data: section.data }
    : { state: "unavailable", message: SECTION_UNAVAILABLE_MESSAGE };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/**
 * The alert strip's copy.
 *
 * ORDER IS NOT DECIDED HERE. The server sends the list already ranked, and a
 * client that sorts it has reimplemented a product decision whose reasons it
 * cannot see. This maps an id to a sentence and nothing else.
 */
export function alertHeadline(alert: OwnerPetAlertV1): string {
  switch (alert.id) {
    case "lost":
      return "Está reportada como perdida";
    case "rabies":
      return "Observación antirrábica abierta";
    case "transit":
      return "La estás cuidando en tránsito";
    case "caretaker":
      return "Hay un cuidador designado";
    case "rehome":
      return "Está en búsqueda de un nuevo hogar";
    case "open-cases":
      return "Tiene trámites abiertos";
    case "pregnancy":
      return "Está preñada";
    default:
      // An alert id the client does not know is a payload from a newer server.
      // The row is still shown — an alert the owner cannot see is worse than one
      // they cannot fully read — but the raw id is NOT: `open-cases` in
      // parentheses is an internal identifier in a citizen's wallet, and it told
      // them nothing the sentence does not already say. See `ui/enum-label.ts`.
      return unknownEnumLabel(alert.id, "Tiene un aviso que esta versión no sabe mostrar");
  }
}

/** Maps the strip's tone onto the kit's callout tones. */
export function alertTone(alert: OwnerPetAlertV1): "err" | "warn" | "neutral" {
  if (alert.tone === "urgent") return "err";
  if (alert.tone === "warning") return "warn";
  return "neutral";
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

/**
 * How the viewer holds this animal, in words — or NOTHING, when the viewer is
 * the titular.
 *
 * The line exists because a caretaker or a foster reading this face needs to
 * know WHY some things are missing from it: the arrangements a titular made are
 * not theirs to see, and an unexplained gap reads as a bug.
 *
 * THAT REASON DOES NOT REACH THE TITULAR, and this is the one case where it
 * does not. Nothing is missing from their own document, so "Sos el titular"
 * answers a question they never asked — it is simply true, on every pet they
 * own, forever, in the most prominent line of the screen. A label that cannot
 * vary carries no information; it only spends the space above the credential.
 * PO decision 2026-09-15, and the same call this file's neighbour already made:
 * the "Ficha del dueño" eyebrow was deleted from `PetDocumentScreen` on
 * 2026-09-03 for the identical reason, and its tombstone comment is still there.
 *
 * `null` and not an empty string: the caller must decide not to RENDER the row,
 * rather than render an empty one that still occupies its margins.
 */
export function viewerRoleLabel(role: OwnerPetDetailViewerRole): string | null {
  switch (role) {
    case "owner":
      return null;
    case "co_owner":
      return "Sos cotitular";
    case "foster":
      return "La tenés en tránsito";
    case "caretaker":
      return "Sos su cuidador";
    case "org_member":
      return "La ves como miembro de la organización";
    default:
      // A role from a newer server. The sentence still answers the question the
      // line exists for — WHY parts of this face are missing — without printing
      // `org_member`-shaped English at somebody. See `ui/enum-label.ts`.
      return unknownEnumLabel(role, "Tenés acceso a esta mascota");
  }
}

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

/**
 * The stamp's word.
 *
 * SIN DATO is not a temporal word, and that distinction is load-bearing: when
 * the most urgent card is a missing FACT, stamping "POR VENCER" over it borrows
 * a deadline that does not exist. The server already decided which case this is
 * (`worstIsUnknown`); this only prints it.
 */
export function complianceStampLabel(compliance: OwnerPetComplianceSection): string {
  if (compliance.worstIsUnknown) return "SIN DATO";
  switch (compliance.worstTone) {
    case "ok":
      return "AL DÍA";
    case "due":
      return "POR VENCER";
    case "over":
      return "VENCIDA";
    case "reserved":
      return "TURNO RESERVADO";
    default:
      return "SIN DATO";
  }
}

/**
 * The count line, or an honest note when the jurisdiction has no obligations
 * loaded. `total === 0` is not "0 de 0 al día" — it is "we have no rules for
 * here yet", which is a different thing to tell an owner.
 */
export function complianceSummaryLabel(compliance: OwnerPetComplianceSection): string {
  if (compliance.summary.total === 0) return "Sin obligaciones cargadas para tu jurisdicción";
  return compliance.summary.label;
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/** "Vence hoy" / "Vence en 3 días" / "Venció hace 2 días". Never a bare number. */
export function reminderDueLabel(daysUntilDue: number): string {
  if (daysUntilDue === 0) return "Vence hoy";
  if (daysUntilDue === 1) return "Vence mañana";
  if (daysUntilDue > 1) return `Vence en ${daysUntilDue} días`;
  const overdue = Math.abs(daysUntilDue);
  return overdue === 1 ? "Venció ayer" : `Venció hace ${overdue} días`;
}

// ---------------------------------------------------------------------------
// Reminders — the writes (`POST /pets/{token}/reminders`)
// ---------------------------------------------------------------------------
//
// The face could READ this section since it was built and could do nothing
// about it. What follows is the pure half of the two operations the web has
// on the same card — "Programar vacuna" and "Eliminar" — worded as the web
// words them, validated by the CONTRACT's own schema rather than restated.

/* `RemindersOffer`, `remindersOffer` and `remindersOfferLabel` were DELETED on
 * 2026-09-16 with the door they worded. They existed to label one button — the
 * card's "Programar vacuna" / "Programar o eliminar" — and to keep `unknown`
 * apart from `none` so a failed read could not hide that button. The PO moved
 * the door into the Más sheet, where the row is unconditional and its label is
 * static, so all three had exactly one consumer left: their own test.
 *
 * They are removed rather than kept "in case": a function whose only caller is
 * its test reads as covered code and is dead code, and this repo has paid for
 * that confusion before. The REASONING survives where it still applies —
 * RemindersCard's docblock explains why the `unavailable` arm still renders,
 * which is the same argument `unknown` used to carry. */

/** The web's own empty line on the same card (`PetReminders.tsx`). */
export const REMINDERS_EMPTY_LINE = "Sin próximas vacunas.";
export const REMINDERS_EMPTY_HINT =
  "Programá un recordatorio y te avisamos cuando se acerque la fecha.";

/** What the form holds before it is a command. `dueAt` is `DD/MM/AAAA`. */
export type ScheduleReminderDraft = {
  vaccineName: string;
  dueAt: string;
  description: string;
};

export const EMPTY_SCHEDULE_REMINDER_DRAFT: ScheduleReminderDraft = {
  vaccineName: "",
  dueAt: "",
  description: "",
};

export type ScheduleReminderResult =
  | { ok: true; input: VaccineReminderCommandInput }
  | { ok: false; code: VaccineReminderCommandInputCode | null; message: string };

/**
 * One sentence per input code. The first two are the web's own
 * (`createVaccineReminder`), so a person who has used both surfaces reads the
 * same refusal on each.
 */
export function scheduleReminderInputCodeMessage(
  code: VaccineReminderCommandInputCode | null,
): string {
  switch (code) {
    case "VACCINE_NAME_REQUIRED":
      return "Falta el nombre de la vacuna.";
    case "DUE_AT_REQUIRED":
      return "Falta la fecha estimada.";
    case "DUE_AT_MALFORMED":
      return "Escribí la fecha estimada como DD/MM/AAAA.";
    case "DUE_AT_INVALID":
      return "Esa fecha no existe en el calendario. Revisá el día y el mes.";
    case "REMINDER_ID_REQUIRED":
    case "COMMAND_REQUIRED":
    case null:
      return "No pudimos armar el recordatorio. Volvé a cargar los datos.";
  }
}

/**
 * PROGRAMAR UNA VACUNA, from the form's three answers.
 *
 * The date crosses `dateInputToIso` at this boundary and nowhere else: the
 * field shows `DD/MM/AAAA`, the contract wants `YYYY-MM-DD`, and whether the
 * result is a real calendar day is the schema's call (`isRealArDay`), not
 * this function's. The description is trimmed to `null`, like every optional
 * free-text field on this surface.
 */
export function buildScheduleReminder(draft: ScheduleReminderDraft): ScheduleReminderResult {
  const parsed = vaccineReminderCommandInputSchema.safeParse({
    command: "create_vaccine_reminder",
    vaccineName: draft.vaccineName,
    dueAt: dateInputToIso(draft.dueAt),
    description: draft.description.trim() || null,
  });
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstVaccineReminderCommandInputCode(parsed.error);
  return { ok: false, code, message: scheduleReminderInputCodeMessage(code) };
}

/** ELIMINAR, by the row id the face already holds. */
export function buildCancelReminder(reminderId: string): VaccineReminderCommandInput {
  return { command: "cancel_vaccine_reminder", reminderId };
}

/** What the screen says once the reminder is on the books. */
export function reminderScheduledMessage(vaccineName: string): string {
  return `Listo. Te vamos a avisar cuando se acerque la fecha de ${vaccineName.trim()}.`;
}

/**
 * What the screen says after a cancel — and BOTH arms are a success.
 *
 * `changed: false` is the server saying the row was already gone: a second
 * tap, or a retry after a lost response. The web's own delete answers that
 * replay identically to the first, and a screen that rendered it as "no hay
 * recordatorio que eliminar" would tell somebody their cancel failed when it
 * is precisely what they asked for that already happened.
 */
export function reminderCancelledMessage(
  ack: Extract<VaccineReminderCommandAckV1, { command: "cancel_vaccine_reminder" }>,
): string {
  return ack.changed
    ? "Listo. El recordatorio quedó eliminado."
    : "Ese recordatorio ya estaba eliminado.";
}

/**
 * The note under a truncated list.
 *
 * A list that shows some of what exists must SAY so. The alternative — showing
 * eight of fourteen silently — is the bug the web carousel already had once,
 * where the dots disagreed with the index and nobody could tell which was lying.
 */
export function truncationNote(shown: number, total: number, noun: string): string | null {
  if (shown >= total) return null;
  return `Mostrando ${shown} de ${total} ${noun}.`;
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

export function caretakerBannerLines(banners: OwnerPetBannersSection): string[] {
  const caretaker = banners.caretaker;
  if (!caretaker) return [];
  const lines: string[] = [];
  switch (caretaker.state) {
    case "active":
      lines.push(
        caretaker.caretakerName
          ? `${caretaker.caretakerName} la está cuidando.`
          : "Hay un cuidador activo.",
      );
      break;
    case "pending":
      lines.push("Hay una invitación de cuidado sin responder.");
      break;
    case "recently_ended":
      lines.push("El cuidado terminó hace poco.");
      break;
  }
  // KEY 2 of the two-key public-contact model. The row exists ONLY when the
  // caretaker consented at invitation accept; without consent there is nothing
  // to offer, and a switch that cannot do anything is a lie in the shape of a
  // control.
  if (caretaker.publicContactName) {
    lines.push(`${caretaker.publicContactName} figura como contacto público.`);
  }
  return lines;
}

export function rehomeBannerLine(banners: OwnerPetBannersSection): string | null {
  const rehome = banners.rehome;
  if (!rehome) return null;
  const org = rehome.orgDisplayName ?? "la organización";
  return rehome.kind === "pending"
    ? `Hay una propuesta de adopción pendiente con ${org}.`
    : `${org} está buscándole un nuevo hogar.`;
}

export function transitBannerLine(banners: OwnerPetBannersSection): string | null {
  if (!banners.transit) return null;
  // The vecino who picked up a stray gets the same sentence; what they do NOT
  // get are the org-mediated actions, which the web withholds for the same
  // reason (they would dead-end without an organization behind them).
  return "La tenés en tránsito. Las acciones de tránsito se hacen desde la web.";
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export function casesLine(cases: OwnerPetCasesSection): string {
  if (cases.openCount === 0) return "No tiene trámites abiertos.";
  const noun = cases.openCount === 1 ? "trámite abierto" : "trámites abiertos";
  // `truncated` means the read hit its cap, so the count is a FLOOR. Saying
  // "al menos" is the difference between a number and a guess wearing a number's
  // clothes.
  return cases.truncated ? `Al menos ${cases.openCount} ${noun}.` : `${cases.openCount} ${noun}.`;
}

/**
 * The es-AR label for a case kind.
 *
 * A TRANSLATION of the wire vocabulary and nothing more — the server already
 * decided WHICH cases this person may see, and the phone does not get to add or
 * subtract from that list. The strings are `caseKindLabel`'s
 * (src/modules/cases/domain/case-kinds.ts), so the same expediente reads the
 * same way in a browser and on a phone; a person quoting a case to a sanitary
 * authority should not have to translate between two of our own surfaces.
 *
 * `other` is the contract's own fallback for a kind outside the union. It says
 * "Otro trámite" rather than printing a raw key, which is the same choice the
 * payload made when it clamped the string.
 */
export function caseKindLabel(kind: OwnerPetCaseV1["kind"]): string {
  switch (kind) {
    case "bite_incident":
      return "Mordedura / observación rábica";
    case "adoption_listing":
      return "Publicación en adopción";
    case "adoption_application":
      return "Postulación de adopción";
    case "custody_dispute":
      return "Disputa de custodia";
    case "foster_placement":
      return "Tránsito asignado";
    case "custody_episode":
      return "Custodia temporal";
    case "custody_transfer_handshake":
      return "Transferencia de custodia";
    case "foster_proposal":
      return "Propuesta de tránsito";
    case "outbreak_investigation":
      return "Investigación de brote";
    case "microchip_remediation":
      return "Remediación de microchip";
    case "rehome_request":
      return "Solicitud de nuevo hogar";
    default:
      return "Otro trámite";
  }
}

/** The es-AR label for a case status. `CASE_STATUS_CONFIG`'s words, verbatim. */
export function caseStatusLabel(status: OwnerPetCaseV1["status"]): string {
  return status === "escalated" ? "Escalado" : "Abierto";
}

/**
 * One open case as the phone prints it: `CAS-XXXX-XXXX · Mordedura · Abierto`.
 *
 * The SAME three fields in the SAME order as the web's `CaseBadge`, because
 * this line exists so a person can read the code back to whoever asks for it.
 * The screen draws it as the link to the app's own case screen (M11).
 */
export function caseLine(item: OwnerPetCaseV1): string {
  return `${item.casePublicCode} · ${caseKindLabel(item.kind)} · ${caseStatusLabel(item.status)}`;
}

// ---------------------------------------------------------------------------
// The whole face
// ---------------------------------------------------------------------------

export type OwnerFaceView = {
  publicToken: string;
  /** `null` for a titular reading their own document — see `viewerRoleLabel`. */
  viewerLabel: string | null;
  /** The raw viewer role — the panel's catalogue reads it (`ownerPanelView`):
   *  which rows exist for this viewer, and which are grey and why. */
  viewerRole: OwnerPetDetailViewerRole;
  isTitular: boolean;
  /**
   * The server's "Editar datos" verdict (`viewer.canEditProfile`), or `null`
   * when a server older than the field did not send it — the catalogue then
   * falls back to the role. It is what lets the vecino en tránsito (reported
   * as `caretaker`) edit while the animal has no titular (PO 2026-10-01).
   */
  canEditProfile: boolean | null;
  identity: SectionView<OwnerPetIdentitySection>;
  status: SectionView<OwnerPetStatusSection>;
  alerts: SectionView<{ items: OwnerPetAlertV1[] }>;
  compliance: SectionView<OwnerPetComplianceSection>;
  reminders: SectionView<OwnerPetRemindersSection>;
  banners: SectionView<OwnerPetBannersSection>;
  cases: SectionView<OwnerPetCasesSection>;
  pregnancy: SectionView<OwnerPetPregnancySection>;
  carousel: SectionView<OwnerPetCarouselSection>;
  /**
   * Whether the PPP regime applies to THIS animal, and which registries its
   * jurisdiction names.
   *
   * CARRIED ON THE FACE ONLY SO THE DOOR CAN BE GATED. Nothing on the document
   * prints a registry — the attestation FORM resolves its own list from the
   * same section (`RecordEventScreen`'s `useOwnerPetFacts`). What the face
   * needs is the one fact the contract says to read here: `data: null` means
   * "not under the regime", and the contract's own docblock asks a client to
   * gate the attestation door on that field "instead of pattern-matching a
   * compliance card's label".
   */
  pppRegistries: SectionView<OwnerPetPppRegistriesSection>;
  /**
   * When the server composed this read, from the payload ENVELOPE rather than
   * from any one section — so it survives a section that failed, which is the
   * point: the credential's foot states when the document was issued, and a
   * document that cannot say that is not one.
   */
  issuedAt: string;
};

// ---------------------------------------------------------------------------
// What the panel below the card offers (owner-pet-actions, PO plan 2026-10-01)
// ---------------------------------------------------------------------------
//
// WHO GETS WHICH ROW IS NOT DECIDED HERE ANY MORE. Until owner-pet-actions this
// file computed `ownerFaceGates`, the app's copy of the web's row gates, beside
// the two copies the web kept (`MasSheet.helpers.ts` and the Anotar catalogue's
// "Perfil" category). Three copies of one rule is how they came to disagree, and
// each was internally consistent, so no test could see it. The rule now lives
// once, in the contract — `derivePetActions` in `@dim/contract/reference`, with
// its own gate matrix — and both platforms draw from it: live, grey with a
// reason, or absent.
//
// WHAT IS LEFT FOR THIS FILE is what is genuinely the app's:
//   · the CONTEXT the catalogue reads, off this payload's sections, where an
//     unread section is "no fact" and never "not active" (the catalogue's rule,
//     and the one `ownerFaceGates` founded);
//   · the DESTINATIONS, as an exhaustive record over `PetActionId`, so an action
//     added to the catalogue fails to compile here until somebody says where it
//     goes on a phone;
//   · the one row this build has NO screen for — the foster's "Buscar hogar" —
//     drawn grey with the catalogue's own `web_only` caption, never a browser.

/**
 * The sections the panel reads. A narrow pick, so a test can build one without
 * a whole face and the panel cannot quietly start reading a section it does not
 * declare.
 */
export type OwnerPanelSource = Pick<
  OwnerFaceView,
  | "publicToken"
  | "viewerRole"
  | "isTitular"
  | "canEditProfile"
  | "status"
  | "identity"
  | "pppRegistries"
>;

/**
 * Where a tap goes, in the shape `router.push` takes. The object form carries
 * the animal's name to the two screens that open addressed by it ("Transferir a
 * Pampa"); an identity read that failed sends empty params rather than a name
 * nobody read.
 */
export type PanelTarget = string | { pathname: string; params: { name?: string } };

export type OwnerPanelRow = {
  id: PetActionId;
  label: string;
  /** What the row does, for a screen reader. */
  hint: string;
  /** The reason under a grey row, a live row's standing note, or `null`. */
  caption: string | null;
  /** The primary row's glyph; `null` for the rows of the groups. */
  icon: PetProfileIconName | null;
  tone: "default" | "danger";
  /**
   * `null` = the row is drawn INERT: grey, announcing `disabled`, with its
   * caption saying why. Never omitted for that reason — absence is the
   * catalogue's call, not this file's.
   */
  target: PanelTarget | null;
};

export type OwnerPanelGroup = {
  id: PetActionGroupId;
  /** `null` for the closing group, drawn as a separator rather than a category. */
  heading: string | null;
  rows: OwnerPanelRow[];
};

export type OwnerPanelView = {
  /** The row directly under the card: Anotar, Compartir, Modo perdida. */
  primary: OwnerPanelRow[];
  /** Only the groups with at least one row, in panel order. */
  groups: OwnerPanelGroup[];
  /** The compliance card's "Registrar atestación" door. Never a panel row (PO). */
  attestationDoor: boolean;
  /**
   * The photo frame's door: the Foto row's own target, so the frame and the row
   * cannot disagree about who may change the picture. `null` where the panel has
   * no Foto row at all (the organization path).
   */
  photoTarget: PanelTarget | null;
};

/** The catalogue's context, read off this payload. `null` = the section did not load. */
function panelContext(view: OwnerPanelSource): PetActionContext {
  return {
    viewerRole: view.viewerRole,
    isTitular: view.isTitular,
    canEditProfile: view.canEditProfile,
    petStatus: view.status.state === "ok" ? view.status.data.petStatus : null,
    species: view.identity.state === "ok" ? view.identity.data.species : null,
    // `data: null` is the contract's own "this animal is not under the regime";
    // an unread section stays `null`, which the catalogue reads as a CLOSED door.
    pppDoor: view.pppRegistries.state === "ok" ? view.pppRegistries.data !== null : null,
  };
}

/** A screen of this app, or the admission that the action has none here yet. */
type NativeDestination = { kind: "screen"; target: PanelTarget } | { kind: "web_only" };

type DestinationInput = {
  publicToken: string;
  petName: string | null;
  viewerRole: OwnerPetDetailViewerRole;
};

function toScreen(target: PanelTarget): NativeDestination {
  return { kind: "screen", target };
}

function named(pathname: string, petName: string | null): PanelTarget {
  return { pathname, params: petName === null ? {} : { name: petName } };
}

/**
 * Where each action goes on a phone.
 *
 * A `Record` OVER EVERY `PetActionId`, so the catalogue cannot grow a row the
 * app has not placed: a new id is a compile error here, the same way the web's
 * own destination table fails on its side.
 *
 * Every route below is the screen the old "Más" list already opened, with two
 * changes the PO plan asked for: "Contactos de emergencia" now opens Editar
 * datos ON ITS SECTION (`?seccion=contactos`) instead of at the top of a form
 * about something else, and "Credencial pública" is gone — it was the QR tap
 * again, one row down.
 */
const NATIVE_DESTINATIONS: Readonly<
  Record<PetActionId, (input: DestinationInput) => NativeDestination>
> = {
  record: (i) => toScreen(recordEventRoute(i.publicToken)),
  share: (i) => toScreen(sharesRoute(i.publicToken)),
  lost: (i) => toScreen(lostModeRoute(i.publicToken)),
  edit: (i) => toScreen(editPetRoute(i.publicToken)),
  photo: (i) => toScreen(petPhotoRoute(i.publicToken)),
  contacts: (i) => toScreen(editPetRoute(i.publicToken, { seccion: "contactos" })),
  service_dog: (i) => toScreen(serviceDogRoute(i.publicToken)),
  physical_tag: (i) => toScreen(physicalTagInterestRoute(i.publicToken)),
  vaccine_reminders: (i) => toScreen(vaccineRemindersRoute(i.publicToken)),
  travel: (i) => toScreen(travelRoute(i.publicToken)),
  caretaker: (i) => toScreen(named(caretakerPetRoute(i.publicToken), i.petName)),
  return: (i) => toScreen(returnPetRoute(i.publicToken)),
  // ONE DESTINATION ON THE WEB, TWO ASKS. The titular's "Acompañamiento de
  // adopción" is `RehomeScreen` (`GET|POST /pets/{token}/rehome`). The foster's
  // "Buscar hogar" is `foster`'s `sendRehomeRequest`, a different action with
  // no v1 route yet (a named follow-up of this change), so it stays grey — and
  // never opens a browser: a tester sent out of the app mid-flow does not come
  // back (PO, 2026-09-11).
  find_home: (i) =>
    i.viewerRole === "foster" ? { kind: "web_only" } : toScreen(rehomeRoute(i.publicToken)),
  transfer: (i) => toScreen(named(transferPetRoute(i.publicToken), i.petName)),
  // NOT the picker: the picker and this form differ only in `?kind=death`, and
  // a terminal act is not one more option among the routine ones.
  death: (i) => toScreen(recordEventRoute(i.publicToken, { kind: "death" })),
};

function panelRow(action: DerivedPetAction, input: DestinationInput): OwnerPanelRow {
  const base = {
    id: action.id,
    label: action.label,
    hint: action.hint,
    icon: action.icon,
    tone: action.tone,
  };
  if (action.state.kind === "inert") return { ...base, caption: action.caption, target: null };
  const destination = NATIVE_DESTINATIONS[action.id](input);
  if (destination.kind === "web_only") {
    return { ...base, caption: PET_ACTION_INERT_CAPTIONS.web_only, target: null };
  }
  return { ...base, caption: action.caption, target: destination.target };
}

/** The whole panel for this face: the catalogue's rows, with this app's doors behind them. */
export function ownerPanelView(view: OwnerPanelSource): OwnerPanelView {
  const derived = derivePetActions(panelContext(view));
  const input: DestinationInput = {
    publicToken: view.publicToken,
    petName: view.identity.state === "ok" ? view.identity.data.name : null,
    viewerRole: view.viewerRole,
  };
  const photo = findPetAction(derived, "photo");
  return {
    primary: derived.primary.map((action) => panelRow(action, input)),
    groups: derived.groups.map((group) => ({
      id: group.id,
      heading: group.heading,
      rows: group.actions.map((action) => panelRow(action, input)),
    })),
    attestationDoor: derived.attestationDoor,
    photoTarget: photo === null ? null : panelRow(photo, input).target,
  };
}

/**
 * Does THIS obligation card carry the attestation door?
 *
 * A FUNCTION AND NOT AN INLINE CONDITION IN THE RENDERER, for the reason
 * finding F6 gave about the "Editar datos" row: a rule read off one source
 * everywhere except in one component that re-derives it is a rule with two
 * homes. WHO may file comes from the catalogue (`ownerPanelView`'s
 * `attestationDoor`, owner-pet-actions); WHICH card carries the door is this.
 * It is also the only way to test the placement without rendering.
 *
 * `tone === "ok"` IS "ALREADY ATTESTED, AND IT COUNTS" — which since T4-I1 /
 * #753 is a narrower thing than "an attestation exists". `derivePpp` now gives
 * this card THREE states, not two:
 *
 *   "Atestación requerida" · due     — nothing on record
 *   "Declarada"            · neutral — an attestation exists but cites no
 *                                      inscription number and carries no
 *                                      institutional signature, so it does not
 *                                      clear the obligation
 *   "Atestada"             · ok      — it counts
 *
 * The door is correctly OPEN on the middle one, and that is not an accident of
 * the `!== "ok"` test: the remedy for a Declarada card is to file an
 * attestation that DOES cite the number, and this door is the only way to file
 * one — the card's hint says exactly that. The web twin
 * (`showPppRegister` in components/pet-profile/ComplianceObligationsPanel.tsx)
 * reads the same `tone` for the same reason, so the two surfaces answer alike.
 *
 * Reading the TONE rather than the Spanish copy is what let this survive a
 * change that ADDED a state: the label moved, the structured fact did not. The
 * previous version of this docblock said the rule was "only where the card
 * reads 'Atestación requerida'"; that sentence is now false and the code it
 * described was nearly right.
 *
 * NEARLY, because `tone !== "ok"` alone also matches the FOURTH card `derivePpp`
 * can return: "Faltan datos" · due, the indeterminado nudge for a dog whose
 * breed or weight is unknown. That dog is not yet KNOWN to be PPP, so offering
 * to register it in the dangerous-breed registry answers a question nobody has
 * asked — and the web twin excluded it all along, via `card.dataUnknown`. The
 * same flag crosses the wire on `OwnerPetObligationCardV1`, so the exclusion is
 * spelled here too and the two surfaces answer alike on all four states.
 */
export function isAttestationDoorCard(
  card: OwnerPetObligationCardV1,
  attestationDoor: boolean,
): boolean {
  return attestationDoor && card.key === "ppp" && card.tone !== "ok" && !card.dataUnknown;
}

/**
 * The two web pages the "Más" sheet hands off to, absolute.
 *
 * THE ROWS ALREADY SAID "Disponible en la web" AND THEN DID NOTHING. Both were
 * rendered with no `onPress`, which draws `ListRow`'s inert arm — a row that
 * announces its own unavailability and is then indistinguishable from a broken
 * button. Of the three ways out, this is the only one that keeps a promise
 * already printed on the row: the capability genuinely exists, on the web, at
 * these two paths. Rendering them as plain text would delete an affordance the
 * person really has; leaving them inert was the worst of the three.
 *
 * THE CALLER'S GATES WOULD BE WHAT MAKES THE LINK SAFE: a deceased animal has
 * neither row, whose destinations the web suppresses too, and the foster's
 * "Buscar hogar" is the foster's alone because `buscar-hogar/page.tsx`
 * `notFound()`s every other role. Since owner-pet-actions those gates are the
 * contract's catalogue (`derivePetActions`), and the foster's row is drawn grey
 * with its `web_only` caption (`ownerPanelView`). A link that 404s is worse than
 * an inert row.
 *
 * NOT IN `deepLinkMap`, and that is the table's own rule rather than an
 * omission: "A destination belongs here when something OUTSIDE the rendering
 * surface has to name it" — a QR, a notification, an invitation. These are one
 * surface handing off to another, which is the case the table's header
 * explicitly declines ("putting 400 routes in this table would make it a
 * second, worse copy of the file system router"). `claimDisputeUrl` in
 * `claims/claim-view-model.ts` was the precedent until D6 moved the disputa
 * into the app and retired it.
 *
 * TRAILING SLASHES ARE STRIPPED because `API_BASE_URL` is the one the caller
 * passes and an origin from the environment may carry one.
 */
function webPetPage(origin: string, publicToken: string, page: string): string {
  return `${origin.replace(/\/+$/, "")}/mis-mascotas/${encodeURIComponent(publicToken)}/${page}`;
}

/** Ordering a physical tag — the web's `chapita` page. */
// NEITHER OF THE TWO BUILDERS BELOW IS WIRED TO A ROW TODAY (2026-09-11), and
// that is a product decision rather than an oversight. "Chapa física" and
// "Buscar hogar" used to open the browser; during the closed pilot they render
// as inert rows that say where the thing lives, because a tester sent out to a
// browser mid-flow does not come back and the pilot is measured in people who
// keep using the app.
//
// Kept rather than deleted: the decision is scoped to the pilot, the builders
// are three lines each, and rewriting a URL from memory later is how a token
// ends up in the wrong path segment. Their tests are the only callers right
// now, and those tests say so in their own describe.
export function petTagWebUrl(origin: string, publicToken: string): string {
  return webPetPage(origin, publicToken, "chapita");
}

/**
 * The FOSTER's rehome ask — the web's `buscar-hogar` page.
 *
 * NOT `RehomeScreen`, and the distinction is load-bearing. The titular's
 * "Acompañamiento de adopción" row below shipped native on 2026-09-10 against
 * `GET|POST /pets/{token}/rehome`; this row is the foster's, whose ask is a
 * different action in a different module (`foster`'s `sendRehomeRequest`) with
 * no native endpoint. Same page on the web, two audiences, and only one of them
 * has a screen here.
 */
export function findHomeWebUrl(origin: string, publicToken: string): string {
  return webPetPage(origin, publicToken, "buscar-hogar");
}

export function buildOwnerFaceView(payload: OwnerPetDetailV1): OwnerFaceView {
  return {
    publicToken: payload.publicToken,
    issuedAt: payload.issuedAt,
    viewerLabel: viewerRoleLabel(payload.viewer.role),
    viewerRole: payload.viewer.role,
    isTitular: payload.viewer.isTitular,
    // Absent from an older server: `null`, the catalogue's "no verdict".
    canEditProfile: payload.viewer.canEditProfile ?? null,
    identity: sectionView(payload.identity),
    status: sectionView(payload.status),
    alerts: sectionView(payload.alerts),
    compliance: sectionView(payload.compliance),
    reminders: sectionView(payload.reminders),
    banners: sectionView(payload.banners),
    cases: sectionView(payload.cases),
    pregnancy: sectionView(payload.pregnancy),
    carousel: sectionView(payload.carousel),
    pppRegistries: sectionView(payload.pppRegistries),
  };
}
