// emergency-contacts.ts — per-pet override + account-default resolution
// (owner-ia-redesign P2, PO decision 2).
//
// Emergency contacts (preferred vet + emergency contact) exist at two levels:
//   - pet level    — pets.preferred_vet_* / emergency_contact_* (migration 0145)
//   - account level — profiles.preferred_vet_* / emergency_contact_* (migration 0042)
//
// A pet-level value OVERRIDES the account default; an empty/absent pet value
// FALLS BACK to the account. Resolution is done at the PAIR level (name +
// phone together) so a single contact row never mixes this pet's phone with
// the account's name — the "Veterinario" and "Contacto de emergencia" rows
// each come wholesale from one level, honestly labeled ("de tu cuenta" when
// the value fell back to the account default).
//
// Pure — no DB, no React. Unit-tested; also consumed by the pet profile RSC.

export type EmergencyContactSource = "pet" | "account";

/** A resolved contact row, or null when NEITHER level has any value for it. */
export type ResolvedEmergencyPair = {
  name: string | null;
  phone: string | null;
  source: EmergencyContactSource;
} | null;

export type EmergencyContactLevel = {
  preferredVetName: string | null;
  preferredVetPhone: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
};

export type ResolvedEmergencyContacts = {
  vet: ResolvedEmergencyPair;
  emergency: ResolvedEmergencyPair;
};

/** Trim, then treat an empty string as absent (null). */
function clean(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve one contact row: the pet's (name, phone) wins if EITHER is present,
 * otherwise the account's. Returns null when neither level carries a value.
 */
function resolvePair(
  petName: string | null | undefined,
  petPhone: string | null | undefined,
  accountName: string | null | undefined,
  accountPhone: string | null | undefined,
): ResolvedEmergencyPair {
  const pName = clean(petName);
  const pPhone = clean(petPhone);
  if (pName || pPhone) return { name: pName, phone: pPhone, source: "pet" };

  const aName = clean(accountName);
  const aPhone = clean(accountPhone);
  if (aName || aPhone) return { name: aName, phone: aPhone, source: "account" };

  return null;
}

/**
 * Resolve the pet's emergency contacts, overlaying the pet-level override on
 * top of the account default. `pet` values win per-row; missing rows fall back
 * to `account`.
 */
export function resolveEmergencyContacts(
  pet: EmergencyContactLevel,
  account: EmergencyContactLevel,
): ResolvedEmergencyContacts {
  return {
    vet: resolvePair(
      pet.preferredVetName,
      pet.preferredVetPhone,
      account.preferredVetName,
      account.preferredVetPhone,
    ),
    emergency: resolvePair(
      pet.emergencyContactName,
      pet.emergencyContactPhone,
      account.emergencyContactName,
      account.emergencyContactPhone,
    ),
  };
}
