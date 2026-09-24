// Pure domain helpers for disclosure preferences.
//
// Extracted from app/actions/events.ts — setPetLostWriter + parseDisclosurePrefsFromForm.
// Zero runtime imports — pure over plain objects.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DisclosurePrefsInput = {
  discloseFirstNameWhenLost: boolean;
  disclosePhoneWhenLost: boolean;
  discloseEmailWhenLost: boolean;
  discloseLastLocationWhenLost: boolean;
  allowFinderFormWhenLost: boolean;
};

export type DisclosurePrefsSnapshot = {
  first_name: boolean;
  phone: boolean;
  email: boolean;
  last_location: boolean;
  finder_form: boolean;
};

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/**
 * Convert the camelCase DisclosurePrefsInput to the snake_case payload shape
 * stored in the status_changed event for historical audit.
 *
 * Pure function — no side effects.
 */
export function parseDisclosurePrefsSnapshot(prefs: DisclosurePrefsInput): DisclosurePrefsSnapshot {
  return {
    first_name: prefs.discloseFirstNameWhenLost,
    phone: prefs.disclosePhoneWhenLost,
    email: prefs.discloseEmailWhenLost,
    last_location: prefs.discloseLastLocationWhenLost,
    finder_form: prefs.allowFinderFormWhenLost,
  };
}
