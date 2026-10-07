// The re-acceptance screen's three boxes → what `POST /api/v1/me/legal-acceptance`
// accepts, judged by the SERVER'S schema (`legalAcceptanceInputSchema`), for
// `signup-input.ts`'s reason: one definition of "valid", not two drifting apart.
//
// THE VERSION SENT IS THE ONE THIS BUNDLE DISPLAYS (`LEGAL_VERSION` from the
// contract package at build time). The server records only its own current
// version and refuses any other with `invalid_request` ("actualizá la app"):
// an old bundle must not record a text it never showed.

import {
  LEGAL_ACCEPTANCE_INPUT_CODES,
  type LegalAcceptanceInput,
  type LegalAcceptanceInputCode,
  firstInputCode,
  legalAcceptanceInputSchema,
} from "@dim/contract/input";
import { LEGAL_VERSION } from "@dim/contract/reference";

import type { LegalConsents } from "./LegalConsentBoxes";

export type LegalAcceptanceVerdict =
  | { ok: true; input: LegalAcceptanceInput }
  | { ok: false; code: LegalAcceptanceInputCode; message: string };

/** es-AR copy for each refusal. Exhaustive: a new code without copy is a compile error. */
export function legalAcceptanceErrorMessage(code: LegalAcceptanceInputCode): string {
  switch (code) {
    case "TOS_NOT_ACCEPTED":
      return "Tenés que aceptar los Términos y la Política de privacidad.";
    case "TRANSFER_NOT_ACCEPTED":
      return "Tenés que aceptar la transferencia de tus datos a Brasil y Estados Unidos para seguir.";
    case "ADULT_NOT_DECLARED":
      return "Para usar una cuenta de miMAR tenés que tener 18 años o más.";
  }
}

export function toLegalAcceptanceInput(consents: LegalConsents): LegalAcceptanceVerdict {
  const parsed = legalAcceptanceInputSchema.safeParse({ ...consents, legalVersion: LEGAL_VERSION });
  if (parsed.success) return { ok: true, input: parsed.data };
  const code = firstInputCode(LEGAL_ACCEPTANCE_INPUT_CODES, parsed.error) ?? "TOS_NOT_ACCEPTED";
  return { ok: false, code, message: legalAcceptanceErrorMessage(code) };
}

/** A convenience for the button, never the authority — see `canSubmitSignup`. */
export function canSubmitLegalAcceptance(consents: LegalConsents): boolean {
  return consents.tosAccepted && consents.transferAccepted && consents.adultDeclared;
}
