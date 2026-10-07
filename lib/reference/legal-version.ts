// The legal-document version constants now live in the contract package
// (`packages/contract/src/reference/legal-version.ts`), because the native app
// must be able to say which consent sentence it DISPLAYED — see the header
// there for why the server stopped stamping its own current version.
//
// This module is kept as the web's import path so the legal pages and the
// server writers do not each learn a second one.
export {
  ADULT_DECLARATION_SENTENCE,
  KNOWN_LEGAL_VERSIONS,
  LEGAL_VERSION,
  LEGAL_VERSION_CHANGES,
  LEGAL_VERSION_LABEL,
  type LegalVersion,
  PREVIOUS_LEGAL_VERSION,
  TRANSFER_CONSENT_NOTICE,
  TRANSFER_CONSENT_SENTENCE,
  legalChangesSince,
  resolveAcceptedLegalVersion,
} from "@dim/contract/reference";
