// The legal-document versions a signup can accept — shared by the web and the
// native app, because each of them DISPLAYS a consent sentence and each must be
// able to say which one it displayed.
//
// Ley 25.326 art. 5 requires consent to be informed, express AND PROVABLE: to
// show WHAT somebody agreed to, `profiles.tos_version` records the version of
// the Terms + Privacy Policy whose sentence they ticked. One shared string
// covers both documents; they change together (same "Última actualización").
// Format: ISO date of the last substantive revision.
//
// WHY THIS LIVES IN THE CONTRACT (review of 1c1ac9f82, 2026-09-24). The server
// used to stamp its OWN current version on every acceptance. That is only true
// for a client that renders what the server renders. The Android app ships its
// consent sentence inside a bundle, and an old bundle keeps showing the old
// sentence after the server moves on — so the server was recording, for those
// people, a text they never saw. Now the client SENDS the version it displayed
// (`legalVersion` on the signup body), and the server records it only if it is
// one of `KNOWN_LEGAL_VERSIONS`. A client that sends nothing is, by definition,
// a client built before it knew to — it showed `PREVIOUS_LEGAL_VERSION`.
//
// Bumping: add the new date to `KNOWN_LEGAL_VERSIONS`, move `LEGAL_VERSION`,
// and set `PREVIOUS_LEGAL_VERSION` to the version bundles WITHOUT a
// `legalVersion` field displayed — which stays "2026-07-23" forever, because
// every bundle from 2026-09-24 onward sends the field. Re-acceptance of a newer
// version by an existing account is a separate feature that does not exist.
//
// HISTORY
//   2026-07-23 — first recorded version.
//   2026-09-24 — /privacidad names every provider that processes data, with its
//                country, and discloses the international transfer (Brazil,
//                US) under Ley 25.326 art. 12; the signup sentence consents to
//                that transfer by name (finding S-2, PO decision 6A).

/** Every version a consent may be recorded under, oldest first. */
export const KNOWN_LEGAL_VERSIONS = ["2026-07-23", "2026-09-24"] as const;

export type LegalVersion = (typeof KNOWN_LEGAL_VERSIONS)[number];

/** The version the current consent sentence and legal pages carry. */
export const LEGAL_VERSION: LegalVersion = "2026-09-24";

/** Human-facing label for the legal pages. Bumped together with the version. */
export const LEGAL_VERSION_LABEL = "septiembre 2026";

/**
 * What a client that sends NO version displayed: every signup surface built
 * before `legalVersion` existed showed the 2026-07-23 sentence.
 */
export const PREVIOUS_LEGAL_VERSION: LegalVersion = "2026-07-23";

/**
 * The version to RECORD for what a client claims it displayed. A known version
 * is taken as sent; anything else — absent, empty, malformed, or a date this
 * build does not know — falls back to `PREVIOUS_LEGAL_VERSION`. The fallback
 * is the conservative one on purpose: under-claiming what somebody consented
 * to is a gap that can be closed by asking again; over-claiming is a record
 * that asserts a consent that was never given.
 */
export function resolveAcceptedLegalVersion(sent: unknown): LegalVersion {
  return typeof sent === "string" && (KNOWN_LEGAL_VERSIONS as readonly string[]).includes(sent)
    ? (sent as LegalVersion)
    : PREVIOUS_LEGAL_VERSION;
}
