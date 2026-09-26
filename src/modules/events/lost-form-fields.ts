// Lost-report form parsing (disclosure prefs + enriched description) for the
// lifecycle actions in ./actions.ts. Moved out of the "use server" module,
// unchanged, to keep it under the file-size ceiling; not a server action.

import { checkboxOn } from "@/lib/ui/form-checkbox";

import type {
  DisclosurePrefsInput,
  EnrichedLostDescriptionInput,
} from "./application/lifecycle/set-pet-lost-use-case";

// ---------------------------------------------------------------------------
// Disclosure prefs + enriched description form helpers (lifecycle)
// ---------------------------------------------------------------------------

export function parseDisclosurePrefsFromForm(formData: FormData): DisclosurePrefsInput {
  const checked = (name: string) => checkboxOn(formData, name);
  const hasSection = [
    "disclose_first_name_when_lost",
    "disclose_phone_when_lost",
    "disclose_email_when_lost",
    "disclose_last_location_when_lost",
    "allow_finder_form_when_lost",
  ].some((key) => formData.has(key));

  // cursor privacy P4: fail CLOSED. A caller that omits the disclosure section
  // entirely used to inherit the pet's current (possibly permissive) prefs via
  // a `petDefaults` fallback — but the only real caller (MarkLostWizard) always
  // submits all five fields explicitly via hidden inputs, so "section absent"
  // means no consent was expressed, not "keep whatever was there before".
  // Every toggle defaults to false rather than silently republishing PII.
  if (!hasSection) {
    return {
      discloseFirstNameWhenLost: false,
      disclosePhoneWhenLost: false,
      discloseEmailWhenLost: false,
      discloseLastLocationWhenLost: false,
      allowFinderFormWhenLost: false,
    };
  }

  return {
    discloseFirstNameWhenLost: checked("disclose_first_name_when_lost"),
    disclosePhoneWhenLost: checked("disclose_phone_when_lost"),
    discloseEmailWhenLost: checked("disclose_email_when_lost"),
    discloseLastLocationWhenLost: checked("disclose_last_location_when_lost"),
    allowFinderFormWhenLost: checked("allow_finder_form_when_lost"),
  };
}

export function parseEnrichedDescriptionFromForm(
  formData: FormData,
): EnrichedLostDescriptionInput | null {
  const enrichedKeys = [
    "enriched_color",
    "enriched_distinguishing_features",
    "enriched_accessories_when_lost",
    "enriched_behavior_notes",
    "enriched_last_seen_context",
    "enriched_microchip_id",
    "enriched_tattoo_code",
    "enriched_tattoo_location",
    "enriched_tattoo_description",
  ];

  const hasSection = enrichedKeys.some((k) => formData.has(k));
  if (!hasSection) return null;

  const str = (key: string) => String(formData.get(key) ?? "").trim() || null;

  return {
    color: str("enriched_color"),
    distinguishingFeatures: str("enriched_distinguishing_features"),
    accessoriesWhenLost: str("enriched_accessories_when_lost"),
    behaviorNotes: str("enriched_behavior_notes"),
    lastSeenContext: str("enriched_last_seen_context"),
    microchipId: str("enriched_microchip_id"),
    tattooCode: str("enriched_tattoo_code"),
    tattooLocation: str("enriched_tattoo_location"),
    tattooDescription: str("enriched_tattoo_description"),
  };
}
