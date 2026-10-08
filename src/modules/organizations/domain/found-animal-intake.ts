// "Recibimos animales encontrados" — an organization's opt-in to the finder's
// plan-B list (migration 0292, P4; design note
// docs/superpowers/specs/2026-10-p4-receptoras-cercanas.md).
//
// The pure half: which org types have the setting, its vocabulary, the
// validation the use case and the form share, and the one link a published
// contact turns into. The SQL half — who is LISTED — is
// src/modules/organizations/infrastructure/found-animal-help-read.ts, pinned
// against `isListedReceiver` below by its test.
//
// ZERO server imports: the settings card ("use client") reads this file.

/** Org types that may say they receive found animals. Not `other`. */
export const FOUND_ANIMAL_INTAKE_ORG_TYPES: ReadonlySet<string> = new Set([
  "shelter",
  "rescue_network",
  "clinic",
  // A municipal zoonosis or animal-welfare service is exactly the "municipal
  // channel" the empty state falls back on (design note §4, D7).
  "sanitary_authority",
]);

/** Whether an org of this type gets the "Animales encontrados" setting. */
export function canReceiveFoundAnimals(orgType: string): boolean {
  return FOUND_ANIMAL_INTAKE_ORG_TYPES.has(orgType);
}

/**
 * Whether an organization appears on a finder's list. The switch alone is not
 * enough: verification is what lets a stranger trust the name, and a suspended
 * or dissolved org leaves every public surface at once.
 */
export function isListedReceiver(org: {
  orgType: string;
  verified: boolean;
  status: string;
  accepting: boolean;
}): boolean {
  return (
    org.accepting && org.verified && org.status === "active" && canReceiveFoundAnimals(org.orgType)
  );
}

// ---------------------------------------------------------------------------
// Capacity status
// ---------------------------------------------------------------------------

export const INTAKE_CAPACITY_STATUSES = ["recibimos", "consultar", "sin_lugar"] as const;
export type IntakeCapacityStatus = (typeof INTAKE_CAPACITY_STATUSES)[number];

export const INTAKE_CAPACITY_LABELS: Readonly<Record<IntakeCapacityStatus, string>> = {
  recibimos: "Recibimos",
  consultar: "Consultar antes",
  sin_lugar: "Sin lugar por ahora",
};

/**
 * How long a "Recibimos" stays true without an admin saving the card again.
 * Past it the PUBLIC list shows "Consultar antes" — a stale "we have room" is
 * how a finder arrives with an animal at a full shelter — and the settings
 * card reminds the admin. The other two statuses never go stale: both already
 * tell the finder to ask first.
 */
export const INTAKE_CONFIRMATION_DAYS = 30;

/** The status a finder sees, given whether the org confirmed it recently. */
export function publicCapacityStatus(
  status: IntakeCapacityStatus,
  confirmationExpired: boolean,
): IntakeCapacityStatus {
  return status === "recibimos" && confirmationExpired ? "consultar" : status;
}

export function isIntakeCapacityStatus(value: string): value is IntakeCapacityStatus {
  return (INTAKE_CAPACITY_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Published contact
// ---------------------------------------------------------------------------

export const INTAKE_CONTACT_KINDS = ["telefono", "whatsapp", "email", "web"] as const;
export type IntakeContactKind = (typeof INTAKE_CONTACT_KINDS)[number];

export const INTAKE_CONTACT_KIND_LABELS: Readonly<Record<IntakeContactKind, string>> = {
  telefono: "Teléfono",
  whatsapp: "WhatsApp",
  email: "Correo electrónico",
  web: "Sitio web o formulario",
};

export function isIntakeContactKind(value: string): value is IntakeContactKind {
  return (INTAKE_CONTACT_KINDS as readonly string[]).includes(value);
}

/** Column bounds, the same numbers as migration 0292's CHECKs. */
export const INTAKE_CONTACT_MIN = 3;
export const INTAKE_CONTACT_MAX = 200;
export const INTAKE_HOURS_MAX = 120;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https:\/\/[^\s.]+\.[^\s]{2,}$/;
const PHONE_RE = /^\+?[0-9][0-9 ()-]{5,}$/;
/**
 * Seven or more digits in a row (spaces, dots, dashes and parentheses
 * between them allowed): a phone number typed into the free-text hours, which
 * are published as-is. "10 a 17", "9:30 a 13" and "lun-vie" pass.
 */
const PHONE_LIKE_RUN = /\d(?:[\s().-]*\d){6,}/;

export type FoundAnimalIntakeSettings = {
  accepting: boolean;
  capacityStatus: IntakeCapacityStatus;
  publicContactKind: IntakeContactKind | null;
  publicContactValue: string | null;
  publicHours: string | null;
};

/** An org that never saved the card: off, and nothing published. */
export const FOUND_ANIMAL_INTAKE_OFF: FoundAnimalIntakeSettings = {
  accepting: false,
  capacityStatus: "recibimos",
  publicContactKind: null,
  publicContactValue: null,
  publicHours: null,
};

export type FoundAnimalIntakeInput = {
  accepting: boolean;
  capacityStatus: string;
  publicContactKind: string | null;
  publicContactValue: string | null;
  publicHours: string | null;
};

/**
 * Validates and normalizes the settings form. A contact is both halves or
 * neither: a kind with no value, or a value with no kind, is refused rather
 * than half-stored.
 */
export function validateFoundAnimalIntake(
  input: FoundAnimalIntakeInput,
): { ok: true; value: FoundAnimalIntakeSettings } | { ok: false; error: string } {
  if (!isIntakeCapacityStatus(input.capacityStatus)) {
    return { ok: false, error: "Elegí cómo está la capacidad de recepción." };
  }
  const kindRaw = input.publicContactKind?.trim() || null;
  const value = input.publicContactValue?.trim() || null;
  const hours = input.publicHours?.trim() || null;

  if (kindRaw !== null && !isIntakeContactKind(kindRaw)) {
    return { ok: false, error: "El tipo de contacto no es válido." };
  }
  const kind = kindRaw as IntakeContactKind | null;
  if ((kind === null) !== (value === null)) {
    return {
      ok: false,
      error: "Para publicar un contacto, elegí el tipo y completá el dato (o dejá los dos vacíos).",
    };
  }
  if (kind !== null && value !== null) {
    if (value.length < INTAKE_CONTACT_MIN || value.length > INTAKE_CONTACT_MAX) {
      return {
        ok: false,
        error: `El contacto debe tener entre ${INTAKE_CONTACT_MIN} y ${INTAKE_CONTACT_MAX} caracteres.`,
      };
    }
    if ((kind === "telefono" || kind === "whatsapp") && !PHONE_RE.test(value)) {
      return { ok: false, error: "El teléfono solo puede tener números, espacios, guiones y +." };
    }
    if (kind === "email" && !EMAIL_RE.test(value)) {
      return { ok: false, error: "El correo electrónico es inválido." };
    }
    if (kind === "web" && !URL_RE.test(value)) {
      return { ok: false, error: "El sitio web debe empezar con https://." };
    }
  }
  if (hours !== null && PHONE_LIKE_RUN.test(hours)) {
    return {
      ok: false,
      error:
        "Los horarios no pueden incluir un número de teléfono. Si querés publicar uno, usá el contacto público.",
    };
  }
  if (hours !== null && hours.length > INTAKE_HOURS_MAX) {
    return {
      ok: false,
      error: `Los horarios no pueden tener más de ${INTAKE_HOURS_MAX} caracteres.`,
    };
  }
  return {
    ok: true,
    value: {
      accepting: input.accepting,
      capacityStatus: input.capacityStatus,
      publicContactKind: kind,
      publicContactValue: value,
      publicHours: hours,
    },
  };
}

/**
 * The link a published contact becomes, or null when the value cannot be one
 * (a row stored before a validation rule tightened is shown as text, never
 * turned into a link it was not checked to be).
 */
export function intakeContactHref(kind: IntakeContactKind, value: string): string | null {
  switch (kind) {
    case "telefono":
      return PHONE_RE.test(value) ? `tel:${value.replace(/[^0-9+]/g, "")}` : null;
    case "whatsapp": {
      if (!PHONE_RE.test(value)) return null;
      return `https://wa.me/${value.replace(/[^0-9]/g, "")}`;
    }
    case "email":
      return EMAIL_RE.test(value) ? `mailto:${value}` : null;
    case "web":
      return URL_RE.test(value) ? value : null;
  }
}

/** How an organization's type reads on the finder's list. */
export const FOUND_HELP_ORG_TYPE_LABELS: Readonly<Record<string, string>> = {
  shelter: "Refugio",
  rescue_network: "Red de rescate",
  clinic: "Veterinaria",
  sanitary_authority: "Servicio municipal",
};
