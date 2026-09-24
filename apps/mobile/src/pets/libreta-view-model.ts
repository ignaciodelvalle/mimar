// The libreta, turned into es-AR sentences.
//
// PURE. No React, no React Native, no fetch — the same discipline
// `owner-face-view-model.ts` keeps, and for the same reason: every label rule
// below is a product decision, and a product decision that can only be checked
// by rendering a screen is one that drifts.
//
// WHAT IS NOT DECIDED HERE, because the server already decided it:
//   · The ORDER of the ledger (newest asiento first, upcoming ascending).
//   · The CONTENT of an asiento — its eyebrow, its title, its facts, its
//     provenance stamp — all composed server-side out of the same whitelisted
//     templates the web renders.
//   · The DATE WORDS. "hace 2 días" and "20 ago 2026" are Argentine-calendar
//     facts; a phone travelling with its owner must not renumber an animal's
//     dates, so they arrive computed.
//   · WHO may correct WHAT. `canAmend` is the conjunction of the amendable-type
//     allowlist and the viewer's capability, folded server-side.
//
// What IS decided here is the copy this screen puts AROUND those facts.

import type {
  LibretaIdentitySection,
  LibretaTimelineSection,
  LibretaUpcomingItemV1,
  LibretaVaccinationSection,
  PetLibretaV1,
} from "@dim/contract/api";

import { unknownEnumLabel } from "../ui/enum-label";
import { type SectionView, sectionView } from "./owner-face-view-model";
import { speciesLabel } from "./species";

/**
 * The immutability note the web prints at the foot of the libreta, verbatim.
 *
 * It is not decoration. It is the sentence that makes the "Corregir" affordance
 * legible: without it, a correction that leaves the original in place reads as a
 * bug rather than as the whole design.
 */
export const LIBRETA_IMMUTABILITY_NOTE =
  "Los eventos no se editan ni se borran. Una corrección es un evento nuevo.";

/** Both lists empty. The web's own sentence for it. */
export const LIBRETA_EMPTY_LABEL = "Sin eventos ni cuidados programados todavía.";

/**
 * The web's note under a capped ledger, minus its print instruction.
 *
 * The web says "Imprimí la libreta completa para ver todo el historial", which
 * points at an affordance this client does not have. Naming a way out that does
 * not exist here would be worse than naming none, so this says the true half and
 * stops. When the app grows an export, this line grows the other half back.
 */
export const LIBRETA_TRUNCATED_NOTE = "Mostrando los eventos más recientes.";

export type LibretaView = {
  publicToken: string;
  /** The viewer's own capability, for the screen's chrome. */
  canAmend: boolean;
  identity: SectionView<LibretaIdentitySection>;
  vaccination: SectionView<LibretaVaccinationSection>;
  upcoming: SectionView<{ items: LibretaUpcomingItemV1[] }>;
  timeline: SectionView<LibretaTimelineSection>;
};

export function buildLibretaView(payload: PetLibretaV1): LibretaView {
  return {
    publicToken: payload.publicToken,
    canAmend: payload.viewer.canAmend,
    identity: sectionView(payload.identity),
    vaccination: sectionView(payload.vaccination),
    upcoming: sectionView(payload.upcoming),
    timeline: sectionView(payload.timeline),
  };
}

// ---------------------------------------------------------------------------
// The masthead
// ---------------------------------------------------------------------------

/**
 * The species/sex line under the name, exactly as the libreta face composes it.
 *
 * Joins with "·" and drops what it does not know, so an animal of unrecorded sex
 * reads "Perro" rather than "Perro · ".
 */
export function speciesLine(identity: { species: string; sex: string | null }): string {
  const species = speciesLabel(identity.species);
  const sex = identity.sex === "male" ? "macho" : identity.sex === "female" ? "hembra" : null;
  return [species, sex].filter(Boolean).join(" · ");
}

// THIS FILE USED TO CARRY ITS OWN COPY of the species table, and the copy had
// drifted in the way a second copy always does. Two defects in one:
//
//   1. `SPECIES_LABELS[identity.species] ?? identity.species` fell back to the
//      RAW WIRE VALUE, so a species this bundle had never heard of printed
//      `chinchilla` on the libreta — the same defect `speciesLabel` was written
//      to close (finding M1, review 2026-09-07), one file over.
//   2. It mapped `other` to "Otra especie", while the canonical table maps the
//      real `other` member to "Otro" and RESERVES "Otra especie" for a value the
//      build does not know. The same phrase meant two different things
//      depending on which module rendered it, and the difference is exactly the
//      one a citizen would need: "the owner chose Other" vs "this app is older
//      than the server".
//
// `lib/analytics/export-attribution.ts` already states the rule this breaks —
// triplication is what let one wrong word reach three legal surfaces, so the
// fix is a single origin and not three edits. One table, in `./species`.

// ---------------------------------------------------------------------------
// Vaccination
// ---------------------------------------------------------------------------

/**
 * The one-line verdict above the ledger.
 *
 * "SIN DATOS" IS ITS OWN ANSWER and it is not "al día". An animal with no dose
 * on file has not been reported compliant — it has been reported unknown, and
 * the compliance stamp on the owner face makes the same distinction for the same
 * reason.
 *
 * `unconfirmed` never counts toward "sin aplicar": a core vaccine we cannot
 * MATCH, on an animal that carries a dose we cannot IDENTIFY, is not an animal
 * whose owner can be told it is unvaccinated (PO 2026-07-28).
 */
export function vaccinationHeadline(summary: LibretaVaccinationSection): string {
  const known =
    summary.active + summary.dueSoon + summary.expired + summary.missing + summary.unconfirmed;
  if (known === 0 && summary.otherCount === 0) return "SIN DATOS";
  if (summary.expired > 0) return "VENCIDA";
  if (summary.missing > 0) return "SIN APLICAR";
  if (summary.dueSoon > 0) return "POR VENCER";
  if (summary.unconfirmed > 0) return "SIN CONFIRMAR";
  return "AL DÍA";
}

/** One vaccine's state, in the web's own words. */
export function vaccineStatusLabel(
  status: LibretaVaccinationSection["perVaccine"][number]["status"],
): string {
  switch (status) {
    case "active":
      return "Al día";
    case "due_soon":
      return "Por vencer";
    case "expired":
      return "Vencida";
    case "missing":
      return "Nunca aplicada";
    case "unconfirmed":
      return "Sin confirmar";
    default:
      // A state a newer server knows and this build does not. Say so rather than
      // print an empty cell, which reads as "nothing to report" — but WITHOUT
      // the raw value: `Estado desconocido (rabies_pending)` put an English
      // identifier in the middle of a libreta. See `ui/enum-label.ts`.
      return unknownEnumLabel(status, "Estado desconocido");
  }
}

/**
 * The off-catalog note.
 *
 * A dose whose name the catalog could not resolve does NOT move the core-vaccine
 * verdict and must stay visible anyway: it is still a dose somebody gave the
 * animal, and dropping it silently is how a real vaccination disappears.
 */
export function otherVaccinesNote(summary: LibretaVaccinationSection): string | null {
  if (summary.otherCount === 0) return null;
  return summary.otherCount === 1
    ? "Hay 1 vacuna registrada fuera del catálogo."
    : `Hay ${summary.otherCount} vacunas registradas fuera del catálogo.`;
}

// ---------------------------------------------------------------------------
// PRÓXIMO
// ---------------------------------------------------------------------------

/** What kind of upcoming item this is. */
export function upcomingKindLabel(kind: LibretaUpcomingItemV1["kind"]): string {
  switch (kind) {
    case "reminder":
      return "Recordatorio";
    case "appointment":
      return "Turno";
    case "medication":
      return "Dosis";
    default:
      // A kind a newer server sent. "Registro" is deliberately vague and
      // deliberately Spanish: the row still has a real date beside it, so the
      // person can act on it, and `medication` printed raw could not have been
      // read by anybody this app is for. See `ui/enum-label.ts`.
      return unknownEnumLabel(kind, "Registro");
  }
}

/**
 * How far away an upcoming item is, in ARGENTINE calendar days.
 *
 * Pinned to the Argentine calendar rather than to the device's, so an owner
 * abroad does not see their animal's turno move by a day. An item already past
 * says so — "vencía ayer" is actionable, "en -1 días" is a bug on screen.
 */
export function upcomingDueLabel(dueAtIso: string, now: Date): string {
  const days = calendarDaysBetweenInAr(now, dueAtIso);
  if (days === null) return "Sin fecha";
  if (days < -1) return `Venció hace ${Math.abs(days)} días`;
  if (days === -1) return "Venció ayer";
  if (days === 0) return "Hoy";
  if (days === 1) return "Mañana";
  if (days < 30) return `En ${days} días`;
  const months = Math.round(days / 30);
  return months === 1 ? "En 1 mes" : `En ${months} meses`;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/** "Asientos · N registros", pluralised. */
export function ledgerCountLabel(count: number): string {
  return count === 1 ? "1 registro" : `${count} registros`;
}

/** No asientos, but the read succeeded. A fact about the animal. */
export const LEDGER_EMPTY_LABEL = "Todavía no hay asientos en esta libreta.";

/** No upcoming items, but the read succeeded. */
export const UPCOMING_EMPTY_LABEL = "No hay nada programado.";

/**
 * The "Corregido" marker under an amended asiento.
 *
 * The values above it are ALREADY the corrected ones — this says a correction
 * happened, which is the half a corrected value cannot say on its own.
 */
export function amendedLabel(amendedAtIso: string): string {
  return `Corregido el ${formatArDate(amendedAtIso)}`;
}

/** A date as a plain Argentine calendar day. */
export function formatArDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: AR_TIME_ZONE,
  }).format(date);
}

/**
 * The one timezone every date on this screen is formatted in.
 *
 * miMAR is an Argentina-only service, so a calendar day is the Argentine
 * calendar day — on a device set to any zone. The web pins the same constant for
 * the same reason.
 */
export const AR_TIME_ZONE = "America/Argentina/Buenos_Aires";

/**
 * Whole ARGENTINE calendar days from `now` to `iso` (negative when past).
 *
 * Compares calendar DAY STRINGS, not elapsed milliseconds: an item due at 08:00
 * tomorrow is one calendar day away even though it is 14 hours off, and elapsed
 * math calls that "today". Exported for the tests that pin the boundary.
 */
export function calendarDaysBetweenInAr(now: Date, iso: string): number | null {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return null;
  const dayOf = (d: Date) =>
    Date.parse(
      `${new Intl.DateTimeFormat("en-CA", { timeZone: AR_TIME_ZONE }).format(d)}T00:00:00Z`,
    );
  return Math.round((dayOf(target) - dayOf(now)) / 86_400_000);
}
