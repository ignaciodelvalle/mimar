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
import type {
  VaccineReminderCommandInput,
  VaccineReminderCommandInputCode,
} from "@dim/contract/input";
import {
  firstVaccineReminderCommandInputCode,
  vaccineReminderCommandInputSchema,
} from "@dim/contract/input";

import { dateInputToIso } from "../ui/date-input";
import { unknownEnumLabel } from "../ui/enum-label";

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

/**
 * The registration badge's word, gender-agreed with the animal's recorded sex —
 * the same rule the web's `registeredAdjective` (lib/utils/format.ts) applies
 * to the identical badge. Presentational agreement, not a state decision: the
 * STATE (active) comes from the payload.
 */
export function registeredBadgeWord(sex: string | null): string {
  if (sex === "male") return "Registrado";
  if (sex === "female") return "Registrada";
  return "Registrado/a";
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
  /** The raw viewer role — the disabled-row gates key off it (a dead control
   *  has no server to refuse it, so the client mirrors the web's own gates). */
  viewerRole: OwnerPetDetailViewerRole;
  isTitular: boolean;
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
// What the face may offer (A3-documento-credencial-04)
// ---------------------------------------------------------------------------

/**
 * The web's own action gates, computed from the two facts the payload carries
 * and this face was ignoring: `status.data.petStatus` and who the viewer is.
 *
 * WHAT WAS WRONG. The footer gated on `viewerRole` for the ORG path only, so a
 * titular whose animal is registered as fallecida was offered a red "Modo
 * perdida" pill and "Transferir la titularidad" — the second answers 409 "Abrí
 * su ficha para ver por qué" while the person IS in the ficha — and a co-owner,
 * a foster or the neighbour caring for the dog filled in the whole transfer form
 * before a refusal the browser never lets them reach. Two "Disponible en la web"
 * rows pointed at pages the web hides for a deceased animal, which is worse than
 * a dead row: it is a promise about somewhere else.
 *
 * THE GATES ARE THE WEB'S, LINE FOR LINE. `PetActionRow.tsx:43-67` for the row
 * (person path AND not deceased for Anotar/Editar; plus `petStatus === "active"`
 * for Marcar como perdida) and `MasSheet.helpers.ts:67-118` for the sheet (the
 * deceased early-return keeps corrections and who-to-call and nothing else;
 * Transferir and Cuidador require `ownershipRole === "owner"` AND an active
 * animal). `isTitular` IS that `ownershipRole === "owner"` — the contract says
 * so and says a co-owner is deliberately false there.
 *
 * MODO PERDIDA IS THE ONE DELIBERATE DIVERGENCE. The web drops it on a LOST
 * animal because "Marcar como encontrada" lives prominently in its
 * `LostCaseBlock`; this app has no such block — the row IS the cockpit for both
 * directions — so it stays for `lost` and goes only for `deceased`.
 *
 * A FAILED STATUS READ TAKES NOTHING AWAY. `unavailable` means the server could
 * not read the section, which is this file's founding distinction, so an outage
 * must not remove a control: the client gates only on what it KNOWS, and the
 * server refusal is still the backstop it always was.
 */
export type OwnerFaceGates = {
  /** KNOWN to be fallecida. False while the status section failed to load. */
  isDeceased: boolean;
  /**
   * KNOWN to be in a situation other than `active` — lost or deceased. An
   * UNREAD status is neither `isDeceased` nor this: both are phrased as "the
   * server said so", which is what keeps an outage from removing a control.
   */
  isNotActive: boolean;
  /** `ownershipRole === "owner"`: a co-owner is deliberately NOT one. */
  isTitular: boolean;
  canRecordEvent: boolean;
  canOpenLostMode: boolean;
  canEditIdentity: boolean;
  /** The who-to-call row. Same audience as `canEditIdentity` — one destination. */
  canSeeEmergencyContacts: boolean;
  /**
   * The foster's "Buscar hogar" row and the titular's "Acompañamiento de
   * adopción" row — ONE destination, two labels, and two DIFFERENT audiences
   * (finding F2, review 2026-09-07).
   *
   * They are two gates rather than an if/else on the role because the else arm
   * is what went wrong: it covered `owner` AND `co_owner` AND `org_member`, so a
   * co-owner read "Acompañamiento de adopción — Disponible en la web", opened a
   * browser and got a 404. `buscar-hogar/page.tsx` filters its ownership row to
   * `owner` or `foster` and `notFound()`s everything else, and the web's own row
   * gates on `ownershipRole === "owner"` (`MasSheet.helpers.ts:134-146`) for
   * exactly that reason — a titular tapped a live row and got a 404 on
   * 2026-08-20, and this is the same defect on the role axis.
   */
  canSeeFindHome: boolean;
  canSeeAdoptionSupport: boolean;
  canTransfer: boolean;
  canDesignateCaretaker: boolean;
  canOpenReturn: boolean;
  /** The "Disponible en la web" / "Próximamente" rows, which the web hides on a
   *  deceased animal — its `chapita` row sits AFTER the deceased early-return,
   *  and page.tsx nulls the data behind it. */
  showWebOnlyRows: boolean;
  /**
   * "Reportar fallecimiento" — the terminal asiento, from the ⋯ Más list.
   *
   * A GATE OF ITS OWN AND NOT `canRecordEvent`, though today the two compute
   * the same boolean. They answer different questions: `canRecordEvent` opens
   * the PICKER of routine acts, and this one opens the single form that CLOSES
   * the record. Folding them into one flag would mean that the day either
   * audience changes — a caretaker losing the picker, a jurisdiction gating the
   * death form — the other would move with it silently. `titular-only.ts`
   * already says these are not the same audience: `death_recorded` is
   * EXPLICITLY allowed to a caretaker, so no titular gate belongs here.
   *
   * DECEASED IS THE ONLY THING THAT TAKES IT AWAY, and the server agrees: a
   * second death on one animal is a 409 from `checkWriteGuard`.
   */
  canRecordDeath: boolean;
  /**
   * "Registrar atestación" — the PPP door, from the compliance card.
   *
   * GATED ON `pppRegistries`, WHICH IS THE FACT AND NOT A LABEL. The contract's
   * own docblock asks for exactly this: `data: null` means "this animal is not
   * under the PPP regime", so "a client can gate the attestation door on this
   * one field instead of pattern-matching a compliance card's label".
   *
   * AND A FAILED READ TAKES THE DOOR AWAY, which is the OPPOSITE of the
   * three-state rule `conditionalKinds` follows for the pregnancy rows — said
   * out loud because the two look alike and are not. There, an unknown fact
   * costs a round trip and a refusal sentence. Here the form exists only for an
   * animal the regime applies to, and the regime applies to a small minority of
   * dogs: offering it on an unread section would put "Atestación de raza
   * peligrosa" in front of almost everybody, which is the "form that refuses
   * most animals" the same docblock refuses to build.
   */
  canAttestDangerousBreed: boolean;
  /**
   * D2 (2026-09-25) — the §4.20 physical-tag interest row. Mirrors
   * `togglePhysicalTagInterestAction`'s own check (`accessPath !== "owner"`
   * refuses) translated to this payload's viewer vocabulary: PERSON PATH, not
   * the legal owner alone — owner, co-owner, foster and caretaker all pass,
   * only the org path does not. This is the gate `showWebOnlyRows` (deceased
   * alone) cannot express on its own: the web page this row's sheet lives on
   * is person-path ONLY by construction, so the web's `!isDeceased` gate never
   * had to also exclude an org member — this face does, because ONE
   * component serves both viewer paths.
   */
  canRequestPhysicalTag: boolean;
};

export function ownerFaceGates(view: {
  viewerRole: OwnerPetDetailViewerRole;
  isTitular: boolean;
  status: SectionView<OwnerPetStatusSection>;
  pppRegistries: SectionView<OwnerPetPppRegistriesSection>;
}): OwnerFaceGates {
  // `null` = the section did not load. Every gate below reads it as "no fact",
  // never as "not active": the permissive direction is the correct one here
  // because the server refusal is still in place behind every one of them.
  const petStatus = view.status.state === "ok" ? view.status.data.petStatus : null;
  const isDeceased = petStatus === "deceased";
  const isNotActive = petStatus !== null && petStatus !== "active";
  const isCaretaker = view.viewerRole === "caretaker";
  return {
    isDeceased,
    isNotActive,
    isTitular: view.isTitular,
    canRecordEvent: !isDeceased,
    canOpenLostMode: !isDeceased,
    canEditIdentity: !isCaretaker,
    canSeeEmergencyContacts: !isCaretaker,
    canSeeFindHome: view.viewerRole === "foster" && !isDeceased,
    canSeeAdoptionSupport: view.isTitular && !isDeceased,
    canTransfer: view.isTitular && !isNotActive,
    canDesignateCaretaker: view.isTitular && !isNotActive,
    canOpenReturn: !isDeceased,
    showWebOnlyRows: !isDeceased,
    canRecordDeath: !isDeceased,
    canAttestDangerousBreed:
      !isDeceased && view.pppRegistries.state === "ok" && view.pppRegistries.data !== null,
    canRequestPhysicalTag: !isDeceased && view.viewerRole !== "org_member",
  };
}

/**
 * Does THIS obligation card carry the attestation door?
 *
 * A FUNCTION AND NOT AN INLINE CONDITION IN THE RENDERER, for the reason
 * finding F6 gave about the "Editar datos" row: a rule read off `gates`
 * everywhere except in one component that re-derives it is a rule with two
 * homes. It is also the only way to test the placement without rendering.
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
  gates: OwnerFaceGates,
): boolean {
  return (
    gates.canAttestDangerousBreed && card.key === "ppp" && card.tone !== "ok" && !card.dataUnknown
  );
}

/**
 * WHY a titular-only row is inert, in one short line under its label.
 *
 * `null` when the row is live. The two reasons are kept apart because the moves
 * are different: a co-owner has to ask the titular, and a titular whose animal
 * is lost has to find it first.
 */
export function titularOnlyRowCaption(gates: OwnerFaceGates): string | null {
  if (!gates.isTitular) return "Solo el titular";
  if (gates.isNotActive) return "No se puede en esta situación";
  return null;
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
 * THE CALLER'S GATES ARE WHAT MAKE THE LINK SAFE, and they were reasoned out
 * before this function existed (see the two comments above the rows in
 * `OwnerFace.tsx`): `showWebOnlyRows` drops both for a deceased animal, whose
 * destinations the web suppresses too, and `canSeeFindHome` is `foster`-only
 * because `buscar-hogar/page.tsx` `notFound()`s every other role. A link that
 * 404s is worse than an inert row, and the gates are why neither of these can.
 *
 * NOT IN `deepLinkMap`, and that is the table's own rule rather than an
 * omission: "A destination belongs here when something OUTSIDE the rendering
 * surface has to name it" — a QR, a notification, an invitation. These are one
 * surface handing off to another, which is the case the table's header
 * explicitly declines ("putting 400 routes in this table would make it a
 * second, worse copy of the file system router"). `claimDisputeUrl` in
 * `claims/claim-view-model.ts` is the precedent: same shape, same reason.
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
