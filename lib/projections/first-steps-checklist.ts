// first-steps-checklist.ts — "Primeros pasos" owner-onboarding projection.
//
// Pure derivation: (pet fields/ledger signals, dismissed keys) → pending
// checklist rows. No DB, no React — unit-tested in isolation, consumed by the
// pet profile RSC (page.tsx) and rendered by
// components/pet-profile/FirstStepsChecklist.tsx.
//
// SCOPE BOUNDARY vs Cumplimiento (ComplianceObligationsPanel): compliance
// covers LEGAL obligations (rabies, sterilization, microchip-when-required,
// PPP attestation) — a permanent state panel that never disappears while an
// obligation is outstanding. This checklist covers SETUP tasks that are
// never a legal obligation on their own (a photo, an emergency contact, the
// lost-mode disclosure choice) — it is onboarding, not compliance, and once
// a pet is set up the section vanishes entirely. The one item that overlaps
// vocabulary with compliance is "microchip", but here it means "the owner
// recorded ANY identifier for glanceability", independent of whether the
// jurisdiction legally requires one — the two panels can disagree without
// contradicting each other (compliance is authoritative on the LEGAL
// question; this one is authoritative on nothing, it just nudges).
//
// VISIBILITY MODEL: a row shows ONLY while it is neither done nor dismissed.
// A done row (derived live from the pet's own data) drops off exactly like a
// dismissed one — this is a remaining-work list, not a checkbox list with
// permanent checkmarks (same posture as FutureLedgerList's "Próximo"
// section). The whole section renders only when the returned array is
// non-empty; the caller is expected to render nothing otherwise.

export type FirstStepKey =
  | "photo"
  | "microchip"
  | "vaccines"
  | "emergency_contact"
  | "disclosure_prefs";

export const FIRST_STEP_KEYS: readonly FirstStepKey[] = [
  "disclosure_prefs",
  "photo",
  "microchip",
  "vaccines",
  "emergency_contact",
] as const;

export type FirstStepItem = {
  key: FirstStepKey;
  label: string;
  /** Where the "Hacerlo" link sends the owner — always a sheet on this pet's profile. */
  actionHref: string;
  actionLabel: string;
  /**
   * STAR item (PO decision): decide lost-disclosure prefs BEFORE a crisis,
   * so they're already set when the pet actually goes missing. Rendered
   * first and visually distinguished by the component.
   */
  star?: boolean;
};

export type FirstStepsChecklistInput = {
  petPublicToken: string;
  hasPhoto: boolean;
  hasMicrochip: boolean;
  /** At least one vaccination_administered event exists in the pet's ledger. */
  hasVaccineRecorded: boolean;
  /** resolveEmergencyContacts(...).emergency !== null (pet OR account level). */
  hasEmergencyContact: boolean;
  /**
   * Best-effort "has the owner looked at this" signal: true when the pet's
   * disclose_*_when_lost columns differ from the DB defaults (true, true,
   * false, true, true) — i.e. the owner changed at least one toggle from
   * what every newly-created pet starts with. There is no dedicated
   * "reviewed" flag (a UI preference, not a ledger event per the project's
   * append-only-events invariant), so an owner who deliberately KEEPS every
   * default will keep seeing this nudge until they dismiss it or the
   * checklist gains a real reviewed marker. Documented limitation, not a bug.
   */
  disclosurePrefsDecided: boolean;
  /** pets.dismissedFirstSteps — step keys the owner explicitly chose "Omitir" for. */
  dismissedKeys: readonly string[];
};

function buildCandidates(
  input: FirstStepsChecklistInput,
): Array<FirstStepItem & { done: boolean }> {
  const sheetHref = (sheet: string) => `/mis-mascotas/${input.petPublicToken}?sheet=${sheet}`;

  return [
    {
      key: "disclosure_prefs",
      label: "Decidí qué se muestra si se pierde",
      actionHref: sheetHref("privacidad"),
      actionLabel: "Revisar",
      star: true,
      done: input.disclosurePrefsDecided,
    },
    {
      key: "photo",
      label: "Agregá una foto",
      actionHref: sheetHref("editar-mascota"),
      actionLabel: "Agregar",
      done: input.hasPhoto,
    },
    {
      key: "microchip",
      label: "Cargá el microchip",
      actionHref: sheetHref("editar-mascota"),
      actionLabel: "Cargar",
      done: input.hasMicrochip,
    },
    {
      key: "vaccines",
      label: "Registrá su primera vacuna",
      actionHref: sheetHref("vacuna"),
      actionLabel: "Registrar",
      done: input.hasVaccineRecorded,
    },
    {
      key: "emergency_contact",
      label: "Sumá un contacto de emergencia",
      actionHref: sheetHref("emergencia"),
      actionLabel: "Completar",
      done: input.hasEmergencyContact,
    },
  ];
}

/**
 * Returns the PENDING rows only (not done, not dismissed), in fixed priority
 * order (disclosure_prefs first). Empty array → caller renders no section.
 */
export function deriveFirstStepsChecklist(input: FirstStepsChecklistInput): FirstStepItem[] {
  const dismissed = new Set(input.dismissedKeys);
  return buildCandidates(input)
    .filter((item) => !item.done && !dismissed.has(item.key))
    .map(({ done: _done, ...rest }) => rest);
}

/** DB defaults every newly-created pet starts with (schema.ts, `pets` table). */
export const DISCLOSURE_PREF_DEFAULTS = {
  discloseFirstNameWhenLost: true,
  disclosePhoneWhenLost: true,
  discloseEmailWhenLost: false,
  discloseLastLocationWhenLost: true,
  allowFinderFormWhenLost: true,
} as const;

/** See `disclosurePrefsDecided` doc above. */
export function hasReviewedDisclosurePrefs(pet: {
  discloseFirstNameWhenLost: boolean;
  disclosePhoneWhenLost: boolean;
  discloseEmailWhenLost: boolean;
  discloseLastLocationWhenLost: boolean;
  allowFinderFormWhenLost: boolean;
}): boolean {
  return (
    Object.keys(DISCLOSURE_PREF_DEFAULTS) as Array<keyof typeof DISCLOSURE_PREF_DEFAULTS>
  ).some((key) => pet[key] !== DISCLOSURE_PREF_DEFAULTS[key]);
}
