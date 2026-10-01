// Landing content model — miMAR public landing ("una mascota, muchas manos").
//
// Ported from docs/design_handoff_landing/landing2/data2.js (prototype content
// model). Copy is es-AR (voseo); identifiers in English. Event types are the
// REAL system event types, verbatim, as they appear in the event log.
//
// PAMPA is the narrative pet of the story. Whether the hero ALSO renders a
// real scannable QR is a per-deployment declaration, not a constant baked in
// here — see components/landing/demo-pet.ts (RA-6 finding 1: the hardcoded
// flagship token made the front door 404 on every deployment provisioned the
// way dim-interno:docs/ops/cutover-playbook.md mandates).
//
// Sub-brand note: the landing's serif display type ("Libreta Nacional" —
// lp-display / --font-ln-serif in globals.css) is an INTENTIONAL departure
// from literal Poncho. Poncho supplies the color palette and the Encode Sans
// body/UI type; the serif display motif on headings and the credential's
// libreta-style back face is a deliberate sub-brand identity (PO decision:
// keep the sub-brand, just make the page around it calmer). Do not "fix" it
// back to a Poncho display font — see dim-interno:docs/archive/poncho/components.md,
// which is now archived precisely because Poncho's original component/token
// set no longer matches what ships here.

import type { IconName } from "@/components/Icon";
import type { EventType } from "@/db/schema";
import { BRANDING } from "@/lib/ui/branding";
import {
  AR_TIME_ZONE,
  ageFromDateOfBirth,
  eventTypeLabel,
  pluralizeEs,
  speciesLabel,
} from "@/lib/utils/format";
import {
  OWNER_NAME,
  PAMPA_EVENTS,
  PAMPA_PET,
  type PampaSeedEvent,
  VET_CLINIC,
  VET_LICENSE,
  VET_NAME,
} from "@/scripts/flagship-pampa-data";

// ---------------------------------------------------------------------------
// Pampa's facts — derived from the flagship seed's data module
// ---------------------------------------------------------------------------

// Every Pampa fact on the landing — dates, batches, brands, the vet, the
// authors — is read from scripts/flagship-pampa-data.ts, the module the
// flagship seed writes from. The landing's own copy of this story drifted from the pet its hero QR
// opens (a vet the seed never created, a neighbours' alert the product never
// sends); __tests__/flagship-pampa-consistency.test.ts now fences it.

/** No-break space: a chip number or "Dra. Marrone" never splits across lines. */
const NBSP = "\u00a0";

/**
 * A seed date ("2022-04-12") as an instant at Argentine noon, so no product
 * formatter pinned to AR time ever prints it as the day before.
 */
export function seedInstant(date: string): Date {
  return new Date(`${date}T12:00:00-03:00`);
}

/** "941000100000001" → "941 000 100 000 001" (groups joined by no-break spaces). */
export function formatChip(chip: string): string {
  return chip.replace(/(\d{3})(?=\d)/g, `$1${NBSP}`);
}

/** "Dra. Lilian Marrone" → "Dra. Marrone" (title + surname, as the story names her). */
export const VET_SHORT_NAME = (() => {
  const parts = VET_NAME.split(" ");
  return `${parts[0]}${NBSP}${parts[parts.length - 1]}`;
})();

export const PAMPA_VET = {
  name: VET_NAME.replace(" ", NBSP),
  shortName: VET_SHORT_NAME,
  license: VET_LICENSE,
  clinic: VET_CLINIC,
} as const;

export const PAMPA_OWNER_NAME = OWNER_NAME;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Looks one seed event up by type (and, for status changes, target status). */
export function pampaEvent(eventType: string, toStatus?: string): PampaSeedEvent {
  const hit = PAMPA_EVENTS.find(
    (e) =>
      e.eventType === eventType && (toStatus === undefined || e.payload.to_status === toStatus),
  );
  if (!hit) throw new Error(`flagship-pampa-data has no ${eventType} ${toStatus ?? ""}`);
  return hit;
}

/** The seed's LAST vaccination — the Comuna 13 campaign dose. */
export const PAMPA_CAMPAIGN_DOSE = PAMPA_EVENTS.filter(
  (e) => e.eventType === "vaccination_administered",
).at(-1) as PampaSeedEvent;

/** The seed's FIRST vaccination — the one chapter 2 shows being signed. */
export const PAMPA_FIRST_DOSE = pampaEvent("vaccination_administered");

/**
 * The shelter of chapter 4. The seed has no organization for its intake
 * (it records it under the owner), so the name is the landing's own; it is
 * the org `confirm-chip-match-refugio.ts` would stamp on the event.
 */
export const PAMPA_SHELTER = "Refugio Patitas del Barrio";

// ---------------------------------------------------------------------------
// The owner's libreta, as the NATIVE app draws it (PO 2026-09-30: Martín's
// phone is the native owner app in every chapter)
// ---------------------------------------------------------------------------
//
// apps/mobile/src/pets/LibretaScreen.tsx:350-378 draws each asiento as the
// server composed it (app/api/v1/pets/[publicToken]/libreta/payload.ts:146-168,
// which runs the web's own projection, components/pet-profile/asiento-fields.ts
// toAsientoView): an eyebrow (`kind`), a title, "{relativo} · {fecha}", the
// fact rows, and the provenance line. The owner audience sees EVERY event
// (components/pet-profile/libreta-lens.ts:18-21, `audience === "owner"`), so
// the lost/intake/found asientos are on it — the "sanitaria" whitelist that
// excludes them is the org viewer's, not the owner's.
//
// The projection below is a transcription of toAsientoView for the event
// types the seed carries, fenced against the real function in
// __tests__/flagship-pampa-consistency.test.tsx. It is not imported: its
// module pulls drizzle-orm into this client bundle.

/** asiento-fields.ts:317 — the rabies test that makes a vaccine "obligatoria". */
const RABIES_RE = /antirr[aá]b|rabi/i;

/** lib/events/events.ts:443-451 — clinical_info_logged's sub_kind labels. */
const CLINICAL_SUB_KIND_LABELS: Record<string, string> = {
  lab_work: "Laboratorio",
  imaging: "Imagen",
  surgery: "Cirugía",
  allergy_detection: "Alergia",
  disease_diagnosis: "Diagnóstico",
  pregnancy: "Embarazo",
  other: "Otro",
};

export type LibretaFact = { key: string; value: string; mono?: boolean };

/**
 * asiento-fields.ts:186-257 (deriveProvenance), for the authors the seed has.
 * The owner reads his own asientos, so an owner-declared one is "vos"; the
 * shelter's intake carries its organization (confirm-chip-match-refugio.ts:185-187).
 */
function provenance(e: PampaSeedEvent, citedProfessional: string | null): string {
  switch (e.authorRole) {
    case "vet":
      if (e.authorVerified) {
        return citedProfessional ? `Verificado por ${citedProfessional}` : "Verificado por vet";
      }
      return "Registrado sin verificar";
    case "shelter":
      return e.authorVerified ? "Verificado · Registro miMAR" : `Registrado por ${PAMPA_SHELTER}`;
    case "scanner":
      return "Reportado por un tercero";
    default:
      return "Cargado por vos";
  }
}

type AsientoCopy = { kind: string; title: string; facts: LibretaFact[]; cited?: string | null };

/** asiento-fields.ts:389-612 (toAsientoView), per event type. */
function asientoCopy(e: PampaSeedEvent): AsientoCopy | null {
  const p = e.payload;
  const label = eventTypeLabel(e.eventType as EventType);
  switch (e.eventType) {
    case "vaccination_administered": {
      const name = str(p.vaccine_name);
      // :401-412 — the rows the native card prints; the laboratory and batch
      // are the two this story needs (the rest are omitted, not altered).
      return {
        kind: RABIES_RE.test(name) ? "Vacuna · obligatoria" : "Vacuna",
        title: name || "Vacuna",
        facts: [
          { key: "Laboratorio", value: str(p.brand) },
          { key: "Lote", value: str(p.batch) },
        ],
        cited: str(p.administered_by) || null,
      };
    }
    case "sterilization_performed": {
      const procedure = str(p.procedure);
      const procedureLabel =
        procedure === "castration"
          ? "castración"
          : procedure === "spay"
            ? "ovariectomía"
            : procedure;
      return {
        kind: "Esterilización",
        title: procedureLabel ? `Esterilización · ${procedureLabel}` : "Esterilización",
        facts: [],
      };
    }
    case "microchip_implanted":
      // :508-519 — "Número" is a mono fact.
      return {
        kind: "Identificación · microchip",
        title: "Microchip",
        facts: [{ key: "Número", value: str(p.chip_number), mono: true }],
      };
    case "status_changed":
      // The default branch (:594-611): kind is the type label, title the
      // summary's primary (lib/events/events.ts:493-505).
      return {
        kind: label,
        title:
          p.to_status === "lost"
            ? "Marcada como perdida"
            : p.to_status === "active"
              ? "Marcada como encontrada"
              : label,
        facts: [],
      };
    case "clinical_info_logged": {
      const sub = CLINICAL_SUB_KIND_LABELS[str(p.sub_kind)];
      return {
        kind: label,
        title: sub ? `Información clínica · ${sub}` : "Información clínica",
        facts: [],
      };
    }
    case "pet_registered":
    case "shelter_intake_recorded":
      // No summary case in lib/events/events.ts: the title falls back to the label.
      return { kind: label, title: label, facts: [] };
    // credential_scanned is NOT an asiento here: scanner-role scans are purged
    // after 90 days (lib/infra/scan-retention.ts).
    default:
      return null;
  }
}

/** asiento-fields.ts:103-114 (formatAbsolute) — "12 abr 2022". */
export function asientoDate(date: string): string {
  return seedInstant(date).toLocaleDateString("es-AR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: AR_TIME_ZONE,
  });
}

/** asiento-fields.ts:120-134 (formatRelative), against `now`. */
export function asientoRelative(date: string, now: Date): string {
  const days = Math.floor((now.getTime() - seedInstant(date).getTime()) / 86_400_000);
  if (days <= 0) return "hoy";
  if (days === 1) return "ayer";
  if (days < 7) return `hace ${days} días`;
  if (days < 14) return "hace 1 semana";
  if (days < 30) return `hace ${Math.floor(days / 7)} sem.`;
  if (days < 60) return "hace 1 mes";
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `hace ${months} ${pluralizeEs(months, "mes")}`;
  }
  const years = Math.floor(days / 365);
  return years === 1 ? "hace 1 año" : `hace ${years} años`;
}

// ---------------------------------------------------------------------------
// Narrative pet
// ---------------------------------------------------------------------------

export const PAMPA = {
  name: "Pampa",
  sex: "Hembra",
  /**
   * Enum form of `sex`, for components whose copy inflects. The story rail and
   * the libreta mock both flag Pampa as lost, and without this they rendered
   * the masculine "PERDIDO" for a female dog on the first screen of the
   * product (same defect as critique-libreta finding #5, which was reported
   * against the owner's list).
   */
  sexEnum: "female",
  /**
   * The species noun, already agreeing with `sex` — for copy that names the
   * animal (the hero photo's alt said "perro" for a female dog). A constant
   * rather than a derivation: Pampa is one fixed character, and no helper in
   * the repo inflects species by sex.
   */
  speciesNoun: "perra",
  /**
   * Derived from the seed's date of birth with the app's own helper, not a
   * literal: a typed "4 años" goes stale the day Pampa has a birthday.
   */
  age: ageFromDateOfBirth(PAMPA_PET.dateOfBirth) ?? "",
} as const;

// ---------------------------------------------------------------------------
// Hero credential — the card the QR's own page prints, in miniature
// ---------------------------------------------------------------------------

/**
 * The hero card's identity fields. Same labels and the same words as the
 * public credential the hero QR opens (app/(public)/p/[publicToken]/page.tsx
 * prints "Microchip · Sí/No"; the native credential labels "Raza" and
 * "Microchip"), all read from the seed's pet row and libreta — so the
 * card and the page it links to cannot disagree about Pampa.
 *
 * "Sexo" and "Edad" were removed (PO 2026-09-30): the front had four fields
 * across two rows and only needed one line's worth of identity to make its
 * point; breed and microchip are the two that a person scanning a lost-pet
 * QR actually needs.
 */
export const HERO_CREDENTIAL_FIELDS: ReadonlyArray<{ label: string; value: string }> = [
  // "Raza" and "Microchip" are the labels the native credential prints
  // (apps/mobile/src/credential/CredentialScreen.tsx:375, :383). "Especie y
  // raza" was a label no product surface has (landing-vs-app audit 2026-09-30).
  { label: "Raza", value: PAMPA_PET.breed },
  {
    label: "Microchip",
    value: PAMPA_EVENTS.some((e) => e.eventType === "microchip_implanted") ? "Sí" : "No",
  },
];

/** Width of each machine-readable line on the hero card. */
export const HERO_MRZ_WIDTH = 30;

/** Upper-case, accents stripped, every run of anything else folded to "<". */
function mrzField(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "<");
}

/**
 * The hero card's machine-readable strip, in miMAR's OWN format.
 *
 * It used to be an ICAO passport line opening "P<ARG" — the document code and
 * issuing-State code of an Argentine passport. On a card this product issues,
 * that is the State signing something it never signed (the same overclaim the
 * state-endorsement fence removed from the eyebrow and the footers). The strip
 * keeps the document feel and says only what miMAR can say:
 *
 *   line 1 · issuer (the brand name in the strip's alphabet), the credential
 *            token, the pet's name
 *   line 2 · species, breed, sex (H/M), birth year and month
 *
 * With no demo pet to resolve (`token` null) the token segment is filler, the
 * same masking the card applies to the printed token: a strip must not show a
 * token as if it resolved when the QR beside it is inert.
 */
export function heroMrzLines(token: string | null): [string, string] {
  // dim-codename-ok: the public DIM-XXXX-XXXX token prefix, kept while the rest is masked.
  const tokenPart = token ? mrzField(token) : `DIM${"<".repeat(10)}`;
  const sexCode = PAMPA_PET.sex === "female" ? "H" : PAMPA_PET.sex === "male" ? "M" : "X";
  const [year = "", month = ""] = PAMPA_PET.dateOfBirth.split("-");
  const fit = (line: string) => line.padEnd(HERO_MRZ_WIDTH, "<").slice(0, HERO_MRZ_WIDTH);
  // The issuer code is the brand name put through the same A–Z/0–9 alphabet as
  // every other field: a machine-readable line has no lower case, so it cannot
  // spell "miMAR". Derived rather than typed, so the one upper-cased form of
  // the brand in the product is visibly the strip's encoding of it and not a
  // second spelling (lint:brand fences typed wrong-cased brand literals).
  const issuer = mrzField(BRANDING.appName);
  return [
    fit(`${issuer}<${tokenPart}<<${mrzField(PAMPA_PET.name)}`),
    fit(
      `${mrzField(speciesLabel(PAMPA_PET.species))}<${mrzField(PAMPA_PET.breed)}<<${sexCode}<${year}<${month}`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Cast — the four hands around the pet (CastFila, PO-locked variant)
// ---------------------------------------------------------------------------

// ONE NAME PER HAND, EVERYWHERE (critique 2026-09-29, M6). The cast said
// "Veterinario" and "Organización" while the rail and the chapter eyebrows said
// "Veterinaria" and "Refugio" for the same people; they now match. The cast is
// also no longer a grid of chapter shortcuts: the rail right below it already
// jumps to chapters, so two blocks did one job. It is one paragraph now.
export type LandingActor = {
  key: string;
  name: string;
  does: string;
};

export const ACTORS: LandingActor[] = [
  {
    key: "dueno",
    name: "Dueño",
    does: "Registra, comparte, activa el modo perdido.",
  },
  {
    key: "vet",
    name: "Veterinaria",
    does: "Firma vacunas y diagnósticos.",
  },
  {
    key: "refugio",
    name: "Refugio",
    // Owner's words (critique 2026-09-29, M2): what a shelter does FOR HER.
    does: "La recibe si se pierde y la identifica por su chip.",
  },
  {
    key: "estado",
    name: "Estado",
    does: "Vigila tendencias con datos reales.",
  },
];

// ---------------------------------------------------------------------------
// Chapters — Pampa's story, one hand per chapter
// ---------------------------------------------------------------------------

export type LandingChapter = {
  key: string;
  /**
   * What HAPPENS in the chapter, named on the rail and in the eyebrow
   * (critique 2026-09-29, M6). It used to be whose hand it was, which gave
   * "Anónimo" to a chapter about Pampa getting lost and "miMAR" to one that is
   * nobody's hand at all.
   */
  moment: string;
  /** Rail dot tone — drives the rail state (Pampa turns red on "anon"). */
  state: "registered" | "ok" | "lost" | "navy";
  /** Device side on desktop; the "estado" chapter is full-width. */
  side?: "l" | "r";
  full?: boolean;
  title?: string;
  lead?: string;
};

// Order note (PO, 2026-09-25): Pampa's life in order — 1 Dueño · 2 Veterinaria
// · 3 Se pierde · 4 Refugio · 5 La libreta · 6 Estado. This supersedes the
// 2026-07-21 order, which put "estado" before "libreta" so the institutional
// signal landed before the closing beat: /municipios now carries the
// institutional pitch, and the story ends where the libreta's last entry
// points — the 2026-06-15 Comuna 13 campaign dose, signed by a verified vet,
// which is one more dose in that jurisdiction's coverage. The "estado" lead
// is that bridge. Position/side data only — StorySection.tsx renders in array
// order.
export const CHAPTERS: LandingChapter[] = [
  {
    key: "dueno",
    moment: "Alta",
    state: "registered",
    side: "r",
    title: "Empieza en casa.",
    lead: `${OWNER_NAME} registra a Pampa: ya tiene su QR y su libreta.`,
  },
  {
    key: "vet",
    moment: "Vacuna",
    state: "ok",
    side: "l",
    // Pampa's libreta has no appointment: what the vet chapter can truthfully
    // show is the 2022 rabies dose being signed.
    title: "La vacuna queda firmada.",
    // "Dato fiable, de origen." was the operator's vocabulary (critique
    // 2026-09-29, M2; PO chose this wording over "vale como la libreta de papel").
    // Copy review 2026-09-30 (D7): "firmada con su matrícula" repeated 3 times
    // in this one chapter (the step list and the FAQ already say it).
    lead: `La ${VET_SHORT_NAME} le aplica la antirrábica y la anota en su libreta.`,
  },
  {
    key: "anon",
    moment: "Se pierde",
    state: "lost",
    side: "r",
    // 2024-03-09, the day the seed marks her lost, was a Saturday; the seed's
    // last_seen_context is "Se soltó en la plaza durante un paseo".
    title: "Un sábado, se suelta en la plaza.",
    // Copy review 2026-09-30 (D10): the first sentence repeated the chapter's
    // own step 1, right below. PO 2026-10-01: the chapter now opens on the
    // owner's report and poster, and the neighbour's notice is a sighting.
    lead: `${OWNER_NAME} la reporta perdida e imprime su cartel. Un vecino escanea el QR y le avisa, sin cuenta ni app.`,
  },
  {
    key: "refugio",
    moment: "Refugio",
    // Still lost here: the shelter takes her in on 2024-03-11; Martín marks
    // her found on 2024-03-13, at the end of this chapter.
    state: "lost",
    side: "l",
    // The return home is authored by the owner (2024-03-13), not the shelter.
    title: "La recibe un refugio.",
    // Copy review 2026-09-30 (D9): the fuller version repeated the 7 steps
    // the chapter plays right below it.
    lead: `Leen su chip y miMAR la reconoce. Dos días después, ${OWNER_NAME} la marca como encontrada.`,
  },
  {
    key: "libreta",
    moment: "Libreta",
    state: "ok",
    side: "r",
    title: "Todo quedó escrito.",
    // Honesty pass (WU1, landing redesign 2026-09-24): "inmutable" overclaimed —
    // art. 16 de la Ley 25.326 exige una excepción auditada de supresión sobre
    // el asiento (límites honestos A.1). Lo que sí se sostiene: solo agrega.
    // Copy review 2026-09-30 (D12): 38 words down to one sentence — the
    // "asiento nuevo" mechanic is explained once already (see the FAQ trust
    // row), and "cada vuelta a casa" is the same phrasing the honesty pass
    // retired from the libreta row above.
    lead: `${OWNER_NAME}, la ${VET_SHORT_NAME} y el refugio escribieron en la misma libreta.`,
  },
  {
    key: "estado",
    moment: "Estado",
    state: "navy",
    full: true,
    // Bridge from the libreta's last entry. True under both coverage lenses:
    // the dose is a vaccination_administered signed by a verified vet.
    lead: "Esa dosis de campaña es una más en la cobertura de su comuna.",
  },
];

// ---------------------------------------------------------------------------
// Pampa's libreta — REAL system event types only, as seen in the app
// ---------------------------------------------------------------------------

/** One asiento as the native libreta draws it (see the projection above). */
export type LibretaEvent = {
  /** event_type verbatim (English, system vocabulary). */
  type: string;
  /** The seed's date, "YYYY-MM-DD". */
  date: string;
  year: string;
  /** The mono eyebrow (LibretaScreen.tsx:358). */
  kind: string;
  title: string;
  /** "12 abr 2022" — the absolute half of "{relativo} · {fecha}" (:360-362). */
  whenAbsolute: string;
  facts: LibretaFact[];
  /** The provenance line (:370). */
  provenance: string;
};

/** Pampa's libreta, chronological (oldest → newest), straight from the seed. */
export const LIBRETA_EVENTS: LibretaEvent[] = PAMPA_EVENTS.flatMap((e) => {
  const copy = asientoCopy(e);
  if (!copy) return [];
  return [
    {
      type: e.eventType,
      date: e.date,
      year: e.date.slice(0, 4),
      kind: copy.kind,
      title: copy.title,
      whenAbsolute: asientoDate(e.date),
      facts: copy.facts,
      provenance: provenance(e, copy.cited ?? null),
    },
  ];
});

/**
 * The hero card's back face — a mini libreta: the three newest entries a vet
 * signed, newest first ("Dra. Marrone · 06/2026"). The rows used to name a
 * "Vet. M.N. 12.345", a deworming and a "Clínica Recoleta" that are nowhere in
 * Pampa's record.
 */
export const HERO_LIBRETA_ROWS: Array<{ what: string; who: string }> = PAMPA_EVENTS.filter(
  (e) => e.authorRole === "vet" && e.authorVerified,
)
  .slice(-3)
  .reverse()
  .map((e) => {
    const [year = "", month = ""] = e.date.split("-");
    const p = e.payload;
    const what =
      e.eventType === "vaccination_administered"
        ? str(p.vaccine_name)
        : e.eventType === "clinical_info_logged"
          ? str(p.title)
          : e.eventType === "sterilization_performed"
            ? "Castración"
            : "Microchip";
    return { what, who: `${VET_SHORT_NAME} · ${month}/${year}` };
  });

// ---------------------------------------------------------------------------
// Estado console — 24-jurisdiction cartogram (silhouette layout, celeste tint)
// ---------------------------------------------------------------------------

export type MapTile = {
  ab: string;
  name: string;
  /** Grid column (0-based) — schematic Argentina silhouette layout. */
  c: number;
  /** Grid row (0-based). */
  r: number;
  /**
   * Rabies coverage, dogs, last 12 months, in % (demo data). A real panorama
   * layer (`rabies-coverage`, src/modules/panorama/application/get-layer-features.ts:516)
   * and a real KPI (lib/metrics/kpi-catalog.ts:377); the old "señales por 100
   * mil habitantes" was neither (landing-vs-app audit 2026-09-30).
   */
  v: number;
};

export const MAP_TILES: MapTile[] = [
  { ab: "JUJ", name: "Jujuy", c: 1, r: 0, v: 70.5 },
  { ab: "SAL", name: "Salta", c: 1, r: 1, v: 77 },
  { ab: "FOR", name: "Formosa", c: 3, r: 1, v: 81 },
  { ab: "MIS", name: "Misiones", c: 4, r: 1, v: 74 },
  { ab: "CAT", name: "Catamarca", c: 0, r: 2, v: 54.5 },
  { ab: "TUC", name: "Tucumán", c: 1, r: 2, v: 61 },
  { ab: "SDE", name: "S. del Estero", c: 2, r: 2, v: 66.5 },
  { ab: "CHA", name: "Chaco", c: 3, r: 2, v: 75.5 },
  { ab: "CTS", name: "Corrientes", c: 4, r: 2, v: 68 },
  { ab: "LRJ", name: "La Rioja", c: 0, r: 3, v: 49 },
  { ab: "CBA", name: "Córdoba", c: 2, r: 3, v: 52 },
  { ab: "SFE", name: "Santa Fe", c: 3, r: 3, v: 57.5 },
  { ab: "ERS", name: "Entre Ríos", c: 4, r: 3, v: 55.5 },
  { ab: "SJN", name: "San Juan", c: 0, r: 4, v: 46 },
  { ab: "SLU", name: "San Luis", c: 1, r: 4, v: 45 },
  { ab: "BUE", name: "Buenos Aires", c: 3, r: 4, v: 60 },
  { ab: "CABA", name: "CABA", c: 4, r: 4, v: 47 },
  { ab: "MZA", name: "Mendoza", c: 0, r: 5, v: 45.5 },
  { ab: "LPA", name: "La Pampa", c: 2, r: 5, v: 41.5 },
  { ab: "NQN", name: "Neuquén", c: 1, r: 6, v: 40.5 },
  { ab: "RNG", name: "Río Negro", c: 2, r: 6, v: 44 },
  { ab: "CHU", name: "Chubut", c: 1, r: 7, v: 39.5 },
  { ab: "SCZ", name: "Santa Cruz", c: 1, r: 8, v: 37 },
  { ab: "TDF", name: "T. del Fuego", c: 2, r: 9, v: 36.5 },
];

/** Celeste tint quantile (0–4) — silhouette map, single hue (PO decision #5). */
export function mapTintStep(v: number): 0 | 1 | 2 | 3 | 4 {
  if (v >= 75) return 4;
  if (v >= 65) return 3;
  if (v >= 55) return 2;
  if (v >= 45) return 1;
  return 0;
}

// Both labels are real KPIs (lib/metrics/kpi-catalog.ts:377 shortened, and
// :597 verbatim). "Jurisdicciones con señal" was not one (landing-vs-app audit
// 2026-09-30): nothing in the catalog is called that.
//
// Two, not four (critique 2026-09-29, M7, PO-approved): for an owner the
// console is a glimpse, not a pitch. The one that speaks to their own pet's
// vaccine leads; the full console lives on /municipios.
export const CONSOLE_KPIS = [
  { label: "Cobertura antirrábica", value: "72,4%", tone: "ok" },
  { label: "Mascotas en observación rábica", value: "38", tone: "blue" },
] as const;

// ---------------------------------------------------------------------------
// Features — life moments (LifeSG naming; NO law citations in copy)
// ---------------------------------------------------------------------------

export type LifeMoment = {
  icon: IconName;
  title: string;
  body: string;
};

export const LIFE_MOMENTS: LifeMoment[] = [
  // "Vi un caso de maltrato" was cut (copy review 2026-09-30, D6): CrisisBand
  // already has this exact door above the fold, and this card's own body
  // said "el caso lo toma la autoridad" — which contradicts
  // app/(public)/denuncias/seguimiento/page.tsx ("aún no fue enviada a la
  // herramienta gubernamental").
  {
    icon: "shield",
    title: "Mi perro mordió a alguien",
    // Copy review 2026-09-30: "se cierra en miMAR. Automático." was false —
    // only a professional closes an observation
    // (src/modules/surveillance/application/close-eligible-observations.ts).
    body: "La observación antirrábica se abre en miMAR y la cierra un profesional.",
  },
  {
    icon: "vacuna",
    title: "Hay campaña en mi barrio",
    // Honesty pass (WU1; corrected 2026-09-24 review): "una vez por día" was
    // ALSO wrong — panorama_cube (daily cron) is a DIFFERENT surface from the
    // KPI this life-moment describes. rabies_coverage_dogs_12m
    // (lib/metrics/kpi-catalog.ts:375-389, fetcherName "fetchRabiesCoverage")
    // is computed straight from pets/pet_events, cadence "recomputed on every
    // render" — live, not daily. Rewritten to make no cadence claim at all:
    // just that it is automatic, not a spreadsheet.
    // Owner's words (critique 2026-09-29, M2): what the campaign means for
    // YOUR pet and what your comuna sees. Still no cadence claim.
    // Copy review 2026-09-30 (the state-access claim, minimal option): "sin
    // ver las de nadie" repeated the false "solo totales" promise this pass
    // removed from the Estado chapter.
    body: "La dosis de campaña se suma a su libreta y a la cobertura de tu comuna.",
  },
  {
    icon: "candado",
    title: "No quiero exponer mis datos",
    body: "Vos decidís qué se muestra; tu identidad nunca se publica.",
  },
  {
    icon: "corazon",
    title: "Quiero adoptar",
    // Copy review 2026-09-30: "acceso otorgado" was jargon, and "nacional"
    // read as a state-run catalog.
    body: "Mascotas en adopción de organizaciones verificadas.",
  },
  {
    icon: "transferencia",
    title: "Cambió de familia",
    // Copy review 2026-09-30: subject/verb agreement fix ("tránsito, adopción
    // y transferencia" is plural, "queda" is singular).
    body: "Tránsitos, adopciones y transferencias quedan en su libreta.",
  },
  {
    // PO 2026-10-01. The travel view (loadTravelView) checks the
    // destination's and the airline's requirements against the libreta.
    // The sixth card also closes the grid: 3 + 3 at three columns, 2 + 2 + 2
    // at two (app/landing.css .lp-feat-grid), where five left one row short.
    icon: "valija",
    title: "Me voy de viaje con mi mascota",
    body: "Te dice qué le falta según el país y la aerolínea, con lo que ya está en su libreta.",
  },
];

// ---------------------------------------------------------------------------
// FAQ — objection handling (NZ DIA pattern)
// ---------------------------------------------------------------------------

export const FAQS: Array<[string, string]> = [
  [
    "¿Cuánto cuesta?",
    // The answer used to open "miMAR lo opera la autoridad sanitaria nacional",
    // which asserted an operator the product does not have. The rest of the
    // answer — free, and nobody may charge in miMAR's name — is true and stays.
    "Nada, nunca. Registrar tu mascota y recuperarla no tiene costo. Desconfiá de cualquiera que te pida dinero en su nombre.",
  ],
  [
    "¿Quién ve los datos de mi mascota?",
    // Copy review 2026-09-30 (the state-access claim, minimal option): this
    // answer used to say nothing about the State's own access, which the
    // Estado chapter now states plainly — the two must agree.
    "Vos ves todo. Quien escanea el QR ve solo lo que decidiste compartir. La autoridad de tu zona accede a lo que necesita para cuidar la salud pública, y cada acceso queda registrado.",
  ],
  [
    "¿Necesito microchip?",
    "No. La credencial QR funciona desde el día uno. Si tu mascota ya tiene chip, se asocia al mismo historial y suma una forma más de identificarla.",
  ],
  [
    // Critique 2026-09-29, M1: the whole "anyone can scan it if she gets lost"
    // promise rests on a physical QR, and the page never said how to get one.
    // Only the two paths that exist today: the self-print sheet at
    // /mis-mascotas/[token]/chapita (on unless the jurisdiction turns its
    // printable_qr channel off, lib/domain/business-rules-defaults.ts) and the
    // pre-issued tag activated at /cuenta/chapas/activar with its serial and
    // the code printed on the envelope.
    "¿Cómo le pongo el QR?",
    // Copy review 2026-09-30: 45 words down to the two real paths, without
    // repeating step 3 of "Empezar" (recortala/plastificala, número de serie).
    "Desde la ficha de tu mascota imprimís su chapita con el QR, si tu jurisdicción lo habilita. Si te dieron una chapa miMAR, la activás desde tu cuenta.",
  ],
  [
    "¿Reemplaza la libreta de papel?",
    // PO 2026-09-29 (critique M3): "firmada digitalmente" names a legal
    // category (Ley 25.506, licensed certifier) the product does not claim, and
    // no homologation is in progress.
    "Tiene la misma información, firmada por tu veterinaria con su matrícula verificada. Por ahora, conservá también la libreta de papel.",
  ],
  [
    "¿Y si me roban el teléfono?",
    "Tu libreta no está en el teléfono: entrás desde cualquier dispositivo, y el QR sigue funcionando.",
  ],
];

// ---------------------------------------------------------------------------
// Empezar — 3 doors (owner + organization + municipio/provincia, WU4).
//
// The third door does NOT reverse "gov/admin accounts are invite-only": it
// leads to /municipios, a PUBLIC information page about the offering, never
// to sign-up. Institutional accounts stay invite-only; this door only lets a
// funcionario learn what miMAR offers before anyone invites them (landing
// redesign 2026-09-24, WU4).
// ---------------------------------------------------------------------------

export type LandingRole = {
  tone: "dueno" | "org" | "gob";
  icon: IconName;
  eyebrow: string;
  title: string;
  /** Optional: the owner door's intro sentence was cut (copy review
   *  2026-09-30) — its 3 steps below already say what it said. */
  body?: string;
  cta: string;
  ctaHref: string;
  cta2: string;
  cta2Href: string;
  /** How it starts, in order (the owner door only). */
  steps?: string[];
};

export const ROLES: LandingRole[] = [
  {
    tone: "dueno",
    icon: "corazon",
    eyebrow: "Soy dueño",
    title: "miMAR para tu mascota",
    // M1 (critique 2026-09-29): the last step is the physical QR, the one the
    // page's whole lost-pet promise depends on. See the "¿Cómo le pongo el
    // QR?" FAQ for the two real paths.
    steps: [
      "Creá tu cuenta.",
      "Registrá a tu mascota: su credencial con QR se crea al terminar.",
      "Imprimí su chapita con el QR, o activá la chapa que te entregaron, y ponésela en el collar.",
    ],
    cta: "Crear cuenta",
    ctaHref: "/registro",
    cta2: "Ya tengo cuenta",
    cta2Href: "/iniciar-sesion",
  },
  {
    tone: "org",
    icon: "edificio",
    eyebrow: "Soy organización",
    title: "Solicitá acceso verificado",
    body: "Refugios, veterinarias, redes de rescate: custodia, adopciones y eventos sanitarios firmados.",
    cta: "Solicitar acceso",
    // Its own request form (critique 2026-09-29, M8): /registro is the
    // OWNER's sign-up, so an organization used to land in the wrong flow.
    ctaHref: "/organizaciones/solicitar-acceso",
    cta2: "Ya tengo cuenta",
    cta2Href: "/iniciar-sesion",
  },
  {
    tone: "gob",
    icon: "edificio",
    eyebrow: "Soy municipio o provincia",
    title: "miMAR para tu jurisdicción",
    body: "Coordiná campañas y seguí la cobertura de tu jurisdicción.",
    cta: "Conocer miMAR para municipios",
    ctaHref: "/municipios",
    cta2: "Ya tengo cuenta institucional",
    cta2Href: "/iniciar-sesion",
  },
];

// ---------------------------------------------------------------------------
// Footer nav — 3 columns, real routes only
// ---------------------------------------------------------------------------

export const FOOTER_NAV: Array<[string, Array<[string, string]>]> = [
  [
    "Ciudadanía",
    [
      ["Crear mi miMAR", "/registro"],
      ["Mascotas perdidas", "/perdidas"],
      ["Adoptar", "/adoptar"],
      ["Denunciar maltrato", "/denuncias/nueva"],
      // The return path for someone who already denounced. It used to be the
      // DEN- half of the crisis band's code lookup; when that lookup came out
      // of the band (2026-08-19) the follow-up had no door left on the home
      // page at all. The footer is the right level of prominence for it —
      // /denuncias/buscar explains the case in a sentence, which an input
      // with a placeholder never did.
      ["Seguir mi denuncia", "/denuncias/buscar"],
      ["Centro de ayuda", "/ayuda"],
      // "Sugerencias" removed (blind QA 2026-08-19): /sugerencias renders a
      // "muy pronto" placeholder with no submission mechanism. AppFooter had
      // already dropped it for exactly that reason ("link hidden to avoid dead
      // end") — the fix landed on one of the two footers and this one, on the
      // highest-traffic page in the product, kept offering the dead end.
      // Since pilot T1-P5 /sugerencias names a mailbox a person reads; the
      // link is still out of BOTH footers until somebody decides to restore
      // it — see __tests__/footer-dead-end-fitness.test.ts.
    ],
  ],
  [
    "Operadores",
    [
      ["Organizaciones", "/organizaciones/solicitar-acceso"],
      ["Refugios", "/refugios"],
      ["Iniciar sesión", "/iniciar-sesion"],
    ],
  ],
  [
    "Institucional",
    [
      ["Municipios", "/municipios"],
      ["Acerca de miMAR", "/acerca"],
      ["Transparencia y datos", "/transparencia"],
      ["Funcionalidades", "/funcionalidades"],
      ["Marco legal", "/leyes"],
      ["Privacidad", "/privacidad"],
      ["Términos", "/terminos"],
      ["Cookies", "/cookies"],
      ["Accesibilidad", "/accesibilidad"],
    ],
  ],
];
