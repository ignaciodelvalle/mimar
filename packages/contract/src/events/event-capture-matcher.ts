// Captura rápida — local keyword matcher (no LLM, no network).
//
// Takes free Spanish text from the owner and tries to match it to one
// of the 14 event-creation forms in EVENT_CAPTURE_REGISTRY. Returns a
// MatchResult with the resolved event_type, a confidence label, and
// any slot values it could extract (vaccine name, kg, microchip id,
// note body, date).
//
// Design constraints:
//   - 100% deterministic, runs client-side, no fetch.
//   - "Excellent match" path covers the high-frequency events
//     (vacuna, antiparasitario, peso, vet, microchip, esterilización,
//     fallecimiento, checkin, nota). The 5 complex forms (medicación
//     inicio/fin, mordedura, síntoma, clínico) match by trigger only
//     and return empty slots — the user fills in the form.
//   - First match wins. PATTERN order encodes priority — more specific
//     patterns come first (so "le di antirrábica" hits vaccine before
//     a generic "nota" catch-all).
//   - Negative matches (no trigger fired) return null so the UI can
//     show "no reconocemos eso".
//
// WHY IT LIVES IN THE CONTRACT SINCE 2026-09-17, AND NOT IN lib/events/
// ---------------------------------------------------------------------------
// The native app grew a capture box of its own (the asentar screen's
// `QuickCaptureBox`), and a second surface that has to answer "what kind of
// asiento is this sentence?" is exactly where a copy gets made. A copy would
// have been easy — this file has no dependency to speak of — and it would have
// been the worst outcome available: two matchers drifting apart means the SAME
// sentence resolves to different forms on the web and on the phone, for a
// product whose whole promise is one libreta seen from two places. The web's
// nine WP fixes recorded in the patterns below (the diacritic lookaheads, the
// `control post adopción` ordering, the `análisis` typo) would have had to be
// found and fixed twice.
//
// It moved rather than being copied because moving cost one import. The ONLY
// app-level reference here was a type-only import of `EventType` through the
// web app's alias for `db/schema`, and that symbol has lived in
// `./event-types.ts` since the catalog was pulled out of the ORM — the ORM
// module merely re-exports it. So the file was already pure by construction and
// nobody had noticed.
//
// (That sentence is deliberately spelled out in prose. Written as the import
// statement it actually was, `check-contract-purity` reads it out of the raw
// source and fails the fence on a comment explaining why the import is gone —
// the hazard this repo already has a name for.)
//
// `lib/events/event-capture-matcher.ts` is now a re-export of this module, the
// same shape `db/schema.ts` uses for `EVENT_TYPES`: the eight web call sites
// and the four web test files keep their import path and their behaviour, and
// there is still exactly one matcher.
//
// WHAT A CONSUMER OUTSIDE THE WEB MUST KNOW. `EVENT_CAPTURE_REGISTRY` and
// `buildCaptureDeeplink` did NOT move: those map an event type to a WEB ROUTE
// (`/eventos/nuevo/vacuna`, `?sheet=peso`), which is a fact about the Next.js
// app and not about the domain. `matchToCaptureUrl` stays here only because it
// takes that builder as an argument — it is web-shaped, and a native caller
// reads `MatchResult.eventType` directly instead. `routeOverride` is web-shaped
// for the same reason; see `apps/mobile/src/pets/capture-match.ts` for why the
// native side rejects every match that carries one.

import type { EventType } from "./event-types.ts";

export type ConfidenceLabel = "high" | "medium" | "low";

export type MatchResult = {
  eventType: EventType;
  confidence: ConfidenceLabel;
  slots: Record<string, string>;
  /** The first trigger pattern that matched. Useful for debugging + tests. */
  matchedPattern: string;
  /**
   * Optional route override. When present, the caller uses this instead
   * of the registry's deeplink. Used by sub-flows of a single eventType
   * (e.g. pregnancy started vs ended both share `clinical_info_logged`
   * but live at `/eventos/nuevo/embarazo`).
   */
  routeOverride?: string;
};

type Pattern = {
  eventType: EventType;
  /** Triggers in priority order. First match wins. */
  triggers: RegExp[];
  /**
   * Per-slot regex extractors. Run against the full text, not just the
   * trigger match. Each one is optional — if the regex doesn't match
   * the slot is omitted (the form fills its own default).
   */
  slotExtractors?: Array<{ slot: string; pattern: RegExp; transform?: (m: string) => string }>;
  confidence?: ConfidenceLabel;
  /** Static route override appended to `/mis-mascotas/{publicToken}`. */
  routeOverride?: string;
  /**
   * Slots a routeOverride target actually consumes. Registry routes filter
   * via prefillSlots; override routes had NO filter, so every extracted slot
   * (incl. the shared occurredAt) leaked onto sheet URLs that never read
   * them (deep review 2026-07-04). Overrides now default to NO slots unless
   * they declare them here.
   */
  allowedSlots?: string[];
};

// IMPORTANT: order matters. More specific patterns must come BEFORE
// catch-alls so "le di antirrábica" matches vacuna and not nota.
const PATTERNS: Pattern[] = [
  // Programar vacuna — must come BEFORE the generic vacuna pattern so
  // "programar una vacuna" doesn't land on vaccination_administered.
  //
  // WP-5: management flow.
  {
    eventType: "vaccination_administered",
    triggers: [
      /programar\s+(?:una?\s+)?vacuna/i,
      /recordatorio\s+(?:de\s+)?vacuna/i,
      /agendar\s+(?:una?\s+)?vacuna/i,
    ],
    confidence: "medium",
    routeOverride: "/vacunas/programar",
  },

  // Vacuna — recognized by the vaccine name itself or generic "vacuna".
  {
    eventType: "vaccination_administered",
    triggers: [
      /antirr[áa]bica/i,
      /\brabia\b/i,
      /\btriple\b/i,
      /polival(?:ente)?/i,
      /quintuple|quíntuple/i,
      /\bsextuple\b/i,
      /\bvacun/i,
    ],
    slotExtractors: [
      {
        slot: "vaccineName",
        pattern: /(antirr[áa]bica|rabia|triple|polival(?:ente)?|quintuple|quíntuple|sextuple)/i,
      },
    ],
    confidence: "high",
  },

  // Antiparasitario — pulgas, garrapatas, desparasitación.
  {
    eventType: "deworming_administered",
    triggers: [/antipar/i, /\bpulg/i, /garrap/i, /desparasit/i],
    confidence: "high",
  },

  // Peso — keep before "número genérico" patterns. Excellent slot fill.
  // Triggers cover: "peso", "pesa", "pesé", "pesamos", "pesaron", "pesaste".
  // We can't rely on `\b` after the verb because JS regex `\b` is ASCII-only
  // and "é" isn't a word character there — use an explicit lookahead instead.
  {
    eventType: "weight_recorded",
    triggers: [
      /\b(\d+(?:[.,]\d+)?)\s*(?:kg|kilos?)\b/i,
      /(?:^|\s)pes(?:o|a|e|é|amos|aron|aste|aba|aban)(?=\s|[.,;:!?]|$)/i,
    ],
    slotExtractors: [
      {
        slot: "kg",
        // Group 1: the numeric value. Normalize comma → dot for the input.
        pattern: /(\d+(?:[.,]\d+)?)\s*(?:kg|kilos?)/i,
        transform: (m) => m.replace(",", "."),
      },
    ],
    confidence: "high",
  },

  // Microchip reemplazo — must come BEFORE generic microchip so "reemplazaron
  // el chip" does not land on microchip_implanted.
  //
  // WP-4: new coverage block.
  {
    eventType: "microchip_replaced",
    triggers: [
      /reemplaz(?:aron|ó)\s+(?:el\s+)?(?:microchip|chip)/i,
      /cambiaron\s+(?:el\s+)?(?:microchip|chip)/i,
      /(?:microchip|chip)\s+(?:dañado|ilegible|no\s+funciona)/i,
      /le\s+pusieron\s+(?:un\s+)?(?:otro|nuevo)\s+(?:microchip|chip)/i,
      /microchip[\s-]reemplazo/i,
    ],
    confidence: "medium",
    routeOverride: "/eventos/nuevo/microchip-reemplazo",
  },

  // Microchip implant (new chip, first time).
  {
    eventType: "microchip_implanted",
    triggers: [/microchip/i, /\bchip\b/i],
    slotExtractors: [
      // 15-digit ISO 11784/11785. Rare in chat but support it.
      { slot: "chipNumber", pattern: /\b(\d{15})\b/ },
    ],
    confidence: "high",
  },

  // Tatuaje — identification tattoo event.
  //
  // WP-4: new coverage block.
  {
    eventType: "tattoo_recorded",
    triggers: [/tatu[a-z]*\b/i, /\btat[uú]/i, /código\s+(?:de\s+)?tatuaje/i],
    confidence: "medium",
    routeOverride: "/eventos/nuevo/tatuaje",
  },

  // Esterilización.
  {
    eventType: "sterilization_performed",
    triggers: [/castr/i, /esteril/i, /orquiectom/i, /\bovariectom/i],
    confidence: "high",
  },

  // Mordedura / incidente — keep BEFORE the symptom catch-all because
  // "mordedura" is specific.
  {
    eventType: "incident_reported",
    triggers: [/\bmord/i, /\bataque\b/i, /\bse pele[oó]\b/i],
    confidence: "medium",
  },

  // Lost — status_changed has no registry entry (one shared key for the
  // lost/found sub-flows), so route via routeOverride like pregnancy. Placed
  // BEFORE the pregnancy patterns; triggers require pet/escape context so they
  // don't swallow symptoms ("perdió el apetito/peso/pelo") or "perdió el
  // embarazo". Confidence "medium" → the UI asks to confirm.
  //
  // WP-2: added Rioplatense colloquialisms for lost pet.
  {
    eventType: "status_changed",
    triggers: [
      /perd(?:er|[íi])\s+(?:a\s+)?(?:mi\s+)?(?:mascota|perr[oa]|gat[oa]|cachorr|animal)/i,
      /se\s+(?:me\s+)?perdi[óo]/i,
      /se\s+(?:me\s+)?escap[óo]/i,
      /no\s+(?:lo|la)\s+(?:encuentro|puedo\s+encontrar)/i,
      /\bdesaparec[ií]\w*/i,
      /marcar?\s+(?:como\s+)?perdid[oa]/i,
      // WP-2 Rioplatense lost colloquialisms
      /no\s+aparece(?=\s|[.,;:!?]|$)/i,
      /sali[óo]\s+y\s+no\s+volvi[óo]/i,
      /no\s+lleg[óo](?=\s|[.,;:!?]|$)/i,
      /\blo\s+busco\b/i,
      /\bla\s+busco\b/i,
    ],
    confidence: "medium",
    routeOverride: "?sheet=marcar-perdida",
  },

  // Found — the pet reappeared.
  //
  // WP-1: added bare "volvió", "lo recuperé", "está en casa".
  // WP-2: added "lo encontramos", "lo devolvieron", "apareció en el barrio",
  //        "está de vuelta".
  // Diacritic rule: "volvió" and "está" end in accented vowels — use lookahead.
  {
    eventType: "status_changed",
    triggers: [
      /(?:lo|la)\s+encontr\w*/i,
      /\bapareci[óo]/i,
      /volvi[óo]\s+(?:a\s+)?casa/i,
      /ya\s+est[áa]\s+(?:de\s+vuelta|en\s+casa)/i,
      /marcar?\s+(?:como\s+)?encontrad[oa]/i,
      // WP-1 additions
      /volvi[óo](?=\s|[.,;:!?]|$)/i,
      /(?:lo|la)\s+recuper[eé]/i,
      /est[áa]\s+en\s+casa(?=\s|[.,;:!?]|$)/i,
      // WP-2 Rioplatense found colloquialisms
      /(?:lo|la)\s+encontramos/i,
      /(?:lo|la)\s+devolvieron/i,
      /apareci[óo]\s+en\s+el\s+barrio/i,
      /est[áa]\s+de\s+vuelta(?=\s|[.,;:!?]|$)/i,
    ],
    confidence: "medium",
    routeOverride: "?sheet=marcar-encontrada",
  },

  // Pregnancy — pair of started/ended sub-flows over clinical_info_logged.
  // Patterns checked BEFORE the symptom catch-all so "perdió el embarazo"
  // doesn't get classified as a generic symptom.
  // The deeplinks route to /eventos/nuevo/embarazo because pregnancy has
  // a dedicated form, not the generic clinical info form.
  {
    eventType: "clinical_info_logged",
    triggers: [
      /pari[óo]\s+(\d+)?/i,
      /tuvo\s+(\d+)?\s*(cachorr|cr[íi]as|gatit)/i,
      /nacieron\s+(\d+)?\s*(cachorr|cr[íi]as|gatit)/i,
    ],
    slotExtractors: [
      {
        slot: "liveBirthsCount",
        pattern: /(?:pari[óo]|tuvo|nacieron)\s+(\d+)/i,
      },
    ],
    confidence: "high",
    routeOverride: "/eventos/nuevo/embarazo?phase=ended&outcome=live_birth",
    allowedSlots: ["liveBirthsCount", "occurredAt"],
  },
  {
    eventType: "clinical_info_logged",
    triggers: [
      /perdi[óo]\s+(?:el\s+)?embarazo/i,
      /tuvo\s+un\s+aborto/i,
      /se\s+complic[óo]\s+el\s+embarazo/i,
    ],
    confidence: "high",
    routeOverride: "/eventos/nuevo/embarazo?phase=ended&outcome=miscarriage",
  },
  {
    eventType: "clinical_info_logged",
    triggers: [
      /est[áa]\s+embarazada/i,
      /est[áa]\s+pre[ñn]ada/i,
      /espera\s+(?:cachorr|cr[íi]as|gatit)/i,
      /panza\s+de\s+embaraz/i,
    ],
    confidence: "high",
    routeOverride: "/eventos/nuevo/embarazo?phase=started",
  },

  // Síntoma — vómitos, diarrea, fiebre, tos, etc. The catalog has 30+
  // symptoms; slot fill requires LLM so we just trigger the form.
  //
  // WP-3: added Rioplatense symptom colloquialisms.
  {
    eventType: "symptom_observed",
    triggers: [
      /\bv[óo]mit/i,
      /diarrea/i,
      /\bfiebre\b/i,
      /\btos\b/i,
      /estornud/i,
      /coje[ao]?/i,
      /no\s+come/i,
      /no\s+toma\s+agua/i,
      /letarg/i,
      /decaid[ao]/i,
      /s[íi]ntoma/i,
      // WP-3 colloquialisms
      /est[áa]\s+descompuest[oa]/i,
      /no\s+quiere\s+comer/i,
      /se\s+rasca(?=\s|[.,;:!?]|$)/i,
      /est[áa]\s+mal(?=\s|[.,;:!?]|$)/i,
      /panza\s+hinchada/i,
    ],
    confidence: "medium",
  },

  // Fallecimiento — antes de vet_visit_logged porque "falleció en la
  // clínica" debería matchear muerte, no visita.
  {
    eventType: "death_recorded",
    triggers: [/falleci[óo]/i, /muri[óo]/i, /se\s+fue\s+al\s+arcoiris/i, /cruz[óo]\s+el\s+puente/i],
    confidence: "high",
  },

  // Checkin post-adopción — BEFORE vet_visit: its trigger
  // /control.*post.?adopci[óo]n/ was unreachable behind vet's greedy
  // \bcontrol\b (deep review 2026-07-04: "control post adopción" routed
  // to vet_visit_logged).
  {
    eventType: "post_adoption_checkin",
    triggers: [/check[\s-]?in/i, /seguimient.*adopci[óo]n/i, /control.*post.?adopci[óo]n/i],
    confidence: "medium",
  },

  // Visita al vet.
  {
    eventType: "vet_visit_logged",
    triggers: [/\bvet\b/i, /veterinari/i, /\bconsulta\b/i, /\bcl[íi]nica\b/i, /\bcontrol\b/i],
    confidence: "high",
  },

  // Medicación inicio vs fin. The trigger order disambiguates — "termina"
  // / "termin[éo]" / "deja" point to stopped; otherwise default to started.
  //
  // WP-3: added medication stopped colloquialisms.
  {
    eventType: "medication_stopped",
    triggers: [
      // Tolerate any short connector (las / los / con la / etc.) between
      // the verb and the noun — natural Spanish doesn't always go bare.
      /termin[éo]\s+.{0,15}(?:medicaci[óo]n|tratamient)/i,
      /\bdej[éo]\s+.{0,15}(?:medic|pastilla|tratamient)/i,
      /\bfin\s+(?:del|de\s+la)\s+tratamient/i,
      // WP-3 colloquialisms
      /complet[óo]\s+(?:el\s+)?tratamiento/i,
      /terminamos\s+.{0,15}(?:medicaci[óo]n|pastilla|tratamient)/i,
      /se\s+terminaron\s+(?:las\s+)?pastillas/i,
      /suspendi[óo]\s+(?:el\s+|la\s+)?(?:medicaci[óo]n|pastilla|tratamient)/i,
    ],
    confidence: "medium",
  },

  // WP-1 fix: expanded connector group to include `un|una` so "empecé un
  // tratamiento" matches. Previously only el|la|con were accepted.
  // WP-3: added more medication-started colloquialisms.
  {
    eventType: "medication_started",
    triggers: [
      /empec[éo]\s+(?:el|la|con|un|una)?\s*(?:medicaci[óo]n|tratamient|pastilla|jarabe)/i,
      /\bmedicaci[óo]n\b/i,
      /\bantibiot/i,
      /\bjarabe\b/i,
      /\bpastill/i,
      // WP-3 colloquialisms
      /le\s+recetar(?:on|ó)/i,
      /empezamos\s+(?:el|la|con|un|una)?\s*(?:medicaci[óo]n|tratamient|pastilla|jarabe)/i,
      /est[áa]\s+tomando\s+(?:medicaci[óo]n|pastilla|jarabe|tratamient)/i,
    ],
    confidence: "medium",
  },

  // Clínico — catch-all médico que no es síntoma puntual.
  //
  // WP-1 fix: "/\branalisis\b/i" and "/\branálisis\b/i" were typos — the
  // spurious `r` prefix made them unmatchable. Replaced with the correct
  // Spanish word "análisis".
  {
    eventType: "clinical_info_logged",
    triggers: [
      /\bcl[íi]nic[oa]\b/i,
      /\bdiagn[óo]stic/i,
      /\bestudio\b/i,
      /\ban[áa]lisis\b/i,
      /\becograf/i,
      /\bradiograf/i,
    ],
    confidence: "low",
  },

  // Management flows — WP-5. These are profile-action sheets, not event-log
  // forms. Positioned AFTER all event patterns so they don't hijack event
  // phrases. Uses routeOverride to bypass the registry deeplink.
  {
    eventType: "status_changed",
    triggers: [/compartir\s+(?:la\s+)?libreta/i, /compartir\s+historial/i],
    confidence: "medium",
    routeOverride: "?sheet=compartir-libreta",
  },
  {
    eventType: "status_changed",
    triggers: [
      /transferir\s+(?:la\s+)?mascota/i,
      /cambiar\s+(?:el\s+)?due[ñn]o/i,
      /ceder\s+(?:la\s+)?mascota/i,
    ],
    confidence: "medium",
    routeOverride: "?sheet=transferir-mascota",
  },
  {
    eventType: "status_changed",
    triggers: [
      /editar\s+(?:la\s+)?mascota/i,
      /actualizar\s+(?:los?\s+)?datos/i,
      /cambiar\s+(?:los?\s+)?datos/i,
    ],
    confidence: "medium",
    routeOverride: "?sheet=editar-mascota",
  },
  {
    eventType: "status_changed",
    triggers: [
      /mostrar\s+(?:la\s+)?libreta\s+(?:p[uú]blica|m[eé]dica)/i,
      /libreta\s+p[uú]blica/i,
      /vista\s+p[uú]blica/i,
    ],
    confidence: "medium",
    routeOverride: "?sheet=mostrar-tier2",
  },
  {
    eventType: "status_changed",
    triggers: [
      /buscar(?:le)?\s+(?:un\s+)?hogar/i,
      /dar\s+(?:en\s+)?adopci[óo]n/i,
      /en\s+(?:busca\s+de\s+)?adopci[óo]n/i,
    ],
    confidence: "medium",
    routeOverride: "/buscar-hogar",
  },

  // Nota — final catch-all si nada anterior pegó pero el texto parece
  // narrativo. Más conservador: requiere "anot|nota" o no matchea nada.
  // El cuerpo de la nota es TODO el texto del usuario.
  {
    eventType: "note_added",
    triggers: [/\banot/i, /\bnota\b/i, /\brecordar?\b/i],
    slotExtractors: [
      // El cuerpo de la nota es el texto entero, sin la palabra "anotar:"
      // si está al inicio.
      {
        slot: "text",
        pattern: /^(?:anot[ao]r?\s*:?\s*|nota\s*:?\s*)?(.+)$/is,
      },
    ],
    confidence: "medium",
  },
];

/**
 * Resolve an `occurredAt` value from natural-language date phrases.
 * Returns a YYYY-MM-DD string suitable for `<input type="date">` or
 * null if no phrase matched (in which case the form's own `today`
 * default takes over).
 *
 * Supported:
 *  - "hoy"
 *  - "ayer"
 *  - "anteayer"
 *  - "hace N días"
 *  - "el DD/MM[/AAAA]" or "DD-MM-AAAA"
 *  - "el DD de {mes}[ de[l] AAAA]"
 *
 * An explicit year is always honored. Where none is written the current year
 * is assumed — the same assumption the DD/MM branch makes.
 */
export function extractDateFromText(text: string, now: Date = new Date()): string | null {
  const lower = text.toLowerCase();

  if (/\bhoy\b/.test(lower)) return ymd(now);
  if (/\banteayer\b/.test(lower)) return ymd(addDays(now, -2));
  if (/\bayer\b/.test(lower)) return ymd(addDays(now, -1));

  // "hace N días"
  const hace = lower.match(/hace\s+(\d{1,3})\s+d[íi]as?/);
  if (hace) {
    const n = Number.parseInt(group(hace, 1), 10);
    if (!Number.isNaN(n) && n >= 0 && n <= 365) return ymd(addDays(now, -n));
  }

  // DD/MM/AAAA or DD-MM-AAAA
  // Lookbehind rejects IDs glued to words/dashes ("cas-12-06" parsed as a
  // date and prefilled occurredAt=2026-06-12 — deep review 2026-07-04).
  const slash = lower.match(/(?<![a-z0-9-])(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (slash) {
    const d = Number.parseInt(group(slash, 1), 10);
    const m = Number.parseInt(group(slash, 2), 10);
    let y = slash[3] ? Number.parseInt(slash[3], 10) : now.getFullYear();
    if (y < 100) y += 2000;
    if (validYMD(y, m, d)) return formatYMD(y, m, d);
  }

  // "el DD de {mes}"
  const months: Record<string, number> = {
    enero: 1,
    febrero: 2,
    marzo: 3,
    abril: 4,
    mayo: 5,
    junio: 6,
    julio: 7,
    agosto: 8,
    septiembre: 9,
    setiembre: 9,
    octubre: 10,
    noviembre: 11,
    diciembre: 12,
  };
  // "el DD de {mes}" — con año explícito OPCIONAL ("de 2024" / "del 2024").
  //
  // Sin ese año esta rama descartaba en silencio el que el usuario había
  // escrito: "lo desparasitamos el 15 de marzo de 2024" prellenaba 15/03/2026 y
  // lo dejaba en la URL (master test CIU, hallazgo B1-a). El dueño cargaba un
  // evento con la fecha equivocada en una libreta que se declara inmutable, y
  // corregirla exige un evento nuevo — el peor lugar donde equivocarse.
  //
  // La rama DD/MM/AAAA de arriba ya respetaba el año: de las dos gramáticas de
  // fecha que entiende este parser, una sola nunca lo aprendió.
  //
  // Cuatro dígitos a propósito: `\d{2,4}` como el separador barra convertiría
  // "el 15 de marzo de 24" en un año, pero también se comería un peso o una
  // edad que venga detrás. Sin año explícito el comportamiento no cambia.
  const spanish = lower.match(/\b(\d{1,2})\s+de\s+([a-záéíóú]+)(?:\s+del?\s+(\d{4}))?/);
  if (spanish) {
    const d = Number.parseInt(group(spanish, 1), 10);
    const m = months[group(spanish, 2)];
    const y = spanish[3] ? Number.parseInt(spanish[3], 10) : now.getFullYear();
    if (m && validYMD(y, m, d)) return formatYMD(y, m, d);
  }

  return null;
}

/**
 * Maximum input length the matcher will process. Hard cap so that the
 * RegExp engine can never see a pathological 10kb+ string. The text the
 * matcher cares about (an event description from /anotar) fits well under
 * this — anything longer is either a copy/paste accident or abuse.
 */
export const CAPTURE_INPUT_MAX_LENGTH = 500;

/**
 * Run the matcher against a free-text input. Returns the first
 * pattern that fires, with whatever slots could be extracted. Returns
 * null if no pattern matched (UI should surface "no reconocemos eso").
 */
export function matchCaptureIntent(text: string): MatchResult | null {
  // Truncate before any regex runs. The RegExp patterns themselves are
  // hardcoded above, so user input cannot inject a pattern — but a long
  // enough input could still expose pathological backtracking on the
  // existing patterns (especially the note catch-all `(.+)$`). Cap first.
  const trimmed = text.trim().slice(0, CAPTURE_INPUT_MAX_LENGTH);
  if (!trimmed) return null;

  for (const pattern of PATTERNS) {
    let firedTrigger: string | null = null;
    for (const trigger of pattern.triggers) {
      const m = trimmed.match(trigger);
      if (m) {
        firedTrigger = trigger.source;
        break;
      }
    }
    if (!firedTrigger) continue;

    const slots: Record<string, string> = {};
    if (pattern.slotExtractors) {
      for (const ex of pattern.slotExtractors) {
        const m = trimmed.match(ex.pattern);
        if (m?.[1]) {
          const value = ex.transform ? ex.transform(m[1]) : m[1];
          slots[ex.slot] = value.trim();
        }
      }
    }

    // Date extraction is shared across all event types whose registry
    // includes `occurredAt` — caller decides whether to use it via the
    // registry's prefillSlots.
    const date = extractDateFromText(trimmed);
    if (date) slots.occurredAt = date;

    // Override routes get ONLY their declared slots (none by default) — the
    // registry filter never sees them, so the filter lives here.
    if (pattern.routeOverride) {
      const allowed = new Set(pattern.allowedSlots ?? []);
      for (const key of Object.keys(slots)) {
        if (!allowed.has(key)) delete slots[key];
      }
    }

    return {
      eventType: pattern.eventType,
      confidence: pattern.confidence ?? "medium",
      slots,
      matchedPattern: firedTrigger,
      ...(pattern.routeOverride ? { routeOverride: pattern.routeOverride } : {}),
    };
  }

  return null;
}

/**
 * Viewer-context gate over a match result. The matcher itself is pure and
 * viewer-blind, but some deep-links are only valid for a subset of viewers:
 * `post_adoption_checkin`'s target page 404s for anyone but the registered
 * adopter. QA A9 gated the FIXED options list on `showCheckinOption`
 * (CaptureOptionsList); free text bypassed that gate and deep-linked
 * non-adopters straight into the 404 (adversarial review 2026-08-14).
 * Filtering lives here — at the boundary, keeping the matcher pure — and
 * returns null so the caller falls through to its generic no-match
 * affordances (retry copy, quick actions, save-as-note) instead.
 */
export function gateMatchForViewer(
  match: MatchResult | null,
  ctx: { showCheckinOption: boolean },
): MatchResult | null {
  if (match && match.eventType === "post_adoption_checkin" && !ctx.showCheckinOption) return null;
  return match;
}

/**
 * THE single match-to-URL assembler. Before 2026-07-04 this logic existed in
 * FOUR copies (quick-capture use-case, resolveCaptureIntentUrl, and twice
 * inside CaptureBox) — the override-slot bug lived in all four. Override
 * slots are already filtered by matchCaptureIntent, so assembly is pure.
 */
export function matchToCaptureUrl(
  publicToken: string,
  match: MatchResult,
  buildRegistryDeeplink: (
    eventType: EventType,
    publicToken: string,
    slots: Record<string, string>,
  ) => string | null,
): string | null {
  if (match.routeOverride) {
    const base = `/mis-mascotas/${publicToken}${match.routeOverride}`;
    const sep = match.routeOverride.includes("?") ? "&" : "?";
    const slotParams = new URLSearchParams();
    for (const [k, v] of Object.entries(match.slots)) {
      if (v !== "" && v !== undefined) slotParams.set(k, v);
    }
    const qs = slotParams.toString();
    return qs ? `${base}${sep}${qs}` : base;
  }
  return buildRegistryDeeplink(match.eventType, publicToken, match.slots);
}

/**
 * LOCAL calendar date as YYYY-MM-DD. Exported because quick-chip prefill
 * used `toISOString().slice(0, 10)` (UTC): from 21:00 ART to midnight that
 * stamps TOMORROW's date (deep review 2026-07-04). One clock for all
 * capture-date logic.
 */
export function ymdLocal(d: Date = new Date()): string {
  return formatYMD(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

// --- date helpers ----------------------------------------------------

/**
 * A capture group the pattern guarantees, read where indexing is not trusted.
 *
 * IT EXISTS BECAUSE THE PACKAGE BOUNDARY DID ITS JOB. The web app's tsconfig
 * does not set `noUncheckedIndexedAccess`; the native app's does, and
 * `packages/contract` is the one thing compiled by BOTH programs. So the moment
 * this file moved here, five reads of `match[1]` that had typechecked green for
 * months stopped compiling — under the stricter of the two clients, which is the
 * one that has to keep working.
 *
 * `?? ""` IS NOT A SHRUG, and the reason is what makes this safe rather than
 * merely quiet: every caller below already rejects the value this produces.
 * `Number.parseInt("")` is `NaN`, which `Number.isNaN` refuses outright and
 * which `validYMD` refuses through `new Date(...)` answering `Invalid Date`;
 * `months[""]` is `undefined`, which its own `if (m && …)` refuses. The
 * fallback cannot reach a returned date. It only spells out, for the compiler,
 * an invariant the patterns already hold: groups 1 and 2 are not optional in any
 * of the three, so a match that exists has them.
 */
function group(match: RegExpMatchArray, index: number): string {
  return match[index] ?? "";
}

function ymd(d: Date): string {
  return formatYMD(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function formatYMD(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function validYMD(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const test = new Date(y, m - 1, d);
  return test.getFullYear() === y && test.getMonth() === m - 1 && test.getDate() === d;
}
