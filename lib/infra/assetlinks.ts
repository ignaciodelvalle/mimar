// Android Digital Asset Links — the document that lets an installed miMAR app
// open `https://www.mimar.com.ar/p/{token}` itself instead of handing it to
// Chrome.
//
// WHAT THE FILE IS FOR
// ---------------------------------------------------------------------------
// A verified App Link is a two-sided claim. The APK declares an intent filter
// with `autoVerify` for the host; the host publishes
// `/.well-known/assetlinks.json` naming the app's package and the SHA-256
// fingerprint of the certificate it is signed with. Android fetches the file
// at install time and compares. Both halves must agree or the association
// simply does not happen — and the failure mode is the dangerous one: no error,
// no warning, the link just opens in the browser as if the app were not there.
//
// WHY IT IS GENERATED AND NOT A STATIC FILE IN public/
// ---------------------------------------------------------------------------
// Under Play App Signing the signing key is GOOGLE'S, not ours: the fingerprint
// only exists after the app has been uploaded to a Play console, and it differs
// per track and per environment (an internal-testing build signed with the
// upload key is a DIFFERENT fingerprint from the production one). A file
// committed to `public/` would be one hard-coded value shipped to every
// environment, and rotating it would be a code change.
//
// So the value comes from `ANDROID_APP_FINGERPRINT` and this module turns it
// into the document. The environment that has an app publishes the association;
// the ones that do not, do not — see `assetlinksDocument` returning `null`.
//
// WHY ABSENT IS A 404 AND MALFORMED IS NOT
// ---------------------------------------------------------------------------
// Two different situations that must not be conflated:
//
//   • NO fingerprint configured. That is the state of the world today: there is
//     no Play console — the EAS account exists as of 2026-08-26, Play is a
//     separate enrolment and is still absent — and therefore no signing
//     fingerprint to publish. The honest answer is 404 — "there is no
//     association here" — which is exactly what Android's verifier expects from
//     a host that has not claimed an app. Serving an empty array instead would
//     be a claim that we HAVE checked and there is no app, which is a different
//     and false statement.
//
//   • A fingerprint configured but MALFORMED. That is a deployment bug, and a
//     404 would bury it: someone would set the variable, see the file "not
//     there", and conclude the route is broken. Worse, publishing a wrong
//     fingerprint is actively harmful — Android caches the failed verification
//     and the app's links stay unverified until the app is reinstalled. So a
//     malformed value refuses loudly (the caller answers 500) instead of
//     quietly degrading to the absent case.
//
// The package name comes from `@dim/contract/links`, the same constant
// `apps/mobile/app.config.ts` builds the APK with. One character of drift here
// silently un-verifies every link in the product.

import { ANDROID_PACKAGE_NAME } from "@dim/contract/links";

/**
 * The relation being delegated.
 *
 * `handle_all_urls` is the one Android's App Links verifier looks for; it means
 * "this app may act as me for every URL on this host". It is the whole point of
 * the file and there is no narrower relation that would work — the scoping is
 * done by the intent filter's `pathPrefix` on the app side, not here.
 */
export const HANDLE_ALL_URLS = "delegate_permission/common.handle_all_urls";

/** One statement of the Digital Asset Links document. */
export type AssetLinkStatement = {
  readonly relation: readonly string[];
  readonly target: {
    readonly namespace: "android_app";
    readonly package_name: string;
    readonly sha256_cert_fingerprints: readonly string[];
  };
};

/**
 * A SHA-256 certificate fingerprint as `keytool` and the Play console print it:
 * 32 bytes, uppercase hex, colon-separated. Anchored — a value with anything
 * before or after it is not "close enough", it is a different string that
 * Android will compare byte for byte and reject.
 */
const FINGERPRINT_RE = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/;

export class MalformedFingerprintError extends Error {
  constructor(
    readonly offending: string,
    readonly reason: string,
  ) {
    super(`ANDROID_APP_FINGERPRINT is set but unusable: ${reason}`);
    this.name = "MalformedFingerprintError";
  }
}

/**
 * Parse the environment variable into the fingerprints to publish.
 *
 * Accepts several, comma- or whitespace-separated, because a real Play setup
 * routinely has two: the app-signing certificate Google holds and the upload
 * certificate used for internal-testing builds. A device running either one has
 * to verify, so both belong in the document.
 *
 * Returns `[]` for an absent or blank value — the caller's 404 case. Note that
 * a variable DEFINED BUT EMPTY lands here too, and deliberately: this repo has
 * already shipped a QR encoding a host-less relative URL because `??` treated
 * an empty string as a real value.
 */
export function parseFingerprints(raw: string | undefined): string[] {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return [];

  const parts = trimmed
    .split(/[\s,]+/)
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part !== "");

  for (const part of parts) {
    if (!FINGERPRINT_RE.test(part)) {
      throw new MalformedFingerprintError(
        part,
        `"${part}" is not a SHA-256 certificate fingerprint (expected 32 colon-separated hex bytes, as keytool prints them)`,
      );
    }
  }

  // Two identical entries would publish the same claim twice. Harmless to
  // Android, but it means somebody pasted the same value into both slots
  // believing they had configured two keys.
  return [...new Set(parts)];
}

/**
 * The document to serve, or `null` when no fingerprint is configured.
 *
 * Throws `MalformedFingerprintError` when one IS configured and cannot be used
 * — see the header for why those two are not the same answer.
 */
export function assetlinksDocument(raw: string | undefined): AssetLinkStatement[] | null {
  const fingerprints = parseFingerprints(raw);
  if (fingerprints.length === 0) return null;

  return [
    {
      relation: [HANDLE_ALL_URLS],
      target: {
        namespace: "android_app",
        package_name: ANDROID_PACKAGE_NAME,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];
}
