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
  LibretaEntryV1,
  LibretaIdentitySection,
  LibretaTimelineSection,
  LibretaUpcomingItemV1,
  LibretaVaccinationSection,
  PetLibretaV1,
} from "@dim/contract/api";

import { pluralizeEs } from "@dim/contract/reference";

import { unknownEnumLabel } from "../ui/enum-label";
import { type SectionView, sectionView } from "./owner-face-view-model";
import { speciesLabel } from "./species";

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
  /**
   * The reader came through a person's holding (owner, co-owner, foster,
   * caretaker), not an organization. "Pedir verificación" is offered only
   * then: the web strips it on the org path (`WalkInHistory`).
   */
  onOwnerPath: boolean;
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
    onOwnerPath: payload.viewer.role !== "org_member",
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
  // A current dose nobody professional signed is not "al día" either — the
  // credential front calls the same dose "Declarada" (QA v14 P2a).
  if (summary.unconfirmed > 0 || (summary.declared ?? 0) > 0) return "SIN CONFIRMAR";
  return "AL DÍA";
}

/**
 * The four counts above the ledger. A declared current dose counts with "Sin
 * confirmar", not with "Vigente": the front says "Declarada" and the asiento
 * says "Falta verificación profesional" for the same dose, and a back reading
 * "1 Vigente · 0 Sin confirmar" contradicted both (QA v14 P2a, 2026-10-07).
 */
export function vaccineCounts(summary: LibretaVaccinationSection): {
  vigente: number;
  porVencer: number;
  vencida: number;
  sinConfirmar: number;
} {
  const declared = summary.declared ?? 0;
  return {
    vigente: Math.max(0, summary.active - declared),
    porVencer: summary.dueSoon,
    vencida: summary.expired,
    sinConfirmar: summary.unconfirmed + declared,
  };
}

/** One vaccine row's state: "Declarada" for a current dose nobody signed. */
export function vaccineRowLabel(vaccine: LibretaVaccinationSection["perVaccine"][number]): string {
  if (vaccine.status === "active" && vaccine.provenance === "declarada") return "Declarada";
  return vaccineStatusLabel(vaccine.status);
}

/** One vaccine's state, in the web's own words. */
export function vaccineStatusLabel(
  status: LibretaVaccinationSection["perVaccine"][number]["status"],
): string {
  switch (status) {
    case "active":
      // "Vigente", not "Al día". This row classifies dose recency. "Al día"
      // is the compliance stamp's claim, and using it here contradicted that
      // stamp for an owner-declared dose.
      return "Vigente";
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
 * The suffix the server's dose reminders carry ("<drug> – Dosis"). A server
 * from before the PRÓXIMO collapse still sends it in `label`; the current one
 * strips it (`lib/domain/medication-dose-title.ts`, which this cannot import).
 */
const DOSE_TITLE_SUFFIX_RE = /\s*[–—-]\s*Dosis\s*$/u;

/**
 * The text of an upcoming row.
 *
 * A MEDICATION row names its course, not its kind. It is one row per course
 * (the server collapses the doses), so "Antiparasitario de amplio espectro ·
 * próxima dosis" says what the date beside it is the date OF. Prefixing the kind
 * as well printed "Dosis · Antiparasitario de amplio espectro – Dosis" on a
 * real phone — the word twice, and neither saying WHICH dose.
 */
export function upcomingRowLabel(item: LibretaUpcomingItemV1): string {
  if (item.kind === "medication") {
    const drug = item.label.replace(DOSE_TITLE_SUFFIX_RE, "").trim() || item.label;
    return `${drug} · próxima dosis`;
  }
  return `${upcomingKindLabel(item.kind)} · ${item.label}`;
}

/**
 * "quedan N dosis" under a medication row whose course has more than the dose
 * it names; null otherwise, including a server that sends no count.
 */
export function upcomingRemainingLabel(item: LibretaUpcomingItemV1): string | null {
  if (item.kind !== "medication") return null;
  const remaining = item.remainingDoses ?? null;
  return remaining !== null && remaining > 1 ? `quedan ${remaining} dosis` : null;
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

// ---------------------------------------------------------------------------
// "Pedir verificación"
// ---------------------------------------------------------------------------

/** The link under an unverified rabies dose — the web's AsientoCard words. */
export const REQUEST_VERIFICATION_LABEL = "Pedir verificación";

/**
 * Whether an asiento offers "Pedir verificación".
 *
 * THE WEB'S RULE, read off what the wire carries: `toAsientoView` sets its
 * `verifyHref` for a vaccination that is NOT professionally verified AND is the
 * rabies dose — the one the law asks for, which is why its eyebrow reads
 * "Vacuna · obligatoria". Any other self-declared vaccine still says "Falta
 * verificación profesional", and offers no link on either platform.
 */
export function offersVerificationRequest(
  entry: Pick<LibretaEntryV1, "eventType" | "kind" | "provenance">,
): boolean {
  return (
    entry.eventType === "vaccination_administered" &&
    entry.kind === "Vacuna · obligatoria" &&
    !entry.provenance.verified
  );
}

// ---------------------------------------------------------------------------
// Trip papers ticks — drawn as one row
// ---------------------------------------------------------------------------

/**
 * What a papers tick is titled — the web's `TRIP_PAPERS_UPDATED_LABEL`
 * (`components/pet-profile/asiento-fields.ts`), which this bundle cannot import.
 * A root parity test holds the two together.
 */
export const TRIP_PAPERS_UPDATED_LABEL = "Papeles del viaje actualizados";

/** One line of the ledger: an asiento, or a run of papers ticks drawn as one. */
export type LedgerItem =
  | { kind: "entry"; entry: LibretaEntryV1 }
  | {
      kind: "papers";
      entries: LibretaEntryV1[];
      label: string;
      /**
       * The group's identity — its trip and day (`tripPapersTickKey`), NOT the
       * newest tick's id, which changes with every new tick. The screen keys
       * the "Ver cada cambio" expander on it so the list stays open when the
       * owner comes back from one change (QA v14 P2b).
       */
      key: string;
    };

function factValue(entry: LibretaEntryV1, key: string): string | null {
  return entry.facts.find((fact) => fact.key === key)?.value ?? null;
}

/**
 * The grouping key of a papers tick, or null for every other asiento.
 *
 * NO TRIP ID CROSSES THE WIRE (the asiento carries whitelisted facts, never
 * ids), so the trip is told apart by what the server says about it — its
 * destination and departure day — and the day by `whenAbsolute`, which is
 * already the Argentine calendar day. The web keys on the trip's event id; the
 * two only differ for two trips to one country on one day, ticked in one run.
 */
export function tripPapersTickKey(entry: LibretaEntryV1): string | null {
  if (entry.eventType !== "event_amended" || entry.title !== TRIP_PAPERS_UPDATED_LABEL) {
    return null;
  }
  // NO DESTINATION, NO GROUPING. The facts come from the trip row, and a long
  // libreta's capped read can lose the trip while keeping its ticks; keyed on
  // the day alone, ticks of two different trips would merge here while the
  // web (keyed on the trip's id) keeps them apart. Ungrouped is the safe side.
  const destination = factValue(entry, "Destino");
  if (destination === null) return null;
  return [destination, factValue(entry, "Fecha del viaje") ?? "", entry.whenAbsolute].join("|");
}

/** "Papeles del viaje actualizados · 3 cambios · Chile" — the web's words. */
export function tripPapersGroupLabel(count: number, country: string | null): string {
  return [TRIP_PAPERS_UPDATED_LABEL, `${count} ${pluralizeEs(count, "cambio")}`, country]
    .filter(Boolean)
    .join(" · ");
}

/** One tick's line in an expanded row — the web's `tripPapersTickLabel`. */
export function tripPapersTickLabel(indexNewestFirst: number, total: number): string {
  return `Cambio ${total - indexNewestFirst} de ${total}`;
}

/**
 * The ledger as it is DRAWN: consecutive ticks of one trip on one day become
 * one row. PRESENTATION ONLY — every tick is still its own asiento on the
 * server, the count says how many, and the row opens the newest of them.
 */
export function groupLedgerEntries(entries: readonly LibretaEntryV1[]): LedgerItem[] {
  const items: LedgerItem[] = [];
  let run: LibretaEntryV1[] = [];
  let runKey: string | null = null;
  const flush = () => {
    const head = run[0];
    if (head !== undefined && run.length === 1) items.push({ kind: "entry", entry: head });
    else if (head !== undefined) {
      items.push({
        kind: "papers",
        entries: run,
        label: tripPapersGroupLabel(run.length, factValue(head, "Destino")),
        key: runKey ?? head.eventId,
      });
    }
    run = [];
    runKey = null;
  };
  for (const entry of entries) {
    const key = tripPapersTickKey(entry);
    if (key !== null && key === runKey) {
      run.push(entry);
      continue;
    }
    flush();
    if (key === null) items.push({ kind: "entry", entry });
    else {
      run = [entry];
      runKey = key;
    }
  }
  flush();
  return items;
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
