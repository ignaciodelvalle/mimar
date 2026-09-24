// ---------------------------------------------------------------------------
// Pet compliance projection (owner "comply-first" slice, 2026-07-01)
// Spec: dim-interno:docs/superpowers-private/specs/2026-07-01-owner-compliance-first-slice-handoff.md §2
//
// Projects a pet's append-only events (+ its active reminders and jurisdiction
// gate) into the four legal obligations the owner sees at the top of the pet
// profile: rabies vaccine, sterilization, microchip, and PPP attestation.
//
// This is PURE derivation — (events, reminders, rules) -> view. The pet profile
// RSC already loads every input (typedEvents, petActiveReminders,
// canonicalIds.microchip, pet.potentiallyDangerousBreed), so no DB round-trip is
// needed here. The handoff called this `fetchComplianceState`; it is a pure
// `deriveComplianceState` because nothing is fetched — all inputs arrive
// resolved, which also keeps it trivially table-testable.
//
// No new color tokens, no schema migration, no new event types (token ratchet).
// ---------------------------------------------------------------------------

import { PPP_DECLARED_HINT, attestationCountsAsCompliant } from "@/lib/domain/ppp-attestation";
import { type ProvenanceTier, provenanceTier } from "@/lib/domain/provenance";
import type { ReminderVariant } from "@/lib/domain/vaccine-reminder-state";
import { computeConfidence } from "@/lib/events/event-confidence";
import { addCalendarMonths } from "@/lib/utils/calendar-months";
import {
  formatDateArOmitCurrentYear,
  isoDateInAr,
  parseDateInput,
  pluralizeEs,
} from "@/lib/utils/format";

// Minimal event shape — decoupled from ProjectionEvent so tests stay trivial.
// Carries provenance (the ConfidenceInput fields) so an obligation is only
// cleared by a professional/institutional-verified event (H1, 2026-07-01).
export type ComplianceEvent = {
  eventType: string;
  payload: unknown;
  occurredAt: Date | string;
  authorRole?: string;
  authorVerified?: boolean;
  authorOrganizationId?: string | null;
  /** Who WROTE the event (pet_events.recorded_by_user_id) — see `viewerUserId`. */
  recordedByUserId?: string | null;
};

// The already-filtered rabies reminder, if the pet has one. The caller isolates
// it from the active reminder set (by title) so this module stays pure and free
// of reminder-fetching concerns.
export type RabiesReminder = {
  variant: ReminderVariant;
  dueAt: Date;
};

// A confirmed future rabies appointment (WS-2 "Turno reservado"). Optional in
// WS-1 — the page wires it in WS-2.
export type ReservedRabiesTurno = {
  date: Date;
  provider: string | null;
};

export type ObligationKey = "rabies" | "sterilization" | "microchip" | "ppp";

// Mirror of the DB `requirement_level` union (db/schema.ts REQUIREMENT_LEVELS)
// — declared locally so this projection stays import-light and pure.
export type ObligationRequirementLevel = "mandatory" | "recommended" | "not_regulated" | "optional";

/**
 * EFFECTIVE resolved rule for one obligation, threaded in by RSC callers
 * (spec CS1 — resolved once per distinct jurisdiction, never fetched here).
 * `requirementLevel` is already the effective tier: callers map a NULL tier
 * to the pre-tier legacy behavior via `obligationRuleInfo` /
 * `microchipObligationRuleInfo` (lib/domain/business-rules-defaults.ts), so
 * dev/test environments with no seeded tiers see zero behavior diff.
 */
export type ComplianceObligationRule = {
  requirementLevel: ObligationRequirementLevel;
  legalBasis: string | null;
  authority: string | null;
  sourceUrl: string | null;
};

/**
 * The OPERATIONAL parameters of the jurisdiction's rabies and sterilization
 * rules (T1-G1) — the payload half of the resolved rule row, where
 * `ComplianceObligationRule` is the tier + citation half. Resolved by callers
 * through the same cascade (resolveBusinessRule) and mapped with
 * `complianceRuleParams` (lib/domain/business-rules-defaults.ts); null = the
 * jurisdiction set no value, and then nothing is derived from it.
 *
 * Before T1-G1 these four fields were only RENDERED ("refuerzo cada 12 meses")
 * and never computed with: a signed dose without next_due_at read "Registrada"
 * forever in a jurisdiction that had stated its booster cadence.
 */
export type ComplianceRuleParams = {
  rabies: {
    frequencyMonths: number | null;
    minAgeMonths: number | null;
    /**
     * The norm that fixes `frequencyMonths`, when one does (PO decision
     * 2026-09-18, D5). A cadence WITH it is a legal deadline; a cadence
     * without it stays an administrative suggestion (see `dueSource`).
     * Optional so callers that predate D5 keep the suggestion behaviour.
     */
    frequencyLegalBasis?: string | null;
  };
  sterilization: { minAgeMonths: number | null; mandatoryFromMonths: number | null };
};

/** The three jurisdiction-tiered obligations (PPP has its own gate + input). */
export type ComplianceObligations = Record<
  "rabies" | "sterilization" | "microchip",
  ComplianceObligationRule
>;

// Visual tone shared across the obligation cards. `ok`/`due`/`over` map onto the
// existing LnVstamp variants; `reserved` uses the celeste family (WS-2);
// `neutral` is "sin registro / no aplica todavía".
export type ComplianceTone = "ok" | "due" | "over" | "reserved" | "neutral";

// DUAL vaccine state (task #78 Part 1 — the "0 de 4 · DECLARADA" #4 fix). A
// diligent owner who vaccinated but has no vet signature used to see a single
// flat "Declarada" badge that reads as "you have nothing". The
// dual block splits the two honest truths the credential must tell at once:
//   • what the owner HAS (the currency lens — the dose is on record and vigente)
//   • what the official REGISTRY still needs (a matriculated vet signature).
// Present ONLY on the rabies card, and only for a declared (unsigned) dose.
export type ComplianceDual = {
  ownerLabel: string; // es-AR "lo que tenés" line ("Antirrábica cargada por vos")
  currencyLabel: string | null; // es-AR currency chip ("Vigente" / "Por vencer" / "Vencida")
  currencyTone: "ok" | "due" | "over" | null; // tone of the currency chip
  registryLine: string; // es-AR "lo que pide el registro" educational nudge
};

export type ObligationCard = {
  key: ObligationKey;
  label: string; // es-AR obligation title
  state: string; // es-AR short state label
  tone: ComplianceTone;
  detail: string | null; // es-AR secondary line (date, provider, chip number)
  legalFootnote: string; // es-AR muted legal citation
  hint?: string | null; // es-AR nudge to get a self-reported event verified (H1)
  /**
   * Whether `tone` reflects a REAL vigencia. False for a dose that is on record
   * but carries no next_due_at: the asiento exists, the currency is unknowable.
   *
   * The projection always knew this internally; the card did not carry it, so
   * ComplianceObligationsPanel stamped "VIGENTE" over it and the summary
   * counted it "al día" — the project's own rule inverted ("'no sabemos' nunca
   * se sella VIGENTE", LibretaSanitariaView.tsx:127-132). Undefined means the
   * obligation has no currency dimension at all (microchip, PPP).
   *
   * Also false for a due date computed from the jurisdiction's cadence
   * (`dueSource: "rule"`): an estimate is not an established vigencia.
   */
  currencyKnown?: boolean;
  /**
   * The formatted date the current currency runs UNTIL (the next-due / expiry
   * date), when one is on record. Null/undefined when the obligation has no
   * currency dimension, or when the dose carries no next_due_at.
   *
   * Exists so the pill can carry the DATUM instead of a bare adjective
   * ("VIGENTE · hasta 14/01/2027", UI review PO 2026-08-06) without the
   * presentation layer re-deriving or re-formatting a date the projection
   * already computed — the same reason `currencyKnown` was hoisted onto the
   * card. AR-pinned via formatDateArOmitCurrentYear (the year appears the
   * moment it differs from the caller's `now`).
   */
  currencyUntil?: string | null;
  /**
   * Where the rabies card's due date came from, when it has one:
   *   • "dose"     — the dose itself carries `next_due_at` (the date written on
   *                  the asiento, normally by the vet who signed it);
   *   • "reminder" — the pet's active rabies reminder;
   *   • "rule"     — no date on record; it was COMPUTED from the booster cadence
   *                  (`frequency_months`) the jurisdiction configured (T1-G1),
   *                  and no norm is on record for that cadence;
   *   • "legal_cadence" — no date on record; COMPUTED from a cadence whose
   *                  own legal basis the rule row carries
   *                  (`frequency_legal_basis`, PO decision 2026-09-18, D5).
   * Undefined when there is no due date at all.
   *
   * A "rule" date is an estimate, never a legal verdict: the configured cadence
   * is an administrative value that may not come from any norm. So a "rule"
   * card reads "Refuerzo sugerido", never "Vencida", carries no legal
   * citation, and never counts as "al día".
   *
   * A "legal_cadence" date IS a deadline: the norm fixing the interval is
   * cited in the rule data, so the card reads exactly like a dated dose
   * (Vigente / Vencida), carries the citation — the obligation's and the
   * cadence's — and counts toward "al día" like any sourced obligation.
   * Surfaces branch on THIS field, never on the copy.
   */
  dueSource?: "dose" | "reminder" | "rule" | "legal_cadence";
  /**
   * True when the card reports a missing FACT rather than a deadline: nothing
   * is expiring, something is simply not known yet.
   *
   * `tone` cannot carry this. It ranks urgency — the PPP "Faltan datos" card is
   * deliberately `due` so it ranks high and never counts as "al día" — and the
   * credential stamp then rendered `due`'s word, "POR VENCER", over a card
   * where nothing has a date at all (adversarial review 2026-08-08, S2-F06).
   *
   * Distinct from `currencyKnown`, which is scoped to a DOSE whose vigencia is
   * unknowable; an obligation with no currency dimension leaves that undefined.
   */
  dataUnknown?: boolean;
  // Dual honest vaccine state — see ComplianceDual. Rabies-only, declared-dose-only.
  dual?: ComplianceDual;
  /**
   * Resolved jurisdiction tier when the obligation is NOT mandatory here
   * (spec CS2-CS4): `recommended` renders with a distinct softer treatment and
   * never with "vencida"/overdue styling; `not_regulated` renders as
   * information only. Cards carrying this field are EXCLUDED from the
   * "N de M al día" count — M counts mandatory obligations only. Absent = a
   * real obligation (mandatory, or a legacy caller without threaded
   * obligations).
   */
  requirementTier?: "recommended" | "optional" | "not_regulated";
  /**
   * True when nothing is on record AND the pet is still younger than the age
   * from which its jurisdiction's rule applies (T1-G1: rabies `min_age_months`,
   * sterilization `max(min_age_months, mandatory_from_months)`). The card
   * stays visible — it says from when it applies — but is EXCLUDED from the
   * "N de M al día" count: an obligation that does not apply yet is neither
   * met nor missed. Internal to the projection's summary; not serialised.
   */
  notYetRequired?: boolean;
};

export type ComplianceState = {
  cards: ObligationCard[]; // ordered worst-state first
  summary: { total: number; ok: number; label: string }; // "3 de 4 al día"
  worstTone: ComplianceTone; // mirrored by the panel header chip
  /**
   * True when the single most urgent card is a missing FACT, so a summary stamp
   * must say SIN DATO rather than borrow a temporal word. False as soon as
   * something genuinely dated outranks it — a rabies dose actually due sorts
   * ahead of the PPP card and the stamp correctly reads POR VENCER again.
   */
  worstIsUnknown: boolean;
};

export type ComplianceInput = {
  now: Date;
  events: ComplianceEvent[];
  rabiesReminder: RabiesReminder | null;
  reservedRabiesTurno: ReservedRabiesTurno | null; // WS-2
  microchipCode: string | null; // from fetchActiveIdentifications().microchip
  // LEGACY jurisdiction gate for the microchip obligation (pre-`obligations`
  // callers/tests only — IGNORED when `obligations` is provided, which now
  // carries the microchip tier via the same OR5 semantics). Default TRUE.
  // When FALSE and no chip is on record, the obligation card is omitted
  // entirely (it drops out of the "N de M al día" count); a chip that IS
  // registered still shows, because a registered chip is information, not an
  // unmet obligation.
  microchipApplies?: boolean;
  /**
   * Jurisdiction-resolved obligation tiers + legal provenance (spec CS1),
   * threaded by RSC callers — this module stays PURE, nothing is fetched
   * here. Optional so pre-existing callers/tests keep the legacy universal
   * behavior (everything treated as a mandatory obligation, generic
   * footnotes). When present it supersedes `microchipApplies`.
   */
  obligations?: ComplianceObligations;
  /**
   * Legal provenance of the resolved PPP rule (ppp_breed_list) for citation
   * composition (CS5). Tier is NOT read from here — `pppApplies` stays the
   * authoritative PPP gate. Null/absent → generic stopgap footnote.
   */
  pppRule?: {
    legalBasis: string | null;
    authority: string | null;
    sourceUrl: string | null;
  } | null;
  pppApplies: boolean; // authoritative jurisdiction gate (pet.potentiallyDangerousBreed)
  // PPP-determinability inputs (2026-07-04). PPP is dogs-only, and the size rule
  // needs the pet's WEIGHT while the breed rule needs its BREED. A dog registered
  // through the fast path has neither (both live in the optional "Otros" block),
  // so `pppApplies` is false and the PPP obligation used to vanish silently. When
  // a DOG is missing breed and/or weight we surface an "indeterminado" obligation
  // instead of hiding it — strong-but-optional (PO 2026-07-04): the alta is never
  // blocked, but the obligation GRITA until the two fields are completed. Optional
  // so pre-existing callers/tests default to "not a dog / no data" (no card).
  species?: string | null;
  breed?: string | null;
  estimatedWeightKg?: number | string | null;
  /**
   * The signed-in reader. The rabies dual block addresses the owner in the
   * second person ("Antirrábica cargada por vos"), which is a claim about WHO
   * WROTE THE DOSE — not about the author's role. Deriving it from
   * `authorRole === "owner"` is how the back face came to re-sign a transferred
   * pet's asientos to the incoming titular (see asiento-fields.ts).
   *
   * Optional, and deliberately FAIL-SAFE: with no viewer the copy falls back to
   * the third person ("cargada por el titular"), which is true either way. A
   * caller that forgets this loses warmth, never accuracy.
   */
  viewerUserId?: string | null;
  /**
   * Operational parameters of the resolved rules (T1-G1). Optional: absent,
   * nothing is derived from the jurisdiction beyond its tier — exactly the
   * pre-T1-G1 behavior.
   */
  ruleParams?: ComplianceRuleParams;
  /**
   * The pet's date of birth ("YYYY-MM-DD"), for the age-gated rule fields.
   * Unknown → no age gate is applied: an animal of unknown age is never
   * exempted from an obligation on a guess.
   */
  dateOfBirth?: string | null;
};

// Legal footnotes — generic stopgaps only (spec CS5, RG1 ratified 2026-08-16).
// Kept as one muted line each; never a banner (handoff §5). Every REAL citation
// composes from the resolved rule row in deriveComplianceState; these are the
// fallbacks when nothing resolves — the module never hardcodes another
// jurisdiction's ordinance (the old CABA rabies literal included; a pet outside
// CABA must not be shown a CABA article as if it were its own norm).
const FOOTNOTE = {
  rabies: "Obligación del propietario · según normativa jurisdiccional",
  microchip: "Identificación · según normativa jurisdiccional",
  ppp: "Régimen perros potencialmente peligrosos · regla jurisdiccional",
} as const;

// The sterilization footnote must AGREE with the card's verification state. A
// "Declarada" seal cannot sit above "Evento verificado en la libreta" — that is
// the credential contradicting itself (adversarial-citizen 2026-07-06, same
// class as the rabies "Registrada"/"Declarada" split). Each state carries its
// own provenance line so the seal, the footnote and the "N de M al día" summary
// always tell the same story.
const STERILIZATION_FOOTNOTE = {
  verified: "Evento verificado en la libreta",
  declared: "Declarado por el titular, sin verificación profesional",
  none: "Sin registro en la libreta",
} as const;

/**
 * Compose a legal citation from a resolved rule row's provenance (spec CS5):
 * `[legalBasis, authority].filter(Boolean).join(" · ")`. Returns null when the
 * row carries no citation — the caller then keeps the generic stopgap wording
 * ("según normativa jurisdiccional"), NEVER inventing law. Used for the
 * rabies, microchip and PPP footnotes (RG1 ratified 2026-08-16 — the rabies
 * CABA literal is gone); the sterilization footnotes are provenance lines,
 * not legal citations.
 */
export function composeLegalCitation(
  info: { legalBasis: string | null; authority: string | null } | null | undefined,
): string | null {
  if (!info) return null;
  const joined = [info.legalBasis, info.authority].filter(Boolean).join(" · ");
  return joined.length > 0 ? joined : null;
}

// Worst-first ordering. Lower number = more urgent = shown first.
const TONE_SEVERITY: Record<ComplianceTone, number> = {
  over: 0,
  due: 1,
  neutral: 2,
  reserved: 3,
  ok: 4,
};

// es-AR nudges shown on a "Declarada" card (H1).
const HINT = {
  sterilization: "Pedile a tu veterinario que la registre para que cuente.",
  microchip: "Pedile a quien lo implantó que lo registre para que cuente.",
  rabies: "La cargaste vos; pedí que un veterinario la registre para que cuente como al día.",
} as const;

// Unified affirmative pill vocabulary (UI review, PO 2026-08-06). Each pill now
// carries ONE word from the same two-term provenance pair — VERIFICADA (a
// professional/institutional event cleared it) vs DECLARADA (the titular said
// so, nobody signed it) — instead of three adjacent greens with three grammars
// ("Registrada" / "Sí" / "Declarada · sin verificar"). The epistemic
// distinction is unchanged: only the WORDING converged. The "sin verificar"
// tail moved out of the pill because the footnote below it already says
// "Declarado por el titular, sin verificación profesional" and the hint says
// what to do about it — the pill was the third copy of the same caveat.
const DECLARADA_STATE = "Declarada";
/** Masculine form for the obligations whose noun is masculine ("Microchip"). */
const DECLARADO_STATE = "Declarado";
const VERIFICADA_STATE = "Verificada";
const VERIFICADO_STATE = "Verificado";
/**
 * "Nothing on record" state, shared by every derivation.
 *
 * A CONSTANT, not a literal (T6 review MINOR 6): `applyTierOverlay` decides
 * whether a not_regulated card is dropped by comparing `card.state` to this
 * exact string. As a bare literal, a copy tweak in any one derivation would
 * have silently resurrected empty not_regulated cards with nothing to say.
 */
const SIN_REGISTRO_STATE = "Sin registro";

/** State of an obligation the pet is still too young for (T1-G1). */
const NOT_YET_REQUIRED_STATE = "Aún no corresponde";

/** Rabies states for a due date computed from the jurisdiction's cadence (dueSource "rule"). */
const RULE_SUGGESTED_STATE = "Refuerzo sugerido";
const RULE_SUGGESTED_LAPSED_STATE = "Refuerzo sugerido vencido";

/**
 * The footnote of a "rule" rabies card: how the date was computed, in place of
 * a legal citation. It names the cadence and says plainly that nobody signed
 * that date — it does NOT claim the cadence is or is not law, because that
 * depends on the jurisdiction and is the PO's call (ar-v2 FINDING 3).
 */
function ruleCadenceNote(frequencyMonths: number): string {
  return `Fecha calculada con la frecuencia de refuerzo que configuró tu jurisdicción (cada ${frequencyMonths} ${pluralizeEs(frequencyMonths, "mes")}); no la fijó un veterinario.`;
}

/**
 * Summary label when NO obligation is counted (M = 0) — every resolved rule is
 * recommended / not_regulated and the pet is not a flagged PPP.
 *
 * "0 de 0 al día" used to render here, in green (T6 review M5): a compliance
 * seal earned by an empty denominator. This says what is actually true — the
 * jurisdiction has no mandatory obligation loaded for this pet — and the
 * summary tone goes neutral so nothing reads as approval.
 */
export const NO_COUNTED_OBLIGATIONS_LABEL = "Sin obligaciones cargadas para tu jurisdicción";

// Rabies dual-state copy (task #78 Part 1 / #4). The registry line is educational
// AND a nudge — a vet signature turns declared data into verified data, which is
// what the whole system wants more of.
const REGISTRY_NEEDS_LINE =
  "Para figurar “al día” en el registro oficial, un veterinario matriculado tiene que firmarla.";
const RABIES_DECLARED_BADGE = "Declarada"; // provenance-lens badge; the dual block carries the rest

// `hasEvent` lived here until T4-I1 / #753 and is gone with its last caller.
// It answered "does an event of this type exist?", which was the PPP card's
// whole rule and the reason that card believed a bare assertion — every other
// derivation in this file had already moved to asking WHO authored the
// satisfying event. Leaving the helper would have left the easy wrong answer
// one autocomplete away from the next obligation added here.

// H1: an obligation is only met when the satisfying event was authored by a
// professional or institution. A self-reported / corroborated / unverified
// event is "declared, not verified" and does not count toward "al día".
function clearsObligation(e: ComplianceEvent): boolean {
  const tier = computeConfidence({
    authorRole: e.authorRole ?? "",
    authorVerified: e.authorVerified ?? false,
    authorOrganizationId: e.authorOrganizationId ?? null,
    payload: (e.payload ?? {}) as Record<string, unknown>,
  });
  return tier === "professional_verified" || tier === "institutional_verified";
}

function declaradaCard(
  key: ObligationKey,
  label: string,
  legalFootnote: string,
  hint: string,
  detail: string | null = null,
  state: string = DECLARADA_STATE,
): ObligationCard {
  // The "Declarada" state itself (not a separate provenance field) is what
  // keeps a declared-only card (sterilization, microchip, and the rabies
  // fallback below) distinguishable from a genuinely absent obligation on any
  // surface deriving wording from `tone`/`state` — the credential-face summary
  // (CredentialFace.tsx) once read a Declarada card as "falta X" (missing),
  // the exact contradiction its own doc comment warns against ("a
  // declared-only card is not 'falta'").
  return {
    key,
    label,
    state,
    tone: "neutral",
    detail,
    legalFootnote,
    hint,
  };
}

// The latest rabies vaccination event (by occurredAt), if any.
function latestRabiesDose(events: ComplianceEvent[]): ComplianceEvent | undefined {
  return events
    .filter((e) => {
      if (e.eventType !== "vaccination_administered") return false;
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const name = typeof p.vaccine_name === "string" ? p.vaccine_name.toLowerCase() : "";
      return /antirr[aá]b|rabi/.test(name);
    })
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())[0];
}

// formatDateArOmitCurrentYear (lib/utils/format.ts) is AR_TIME_ZONE-pinned
// (PJ-M3: without it a date-only midnight-UTC value renders as the previous
// day in AR, and SSR/hydration disagree) AND appends the year the moment the
// date's AR-calendar year differs from `now`'s — a bare "Vence 18/07" reads
// as THIS year every time, which is silently wrong the one day a due date
// crosses into next year (medianos-sesión-2 finding #1). `now` threads
// through from ComplianceInput so the comparison always uses the caller's
// pinned instant, not a fresh `new Date()` at format time.

// A date-only "YYYY-MM-DD" next_due_at is midnight UTC = the previous AR
// calendar day; anchor it at NOON UTC (parseDateInput) so a dose "due today" in
// AR is not read Vencida from 21:00 the prior AR day (PJ-M3). Full ISO
// timestamps (with a time component) carry their own instant and pass through.
function parseNextDue(raw: string): Date | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? parseDateInput(raw) : new Date(raw);
}

/**
 * The AR calendar day from which an age-gated rule applies to this pet, or
 * null when it cannot be judged (no rule value, or no date of birth).
 */
function appliesFromYmd(
  dateOfBirth: string | null | undefined,
  ageMonths: number | null | undefined,
): string | null {
  if (ageMonths == null || !dateOfBirth) return null;
  return addCalendarMonths(dateOfBirth.slice(0, 10), ageMonths);
}

/**
 * The "not yet" card for an obligation the pet is still too young for. Only
 * built when NOTHING is on record — a dose or a sterilization that exists is
 * always shown for what it is.
 */
function notYetRequiredCard(
  key: ObligationKey,
  label: string,
  legalFootnote: string,
  fromYmd: string,
  ageMonths: number,
  now: Date,
): ObligationCard {
  const from = parseDateInput(fromYmd) ?? now;
  return {
    key,
    label,
    state: NOT_YET_REQUIRED_STATE,
    tone: "neutral",
    detail: `Corresponde desde el ${formatDateArOmitCurrentYear(from, now)} (a los ${ageMonths} ${pluralizeEs(ageMonths, "mes")})`,
    legalFootnote,
    notYetRequired: true,
  };
}

// Map a reminder variant to the coarse compliance tone + labels.
function rabiesFromVariant(variant: ReminderVariant, dueAt: Date, now: Date): ObligationCard {
  const until = formatDateArOmitCurrentYear(dueAt, now);
  if (variant === "due_soon") {
    return {
      key: "rabies",
      label: "Vacuna antirrábica",
      state: "Por vencer",
      tone: "due",
      detail: `Vence ${until}`,
      legalFootnote: FOOTNOTE.rabies,
      currencyUntil: until,
    };
  }
  if (variant === "overdue" || variant === "overdue_critical") {
    return {
      key: "rabies",
      label: "Vacuna antirrábica",
      state: "Vencida",
      tone: "over",
      detail: `Venció ${until}`,
      legalFootnote: FOOTNOTE.rabies,
      currencyUntil: until,
    };
  }
  // upcoming | success
  return {
    key: "rabies",
    label: "Vacuna antirrábica",
    state: "Vigente",
    tone: "ok",
    detail: `Próxima ${until}`,
    legalFootnote: FOOTNOTE.rabies,
    currencyUntil: until,
  };
}

/**
 * The footnote clause naming the norm that fixes a "legal_cadence" date. It
 * is appended to the obligation's own citation (deriveComplianceState), or to
 * the generic stopgap when the rule row cites nothing else.
 */
function legalCadenceClause(frequencyMonths: number, basis: string): string {
  return `refuerzo cada ${frequencyMonths} ${pluralizeEs(frequencyMonths, "mes")} según ${basis}`;
}

/**
 * The rabies card for a dose whose due date was COMPUTED from the
 * jurisdiction's booster cadence (T1-G1) — the dose itself carries none — when
 * the rule row does NOT cite a norm for that cadence.
 *
 * Lower weight than a dated dose, on purpose: an administrative cadence with no
 * norm behind it is a suggestion, not a deadline — "Refuerzo sugerido" instead
 * of "Vigente", "Refuerzo sugerido vencido" in the warning tone instead of the
 * red "Vencida", and the footnote slot says how the date was computed instead
 * of citing a norm next to a date no norm fixed. A cadence whose norm IS cited
 * (`frequencyLegalBasis`) takes the "legal_cadence" path in deriveRabies
 * instead (PO decision 2026-09-18, D5).
 */
function rabiesFromRuleCadence(
  dose: ComplianceEvent,
  ruleDue: Date,
  frequency: number,
  now: Date,
): ObligationCard {
  const suggested = formatDateArOmitCurrentYear(ruleDue, now);
  // Own line, not inside the ${} — the no-raw-date-in-sql guard (see below).
  const appliedAt = new Date(dose.occurredAt);
  const applied = formatDateArOmitCurrentYear(appliedAt, now);
  const lapsed = ruleDue <= now;
  return {
    key: "rabies",
    label: "Vacuna antirrábica",
    state: lapsed ? RULE_SUGGESTED_LAPSED_STATE : RULE_SUGGESTED_STATE,
    // Warning, never red: past a suggested date is a nudge to book a turno, not
    // a breach. Upcoming is neutral — nothing on record establishes vigencia.
    tone: lapsed ? "due" : "neutral",
    detail: lapsed
      ? `Aplicada ${applied} · refuerzo sugerido vencido el ${suggested}`
      : `Aplicada ${applied} · refuerzo sugerido: ${suggested}`,
    legalFootnote: ruleCadenceNote(frequency),
    currencyUntil: null,
    dueSource: "rule",
  };
}

// The rabies obligation. Priority: a reserved turno (WS-2) wins the display,
// then the active reminder's variant, then a fallback to raw events, then
// "sin registro".
function deriveRabies(input: ComplianceInput): ObligationCard {
  if (input.reservedRabiesTurno) {
    const { date, provider } = input.reservedRabiesTurno;
    const providerSuffix = provider ? ` · ${provider}` : "";
    return {
      key: "rabies",
      label: "Vacuna antirrábica",
      state: "Turno reservado",
      tone: "reserved",
      detail: `${formatDateArOmitCurrentYear(date, input.now)}${providerSuffix}`,
      legalFootnote: FOOTNOTE.rabies,
    };
  }

  const dose = latestRabiesDose(input.events);

  // No dose at all → "Sin registro". (A reminder without a dose still needs the
  // dose to judge provenance, so it also lands here for the provenance overlay.)
  if (!dose && !input.rabiesReminder) {
    // T1-G1: the jurisdiction's `min_age_months` — a puppy younger than it has
    // nothing missing yet. Unknown age or no rule value → the obligation
    // applies as before.
    const minAge = input.ruleParams?.rabies.minAgeMonths ?? null;
    const fromYmd = appliesFromYmd(input.dateOfBirth, minAge);
    if (minAge != null && fromYmd && isoDateInAr(input.now) < fromYmd) {
      return notYetRequiredCard(
        "rabies",
        "Vacuna antirrábica",
        FOOTNOTE.rabies,
        fromYmd,
        minAge,
        input.now,
      );
    }
    return {
      key: "rabies",
      label: "Vacuna antirrábica",
      state: SIN_REGISTRO_STATE,
      tone: "neutral",
      detail: null,
      legalFootnote: FOOTNOTE.rabies,
    };
  }

  // ---- CURRENCY base (WHO-agnostic): reminder variant, else next_due_at ----
  // `currencyKnown` marks whether the tone reflects a real vigencia (Vigente /
  // Por vencer / Vencida) vs. a dose on record whose currency we can't judge.
  let base: ObligationCard;
  let currencyKnown: boolean;
  if (input.rabiesReminder) {
    base = {
      ...rabiesFromVariant(input.rabiesReminder.variant, input.rabiesReminder.dueAt, input.now),
      dueSource: "reminder",
    };
    currencyKnown = true;
  } else {
    // dose is defined here (the early return above handled the no-dose case).
    const p = (dose?.payload ?? {}) as Record<string, unknown>;
    const nextDueRaw = typeof p.next_due_at === "string" ? p.next_due_at : null;
    const nextDue = nextDueRaw ? parseNextDue(nextDueRaw) : null;
    // T1-G1: no next_due_at on the dose → the jurisdiction's booster cadence
    // (`frequency_months`) dates it: occurred_at's AR calendar day plus N
    // months. An explicit next_due_at (above) always wins — the vet's date is
    // the override, the rule is the fallback.
    const frequency = input.ruleParams?.rabies.frequencyMonths ?? null;
    const cadenceBasis = input.ruleParams?.rabies.frequencyLegalBasis?.trim() || null;
    const ruleDueYmd =
      !nextDue && dose && frequency != null
        ? addCalendarMonths(isoDateInAr(new Date(dose.occurredAt)), frequency)
        : null;
    const ruleDue = ruleDueYmd ? parseDateInput(ruleDueYmd) : null;
    if (nextDue && Number.isFinite(nextDue.getTime())) {
      base = {
        ...(nextDue <= input.now
          ? rabiesFromVariant("overdue", nextDue, input.now)
          : rabiesFromVariant("upcoming", nextDue, input.now)),
        dueSource: "dose",
      };
      currencyKnown = true;
    } else if (dose && ruleDue && frequency != null && cadenceBasis) {
      // D5 (PO 2026-09-18): the rule row cites the norm that fixes the
      // cadence, so the computed date is a legal deadline — the same states,
      // tones and counting as a date the vet wrote on the asiento. The
      // cadence citation is attached here and completed with the obligation's
      // own in deriveComplianceState.
      base = {
        ...(ruleDue <= input.now
          ? rabiesFromVariant("overdue", ruleDue, input.now)
          : rabiesFromVariant("upcoming", ruleDue, input.now)),
        legalFootnote: `${FOOTNOTE.rabies} · ${legalCadenceClause(frequency, cadenceBasis)}`,
        dueSource: "legal_cadence",
      };
      currencyKnown = true;
    } else if (dose && ruleDue && frequency != null) {
      base = rabiesFromRuleCadence(dose, ruleDue, frequency, input.now);
      // The date is an ESTIMATE from an administrative cadence, not a vigencia
      // on record: the tone must not read as established currency, and the
      // "N de M al día" count must not grant "al día" on it (see the type doc
      // on `dueSource`).
      currencyKnown = false;
    } else {
      // A dose IS on record but its payload carries no next_due_at, so we can't
      // judge currency. This must NOT read "Sin registro" — the libreta shows a
      // real antirrábica asiento (UX gate M5a). Raw base is "Registrada"/ok; the
      // provenance overlay below decides signed ("Registrada") vs declared.
      // Compute the Date on its own line (not inside the ${} interpolation) so
      // the no-raw-date-in-sql guard doesn't flag this display string.
      const appliedAt = new Date(dose?.occurredAt ?? input.now);
      base = {
        key: "rabies",
        label: "Vacuna antirrábica",
        state: "Registrada",
        tone: "ok",
        detail: `Aplicada ${formatDateArOmitCurrentYear(appliedAt, input.now)}`,
        legalFootnote: FOOTNOTE.rabies,
      };
      currencyKnown = false;
    }
  }

  // Stamp the currency-knowability onto the card ONCE, for every branch above,
  // so the panel and the summary read the same fact the projection computed.
  base = { ...base, currencyKnown };

  // ---- PROVENANCE overlay (task #78) ----
  const tier: ProvenanceTier | null = dose
    ? provenanceTier({
        authorRole: dose.authorRole,
        authorVerified: dose.authorVerified,
        authorOrganizationId: dose.authorOrganizationId,
        payload: (dose.payload ?? {}) as Record<string, unknown>,
      })
    : null;
  // "Signed" (clears the al-día gate) iff the provenance is verificado /
  // firmado_matricula — the exact complement of `declarado` (invariant tested in
  // provenance.test.ts against clearsObligation).
  const signed = tier != null && tier !== "declarado";

  // A DECLARED dose (owner-reported or org-recorded, no matrícula) → DUAL honest
  // card (#4). It stops reading as a flat contradiction: the owner sees the dose
  // IS on record (and its currency), plus exactly what the registry still needs.
  if (dose && !signed) {
    const currencyLabel = currencyKnown ? base.state : null; // Vigente/Por vencer/Vencida
    const currencyTone = currencyKnown ? (base.tone as "ok" | "due" | "over") : null;
    const ownerDeclared = (dose.authorRole ?? "") === "owner";
    // "por vos" names an AUTHOR, so it needs an identity match — the role alone
    // only says the writer was AN owner, and after a transfer that owner is
    // someone else entirely.
    const writtenByTheReader =
      ownerDeclared && input.viewerUserId != null && dose.recordedByUserId === input.viewerUserId;
    // Counting tone: a vigente-declared dose must NOT count as "al día" (neutral),
    // but a por-vencer / vencida dose keeps its currency urgency so the owner
    // still sees "renovála" — provenance never hides an expiry.
    const countingTone: ComplianceTone = base.tone === "ok" ? "neutral" : base.tone;
    return {
      key: "rabies",
      label: "Vacuna antirrábica",
      // A neutral base is an upcoming rule-suggested booster: nothing urgent to
      // say, so the pill keeps speaking provenance ("Declarada").
      state: base.tone === "ok" || base.tone === "neutral" ? RABIES_DECLARED_BADGE : base.state,
      tone: countingTone,
      detail: base.detail,
      // base's own footnote: the generic rabies stopgap, or — for a "rule"
      // date — the note on how that date was computed.
      legalFootnote: base.legalFootnote,
      dueSource: base.dueSource,
      dual: {
        ownerLabel: writtenByTheReader
          ? "Antirrábica cargada por vos"
          : ownerDeclared
            ? "Antirrábica cargada por el titular"
            : "Antirrábica registrada sin firma de matrícula",
        currencyLabel,
        currencyTone,
        registryLine: REGISTRY_NEEDS_LINE,
      },
    };
  }

  // Reminder claims currency ("Vigente"/ok) but NO dose backs it (reachable only
  // when `dose` is null — the dose branch returned above). H1: an "al día" claim
  // needs a signed dose, and with no dose there is nothing to surface as dual, so
  // fall back to the plain declarada card.
  if (base.tone === "ok" && !signed) {
    return declaradaCard("rabies", "Vacuna antirrábica", FOOTNOTE.rabies, HINT.rabies, base.detail);
  }

  // Signed dose (or a reminder-only due/over base) → keep the currency card.
  return base;
}

function deriveSterilization(input: ComplianceInput): ObligationCard {
  // Select the BEST-provenance sterilization event, not the earliest (H1 fix):
  // `find` returns the first (oldest, ascending caller) match, so an early
  // owner-declared event masked a later vet-VERIFIED one and the pet read
  // non-compliant despite a signed record. Any satisfying event clears it.
  const events = input.events.filter((e) => e.eventType === "sterilization_performed");
  if (events.length === 0) {
    // T1-G1: the obligation cannot apply before the jurisdiction's
    // `mandatory_from_months`, nor before `min_age_months` (the age from which
    // the procedure is allowed at all — nobody is obliged to what they may not
    // yet do). The later of the two is when "Sin registro" starts to mean
    // something is missing.
    const params = input.ruleParams?.sterilization;
    const ages = [params?.minAgeMonths, params?.mandatoryFromMonths].filter(
      (n): n is number => n != null,
    );
    const startAge = ages.length > 0 ? Math.max(...ages) : null;
    const fromYmd = appliesFromYmd(input.dateOfBirth, startAge);
    if (startAge != null && fromYmd && isoDateInAr(input.now) < fromYmd) {
      return notYetRequiredCard(
        "sterilization",
        "Esterilización",
        STERILIZATION_FOOTNOTE.none,
        fromYmd,
        startAge,
        input.now,
      );
    }
    return {
      key: "sterilization",
      label: "Esterilización",
      state: SIN_REGISTRO_STATE,
      tone: "neutral",
      detail: null,
      legalFootnote: STERILIZATION_FOOTNOTE.none,
    };
  }
  if (events.some(clearsObligation)) {
    return {
      key: "sterilization",
      label: "Esterilización",
      // "Verificada", not "Registrada": the pill's job is to name the PROVENANCE
      // (a professional signed it), and "registrada" was ambiguous next to the
      // rabies card, where "Registrada" means something else entirely — a dose
      // on record whose vigencia is unknown (see deriveRabies).
      state: VERIFICADA_STATE,
      tone: "ok",
      detail: null,
      legalFootnote: STERILIZATION_FOOTNOTE.verified,
    };
  }
  return declaradaCard(
    "sterilization",
    "Esterilización",
    STERILIZATION_FOOTNOTE.declared,
    HINT.sterilization,
  );
}

// The microchip obligation. Returns null ONLY when the jurisdiction does not
// require a chip AND none is on record — then there is no obligation to surface
// and it drops out of the "N de M al día" count. A registered chip (declared or
// verified) always shows, regardless of the jurisdiction gate: it is
// information the credential should surface, not an unmet obligation.
function deriveMicrochip(input: ComplianceInput): ObligationCard | null {
  const code = input.microchipCode;
  // With threaded `obligations`, the tier overlay in deriveComplianceState
  // owns the omission decision (not_regulated + nothing on record → no card),
  // so the raw card is always derived. Legacy callers keep the boolean gate;
  // default TRUE preserves the pre-gate universal behavior.
  const applies = input.obligations ? true : input.microchipApplies !== false;
  // Best-provenance selection, not earliest (H1 fix): a later vet/institution
  // implant event must clear the obligation even if an earlier owner-declared
  // one exists. `some` picks any satisfying event instead of `find`'s oldest.
  const implants = input.events.filter((e) => e.eventType === "microchip_implanted");
  if (implants.some(clearsObligation)) {
    return {
      key: "microchip",
      label: "Microchip",
      // "Sí" is never a pill any more (UI review, PO 2026-08-06): a yes/no
      // adjective carried no information the row's own label didn't already
      // imply. The panel renders the CHIP NUMBER as this card's pill when one
      // is on record; this label is the fallback for a verified implant event
      // with no code captured.
      state: VERIFICADO_STATE,
      tone: "ok",
      detail: code,
      legalFootnote: FOOTNOTE.microchip,
    };
  }
  // Code known (from identifications) or a self-reported implant event, but not
  // backed by a professional/institutional record → declared, not verified.
  if (code || implants.length > 0) {
    return declaradaCard(
      "microchip",
      "Microchip",
      FOOTNOTE.microchip,
      HINT.microchip,
      code,
      DECLARADO_STATE,
    );
  }
  // No chip on record. If the jurisdiction does not require one, there is no
  // obligation to surface — omit the card so it is not counted in "N de M".
  if (!applies) return null;
  return {
    key: "microchip",
    label: "Microchip",
    state: SIN_REGISTRO_STATE,
    tone: "neutral",
    detail: null,
    legalFootnote: FOOTNOTE.microchip,
  };
}

// es-AR nudge shown on the "PPP indeterminado" card. It names ONLY the fields
// actually missing — the projection receives the pet's free-text breed, so when
// a breed IS shown in the header the seal must never tell the owner to "completá
// la raza" (adversarial-citizen C1, 2026-07-06: a Boxer with a visible breed but
// no weight read "completá la raza y el peso", directly contradicting the
// header). Copy stays consistent with what's on screen.
function pppIndeterminadoHint(breedKnown: boolean, weightKnown: boolean): string {
  const missing: string[] = [];
  if (!breedKnown) missing.push("la raza");
  if (!weightKnown) missing.push("el peso");
  return `Completá ${missing.join(" y ")} para saber si tu mascota entra en el régimen PPP.`;
}

function breedIsKnown(breed: string | null | undefined): boolean {
  return typeof breed === "string" && breed.trim().length > 0;
}

// numeric() weights arrive as strings from the driver; a present, positive number
// counts as "known". Blank / 0 / null are all "not provided".
function weightIsKnown(value: number | string | null | undefined): boolean {
  if (value == null) return false;
  const n = typeof value === "number" ? value : Number.parseFloat(String(value).trim());
  return Number.isFinite(n) && n > 0;
}

// The PPP obligation, with three outcomes:
//   1. `pppApplies` (the authoritative pet.potentiallyDangerousBreed flag, already
//      resolved against the jurisdiction's ppp_breed_list + ppp_weight_threshold)
//      -> the attestation card (required / attested).
//   2. Not flagged, DOG, and breed and/or weight missing -> "PPP indeterminado":
//      the pet cannot be ruled IN or OUT of the regime, so instead of hiding the
//      obligation we nudge the owner to complete the two deciding fields. Tone
//      `due` so it GRITA in the panel and does not count as "al día".
//   3. Not flagged, and (not a dog OR breed+weight both known) -> no card. A dog
//      with both fields known and no flag was genuinely classified as non-PPP;
//      cats and other species are never PPP.
function derivePpp(input: ComplianceInput): ObligationCard | null {
  if (input.pppApplies) {
    // THREE STATES, NOT TWO, SINCE T4-I1 / #753. The card used to stamp `ok` on
    // the bare EXISTENCE of an attestation, which made the strongest claim this
    // projection makes — "inscripta en el registro oficial" — the one claim
    // nothing was checked against. What counts is
    // `attestationCountsAsCompliant`; its header argues at length why the H1
    // gate could not simply be copied here and what replaces it.
    //
    // BEST-EVIDENCE SELECTION, not earliest (the same H1 fix the microchip and
    // sterilization cards carry): a later attestation that cites the number
    // must clear the obligation even when an earlier bare one exists. `some`
    // picks any satisfying event instead of `find`'s oldest.
    const attestations = input.events.filter((e) => e.eventType === "dangerous_breed_attested");
    if (attestations.some(attestationCountsAsCompliant)) {
      return {
        key: "ppp",
        label: "Atestación PPP",
        state: "Atestada",
        tone: "ok",
        detail: null,
        legalFootnote: FOOTNOTE.ppp,
      };
    }
    // Attested, but with nothing anyone can check it against. NOT "Atestación
    // requerida": that state is the register DOOR
    // (ComplianceObligationsPanel.tsx:197 and the mobile owner face both match
    // on the literal), and re-offering it would tell an owner who already
    // attested to attest again. `declaradaCard` is the established shape for
    // "on the record, not verified" and carries tone `neutral`, so it does not
    // count toward "al día" and does not GRITAR either.
    if (attestations.length > 0) {
      return declaradaCard("ppp", "Atestación PPP", FOOTNOTE.ppp, PPP_DECLARED_HINT);
    }
    return {
      key: "ppp",
      label: "Atestación PPP",
      state: "Atestación requerida",
      tone: "due",
      detail: null,
      legalFootnote: FOOTNOTE.ppp,
    };
  }

  if (input.species !== "dog") return null;
  const breedKnown = breedIsKnown(input.breed);
  const weightKnown = weightIsKnown(input.estimatedWeightKg);
  if (breedKnown && weightKnown) return null;

  return {
    key: "ppp",
    label: "Régimen PPP",
    state: "Faltan datos",
    tone: "due",
    // The tone ranks it; this says what KIND of problem it is. Nothing here has
    // a date, so no summary stamp above it may say "por vencer".
    dataUnknown: true,
    detail: null,
    legalFootnote: FOOTNOTE.ppp,
    hint: pppIndeterminadoHint(breedKnown, weightKnown),
  };
}

/**
 * Single source for the pet hero's microchip tag — mirrors the microchip
 * obligation card's tone so the hero and the compliance panel never disagree
 * about whether a microchip is verified.
 *
 * Before this helper, the pet profile hero pushed "Microchip verificado"
 * whenever ANY microchip code was on file (`canonicalIds.microchip`),
 * regardless of provenance, while the compliance card below it (this same
 * module's `deriveMicrochip`) correctly required a professional/institutional
 * event to say "verified" — showing "Declarado" for a
 * self-reported chip. Same pet, same screen, two different claims about the
 * same fact (clickthrough audit 2026-07-03/04, Segmento 1 #6). Both surfaces
 * now read this one function.
 */
export function microchipHeroTag(compliance: ComplianceState): string | null {
  const card = compliance.cards.find((c) => c.key === "microchip");
  if (!card) return null;
  if (card.tone === "ok") return "Microchip verificado";
  if (card.state !== SIN_REGISTRO_STATE) return "Microchip declarado";
  return null;
}

/**
 * Map a pet row + its compliance projection onto the status chip shown on the
 * credential header and every pet list row (LnStatusFlag / LnRegRow).
 *
 * AL DÍA ("ok") is a COMPLIANCE claim, not an aliveness claim — it is only
 * granted when every tracked obligation is verified-satisfied; otherwise the
 * credential is simply REGISTRADA. Lost, deceased and pregnancy override
 * compliance.
 *
 * Precedence matches PetCard.helpers (lost first, then deceased): a deceased
 * pet is a closed life record and must render the memorial state, NOT "AL DÍA"
 * (PJ-M1 — the mapper handled lost/pregnant but not deceased, so a deceased
 * fully-compliant pet read "al día" on every list row).
 *
 * This is THE single mapper for every surface that shows the chip (detail
 * header, /inicio registry, /mis-mascotas list) — QA round 2 (2026-07-03)
 * caught the same pet reading "AL DÍA" on the lists and "REGISTRADA · 0 de 3
 * al día" on its own header.
 */
export function lnPetStatusFromCompliance(
  pet: { status: string; pregnancyStatus: string | null },
  compliance: ComplianceState,
): "ok" | "registered" | "lost" | "pregnant" | "deceased" {
  if (pet.status === "lost") return "lost";
  if (pet.status === "deceased") return "deceased";
  if (pet.pregnancyStatus === "in_progress") return "pregnant";
  // An EMPTY denominator is not compliance (T6 review M5): with no counted
  // obligation, `ok === total` is 0 === 0 and every list row stamped "AL DÍA"
  // over a pet nothing had judged. "registered" is the honest status.
  if (compliance.summary.total === 0) return "registered";
  return compliance.summary.ok === compliance.summary.total ? "ok" : "registered";
}

/**
 * Jurisdiction-tier overlay (spec CS2-CS4). A `mandatory` tier keeps the card
 * exactly as derived (existing urgency). A `recommended` or `optional` tier
 * keeps the card but SOFTENS it: never "vencida"/overdue styling (over/due
 * tones clamp to neutral), marked with its own `requirementTier` so the panel
 * adds the matching disclosure line and the summary excludes it from M. A
 * `not_regulated` tier renders information only: a card with nothing on
 * record ("Sin registro") is omitted entirely — there is no obligation to
 * surface and nothing to inform — while real data (a dose, a chip) stays
 * visible as an informational card, tones clamped, hint dropped (the hint
 * says "para que cuente", and there is nothing to count toward).
 *
 * `optional` keeps its OWN tier (T6 review MINOR 7). It used to fold into
 * `recommended`, so an explicitly-optional rule told the owner "Recomendación
 * de tu jurisdicción" — a claim the jurisdiction never made. The tier is a real
 * value of the DB CHECK, so it gets real copy instead of a borrowed one.
 */
function applyTierOverlay(
  card: ObligationCard | null,
  level: ObligationRequirementLevel,
): ObligationCard | null {
  if (card === null || level === "mandatory") return card;
  const tier = level;
  // Nothing on record, nothing claimed: a not-yet-applicable card (T1-G1) is
  // "Sin registro" with a date attached, so it drops the same way.
  if (tier === "not_regulated" && (card.state === SIN_REGISTRO_STATE || card.notYetRequired)) {
    return null;
  }
  const tone: ComplianceTone = card.tone === "over" || card.tone === "due" ? "neutral" : card.tone;
  return {
    ...card,
    tone,
    requirementTier: tier,
    hint: tier === "not_regulated" ? null : card.hint,
  };
}

/**
 * Compose the owner obligations into an ordered, summarized compliance view.
 * Cards are sorted worst-state first. With threaded `obligations` (CS1) each
 * card carries its jurisdiction tier: only `mandatory` obligations (and the
 * PPP gate, which is authoritative on its own) enter the "N de M al día"
 * count (CS2/CS4); `recommended` renders softer and `not_regulated` renders
 * informational, both excluded from M. Without `obligations` (legacy
 * callers/tests) behavior is exactly the pre-tier one: the microchip card is
 * omitted when microchipApplies=false and none is on record. The PPP card is
 * attestation when the pet is a flagged PPP, "indeterminado" when a DOG is
 * missing breed and/or weight, and omitted otherwise.
 */
export function deriveComplianceState(input: ComplianceInput): ComplianceState {
  const { obligations } = input;
  let rabiesCard: ObligationCard | null = deriveRabies(input);
  let sterilizationCard: ObligationCard | null = deriveSterilization(input);
  let microchipCard = deriveMicrochip(input);
  let pppCard = derivePpp(input);

  if (obligations) {
    // Citation composition (CS5, RG1 ratified 2026-08-16) — rabies + microchip
    // compose from the resolved rule row; the sterilization footnotes are
    // provenance lines, not legal citations. The generic stopgap stays when
    // the resolved row carries no citation — never invent law (CS6: a CABA
    // citation reaches ONLY pets whose own jurisdiction resolved it).
    const rabiesCitation = composeLegalCitation(obligations.rabies);
    const rabiesParams = input.ruleParams?.rabies;
    const cadenceBasis = rabiesParams?.frequencyLegalBasis?.trim() || null;
    // A "rule" card's date was computed from a cadence no cited norm fixes, so
    // no citation is attached next to it — its footnote slot already says how
    // the date was computed. A "legal_cadence" card carries BOTH citations: the
    // obligation's, then the norm that fixes the interval (D5).
    if (
      rabiesCard &&
      rabiesCitation &&
      rabiesCard.dueSource === "legal_cadence" &&
      rabiesParams?.frequencyMonths != null &&
      cadenceBasis
    ) {
      rabiesCard = {
        ...rabiesCard,
        legalFootnote: `Obligación del propietario · ${rabiesCitation} · ${legalCadenceClause(rabiesParams.frequencyMonths, cadenceBasis)}`,
      };
    } else if (
      rabiesCard &&
      rabiesCitation &&
      rabiesCard.dueSource !== "rule" &&
      rabiesCard.dueSource !== "legal_cadence"
    ) {
      rabiesCard = {
        ...rabiesCard,
        legalFootnote: `Obligación del propietario · ${rabiesCitation}`,
      };
    }
    const microchipCitation = composeLegalCitation(obligations.microchip);
    if (microchipCard && microchipCitation) {
      microchipCard = { ...microchipCard, legalFootnote: `Identificación · ${microchipCitation}` };
    }
    rabiesCard = applyTierOverlay(rabiesCard, obligations.rabies.requirementLevel);
    sterilizationCard = applyTierOverlay(
      sterilizationCard,
      obligations.sterilization.requirementLevel,
    );
    microchipCard = applyTierOverlay(microchipCard, obligations.microchip.requirementLevel);
  }
  const pppCitation = composeLegalCitation(input.pppRule);
  if (pppCard && pppCitation) {
    pppCard = {
      ...pppCard,
      legalFootnote: `Régimen perros potencialmente peligrosos · ${pppCitation}`,
    };
  }

  const cards: ObligationCard[] = [rabiesCard, sterilizationCard, microchipCard, pppCard].filter(
    (c): c is ObligationCard => c !== null,
  );

  cards.sort((a, b) => TONE_SEVERITY[a.tone] - TONE_SEVERITY[b.tone]);

  // M counts MANDATORY obligations only (CS4): recommended / not_regulated
  // cards are visible but never enter the compliance percentage. Legacy
  // callers (no `obligations`) mark nothing, so countable === cards.
  const countable = cards.filter((c) => c.requirementTier === undefined && !c.notYetRequired);
  const total = countable.length;
  // `currencyKnown === false` is a dose on record whose vigencia is unknowable.
  // It is NOT "al día": counting it produced "3 de 3 al día" beside a card the
  // panel now stamps SIN DATO — the same self-contradiction the vigilancia tile
  // had (C5, external design review).
  const ok = countable.filter((c) => c.tone === "ok" && c.currencyKnown !== false).length;
  // The header chip describes the OBLIGATIONS the summary counts — an
  // informational/recommended card must not drag the "N de M al día" badge to
  // neutral while every counted obligation is ok. `filter` preserves the
  // worst-first sort, so countable[0] is the worst counted obligation.
  const worstCard = countable[0] ?? null;
  // NO COUNTED OBLIGATIONS ≠ COMPLIANT (T6 review M5). With every obligation
  // resolved recommended/not_regulated (reachable today through the admin rules
  // console on a non-PPP pet), M is 0 — and "0 de 0 al día" rendered GREEN, a
  // green seal for a pet nobody has judged. An empty denominator is a fact
  // about the JURISDICTION's rule coverage, not about this animal, so it says
  // so, in neutral.
  const empty = total === 0;
  const worstTone: ComplianceTone = empty ? "neutral" : (worstCard?.tone ?? "ok");
  // Read off the SAME card the tone comes from, so the two can never disagree
  // about which obligation the summary is describing.
  // A "rule" rabies card counts as unknown here too: what is missing is a
  // signed due date, and the summary stamp must not turn the suggestion into
  // "POR VENCER" (its `due` tone's default word) over a date nobody fixed.
  const worstIsUnknown = empty
    ? false
    : worstCard?.dataUnknown === true || worstCard?.dueSource === "rule";

  return {
    cards,
    summary: {
      total,
      ok,
      label: empty ? NO_COUNTED_OBLIGATIONS_LABEL : `${ok} de ${total} al día`,
    },
    worstTone,
    worstIsUnknown,
  };
}
