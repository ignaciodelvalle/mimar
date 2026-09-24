// Pure-logic helpers for the /asistencia/presentar presentation page.
//
// Extracted so the eligibility guard and URL construction can be tested
// without a Next.js runtime. The page imports from here.
// lib/service-dog-presentar.test.ts guards this contract.

import type { ServiceDogStatus } from "@/db/schema";
import { credentialQrUrl } from "@/lib/infra/site-url";

interface PresentableCheck {
  credentialStatus: ServiceDogStatus;
  inService: boolean;
}

/**
 * Returns true when the service dog credential is eligible to be shown
 * on the full-screen presentation page.
 *
 * The page is meaningless without a vigente, in-service credential — if
 * this returns false the route redirects to /asistencia.
 */
export function isCredentialPresentable(row: PresentableCheck | null): boolean {
  if (!row) return false;
  return row.credentialStatus === "vigente" && row.inService;
}

/**
 * Builds the URL for the public credential page that the QR code links to.
 * Used as the QR payload on the presentation page.
 *
 * Always ABSOLUTE via credentialQrUrl (same helper as the main credential QR):
 * a relative `/p/{token}` payload is unresolvable by a phone camera — the same
 * unscannable-QR bug lib/infra/site-url.ts exists to prevent.
 */
export function buildPublicVerifyUrl(publicToken: string): string {
  return credentialQrUrl(publicToken);
}
