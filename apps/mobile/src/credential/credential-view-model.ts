// The credential payload, turned into something a screen can render.
//
// PURE ON PURPOSE. Nothing in this file imports React, React Native, or the
// network layer: it takes a parsed `PublicCredentialV1` and a `Date`, and
// returns data. That is what makes the two things most likely to be wrong here
// — the freshness arithmetic and the per-section honesty — testable without a
// renderer, a device, or a live endpoint (`credential-view-model.test.ts`).
//
// WHY A VIEW MODEL AND NOT JUST `payload.identity.data.name` IN THE JSX
// ---------------------------------------------------------------------------
// Because the contract has a rule that JSX is very good at breaking, and it is
// stated in `packages/contract/src/api/public-credential.ts` in capital letters:
// a section is `{ status: "ok", … }` or `{ status: "unavailable" }`, and a blank
// render of the second is a LIE — it presents a credential the server could not
// read as a credential with nothing to report. The one surface that matters
// here is an anonymous person standing over a lost animal in the street.
//
// A screen that reaches into `payload.notices.data?.emergencyMedical` writes
// that lie by accident, in one character: `?.` turns "we could not load the
// alerts" into "there are no alerts". So the unavailable arm is made
// unreachable-by-accident instead — every section becomes a tagged union the
// renderer must destructure, and the es-AR copy for the failed arm is decided
// HERE, once, next to the reason.
//
// THE THREE-STATE SECTION (`lost`), WHICH IS THE WHOLE POINT
// ---------------------------------------------------------------------------
// `lost` is typed `CredentialSection<CredentialLostSection | null>`, so it has
// three meanings, not two:
//
//   { status: "ok", data: {…} }  → the pet IS lost; here is the search.
//   { status: "ok", data: null } → loaded fine; the pet is NOT lost.
//   { status: "unavailable" }    → we do not know whether the pet is lost.
//
// The second and third are the ones a nullable field would collapse, and
// collapsing them is the worst outcome available on this screen: it renders
// "not lost" for an animal whose owner is looking for it. `lostView()` below
// keeps them apart as three tags, and the test pins all three.

import {
  type CredentialIdentitySection,
  type CredentialLostSection,
  type CredentialNoticesSection,
  type CredentialSection,
  type CredentialStatusSection,
  type CredentialTier2Section,
  type CredentialVaccinationSection,
  PUBLIC_CREDENTIAL_STALE_AFTER_MS,
  type PublicCredentialSituation,
  type PublicCredentialV1,
  type PublicPetStatus,
  type RabiesProvenance,
  type RabiesVigencia,
} from "@dim/contract/api";

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** The es-AR sentence every unavailable section shows. Decided once. */
export const SECTION_UNAVAILABLE_MESSAGE = "No se pudo leer esta sección.";

/**
 * A section, as the renderer sees it.
 *
 * The `unavailable` arm carries its copy rather than a bare tag so a screen
 * cannot render the failure as an empty `<View />` without noticing it threw
 * a string away.
 */
export type SectionView<T> = { state: "ok"; data: T } | { state: "unavailable"; message: string };

/** `lost`'s third state — see the header. */
export type LostView =
  | { state: "lost"; data: CredentialLostSection }
  | { state: "not-lost" }
  | { state: "unavailable"; message: string };

export function sectionView<T>(section: CredentialSection<T>): SectionView<T> {
  return section.status === "ok"
    ? { state: "ok", data: section.data }
    : { state: "unavailable", message: SECTION_UNAVAILABLE_MESSAGE };
}

export function lostView(section: CredentialSection<CredentialLostSection | null>): LostView {
  if (section.status !== "ok") {
    return { state: "unavailable", message: SECTION_UNAVAILABLE_MESSAGE };
  }
  return section.data === null ? { state: "not-lost" } : { state: "lost", data: section.data };
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

export type Freshness =
  | {
      state: "fresh" | "stale";
      /** "actualizado recién", "actualizado hace 3 minutos", … */
      label: string;
      /** Milliseconds between `issuedAt` and `now`. Never negative. */
      ageMs: number;
    }
  | { state: "unknown"; label: string };

/** es-AR: the copy shown next to an expired snapshot. */
export const STALE_NOTICE = "Esta copia venció. Actualizá para ver el estado actual.";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** es-AR pluralization for the three units this label uses. */
function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "hace 3 minutos" / "recién". Rounds DOWN — never claims a snapshot is newer. */
function relativeAge(ageMs: number): string {
  if (ageMs < MINUTE_MS) return "recién";
  if (ageMs < HOUR_MS) return `hace ${plural(Math.floor(ageMs / MINUTE_MS), "minuto", "minutos")}`;
  if (ageMs < DAY_MS) return `hace ${plural(Math.floor(ageMs / HOUR_MS), "hora", "horas")}`;
  return `hace ${plural(Math.floor(ageMs / DAY_MS), "día", "días")}`;
}

/**
 * How old this snapshot is, and whether it may still be shown as current.
 *
 * WHICH EXPIRY WINS. The server's `staleAfter` instant, always — it is the
 * authority, and a client that recomputes the deadline from its own constant
 * silently ignores a server that decided to shorten the window. The exported
 * `PUBLIC_CREDENTIAL_STALE_AFTER_MS` is the FALLBACK, used only when
 * `staleAfter` is missing or unparseable, which is exactly the case the
 * constant's own doc comment describes as "a number it cannot import is a
 * number it will hard-code". Here it is imported.
 *
 * CLOCK SKEW. `ageMs` is clamped at zero. A phone whose clock runs slow gets a
 * payload stamped in its future, and "actualizado hace -4 minutos" is worse
 * than useless. Staleness is still evaluated against the real comparison, so a
 * skewed clock can make a snapshot look fresh — that is the honest limit of a
 * client-side check and the reason the screen also offers a manual refresh.
 */
export function describeFreshness(
  payload: Pick<PublicCredentialV1, "issuedAt" | "staleAfter">,
  now: Date,
): Freshness {
  const issuedAtMs = Date.parse(payload.issuedAt);
  if (Number.isNaN(issuedAtMs)) {
    // No usable stamp. Saying nothing is the only honest answer: a screen that
    // falls back to "actualizado recién" here invents a freshness the payload
    // never claimed.
    return { state: "unknown", label: "No se pudo determinar la antigüedad." };
  }

  const staleAfterParsed = Date.parse(payload.staleAfter);
  const staleAfterMs = Number.isNaN(staleAfterParsed)
    ? issuedAtMs + PUBLIC_CREDENTIAL_STALE_AFTER_MS
    : staleAfterParsed;

  const ageMs = Math.max(0, now.getTime() - issuedAtMs);

  return {
    state: now.getTime() >= staleAfterMs ? "stale" : "fresh",
    label: `actualizado ${relativeAge(ageMs)}`,
    ageMs,
  };
}

/** What the banner over a CACHED credential says. */
export type CachedNotice = {
  /** Always shown. Names both the age and the fact that this came from disk. */
  headline: string;
  /** Shown as an alert when the server's own `staleAfter` has passed. */
  warning: string | null;
};

/**
 * The banner for a credential rendered from the offline cache.
 *
 * NEVER OPTIONAL. A cached credential without this banner is a claim about the
 * present made out of the past — someone could present a rabies status that
 * reads "vigente" and expired last month, on a screen that gives no hint it is
 * not live. That is the single failure the per-section design of this whole
 * credential exists to prevent, and the offline path is where it would sneak
 * back in.
 *
 * The age comes from `describeFreshness`, i.e. from the SERVER'S `issuedAt` and
 * `staleAfter` — not from the device clock at write time. A phone with a wrong
 * clock still reports the payload's real age, and `staleAfter` still decides
 * what "vencido" means, because that is the server's judgement and not ours.
 *
 * The `unknown` arm does not compose the label into the sentence: it reads "No
 * se pudo determinar la antigüedad." and "No se pudo determinar la antigüedad. ·
 * sin conexión" is not a sentence anyone wrote.
 */
export function cachedCredentialNotice(
  freshness: Freshness,
  reason: CachedReason = "offline",
): CachedNotice {
  const because = CACHED_REASON_LABEL[reason];
  if (freshness.state === "unknown") {
    return {
      headline: `Copia guardada en este dispositivo · ${because}`,
      warning: "No sabemos de cuándo es esta copia. Conectate para ver el estado actual.",
    };
  }
  return {
    headline: `${freshness.label} · ${because}`,
    warning: freshness.state === "stale" ? STALE_NOTICE : null,
  };
}

/**
 * WHY the live read failed — the half of the banner that used to be a guess
 * (A3-documento-credencial-02).
 *
 * The banner said "sin conexión" for EVERY failed read: a 503 from a deploy, a
 * payload this build cannot parse, a body that would not decode. Somebody
 * standing in a vet's waiting room with four bars was told to check their
 * connection, and the one action available to them — wait, or update the app —
 * was never named. The cached document is drawn either way; what changes is
 * whether the sentence over it is true.
 */
export type CachedReason = "offline" | "server" | "version" | "unreadable";

const CACHED_REASON_LABEL: Record<CachedReason, string> = {
  offline: "sin conexión",
  server: "servidor no disponible",
  version: "hay que actualizar la app",
  unreadable: "respuesta ilegible",
};

/** The reason, from the outcome of the read that failed. Exhaustive on purpose. */
export function cachedCredentialReason(
  outcome: "unreachable" | "api-error" | "degraded" | "unsupported-version" | "malformed",
): CachedReason {
  switch (outcome) {
    case "unreachable":
      return "offline";
    case "api-error":
    case "degraded":
      return "server";
    case "unsupported-version":
      return "version";
    case "malformed":
      return "unreadable";
  }
}

// ---------------------------------------------------------------------------
// es-AR labels
// ---------------------------------------------------------------------------
//
// The payload ships enums and booleans and NO Spanish, deliberately — the
// contract header says the moment the server ships the label, the client's
// translation and the server's drift. So the client owns these, and every
// exhaustive switch below is what makes a new enum member a compile error here
// rather than a blank string on a phone.

export function petStatusLabel(status: PublicPetStatus): string {
  switch (status) {
    case "active":
      return "Activa";
    case "lost":
      return "Perdida";
    case "deceased":
      return "Fallecida";
  }
}

export function situationLabel(situation: PublicCredentialSituation): string {
  switch (situation) {
    case "perdida":
      return "Perdida";
    case "custodia-oficial":
      return "Bajo custodia oficial";
    case "observacion-antirrabica":
      return "En observación antirrábica";
    case "fallecida":
      return "Fallecida";
  }
}

export function rabiesVigenciaLabel(vigencia: RabiesVigencia): string {
  switch (vigencia) {
    case "vigente":
      return "Vigente";
    case "vencida":
      return "Vencida";
    case "sin-vencimiento":
      return "Sin vencimiento";
    case "none":
      return "Sin registro";
  }
}

/**
 * The provenance qualifier, never optional.
 *
 * The contract states why: an unqualified "VIGENTE" on a dose the owner typed
 * in is a verification this registry never performed. So the label always
 * carries who said it.
 */
export function rabiesProvenanceLabel(provenance: RabiesProvenance): string {
  switch (provenance) {
    case "profesional":
      return "carga profesional";
    case "declarada":
      return "declarada por el titular";
  }
}

// ---------------------------------------------------------------------------
// The whole view
// ---------------------------------------------------------------------------

export type CredentialView = {
  publicToken: string;
  /** `null` when identity itself is unavailable — NOT an empty string. */
  petName: string | null;
  freshness: Freshness;
  identity: SectionView<CredentialIdentitySection>;
  status: SectionView<CredentialStatusSection>;
  vaccination: SectionView<CredentialVaccinationSection>;
  notices: SectionView<CredentialNoticesSection>;
  lost: LostView;
  tier2: SectionView<CredentialTier2Section>;
};

export function buildCredentialView(payload: PublicCredentialV1, now: Date): CredentialView {
  const identity = sectionView(payload.identity);
  return {
    publicToken: payload.publicToken,
    petName: identity.state === "ok" ? identity.data.name : null,
    freshness: describeFreshness(payload, now),
    identity,
    status: sectionView(payload.status),
    vaccination: sectionView(payload.vaccination),
    notices: sectionView(payload.notices),
    lost: lostView(payload.lost),
    tier2: sectionView(payload.tier2),
  };
}

/**
 * The notices worth putting in front of a finder, as es-AR lines.
 *
 * Returns `[]` only for a LOADED notices section with nothing raised — the
 * caller must have already handled the `unavailable` arm, which is why this
 * takes the section data rather than the section.
 */
export function noticeLines(notices: CredentialNoticesSection): string[] {
  const lines: string[] = [];
  if (notices.emergencyMedical) lines.push("Alerta médica publicada por el titular.");
  if (notices.officialCustody) {
    const authority = notices.officialCustody.authorityName;
    lines.push(authority ? `Bajo custodia oficial (${authority}).` : "Bajo custodia oficial.");
  }
  if (notices.custodyDispute) lines.push("Titularidad en revisión.");
  if (notices.potentiallyDangerousBreed) lines.push("Raza potencialmente peligrosa.");
  if (notices.rabiesObservation) {
    lines.push(
      notices.rabiesObservation.windowExpired
        ? "Observación antirrábica con plazo vencido."
        : "Observación antirrábica en curso.",
    );
  }
  if (notices.serviceDog) {
    lines.push(
      notices.serviceDog.rabiesAtRisk
        ? "Perro de asistencia — dosis antirrábica vencida."
        : "Perro de asistencia.",
    );
  }
  if (notices.permanentConditions) {
    const { codes, other } = notices.permanentConditions;
    const detail = [...codes, other].filter((v): v is string => Boolean(v)).join(", ");
    if (detail) lines.push(`Condiciones permanentes: ${detail}.`);
  }
  return lines;
}
