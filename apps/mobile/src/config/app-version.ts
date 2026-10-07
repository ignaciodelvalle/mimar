// The `x-app-version` header every `/api/v1` request carries (2026-10-07;
// security review of textos-legales-v14, finding 1).
//
// WHAT THE SERVER DOES WITH IT. Its PRESENCE tells v14-and-later apart from the
// v13 Android build, which predates the legal re-acceptance circuit and sends
// no such header. An account that owes the acceptance is refused (403
// `legal_acceptance_required`) when the header is present — this app then
// shows its re-acceptance screen — while v13 is let through until
// LEGAL_V13_SUNSET (lib/domain/legal-acceptance.ts → `legalGateVerdict`).
//
// JS-ONLY ON PURPOSE. The value is the app config's `version` read through
// `expo-constants`, already a dependency of this bundle (sentry.ts,
// AboutSection.tsx), so adding the header does not move the native
// fingerprint and can ship in the same build as the screen it protects. The
// value is informational; a build whose config has no version still sends the
// header ("desconocida"), because what matters is that it is there.

import Constants from "expo-constants";

export const APP_VERSION_HEADER = "x-app-version";

export function appVersionHeaderValue(): string {
  const version = Constants.expoConfig?.version;
  return typeof version === "string" && version.trim() !== "" ? version : "desconocida";
}
