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
import {
  OWNER_NAME,
  PAMPA_EVENTS,
  PAMPA_PET,
  type PampaAuthorRole,
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

const MONTHS_ES = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
] as const;

/** "2022-04-12" → { year: "2022", month: "abr", day: 12 }. */
function splitDate(date: string): { year: string; month: string; day: number } {
  const [year = "", month = "1", day = "1"] = date.split("-");
  return { year, month: MONTHS_ES[Number(month) - 1] ?? "", day: Number(day) };
}

/** "2022-04-12" → "12 abr 2022". */
export function landingDate(date: string): string {
  const { year, month, day } = splitDate(date);
  return `${day} ${month} ${year}`;
}

/** "941000100000001" → "941 000 100 000 001". */
export function formatChip(chip: string): string {
  return chip.replace(/(\d{3})(?=\d)/g, "$1 ");
}

/** "Dra. Lilian Marrone" → "Dra. Marrone" (title + surname, as the story names her). */
export const VET_SHORT_NAME = (() => {
  const parts = VET_NAME.split(" ");
  return `${parts[0]} ${parts[parts.length - 1]}`;
})();

export const PAMPA_VET = {
  name: VET_NAME,
  shortName: VET_SHORT_NAME,
  license: VET_LICENSE,
  clinic: VET_CLINIC,
} as const;

export const PAMPA_OWNER_NAME = OWNER_NAME;

/** "Caniche · hembra · nacimiento estimado nov 2021" — the sign-up facts. */
export const PAMPA_SIGNUP_LINE = (() => {
  const dob = splitDate(PAMPA_PET.dateOfBirth);
  const sex = PAMPA_PET.sex === "female" ? "hembra" : "macho";
  const born = PAMPA_PET.birthDateIsEstimated ? "nacimiento estimado" : "nacimiento";
  return `${PAMPA_PET.breed} · ${sex} · ${born} ${dob.month} ${dob.year}`;
})();

const AUTHOR_BY_ROLE: Record<PampaAuthorRole, string> = {
  owner: `${OWNER_NAME} · dueño`,
  vet: `${VET_SHORT_NAME} · vet`,
  shelter: "Refugio · org",
  scanner: "Anónimo · vía QR",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function lowerFirst(v: string): string {
  return v.charAt(0).toLowerCase() + v.slice(1);
}

/** Looks one seed event up by type (and, for status changes, target status). */
export function pampaEvent(eventType: string, toStatus?: string): PampaSeedEvent {
  const hit = PAMPA_EVENTS.find(
    (e) => e.eventType === eventType && (toStatus === undefined || e.payload.to_status === toStatus),
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

type LibretaCopy = Pick<LibretaEvent, "tone" | "title" | "meta" | "flag" | "stamp">;

function libretaCopy(e: PampaSeedEvent): LibretaCopy | null {
  const p = e.payload;
  switch (e.eventType) {
    case "pet_registered":
      return { tone: "warm", title: "Alta en el registro", meta: PAMPA_SIGNUP_LINE };
    case "microchip_implanted":
      return {
        tone: "",
        title: "Microchip implantado",
        meta: `${formatChip(str(p.chip_number))} · ${str(p.location_on_body)}`,
      };
    case "vaccination_administered": {
      const campaign = str(p.administered_by).startsWith("Campaña");
      return {
        tone: campaign ? "navy" : "ok",
        title: `Vacunación: ${lowerFirst(str(p.vaccine_name))}`,
        meta: `${str(p.brand)} · lote ${str(p.batch)} · ${str(p.administered_by)}`,
        stamp: "ok",
      };
    }
    case "sterilization_performed":
      return { tone: "ok", title: "Castración", meta: str(p.clinic) };
    case "status_changed": {
      if (p.to_status === "lost") {
        const lost = (p.lost_description ?? {}) as Record<string, unknown>;
        return {
          tone: "err",
          title: "Reportada perdida",
          meta: `${str(p.location_description)} · ${lowerFirst(str(lost.accessories_when_lost))}`,
          flag: "lost",
        };
      }
      return { tone: "ok", title: "Volvió a casa", meta: "Devuelta a su dueño", flag: "ok" };
    }
    case "shelter_intake_recorded":
      return { tone: "", title: "Ingresó a un refugio", meta: str(p.intake_condition) };
    case "clinical_info_logged":
      return {
        tone: "warn",
        title: "Diagnóstico registrado",
        meta: `${str(p.title)} · ${lowerFirst(str(p.details))}`,
        flag: "sick",
      };
    // credential_scanned is NOT a libreta row: scanner-role scans are purged
    // after 90 days (lib/infra/scan-retention.ts).
    default:
      return null;
  }
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
  age: "4 años",
} as const;

// ---------------------------------------------------------------------------
// Cast — the four hands around the pet (CastFila, PO-locked variant)
// ---------------------------------------------------------------------------

export type LandingActor = {
  key: string;
  /** Chapter id this hand scrolls to (cap-{chapter}). */
  chapter: string;
  tone: "warm" | "neutral" | "official";
  icon: IconName;
  name: string;
  does: string;
};

export const ACTORS: LandingActor[] = [
  {
    key: "dueno",
    chapter: "dueno",
    tone: "warm",
    icon: "corazon",
    name: "Dueño",
    does: "Registra, comparte, activa el modo perdido.",
  },
  {
    key: "vet",
    chapter: "vet",
    tone: "neutral",
    icon: "vet",
    name: "Veterinario",
    does: "Firma vacunas y diagnósticos.",
  },
  {
    key: "org",
    chapter: "refugio",
    tone: "neutral",
    icon: "casa",
    name: "Organización",
    does: "Custodia, tránsitos y adopciones verificadas.",
  },
  {
    key: "estado",
    chapter: "estado",
    tone: "official",
    icon: "edificio",
    name: "Estado",
    does: "Vigila tendencias con datos reales.",
  },
];

// ---------------------------------------------------------------------------
// Chapters — Pampa's story, one hand per chapter
// ---------------------------------------------------------------------------

export type LandingChapter = {
  key: string;
  hand: string;
  /** Rail dot tone — drives the rail state (Pampa turns red on "anon"). */
  state: "registered" | "ok" | "lost" | "navy";
  /** Device side on desktop; the "estado" chapter is full-width. */
  side?: "l" | "r";
  full?: boolean;
  title?: string;
  lead?: string;
};

// Order note (calmer/institutional pass 2026-07-21): "estado" was chapter 6
// (dead last, after "libreta"). Promoted to chapter 5 — right after Pampa's
// personal arc resolves (refugio) and before the closing "Todo quedó
// escrito" beat — so the institutional credibility signal (the cartogram)
// lands before the section's last word, not buried past it. This also reads
// better: "Cuatro manos, una sola historia" now truly closes the story once
// all four hands (dueño, vet, org, Estado) have appeared. Moving it any
// earlier (e.g. right after the "se pierde" crisis chapter) was considered
// and rejected: it would drop a cold institutional dashboard in the middle
// of the lost-pet urgency, undercutting the emotional beat the story needs
// there. Position/side data only — StorySection.tsx renders in array order.
export const CHAPTERS: LandingChapter[] = [
  {
    key: "dueno",
    hand: "Dueño",
    state: "registered",
    side: "r",
    title: "Empieza en casa.",
    lead: "Martín registra a Pampa: identidad pública con QR y un historial listo para escribirse. Gratuito, en cinco minutos.",
  },
  {
    key: "vet",
    hand: "Veterinaria",
    state: "ok",
    side: "l",
    title: "El turno salió de la app.",
    lead: "Martín reservó por miMAR. La Dra. Romero — matrícula verificada — la vacunó y firmó el evento. Dato fiable, de origen.",
  },
  {
    key: "anon",
    hand: "Anónimo",
    state: "lost",
    side: "r",
    title: "Un martes, se pierde.",
    lead: "Alguien la encuentra en la plaza y escanea su QR. Sin cuenta y sin app: ve lo justo para ayudar y avisa.",
  },
  {
    key: "refugio",
    hand: "Refugio",
    state: "ok",
    side: "l",
    title: "La recibe el refugio más cercano.",
    lead: "Verifican el chip, miMAR dice quién es, y Martín ya está en camino. Custodia devuelta — y registrada.",
  },
  { key: "estado", hand: "Estado", state: "navy", full: true },
  {
    key: "libreta",
    hand: "miMAR",
    state: "ok",
    side: "r",
    title: "Todo quedó escrito.",
    // Honesty pass (WU1, landing redesign 2026-09-24): "inmutable" overclaimed —
    // art. 16 de la Ley 25.326 exige una excepción auditada de supresión sobre
    // el asiento (límites honestos A.1). Lo que sí se sostiene: solo agrega.
    lead: `${OWNER_NAME}, la ${VET_SHORT_NAME} y el refugio escribieron en la misma libreta. Cada vacuna, cada consulta, cada vuelta a casa se suma a la de Pampa. Solo se agrega: una corrección es un asiento nuevo, nunca una edición.`,
  },
];

// ---------------------------------------------------------------------------
// Pampa's libreta — REAL system event types only, as seen in the app
// ---------------------------------------------------------------------------

export type LibretaEvent = {
  year: string;
  month: string;
  tone: "" | "ok" | "warn" | "err" | "warm" | "navy";
  title: string;
  meta: string;
  /** event_type verbatim (English, system vocabulary). */
  type: string;
  by: string;
  flag?: "lost" | "ok" | "sick";
  stamp?: "ok";
};

/** Pampa's libreta, chronological (oldest → newest), straight from the seed. */
export const LIBRETA_EVENTS: LibretaEvent[] = PAMPA_EVENTS.flatMap((e) => {
  const copy = libretaCopy(e);
  if (!copy) return [];
  const { year, month } = splitDate(e.date);
  return [{ year, month, type: e.eventType, by: AUTHOR_BY_ROLE[e.authorRole], ...copy }];
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
  /** Zoonotic signals per 100k inhabitants, last 12 months (demo data). */
  v: number;
};

export const MAP_TILES: MapTile[] = [
  { ab: "JUJ", name: "Jujuy", c: 1, r: 0, v: 7.1 },
  { ab: "SAL", name: "Salta", c: 1, r: 1, v: 8.4 },
  { ab: "FOR", name: "Formosa", c: 3, r: 1, v: 9.2 },
  { ab: "MIS", name: "Misiones", c: 4, r: 1, v: 7.8 },
  { ab: "CAT", name: "Catamarca", c: 0, r: 2, v: 3.9 },
  { ab: "TUC", name: "Tucumán", c: 1, r: 2, v: 5.2 },
  { ab: "SDE", name: "S. del Estero", c: 2, r: 2, v: 6.3 },
  { ab: "CHA", name: "Chaco", c: 3, r: 2, v: 8.1 },
  { ab: "CTS", name: "Corrientes", c: 4, r: 2, v: 6.6 },
  { ab: "LRJ", name: "La Rioja", c: 0, r: 3, v: 2.8 },
  { ab: "CBA", name: "Córdoba", c: 2, r: 3, v: 3.4 },
  { ab: "SFE", name: "Santa Fe", c: 3, r: 3, v: 4.5 },
  { ab: "ERS", name: "Entre Ríos", c: 4, r: 3, v: 4.1 },
  { ab: "SJN", name: "San Juan", c: 0, r: 4, v: 2.2 },
  { ab: "SLU", name: "San Luis", c: 1, r: 4, v: 2.0 },
  { ab: "BUE", name: "Buenos Aires", c: 3, r: 4, v: 5.0 },
  { ab: "CABA", name: "CABA", c: 4, r: 4, v: 2.4 },
  { ab: "MZA", name: "Mendoza", c: 0, r: 5, v: 2.1 },
  { ab: "LPA", name: "La Pampa", c: 2, r: 5, v: 1.3 },
  { ab: "NQN", name: "Neuquén", c: 1, r: 6, v: 1.1 },
  { ab: "RNG", name: "Río Negro", c: 2, r: 6, v: 1.8 },
  { ab: "CHU", name: "Chubut", c: 1, r: 7, v: 0.9 },
  { ab: "SCZ", name: "Santa Cruz", c: 1, r: 8, v: 0.4 },
  { ab: "TDF", name: "T. del Fuego", c: 2, r: 9, v: 0.3 },
];

/** Celeste tint quantile (0–4) — silhouette map, single hue (PO decision #5). */
export function mapTintStep(v: number): 0 | 1 | 2 | 3 | 4 {
  if (v >= 8) return 4;
  if (v >= 6) return 3;
  if (v >= 4) return 2;
  if (v >= 1.5) return 1;
  return 0;
}

// Grouped by theme (PO landing feedback): the first pair is surveillance
// REACH — how wide the signal spreads (total signals + jurisdictions covered);
// the second pair is the RABIES-specific read (active observations + coverage).
export const CONSOLE_KPIS = [
  { label: "Señales zoonóticas · 12m", value: "1.982", tone: "warn" },
  { label: "Jurisdicciones con señal", value: "19/24", tone: "blue" },
  { label: "Observaciones antirrábicas", value: "214", tone: "danger" },
  { label: "Cobertura antirrábica", value: "72,4%", tone: "ok" },
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
  {
    icon: "alerta",
    title: "Vi un caso de maltrato",
    body: "Sin cuenta y sin login. Recibís un código de seguimiento y el caso lo toma la autoridad.",
  },
  {
    icon: "shield",
    title: "Mi perro mordió a alguien",
    body: "Tras una mordedura, el período de observación se abre, se sigue y se cierra en miMAR. Automático.",
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
    body: "Las vacunaciones masivas cargan constancias solas; la cobertura se actualiza sola, sin planillas.",
  },
  {
    icon: "candado",
    title: "No quiero exponer mis datos",
    body: "Vos decidís qué se muestra; tu identidad nunca se publica.",
  },
  {
    icon: "corazon",
    title: "Quiero adoptar",
    body: "Catálogo nacional solo con organizaciones de acceso otorgado.",
  },
  {
    icon: "transferencia",
    title: "Cambió de familia",
    body: "Cada tránsito, adopción y transferencia queda registrada.",
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
    "Vos ves todo. Quien escanea el QR ve solo lo que decidiste compartir. Cada profesional u organización accede según su rol.",
  ],
  [
    "¿Necesito microchip?",
    "No. La credencial QR funciona desde el día uno. Si tu mascota ya tiene chip, se asocia al mismo historial y suma una forma más de identificarla.",
  ],
  [
    "¿Reemplaza la libreta de papel?",
    "Tiene la misma información, firmada digitalmente. Mientras la homologación avanza jurisdicción por jurisdicción, conservá también la de papel.",
  ],
  [
    "¿Y si me roban el teléfono?",
    "miMAR no vive en tu teléfono: vive en el registro. Entrás desde cualquier dispositivo con tu cuenta, y la credencial pública sigue funcionando igual.",
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
  body: string;
  cta: string;
  ctaHref: string;
  cta2: string;
  cta2Href: string;
};

export const ROLES: LandingRole[] = [
  {
    tone: "dueno",
    icon: "corazon",
    eyebrow: "Soy dueño",
    title: "miMAR para tu mascota",
    body: "Identidad pública con QR, historial sanitario y modo perdido. Gratis.",
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
    ctaHref: "/registro",
    cta2: "Ya tengo cuenta",
    cta2Href: "/iniciar-sesion",
  },
  {
    tone: "gob",
    icon: "edificio",
    eyebrow: "Soy municipio o provincia",
    title: "miMAR para tu jurisdicción",
    body: "Zoonosis y bienestar animal: coordiná campañas y respondé con datos de origen, no planillas.",
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
      ["Organizaciones", "/registro"],
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
