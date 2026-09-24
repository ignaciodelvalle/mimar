// Single source of truth for the legal-document versions a user accepts at
// signup. Ley 25.326 art. 5 requires consent to be informed, express, AND
// PROVABLE — to demonstrate WHAT a user agreed to we must record the exact
// version of the Terms + Privacy Policy in force at the moment of acceptance.
//
// Versioning approach (documented decision):
//   - We use ONE shared version string covering BOTH the Terms of Service and
//     the Privacy Policy. In this product the two documents always change
//     together (same "Última actualización" date), so a single field keeps the
//     stored proof unambiguous and avoids drift between two near-identical
//     dates. If the documents ever diverge on their own cadence, split this
//     into TOS_VERSION / PRIVACY_VERSION and add a second profiles column.
//   - Format: ISO date (YYYY-MM-DD) of the last substantive revision. A date is
//     human-auditable in legal/DNPDP contexts and sorts naturally.
//
// When the legal text changes, bump this constant AND the "Última actualización"
// label on app/privacidad + app/terminos. Re-acceptance on policy change (asking
// existing users to accept the new version) is a follow-up feature; for v1 we
// record the version accepted at signup.

export const LEGAL_VERSION = "2026-07-23";

// Human-facing label rendered on the legal pages. Kept next to the machine
// version so they are bumped together.
export const LEGAL_VERSION_LABEL = "julio 2026";
