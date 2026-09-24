// SHIM — delegates to src/modules/cases/infrastructure/cases-repository and
// src/modules/cases/domain/case-rules. All 14+ importers of @/lib/case-helpers
// continue to work unchanged with identical signatures and behavior.
// Delete this file when all importers are repointed to the module directly.

import { and, eq, inArray, sql } from "drizzle-orm";

import {
  CASCADE_TRIGGER_PAYLOAD_KEY,
  cascadeTriggerPayload,
  isCascadeEvent,
} from "@/src/modules/cases/domain/case-rules";
import { CasesRepository } from "@/src/modules/cases/infrastructure/cases-repository";
import type {
  CloseCaseInput,
  OpenCaseInput,
} from "@/src/modules/cases/infrastructure/cases-repository";

// Re-export types that callers import from this shim
export type { OpenCaseInput, CloseCaseInput };

// The shared repository instance used by the shim layer.
const _repo = new CasesRepository();

// Re-export the pure domain functions (signatures byte-identical)
export { CASCADE_TRIGGER_PAYLOAD_KEY, cascadeTriggerPayload, isCascadeEvent };

// Re-export raw SQL helpers that some callers use directly
export { eq, and, inArray, sql };

// ---------------------------------------------------------------------------
// Function shims — delegate to CasesRepository
// ---------------------------------------------------------------------------

export const generateUniqueCasePublicCode: typeof _repo.generateUniqueCasePublicCode = (...args) =>
  _repo.generateUniqueCasePublicCode(...args);

export const openCase: typeof _repo.openCase = (...args) => _repo.openCase(...args);

export const closeCase: typeof _repo.closeCase = (...args) => _repo.closeCase(...args);

// `closeCase` that says whether THIS caller won the close. Use it wherever the
// close has a non-idempotent side effect — a `case_closed` timeline entry is
// append-only, and the loser of a race must not write a second one.
export const closeCaseOwned: typeof _repo.closeCaseOwned = (...args) =>
  _repo.closeCaseOwned(...args);

export const escalateCase: typeof _repo.escalateCase = (...args) => _repo.escalateCase(...args);

export const reopenCase: typeof _repo.reopenCase = (...args) => _repo.reopenCase(...args);

export const findOpenCasesForPet: typeof _repo.findOpenCasesForPet = (...args) =>
  _repo.findOpenCasesForPet(...args);

export const findOpenCaseForPetAndKind: typeof _repo.findOpenCaseForPetAndKind = (...args) =>
  _repo.findOpenCaseForPetAndKind(...args);

export const findOpenAdoptionApplicationCase: typeof _repo.findOpenAdoptionApplicationCase = (
  ...args
) => _repo.findOpenAdoptionApplicationCase(...args);

export const findOpenAdoptionListingCase: typeof _repo.findOpenAdoptionListingCase = (...args) =>
  _repo.findOpenAdoptionListingCase(...args);
