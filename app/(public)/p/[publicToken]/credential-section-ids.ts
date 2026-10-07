// The anchor ids the public credential's action bar scrolls to.
//
// NOT in CredentialActionBar.tsx, which is "use client": the server page
// renders these ids on its sections, and a server component that imports a
// constant from a client module receives a client REFERENCE, not the string —
// the section's id is then not the one the bar scrolls to.
// __tests__/client-module-value-import-fence.test.ts holds the rule.

/** Scroll target: the Tier-2 medical section wrapper in page.tsx. */
export const MEDICAL_SECTION_ID = "resumen-medico";
/** Anchor id of the "¿Encontraste a esta mascota?" <details> in page.tsx. */
export const REPORT_SECTION_ID = "reportar-hallazgo";
/** Scroll+reveal target: the dispute-tip <details> in page.tsx (disputed pets). */
export const DISPUTE_SECTION_ID = "informacion-disputa";
