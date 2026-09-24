// `GET /api/v1/pets/{publicToken}/credential` — the wire shape.
//
// WHAT THIS IS
// ---------------------------------------------------------------------------
// The public credential a QR scan resolves to, as data instead of HTML. It is
// the first `/api/v1` read, so it also establishes the envelope every later one
// copies: `payloadVersion` / `issuedAt` / `staleAfter` (api-invariants.md §6)
// and a per-section availability contract (§5).
//
// WHAT IS IN IT, AND HOW THAT WAS DECIDED
// ---------------------------------------------------------------------------
// EXACTLY the facts `app/(public)/p/[publicToken]/page.tsx` renders, and
// nothing else. The shape was derived by reading the page's JSX, not by
// projecting the loader's return type: `CredentialViewData` is what the page
// FETCHES, and the page deliberately fetches several things it only uses to
// derive one boolean. Shipping the fetched shape would have published the
// microchip number, 50 rows of vaccination history and a service-dog
// credential record on a Tier-0 surface — each of them a field the page reads
// and then does not show. The exclusions are listed in the route handler that
// builds this, one line each, with the reason.
//
// Two consequences worth stating up front, because they look like omissions:
//
//   • NO es-AR COPY. The page renders `statusLabel(status)`, `speciesLabel(…)`
//     and a Spanish identity heading; this carries the enum and the boolean
//     behind them. A native client owns its own strings — and the moment the
//     server ships the label, the client's translation and the server's drift.
//   • NO INTERNAL IDs. No pet UUID, no attachment UUID, no case UUID, no owner
//     user id. Photos arrive as resolved URLs, which is what both renderers
//     want and what neither should have to derive from a bucket layout.
//
// WHY EVERY SECTION CARRIES ITS OWN STATE (§5, and the point of the ticket)
// ---------------------------------------------------------------------------
// A hung query fails soft into a blank section. A human reading a web page
// reads that as "something is missing". A native client rendering the same
// blank JSON presents it as A VALID CREDENTIAL WITH NO FINDINGS — no vaccines,
// no notices, nothing to worry about, on the one surface an anonymous finder in
// the street depends on. So a section is never bare data: it is either
// `{ status: "ok", … }` or `{ status: "unavailable" }`, and "empty" is a thing
// only the first can say.

import type { PetSex } from "../input/intake.ts";

/** Bumped when a change would break an existing client's parse. */
export const PUBLIC_CREDENTIAL_PAYLOAD_VERSION = 1;

/**
 * How long a credential snapshot may be presented as current (ms).
 *
 * The web surface answers this question with `Cache-Control: no-store` on
 * every response, because the credential FLIPS: a pet goes lost, an owner marks
 * it found, a disclosure preference changes, and a stale copy showed "SE BUSCA"
 * + the owner's phone for a pet that was already home (the privacy class closed
 * 2026-07-07). A native client holding a copy has no CDN to invalidate, so it
 * gets an explicit expiry instead — `staleAfter` in the envelope.
 *
 * Five minutes is the trade: short enough that a lost->found flip reaches a
 * finder while it still matters, long enough that a client is not re-fetching
 * on every glance. It is NOT a cache-control directive — the response is
 * `no-store` regardless — it is what a client shows the user next to "esto es
 * lo que el servidor sabía a las 14:32". It lives HERE, next to the version,
 * because the client needs the number to render that sentence and a number it
 * cannot import is a number it will hard-code.
 */
export const PUBLIC_CREDENTIAL_STALE_AFTER_MS = 5 * 60_000;

/**
 * One section of a credential read.
 *
 * `unavailable` means the server could not load it, NOT that it is empty. A
 * client must render the difference; that distinction is the whole reason this
 * wrapper exists instead of a nullable field.
 */
export type CredentialSection<T> = { status: "ok"; data: T } | { status: "unavailable" };

/** `pets.status` — the credential's own lifecycle state. */
export const PUBLIC_PET_STATUSES = ["active", "lost", "deceased"] as const;
export type PublicPetStatus = (typeof PUBLIC_PET_STATUSES)[number];

/**
 * The public-safe situation the credential's masthead announces.
 *
 * A strict subset of the app's internal situation vocabulary, and strict on
 * purpose: the medical and household states (`en-tratamiento`, `prenada`,
 * `en-adopcion`, `en-transito`) are STRUCTURALLY unreachable on a Tier-0
 * surface — their inputs are never read here — and `al-dia` is the default,
 * which the credential announces by saying nothing. Listing only what this
 * endpoint can emit means a client's exhaustive switch stays exhaustive.
 */
export const PUBLIC_CREDENTIAL_SITUATIONS = [
  "perdida",
  "custodia-oficial",
  "observacion-antirrabica",
  "fallecida",
] as const;
export type PublicCredentialSituation = (typeof PUBLIC_CREDENTIAL_SITUATIONS)[number];

/** Tri-state vigencia of the one legally-mandated vaccine (Ley 22.953 frame). */
export type RabiesVigencia = "vigente" | "vencida" | "sin-vencimiento" | "none";

/**
 * Whether the record behind a claim carries a professional signature.
 *
 * It rides WITH the vigencia and is not optional: an unqualified "VIGENTE" on
 * a dose the owner typed in is a verification this registry never performed.
 */
export type RabiesProvenance = "profesional" | "declarada";

/** Provenance tier of the most recent vaccination record (ascending trust). */
export type VaccinationConfidenceTier =
  | "unverified"
  | "self_reported"
  | "corroborated"
  | "org_registered"
  | "professional_verified"
  | "institutional_verified";

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** Who the animal is. Present on every credential, in every mode. */
export type CredentialIdentitySection = {
  name: string;
  /** Open vocabulary (`dog`, `cat`, …) — the column itself is free text. */
  species: string;
  breed: string | null;
  sex: PetSex;
  /**
   * Whole years, counted to the DEATH date when there is one. Tier 0 never
   * exposes the exact date of birth; the page shows this same rounded figure.
   */
  ageYears: number | null;
  /** Resolved URL, never a storage path. `null` renders the initial-letter card. */
  photoUrl: string | null;
  /** The credential number printed on the card's identity grid. */
  libretaCode: string;
  /** A canonical active microchip is on record. The NUMBER is never disclosed. */
  hasMicrochip: boolean;
  /** A canonical active tattoo is on record. The code is lost-mode only. */
  hasTattoo: boolean;
  /**
   * The jurisdiction's registry obligation applies AND this animal carries an
   * identifier. Both halves — it is the fact behind the page's identity
   * heading, which is es-AR copy this payload deliberately does not ship.
   */
  registryBacked: boolean;
};

/** What state the credential is in. */
export type CredentialStatusSection = {
  status: PublicPetStatus;
  /** `null` is the default "al día" state — the masthead announces nothing. */
  situation: PublicCredentialSituation | null;
};

/** The Tier-0 vaccination rollup. No dates, no vet, no other vaccine. */
export type CredentialVaccinationSection = {
  /** Any vaccination record exists at all. */
  hasRecords: boolean;
  rabies: { vigencia: RabiesVigencia; provenance: RabiesProvenance };
  /**
   * Provenance of the most recent dose, and ONLY when it is at least
   * `professional_verified` — the same gate the page's badge uses. `null`
   * below that threshold: a weak tier displayed as a badge reads as a
   * verification, which is the failure the gate exists for.
   */
  confidence: VaccinationConfidenceTier | null;
};

/** Everything the credential raises as an alert. Absent notice = `null`. */
export type CredentialNoticesSection = {
  /** The owner published a medical alert (Tier 0+). */
  emergencyMedical: boolean;
  /** An open custody_episode opened by a sanitary authority (state seizure). */
  officialCustody: { authorityName: string | null } | null;
  /** Titularidad under review. Suppresses every owner-contact disclosure. */
  custodyDispute: boolean;
  /** Ley CABA 4078 / Ley Prov 14.107 — the PPP badge. */
  potentiallyDangerousBreed: boolean;
  /** An observation nobody has clinically closed. */
  rabiesObservation: { windowExpired: boolean } | null;
  /**
   * Ley 26.858 — shown only for a vigente, in-service, `full_banner` credential
   * of a recognized type. The credential RECORD is never disclosed; a finder is
   * told the animal is a service dog and whether its rabies dose lapsed.
   */
  serviceDog: { rabiesAtRisk: boolean } | null;
  /**
   * Welfare-safety disclosure, gated by the owner's `discloseConditionsPublicly`.
   * Codes, not labels; unrecognized codes are filtered out server-side so a
   * client never renders one the web credential would not.
   */
  permanentConditions: { codes: string[]; other: string | null } | null;
};

/** Where and when the animal was last seen. Every field disclosure-gated. */
export type CredentialLostLastSeen = {
  placeName: string | null;
  locality: string | null;
  /** Decimal degrees, six places — the demoted coordinate line under the map. */
  coords: string | null;
  lat: number | null;
  lng: number | null;
  /** ISO-8601. When the DISPLAYED point was reported, not when the search opened. */
  at: string | null;
};

/**
 * The Tier-1 promotion: owner contact and last-seen location, revealed only
 * while the pet is marked lost and only for the fields the owner opted to
 * disclose. Active credentials expose NO owner PII, and this whole section is
 * `null` for them.
 *
 * A custody dispute (`notices.custodyDispute`) suppresses every contact field
 * and both report actions: those flows end in an owner-directed notification,
 * which would take sides in a legal dispute.
 */
export type CredentialLostSection = {
  /** ISO-8601 — when the search opened. */
  since: string | null;
  /** Animal-identity traits. Not owner PII; no disclosure preference gates them. */
  color: string | null;
  distinguishingFeatures: string | null;
  owner: {
    /** First name only. The full legal name never reaches a public credential. */
    firstName: string | null;
    phoneE164: string | null;
    email: string | null;
  };
  /**
   * The temporary caretaker's contact — `null` unless BOTH the titular's
   * disclosure preference AND the caretaker's own consent hold, and no dispute
   * is open. Resolved as one gate server-side, never as two booleans a client
   * could combine differently.
   */
  caretakerContact: { firstName: string | null; phoneE164: string | null } | null;
  lastSeen: CredentialLostLastSeen | null;
  /** Spec §8.4 — animal details, always shown when present. */
  description: {
    accessoriesWhenLost: string | null;
    behaviorNotes: string | null;
    lastSeenContext: string | null;
  } | null;
  /**
   * The tattoo, disclosed ONLY here. A microchip needs a reader, so publishing
   * its number helps nobody standing over the animal; a tattoo is a mark read
   * OFF the animal, and withholding it withholds the one identifier a finder
   * can actually match in the exact situation this promotion exists to serve.
   */
  tattoo: {
    code: string | null;
    location: string | null;
    description: string | null;
    photoUrl: string | null;
  } | null;
  /** The owner allows a finder to report possession (relays their contact). */
  allowFinderForm: boolean;
  /** A sighting may be reported (no contact relay). False during a dispute. */
  allowSighting: boolean;
};

/** The owner's Tier-2 opt-in window. The medical detail is NOT in v1. */
export type CredentialTier2Section = {
  enabled: boolean;
  /** "siempre" — no expiry. */
  permanent: boolean;
  /** ISO-8601, or `null` for a permanent / disabled window. */
  enabledUntil: string | null;
  /**
   * ALWAYS `"not_included"`. The Tier-2 medical projection (full vaccination
   * history, medications, sterilization) is a separate streamed read the
   * credential door does not make, so v1 cannot report it and will not pretend
   * it is empty. A later endpoint serves it; until then this field is the
   * honest answer to "why is there no medical data here".
   */
  medical: "not_included";
};

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/**
 * A successful public-credential read (HTTP 200).
 *
 * `staleAfter` is the instant this snapshot stops being safe to present as
 * current. It exists because this credential FLIPS: a pet goes lost, an owner
 * marks it found, a disclosure preference changes, and the web surface answers
 * that with `Cache-Control: no-store` on every response. A native client
 * holding a copy has no such mechanism, so it gets an explicit expiry and can
 * say "this is what the server knew at 14:32" instead of implying live truth.
 */
export type PublicCredentialV1 = {
  payloadVersion: typeof PUBLIC_CREDENTIAL_PAYLOAD_VERSION;
  /** ISO-8601 — when the server built this snapshot. */
  issuedAt: string;
  /** ISO-8601 — after this, the snapshot must not be shown as current. */
  staleAfter: string;
  publicToken: string;
  identity: CredentialSection<CredentialIdentitySection>;
  status: CredentialSection<CredentialStatusSection>;
  vaccination: CredentialSection<CredentialVaccinationSection>;
  notices: CredentialSection<CredentialNoticesSection>;
  /** `{ status: "ok", data: null }` means "loaded, and the pet is not lost". */
  lost: CredentialSection<CredentialLostSection | null>;
  tier2: CredentialSection<CredentialTier2Section>;
};

/**
 * A degraded public-credential read (HTTP 503).
 *
 * The same envelope and the same sections, carrying the error code ALONGSIDE
 * whatever survived — the shape `app/api/panorama/kpis/route.ts` prototyped and
 * that api-invariants.md §2 names as the precedent for the per-section
 * contract. A bare `{ error }` would give a native client strictly less than
 * the web already gets: the page renders a `DegradedCredentialCard` with the
 * animal's name and its aviso CTAs, because those routes run their own reads
 * and may still work while this one is down.
 *
 * `identity` is `ok` only when the pet ROW itself resolved before the failure,
 * and even then it carries only the four fields that card renders. Every other
 * section is `unavailable` — never empty.
 */
export type PublicCredentialV1Degraded = {
  error: "temporarily_unavailable";
  payloadVersion: typeof PUBLIC_CREDENTIAL_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  publicToken: string;
  /**
   * The degraded card's own props — name, sex, and the two lost CTAs.
   *
   * `allowFinderForm` DOES NOT MEAN THE SAME THING HERE AS IT DOES IN
   * `CredentialLostSection`, and the difference is deliberate. On a successful
   * read it is `owner preference AND no custody dispute`. Here it is the owner
   * PREFERENCE ONLY: this envelope exists because a read failed, so the dispute
   * state is precisely one of the things the server could not establish.
   *
   * That is safe because the dispute gate is enforced at SUBMIT, server-side —
   * the finder-possession action re-reads `pets.in_custody_dispute` after
   * resolving the token and refuses the report outright — so a CTA shown here
   * cannot relay anything to a contested owner. Failing the CTA closed instead
   * would hide it for EVERY pet during an outage, including the overwhelming
   * majority with no dispute, on the one surface an anonymous finder in the
   * street depends on. A client may render the CTA on this value; it must not
   * treat it as a statement about the dispute.
   */
  identity: CredentialSection<{
    name: string;
    sex: PetSex;
    isLost: boolean;
    allowFinderForm: boolean;
  }>;
  status: CredentialSection<never>;
  vaccination: CredentialSection<never>;
  notices: CredentialSection<never>;
  lost: CredentialSection<never>;
  tier2: CredentialSection<never>;
};
