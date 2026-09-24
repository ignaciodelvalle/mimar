// Adopción — turning the server's answer into what a person reads, and what they
// typed into what the contract accepts.
//
// PURE, like every other view-model in this app. Nothing here touches the
// network, so all of it is testable without one.
//
// THE LABELS ARE NOT COMPUTED HERE AND THAT IS THE POINT
// ---------------------------------------------------------------------------
// `facts`, `sexLabel`, `speciesLabel` and `sterilizedLabel` arrive from the
// server ALREADY IN es-AR, and three of them agree with the animal's sex. The
// public ficha shipped "Castrada" over a male dog because one of three call
// sites hardcoded the feminine; a fourth implementation of that agreement, in
// another runtime, is that bug waiting to be rewritten. So this file renders
// what it is given and derives no Spanish from an enum.
//
// What it DOES own is the copy that is only ever shown here — the empty states,
// the three closed-ficha sentences, the status lines under an application — and
// the mapping from a filled-in form to an `AdoptionApplicationInput`.
//
// THE VALIDATION IS THE CONTRACT'S OWN SCHEMA, imported and not re-stated. A
// second copy of "the motivation needs thirty characters", written here for a
// nicer message, is the drift `@dim/contract` exists to stop — and
// `__tests__/adoption-application-input-parity.test.ts` already proves that
// schema agrees with the server's domain rule. What lives here is the WORDS:
// the contract carries codes, the consumer owns its copy.

import type {
  AdoptionApplyBlockedReasonV1,
  AdoptionCatalogueItemV1,
  AdoptionDetailClosedV1,
  AdoptionDetailListedV1,
  MyAdoptionApplicationStatusV1,
  MyAdoptionApplicationV1,
} from "@dim/contract/api";
import type {
  AdoptionApplicationInput,
  AdoptionApplicationInputCode,
  AdoptionHousingType,
  AdoptionPriorPets,
} from "@dim/contract/input";
import {
  adoptionApplicationInputSchema,
  firstAdoptionApplicationInputCode,
} from "@dim/contract/input";

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/** The subtitle under a card: breed, then where the animal is. */
export function cardSubtitle(item: AdoptionCatalogueItemV1): string {
  const place = [item.locality, item.province].filter(Boolean).join(", ");
  return [item.breed, place].filter((part) => part && part.length > 0).join(" · ");
}

/**
 * The badges a card shows, in the web's order.
 *
 * "Con chip" IS A BADGE AND NEVER A NUMBER. The payload carries a boolean and
 * there is no code to render; PO-1 took the masked form off the public ficha in
 * 2026-08 and this is the surface that would put it back by accident.
 */
export function cardBadges(item: AdoptionCatalogueItemV1): string[] {
  const badges: string[] = [];
  if (item.isSterilized) badges.push(item.sterilizedLabel);
  if (item.hasMicrochip) badges.push("Con chip");
  if (item.livesWithFamily) badges.push("Vive con su familia");
  return badges;
}

/**
 * The line above the grid.
 *
 * IT COUNTS WHAT IS ON SCREEN AND SAYS SO, because that is all the server told
 * us: the catalogue is a keyset page, there is no total anywhere in the payload,
 * and "24 mascotas" over a country's worth of listings would be a number this
 * app made up. The web's own line has the same shape and the same limit.
 */
export function catalogueSummary(count: number, hasMore: boolean): string {
  const noun = count === 1 ? "mascota publicada" : "mascotas publicadas";
  return hasMore ? `${count} ${noun} · mostrando las más recientes` : `${count} ${noun}`;
}

/**
 * The empty state, which is TWO empty states.
 *
 * "No hay resultados con esos filtros" is misleading when there are no filters:
 * in that case the section simply has no listings yet. The web page distinguishes
 * them (UX 3.5 item 3) and a phone that collapsed them would tell somebody their
 * search was wrong when the country's shelters had published nothing.
 */
export function catalogueEmpty(filtered: boolean): { title: string; body: string } {
  return filtered
    ? {
        title: "No hay mascotas con esos filtros.",
        body: "Probá quitando alguno para ver más opciones.",
      }
    : {
        title: "Todavía no hay animales en adopción.",
        body: "Volvé en unos días — los refugios suben mascotas seguido.",
      };
}

// ---------------------------------------------------------------------------
// The ficha
// ---------------------------------------------------------------------------

/**
 * The two soft answers, in the web's own words.
 *
 * NEITHER IS AN ERROR AND NEITHER IS A 404. Somebody arriving at one of these
 * followed a shared link; telling them the animal was not found would be false
 * about a pet that exists, and telling them nothing would leave them staring at
 * a blank screen.
 */
export function closedFichaCopy(detail: AdoptionDetailClosedV1): {
  title: string;
  body: string;
} {
  if (detail.state === "recently_adopted") {
    return {
      title: `¡${detail.name} ya encontró su hogar!`,
      body: "Esta mascota fue adoptada hace pocos días. Hay muchas otras buscando su familia.",
    };
  }
  const who = detail.orgName ?? "El refugio";
  return {
    title: `${detail.name} no está disponible en este momento`,
    body: `${who} pausó temporalmente la adopción de ${detail.name}. Podés volver más adelante o explorar otras mascotas en adopción.`,
  };
}

/** The org card's eyebrow — who answers for the listing, or who accompanies it. */
export function orgSectionLabel(detail: AdoptionDetailListedV1): string {
  return detail.org.livesWithFamily ? "Organización que acompaña" : "Refugio responsable";
}

/**
 * The org card's body line.
 *
 * A SPONSORED LISTING SAYS SOMETHING DIFFERENT, and it is not decoration: the
 * animal lives with its current family and the organization runs the evaluation.
 * "En custodia desde" over that would state three things that are only true of
 * an intake.
 */
export function orgSectionBody(detail: AdoptionDetailListedV1): string {
  const { org, name } = detail;
  if (org.livesWithFamily) {
    return `${name} vive con su familia actual. ${org.name} publica la búsqueda de hogar y evalúa a quienes se postulan.`;
  }
  return `${org.name} tiene la custodia de ${name} y evalúa a quienes se postulan.`;
}

/**
 * The three health rows.
 *
 * `false` MEANS "SIN DATO" AND NOT "NO", and saying so is a decision the web
 * made in 2026-08 (S1-F13): all three booleans are the PRESENCE OF A RECORD, so
 * a shelter that has not yet loaded a castration looks identical to an animal
 * that is certainly not castrated — and somebody deciding whether to adopt needs
 * that difference. A dash represented both and named neither.
 */
export function healthRows(
  detail: AdoptionDetailListedV1,
): Array<{ label: string; ok: boolean; note: string | null }> {
  const { health } = detail;
  return [
    {
      // NOT "al día": hasVaccinations is the presence of a record (see the
      // docblock above), so one 2019 dose used to render as green "al día" to
      // an adopter. Mirrors the web's two honest states verbatim
      // (app/(public)/p/[publicToken]/page.tsx).
      label: "Vacunación",
      ok: health.hasVaccinations,
      note: health.hasVaccinations ? "Con registros" : "Sin registros",
    },
    { label: "Castración", ok: health.isSterilized, note: rowNote(health.isSterilized) },
    { label: "Microchip miMAR", ok: health.hasMicrochip, note: rowNote(health.hasMicrochip) },
  ];
}

function rowNote(ok: boolean): string | null {
  return ok ? null : "Sin dato";
}

/**
 * The convivencia chips — only the ones the shelter actually answered.
 *
 * `null` IS DROPPED AND NOT RENDERED AS "no". Three of these four are questions
 * a shelter may simply not know the answer to, and a chip that said "No convive
 * con gatos" about an unanswered field would be this app inventing a fact about
 * an animal.
 */
export function convivenciaChips(
  detail: AdoptionDetailListedV1,
): Array<{ label: string; value: boolean }> {
  const raw: Array<{ label: string; value: boolean | null }> = [
    { label: "Con chicos", value: detail.goodWithKids },
    { label: "Con otros perros", value: detail.goodWithDogs },
    { label: "Con gatos", value: detail.goodWithCats },
    { label: "Necesita patio", value: detail.needsYard },
  ];
  return raw.filter((c): c is { label: string; value: boolean } => c.value !== null);
}

/**
 * Why the "Postularme" button is not there.
 *
 * THE SERVER DECIDES AND THIS FILE ONLY SPEAKS. Both refusals need state the
 * phone does not hold, and a screen that recomputed either would draw a form the
 * write throws away — which is `pets/{token}/profile`'s rule for this whole
 * surface, in the one place it would be tempting to guess.
 */
export function applyBlockedCopy(reason: AdoptionApplyBlockedReasonV1): string {
  switch (reason) {
    case "already_applied":
      return "Ya te postulaste para esta mascota. El refugio la está revisando y te contacta por email cuando tenga novedades.";
    case "institutional_account":
      return "Las cuentas institucionales no pueden postularse para adoptar. Si querés adoptar a título personal, creá una cuenta personal con otro email.";
  }
}

/** The fee line, when the shelter asks for a contribution. */
export function feeCopy(feeArs: number | null): string | null {
  if (feeArs === null || feeArs <= 0) return null;
  return `Adopción solidaria: $${feeArs.toLocaleString("es-AR")}`;
}

// ---------------------------------------------------------------------------
// Mis postulaciones
// ---------------------------------------------------------------------------

/** The chip over each row. The web's seven labels, unchanged. */
export function applicationStatusLabel(status: MyAdoptionApplicationStatusV1): string {
  switch (status) {
    case "pending":
      return "En revisión";
    case "info_requested":
      return "Te pidieron info";
    case "approved":
      return "Aprobada";
    case "finalized_to_me":
      return "¡Finalizada!";
    case "auto_rejected":
      return "Cerrada";
    case "rejected":
      return "No avanzó";
    case "withdrawn":
      return "Retirada";
  }
}

/**
 * The sentence under each row.
 *
 * `auto_rejected` IS NOT `rejected` AND THE COPY IS WHERE THAT MATTERS. The
 * first means the animal went to somebody else; the second means the shelter did
 * not advance this application. Telling the first person they were turned down
 * is a small cruelty the web already refuses.
 */
export function applicationStatusBody(app: MyAdoptionApplicationV1): string {
  switch (app.status) {
    case "pending":
      return "El refugio está revisando tu postulación.";
    case "info_requested":
      return `${app.orgName} te pidió más información. Revisá tus notificaciones y respondé por email para que puedan avanzar.`;
    case "approved":
      return "El refugio aprobó tu postulación. Coordinan los próximos pasos por email.";
    case "finalized_to_me":
      return `¡Adoptaste a ${app.petName}! Su libreta digital ya está en Mis mascotas.`;
    case "auto_rejected":
      return `${app.petName} encontró hogar con otra postulación.`;
    case "rejected":
      return "El refugio no avanzó con esta postulación.";
    case "withdrawn":
      return "Retiraste esta postulación.";
  }
}

/**
 * Whether a row may link to the animal's ficha.
 *
 * THE SERVER'S `stillListed`, NEVER THE STATUS. An application can be `pending`
 * over an animal the shelter unpublished this morning, and a link built from the
 * status would open a 404 — or worse, a "ya encontró su hogar" for an animal
 * this person is still waiting on.
 */
export function applicationFichaAvailable(app: MyAdoptionApplicationV1): boolean {
  return app.stillListed;
}

/** The note under a capped list. `null` when the list is whole. */
export function applicationsTruncationNote(truncated: boolean): string | null {
  return truncated
    ? "Mostramos tus 100 postulaciones más recientes. Las anteriores se ven desde la web."
    : null;
}

/** The empty state. A dead end is still a dead end, so it names the way out. */
export const APPLICATIONS_EMPTY = {
  title: "Todavía no te postulaste para adoptar.",
  body: "Encontrá mascotas que buscan hogar y postulate desde su ficha.",
} as const;

// ---------------------------------------------------------------------------
// The application form
// ---------------------------------------------------------------------------

/** What the form holds while somebody fills it in. Strings, as inputs give them. */
export type ApplicationDraft = {
  housingType: AdoptionHousingType | null;
  priorPets: AdoptionPriorPets | null;
  motivation: string;
  otherPets: string;
  dailyRoutine: string;
  notes: string;
  consent: boolean;
};

export const EMPTY_APPLICATION_DRAFT: ApplicationDraft = {
  housingType: null,
  priorPets: null,
  motivation: "",
  otherPets: "",
  dailyRoutine: "",
  notes: "",
  consent: false,
};

export const HOUSING_TYPE_OPTIONS: ReadonlyArray<{
  value: AdoptionHousingType;
  label: string;
}> = [
  { value: "casa_con_patio", label: "Casa con patio" },
  { value: "casa_sin_patio", label: "Casa sin patio" },
  { value: "departamento", label: "Departamento" },
  { value: "otro", label: "Otro" },
];

export const PRIOR_PETS_OPTIONS: ReadonlyArray<{ value: AdoptionPriorPets; label: string }> = [
  { value: "yes_currently", label: "Sí, tengo mascotas ahora" },
  { value: "yes_before", label: "Tuve antes" },
  { value: "no", label: "Nunca tuve" },
];

/**
 * es-AR for each refusal the CONTRACT can produce.
 *
 * The switch has no `default`, so a code added to
 * `ADOPTION_APPLICATION_INPUT_CODES` without copy here does not compile — the
 * same shape `apiErrorMessage` uses for the envelope vocabulary.
 */
export function applicationInputMessage(code: AdoptionApplicationInputCode): string {
  switch (code) {
    case "HOUSING_TYPE_REQUIRED":
      return "Elegí dónde vivís.";
    case "PRIOR_PETS_REQUIRED":
      return "Contanos si tuviste mascotas antes.";
    case "MOTIVATION_TOO_SHORT":
      return "Contanos un poco más por qué querés adoptar (mínimo 30 caracteres).";
    case "TEXT_TOO_LONG":
      return "Alguna respuesta es demasiado larga (máximo 2000 caracteres).";
    case "CONSENT_REQUIRED":
      return "Necesitamos tu permiso para compartir tus datos con el refugio.";
  }
}

export type ApplicationValidation =
  | { ok: true; input: AdoptionApplicationInput }
  | { ok: false; message: string };

/**
 * A draft, validated against the CONTRACT's schema — never against a local copy
 * of its rules.
 *
 * EMPTY OPTIONAL ANSWERS BECOME `null` RATHER THAN `""`, which matters because
 * the writer collapses `undefined`, `null` and whitespace onto the same stored
 * NULL: sending `""` would be this app inventing an empty answer where the
 * person simply skipped a question.
 *
 * A parse failure that produces NO recognised code still returns a message. The
 * schema's own refusals all carry one, so that arm is only reachable if a field
 * is the wrong TYPE — which means a bug here rather than a person's mistake, and
 * a silent `null` would leave a dead button with no explanation.
 */
export function validateApplicationDraft(draft: ApplicationDraft): ApplicationValidation {
  const candidate = {
    housingType: draft.housingType ?? undefined,
    priorPets: draft.priorPets ?? undefined,
    motivation: draft.motivation,
    otherPets: draft.otherPets.trim() === "" ? null : draft.otherPets,
    dailyRoutine: draft.dailyRoutine.trim() === "" ? null : draft.dailyRoutine,
    notes: draft.notes.trim() === "" ? null : draft.notes,
    profileSharingConsent: draft.consent === true ? true : undefined,
  };
  const parsed = adoptionApplicationInputSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstAdoptionApplicationInputCode(parsed.error);
  return {
    ok: false,
    message: code
      ? applicationInputMessage(code)
      : "Revisá el formulario: hay una respuesta que no pudimos leer.",
  };
}
