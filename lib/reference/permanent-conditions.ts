// `lib/reference/permanent-conditions` — the permanent-conditions catalog,
// re-exported from the contract.
//
// THE DATA MOVED TO `packages/contract/src/reference/permanent-conditions.ts`
// (owner-pet-actions, 2026-10-01), unchanged, and this file stayed so the web's
// importers — the pet form, the public credential, the adoption payloads, the
// medical view — keep their import path. The precedent is
// `lib/reference/diseases.ts`, which made the same trip for the same reason: the
// app's "Editar datos" draws the same picker, and a picker that cannot name the
// codes the server accepts can only produce a refusal.
export {
  PERMANENT_CONDITIONS,
  PERMANENT_CONDITIONS_SET,
  PERMANENT_CONDITION_GROUPS,
  type PermanentCondition,
  isPermanentCondition,
  permanentConditionGroup,
  permanentConditionLabel,
  permanentConditionShortLabel,
  resolveLostSpecialConditions,
  sanitizeConditionCodes,
} from "@dim/contract/reference";
