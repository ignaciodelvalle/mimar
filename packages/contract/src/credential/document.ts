// Credential DOCUMENT — the shared slot tree for every painter.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The landing hero, the public `/p/{token}` page, the owner's two-sided
// libreta (web + native) and the native public screen all DRAW a credential.
// Until this file they each invented layout: which fields, which chrome, which
// situations may tint the card. Copies drift; the landing already had to be
// fenced against the seed (`flagship-pampa-consistency`) because it transcribed
// the real card by hand.
//
// So the WHAT lives here, once: surfaces, variants, field catalogues, the
// situation filter, the chrome recipe, the slot tree a painter fills. The
// WHERE does not: web paints with DOM/CSS, native paints with RN Views. Motion
// (`hook` tilt/float/edges on the landing) is a painter plugin, not a slot —
// it must not appear on this type.
//
// THE SLOT TREE IS NOT A WIRE PAYLOAD
// ---------------------------------------------------------------------------
// `PublicCredentialV1` / `OwnerPetDetailV1` stay at `payloadVersion: 1`. This
// module is a LAYOUT recipe for painters. Putting the slot tree onto `/api/v1`
// would be a different change, and it would have to stay ADDITIVE at version 1
// (unknown keys ignored by an installed build) or bump the envelope and leave
// old binaries on the previous shape forever.
//
// ONE resolved value does travel, under exactly that rule: the right-hand cell
// KIND (`CredentialRightCell`) rides `OwnerPetDetailV1.status.rightCell`,
// added additively at payloadVersion 1 so the native face paints the same cell
// as the web without re-deriving it. Only the kind — never the coordinates.
//
// OTA / RUNTIME FINGERPRINT (PO, 2026-10-02)
// ---------------------------------------------------------------------------
// Expo OTA replaces the JavaScript bundle, never the native binary
// (`docs/mobile/ota-policy.md`). `runtimeVersion: { policy: "fingerprint" }`
// refuses to serve an update whose native hash differs from the installed
// build. This file is JS/TS only: it may ride a hotfix bundle IF a later
// painter imports it. It must never import a native module (Reanimated, a
// new permission, a new intent filter) — that is how an OTA crashes every
// phone that took it, and the fingerprint fence would not save you because
// the JS changed and the binary did not.
//
// A layoutVersion the installed JS does not know must be refused by the
// painter (`layoutVersionSupported`), never silently painted as v1.

import { PUBLIC_CREDENTIAL_SITUATIONS } from "../api/public-credential.ts";

/** Painter recipe version. Independent of every `/api/v1` `payloadVersion`. */
export const CREDENTIAL_DOCUMENT_LAYOUT_VERSION = 1;

/**
 * False on purpose: the slot TREE (`CredentialDocumentSlotsV1`) is not
 * shipped on the wire. A later stage that adds it to an envelope must flip
 * this AND keep the addition additive at `payloadVersion: 1`, or bump that
 * envelope — never silently. The one resolved value that does travel today,
 * `rightCell` on the owner detail, is a single enum, not the tree (see the
 * header note).
 */
export const CREDENTIAL_DOCUMENT_ON_WIRE = false;

/** Who is looking. Drives field catalogue + situation filter. */
export const CREDENTIAL_SURFACES = ["landing", "public", "owner"] as const;
export type CredentialSurface = (typeof CREDENTIAL_SURFACES)[number];

/**
 * How the card is framed. Locked to surface today (`CREDENTIAL_VARIANT_FOR_SURFACE`):
 * landing stays a carnet (the hook); `/p/` is the public sheet; the owner
 * document is the two-sided libreta (trust).
 */
export const CREDENTIAL_VARIANTS = ["carnet", "publicSheet", "libreta"] as const;
export type CredentialVariant = (typeof CREDENTIAL_VARIANTS)[number];

export const CREDENTIAL_VARIANT_FOR_SURFACE: Record<CredentialSurface, CredentialVariant> = {
  landing: "carnet",
  public: "publicSheet",
  owner: "libreta",
};

export const CREDENTIAL_FACES = ["credencial", "libreta"] as const;
export type CredentialFace = (typeof CREDENTIAL_FACES)[number];

/** How complete the facts behind the slots are — not a visual skin. */
export const CREDENTIAL_INTEGRITY = ["live", "demo", "degraded", "cached"] as const;
export type CredentialIntegrity = (typeof CREDENTIAL_INTEGRITY)[number];

/**
 * Situation keys the product already derives (`lib/ui/pet-situation.ts`).
 * Listed here so a painter never imports the app module. `al-dia` is the
 * default: public and owner announce it by saying nothing; the landing demo
 * cycle still plays it as the resting state.
 */
export const CREDENTIAL_SITUATION_KEYS = [
  "al-dia",
  "perdida",
  "custodia-oficial",
  "observacion-antirrabica",
  "en-tratamiento",
  "prenada",
  "en-adopcion",
  "en-transito",
  "fallecida",
] as const;
export type CredentialSituationKey = (typeof CREDENTIAL_SITUATION_KEYS)[number];

/**
 * States the landing hero is allowed to play. A subset of the owner set, and
 * a SUPERSET of the public-safe set: "en-tratamiento" is an owner fact the
 * public page must never tint (Tier 0). The hero is a demo of the OWNER card.
 */
export const LANDING_DEMO_SITUATION_KEYS = [
  "al-dia",
  "perdida",
  "observacion-antirrabica",
  "en-tratamiento",
] as const satisfies readonly CredentialSituationKey[];

export type CredentialSituationSlot = {
  key: CredentialSituationKey;
  tone: string;
  icon: string;
  /** es-AR, already agreed with the animal's sex when the painter has one. */
  label: string;
};

// ---------------------------------------------------------------------------
// Field catalogue — identity grid only. Owner compliance is NOT these fields.
// ---------------------------------------------------------------------------

export const CREDENTIAL_FIELD_IDS = [
  "breed",
  "microchipPresence",
  "tattooPresence",
  "registryStatus",
  "vaccinationRecords",
  "rabies",
  "libretaCode",
  "color",
] as const;
export type CredentialFieldId = (typeof CREDENTIAL_FIELD_IDS)[number];

/** es-AR labels as the surfaces already print them. */
export const CREDENTIAL_FIELD_LABEL: Record<CredentialFieldId, string> = {
  breed: "Raza",
  microchipPresence: "Microchip",
  tattooPresence: "Tatuaje",
  registryStatus: "Credencial",
  vaccinationRecords: "Vacunación",
  rabies: "Antirrábica",
  libretaCode: "Libreta",
  color: "Color",
};

const LANDING_FIELDS = [
  "breed",
  "microchipPresence",
] as const satisfies readonly CredentialFieldId[];

/**
 * What `/p/` prints under the identity heading, in page order, on every public
 * level. A slot whose value is "" is not drawn: Microchip only when Sí, Color
 * only when set; Antirrábica always has a value ("Sin registro" at worst).
 * The registry/vaccination/tattoo/libreta fields of the old six-claim grid
 * left the public face with the three-level card (PO 2026-10-03).
 */
const PUBLIC_FIELDS = [
  "rabies",
  "microchipPresence",
  "color",
] as const satisfies readonly CredentialFieldId[];

/** Owner face uses the compliance panel, not this two-column grid. */
const OWNER_FIELDS = [] as const satisfies readonly CredentialFieldId[];

export const CREDENTIAL_FIELDS_FOR_SURFACE: Record<
  CredentialSurface,
  readonly CredentialFieldId[]
> = {
  landing: LANDING_FIELDS,
  public: PUBLIC_FIELDS,
  owner: OWNER_FIELDS,
};

export function fieldsForSurface(surface: CredentialSurface): readonly CredentialFieldId[] {
  return CREDENTIAL_FIELDS_FOR_SURFACE[surface];
}

export function credentialFieldLabel(id: CredentialFieldId): string {
  return CREDENTIAL_FIELD_LABEL[id];
}

/** Fill the surface's field catalogue; missing values become "". */
export function fieldSlots(
  surface: CredentialSurface,
  values: Partial<Record<CredentialFieldId, string>>,
): CredentialFieldSlot[] {
  return fieldsForSurface(surface).map((id) => ({
    id,
    label: credentialFieldLabel(id),
    value: values[id] ?? "",
  }));
}

const SITUATION_KEY_SET = new Set<string>(CREDENTIAL_SITUATION_KEYS);

export function credentialSituationKey(raw: string): CredentialSituationKey | null {
  return SITUATION_KEY_SET.has(raw) ? (raw as CredentialSituationKey) : null;
}

export type CredentialFieldSlot = {
  id: CredentialFieldId;
  label: string;
  value: string;
};

// ---------------------------------------------------------------------------
// Chrome recipe (titles only). Painters own pinstripes, tilt, QR drawing.
// ---------------------------------------------------------------------------

export type CredentialChromeRecipe = {
  brand: "miMAR";
  /** Upper band / masthead title. */
  title: string;
  /** Second line on the credencial face. */
  subtitleFront: string;
  /** Second line on the libreta face. Null when the variant has no back. */
  subtitleBack: string | null;
  /** Public + owner: icon+text chip. Landing: no chip (PO 2026-09-25). */
  showSituationChip: boolean;
};

export const CREDENTIAL_CHROME: Record<CredentialVariant, CredentialChromeRecipe> = {
  carnet: {
    brand: "miMAR",
    title: "miMAR",
    subtitleFront: "Credencial digital",
    subtitleBack: "Libreta sanitaria",
    showSituationChip: false,
  },
  publicSheet: {
    brand: "miMAR",
    title: "miMAR",
    subtitleFront: "Credencial pública",
    subtitleBack: "Libreta sanitaria",
    showSituationChip: true,
  },
  libreta: {
    brand: "miMAR",
    title: "Libreta Sanitaria",
    subtitleFront: "Credencial · frente",
    subtitleBack: "Libreta · dorso",
    showSituationChip: true,
  },
};

export function chromeForSurface(surface: CredentialSurface): CredentialChromeRecipe {
  return CREDENTIAL_CHROME[CREDENTIAL_VARIANT_FOR_SURFACE[surface]];
}

// ---------------------------------------------------------------------------
// Situation filter — the privacy boundary the public painter must not bypass.
// ---------------------------------------------------------------------------

const PUBLIC_SAFE = new Set<string>(PUBLIC_CREDENTIAL_SITUATIONS);
const LANDING_DEMO = new Set<string>(LANDING_DEMO_SITUATION_KEYS);
const OWNER_ALL = new Set<string>(CREDENTIAL_SITUATION_KEYS);

export function mayAnnounceSituation(
  surface: CredentialSurface,
  key: CredentialSituationKey,
): boolean {
  if (surface === "public") {
    if (key === "al-dia") return false;
    return PUBLIC_SAFE.has(key);
  }
  if (surface === "landing") return LANDING_DEMO.has(key);
  return OWNER_ALL.has(key);
}

/**
 * What the right-hand cell of the identity row is. One rule for every painter.
 *
 * - `none` — deceased. No mount at all; the name stays centred in the row.
 * - `ping` — lost, and the last location is disclosed AND there is a coordinate.
 *   A disclosed flag with no point is not a ping.
 * - `qr` — everything else, including an open Tier 2. The "Nivel 2 · Datos
 *   médicos" plaque is a chip beside the situation pill, never this cell.
 *
 * Lost-with-a-point wins over Tier 2: the finder is already on the page, and
 * the ping is the cell that was built for that state. Tier 2 still shows its chip.
 */
export const CREDENTIAL_RIGHT_CELLS = ["qr", "ping", "none"] as const;
export type CredentialRightCell = (typeof CREDENTIAL_RIGHT_CELLS)[number];

/**
 * A last-seen coordinate pair, as the callers hold it: numbers from a parsed
 * point, or numeric-column strings from a raw row. Null/undefined = none.
 */
export type CredentialLastLocation = {
  lat: number | string | null | undefined;
  lng: number | string | null | undefined;
};

function isFiniteCoordinate(value: number | string | null | undefined): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  // `Number("")` is 0 — a blank column must not read as the equator.
  if (typeof value === "string") return value.trim() !== "" && Number.isFinite(Number(value));
  return false;
}

/** True only when BOTH coordinates are present and finite. */
export function hasCredentialPoint(point: CredentialLastLocation | null | undefined): boolean {
  return point != null && isFiniteCoordinate(point.lat) && isFiniteCoordinate(point.lng);
}

export function resolveCredentialRightCell(input: {
  status: string | null;
  discloseLastLocation: boolean;
  /** The last-seen point; the finite check lives here, once, for every caller. */
  lastLocation: CredentialLastLocation | null | undefined;
}): CredentialRightCell {
  if (input.status === "deceased") return "none";
  if (
    input.status === "lost" &&
    input.discloseLastLocation &&
    hasCredentialPoint(input.lastLocation)
  ) {
    return "ping";
  }
  return "qr";
}

export function layoutVersionSupported(version: number): boolean {
  return version === CREDENTIAL_DOCUMENT_LAYOUT_VERSION;
}

// ---------------------------------------------------------------------------
// Slot tree — what a painter receives. No motion, no CTAs, no compliance grid.
// ---------------------------------------------------------------------------

export type CredentialIdentitySlots = {
  name: string;
  /** DIM-XXXX-XXXX, or a masked placeholder when integrity is demo without a pet. */
  publicToken: string;
  photoUrl: string | null;
  /** Absolute URL the QR encodes. Null when the QR must be inert. */
  qrUrl: string | null;
  breedLine: string | null;
  /** "Registrado/a" — owner/libreta. Null when a situation chip is the headline. */
  registrationBadge: string | null;
};

export type CredentialLibretaRowSlot = {
  what: string;
  who: string;
  stamp: string | null;
};

export type CredentialDocumentSlotsV1 = {
  layoutVersion: typeof CREDENTIAL_DOCUMENT_LAYOUT_VERSION;
  surface: CredentialSurface;
  variant: CredentialVariant;
  face: CredentialFace;
  integrity: CredentialIntegrity;
  chrome: CredentialChromeRecipe;
  identity: CredentialIdentitySlots;
  fields: readonly CredentialFieldSlot[];
  /**
   * Landing-only contextual line ("PERDIDA · Llamar al dueño"). Null elsewhere.
   * The public/owner situation TEXT lives on the chrome chip, not here.
   */
  contextLine: { stateWord: string; row: string } | null;
  /** Landing carnet machine-readable strip. Null on public and owner. */
  mrz: readonly [string, string] | null;
  situation: CredentialSituationSlot | null;
  back: { rows: readonly CredentialLibretaRowSlot[] } | null;
};

export function emptyCredentialDocumentSlots(
  surface: CredentialSurface,
): CredentialDocumentSlotsV1 {
  const variant = CREDENTIAL_VARIANT_FOR_SURFACE[surface];
  return {
    layoutVersion: CREDENTIAL_DOCUMENT_LAYOUT_VERSION,
    surface,
    variant,
    face: "credencial",
    integrity: "demo",
    chrome: CREDENTIAL_CHROME[variant],
    identity: {
      name: "",
      publicToken: "",
      photoUrl: null,
      qrUrl: null,
      breedLine: null,
      registrationBadge: null,
    },
    fields: [],
    contextLine: null,
    mrz: null,
    situation: null,
    back: variant === "publicSheet" ? null : { rows: [] },
  };
}
