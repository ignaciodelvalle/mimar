// ---------------------------------------------------------------------------
// Pet SITUATION — the single state-language for "what a pet is going through".
//
// A pet's SITUATION (perdida, en observación antirrábica, en tratamiento,
// preñada, en adopción / tránsito, fallecida) is a SEPARATE axis from its
// compliance / registration state ("inscripta", "al día"). Compliance answers
// "does the paperwork check out"; the situation answers "is something happening
// to this animal right now". They must never be tinted with each other's color.
//
// This module is the ONE place that maps a pet's real, derived state onto a
// { key, tone, label, icon } descriptor. Every surface (credential skin,
// mis-mascotas list card, notifications) reads from here so the language stays
// coherent — one tone, one label, one icon per situation, everywhere.
//
// WCAG: `tone` is NEVER the only signal. Every descriptor pairs the tone with a
// text `label` (es-AR) and an `icon` (a distinct shape), so a color-blind or
// monochrome viewer still reads the situation. Consumers MUST render all three.
//
// Pure module: no React, no color literals (tones map to design tokens in CSS /
// the consuming component), so it stays trivially unit-testable. The one import
// is the rabies-observation state machine, itself a zero-runtime-import domain
// module — so "is this observation still open?" is answered in ONE place rather
// than re-spelled as a status literal here.
// ---------------------------------------------------------------------------
import { isObservationOpen } from "@/src/modules/surveillance/domain/rabies-observation";

/** The set of situations a pet can be in. `al-dia` is the DEFAULT (nothing is
 *  happening) — it carries `isDefault: true` so a surface can skip the skin
 *  entirely and show its normal, quiet registration state instead. */
export type PetSituationKey =
  | "al-dia"
  | "perdida"
  | "custodia-oficial"
  | "observacion-antirrabica"
  | "en-tratamiento"
  | "prenada"
  | "en-adopcion"
  | "en-transito"
  | "fallecida";

/** Semantic tone. Maps to a design-token color family in CSS — never a raw
 *  color here. `accion` is the neutral "needs a decision / action" family
 *  shared by adoption + tránsito. */
export type PetSituationTone =
  | "ok" // verde — al día
  | "alerta" // rojo — perdida
  | "vigilancia" // celeste — observación antirrábica
  | "tratamiento" // ámbar — en tratamiento
  | "gestacion" // rosa — preñada
  | "accion" // neutro-acción — en adopción / tránsito
  | "memoria"; // gris — fallecida

export type PetSituation = {
  key: PetSituationKey;
  tone: PetSituationTone;
  /** es-AR short label (feminine default, matching the app's copy). */
  label: string;
  /** Icon name (see components/Icon) — the non-color, shape-based signal. */
  icon: string;
  /** True only for `al-dia`: the default state, no skin to apply. */
  isDefault: boolean;
};

// The canonical descriptor for every situation. This is the source of truth
// for label + icon + tone — do not hardcode any of these three at a call site.
export const PET_SITUATIONS: Record<PetSituationKey, PetSituation> = {
  "al-dia": {
    key: "al-dia",
    tone: "ok",
    label: "Al día",
    icon: "check-circle",
    isDefault: true,
  },
  perdida: {
    key: "perdida",
    tone: "alerta",
    label: "Perdida",
    icon: "perdida",
    isDefault: false,
  },
  "custodia-oficial": {
    key: "custodia-oficial",
    // PO direction: reuse the warn/amber family — custody is an official
    // intervention, not a medical emergency. No new tone token.
    tone: "tratamiento",
    label: "Bajo custodia oficial",
    icon: "shield",
    isDefault: false,
  },
  "observacion-antirrabica": {
    key: "observacion-antirrabica",
    tone: "vigilancia",
    label: "En observación antirrábica",
    icon: "ver",
    isDefault: false,
  },
  "en-tratamiento": {
    key: "en-tratamiento",
    tone: "tratamiento",
    label: "En tratamiento",
    icon: "medicacion",
    isDefault: false,
  },
  prenada: {
    key: "prenada",
    tone: "gestacion",
    label: "Preñada",
    icon: "embarazo",
    isDefault: false,
  },
  "en-adopcion": {
    key: "en-adopcion",
    tone: "accion",
    label: "En adopción",
    icon: "corazon",
    isDefault: false,
  },
  "en-transito": {
    key: "en-transito",
    tone: "accion",
    label: "En tránsito",
    icon: "casa",
    isDefault: false,
  },
  fallecida: {
    key: "fallecida",
    tone: "memoria",
    label: "Fallecida",
    icon: "fallecimiento",
    isDefault: false,
  },
};

/** Normalized inputs for the derivation — a decoupled shape so the function
 *  never touches the DB row directly and stays pure. All optional so callers
 *  can pass only the signals they have. */
export type PetSituationInput = {
  /** pets.status — "active" | "lost" | "deceased" (projection). */
  status?: string | null;
  /** pets.rabiesObservationStatus — "in_progress" and "window_expired_unclosed"
   *  both mean an observation nobody has clinically closed. */
  rabiesObservationStatus?: string | null;
  /** pets.pregnancyStatus — "in_progress" while pregnant. */
  pregnancyStatus?: string | null;
  /** Held under an open official custody episode (org/state custodian). */
  underOfficialCustody?: boolean;
  /** An open medical treatment (medication course / recovery). */
  inTreatment?: boolean;
  /** Listed for adoption. */
  inAdoption?: boolean;
  /** Held in fostering / tránsito (not a definitive owner). */
  inTransit?: boolean;
};

// Precedence, most urgent first: a pet that is BOTH lost and pregnant is shown
// as PERDIDA — the more urgent situation wins the single skin. Deceased is
// terminal and outranks everything.
export function derivePetSituation(input: PetSituationInput): PetSituation {
  if (input.status === "deceased") return PET_SITUATIONS.fallecida;
  if (input.status === "lost") return PET_SITUATIONS.perdida;
  if (input.underOfficialCustody) return PET_SITUATIONS["custodia-oficial"];
  // An expired-unclosed observation keeps the situation: nothing was resolved,
  // so the credential must not go back to reading "al día".
  if (isObservationOpen(input.rabiesObservationStatus))
    return PET_SITUATIONS["observacion-antirrabica"];
  if (input.inTreatment) return PET_SITUATIONS["en-tratamiento"];
  if (input.pregnancyStatus === "in_progress") return PET_SITUATIONS.prenada;
  if (input.inAdoption) return PET_SITUATIONS["en-adopcion"];
  if (input.inTransit) return PET_SITUATIONS["en-transito"];
  return PET_SITUATIONS["al-dia"];
}

// Bridge for the compliance-derived list status (LnPetStatus: ok | registered |
// sick | lost | pregnant) used by the mis-mascotas registry rows. That axis is
// narrower than the full situation set, so it only maps the situations it can
// express — enough to give each list flag the SAME icon as the credential skin
// (WCAG: label + icon, not color alone). `registered` is the quiet passive base
// (no situation), so it intentionally has no icon.
export const LIST_STATUS_SITUATION_ICON: Record<string, string> = {
  ok: PET_SITUATIONS["al-dia"].icon,
  sick: PET_SITUATIONS["en-tratamiento"].icon,
  lost: PET_SITUATIONS.perdida.icon,
  pregnant: PET_SITUATIONS.prenada.icon,
  deceased: PET_SITUATIONS.fallecida.icon,
};
