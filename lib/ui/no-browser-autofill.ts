// Guardrails to stop the BROWSER's own autofill / form-history / password-manager
// dropdowns from overlaying a catalog-constrained typeahead (the locality
// combobox, the operator omnibox, the address autocomplete). On those inputs the
// ONLY valid options are the ones the system offers — a stray "random" value from
// the browser's saved data is noise (and can be picked by mistake, defeating the
// FK/catalog constraint).
//
// Why the specific attrs:
//  - autoComplete="off"        — asks the browser not to autofill. Unreliable
//                                alone on recognised field names, so we pair it
//                                with the rest below.
//  - autoCorrect / autoCapitalize="off" + spellCheck=false — no mobile
//                                autocorrect mangling a locality name, no red
//                                squiggle on a proper noun.
//  - data-1p-ignore / data-lpignore — tell 1Password / LastPass to skip the field
//                                (their overlay icon + dropdown otherwise cover it).
//  - data-form-type="other"    — Dashlane/others honour this to skip the field.
//
// Spread onto the VISIBLE typeahead input (not the hidden ISO/id inputs).
export const NO_BROWSER_AUTOFILL = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-form-type": "other",
} as const;
