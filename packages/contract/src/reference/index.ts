// `@dim/contract/reference` — the static catalogs a client renders offline.
//
// TYPE-ONLY plus frozen data and pure lookups: no zod, no runtime dependency at
// all. A native app that only needs to draw a breed picker on a subway platform
// imports this and loads nothing else.
//
// What belongs here: a list whose CONTENT is the same everywhere and whose
// staleness is measured in months (breed catalogs, the PPP set). What does NOT:
// anything the server must resolve per request or per jurisdiction — locality
// search (a database), PPP classification for a province (business rules), breed
// matching (the write-side authority, `lib/domain/breed-validation.ts`). A
// catalog a client can render is not a decision a client may make.
export {
  DISEASES,
  type DiseaseDef,
  type DiseaseSpecies,
  diseasesForSpecies,
  findDisease,
  isReportable,
} from "./diseases.ts";
export {
  ALL_BREEDS,
  CAT_BREEDS,
  DOG_BREEDS,
  GUINEA_PIG_BREEDS,
  POTENTIALLY_DANGEROUS_DOG_BREEDS,
  RABBIT_BREEDS,
  SPECIAL_BREED_OPTIONS,
  breedsForSpecies,
} from "./breeds.ts";
export {
  KNOWN_LEGAL_VERSIONS,
  LEGAL_VERSION,
  LEGAL_VERSION_LABEL,
  type LegalVersion,
  PREVIOUS_LEGAL_VERSION,
  resolveAcceptedLegalVersion,
} from "./legal-version.ts";
export {
  type DescribableLocality,
  LOCALITY_FIELD_LABEL,
  LOCALITY_FIELD_PLACEHOLDER,
  chosenLocalityName,
  chosenLocalityParent,
  describeChosenLocality,
  homeLocalityChipLabel,
  homeLocalityChipName,
  homeLocalityChipReason,
  localityOptionLabel,
} from "./locality-copy.ts";
export { detectContactInfoInFreeText } from "./contact-in-free-text.ts";
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
} from "./permanent-conditions.ts";
export { type PetAge, estimatedBirthDateFromAge, petAgeFromBirthDate } from "./pet-age.ts";
export {
  COMMON_ALLERGIES,
  COMMON_FOODS,
  INSURANCE_COMPANIES,
  TRAINING_LEVELS,
  TRAINING_LEVEL_VALUES,
  type TrainingLevel,
} from "./pet-profile-options.ts";
export {
  type DerivedPetAction,
  type DerivedPetActionGroup,
  type DerivedPetActions,
  FOSTER_FIND_HOME_COPY,
  PET_ACTION_COPY,
  PET_ACTION_GROUP_IDS,
  PET_ACTION_GROUPS,
  PET_ACTION_IDS,
  PET_ACTION_INERT_CAPTIONS,
  PET_ACTION_INERT_REASONS,
  PET_ACTION_PRIMARY_ROW,
  type PetActionContext,
  type PetActionCopy,
  type PetActionGroupDef,
  type PetActionGroupId,
  type PetActionId,
  type PetActionInertReason,
  type PetActionState,
  derivePetActions,
  findPetAction,
} from "./pet-actions.ts";
export { pluralizeEs } from "./pluralize-es.ts";
export { PROVINCES, type ReferenceProvince } from "./provinces.ts";
export {
  PROFILE_FIELD_LABELS,
  SUBJECT_RIGHTS_FALLBACK_LABEL,
  SUBJECT_RIGHTS_SECTION_LABELS,
  describeProfileFields,
  formatSubjectRightsDate,
  subjectRightsSections,
  summarizeSubjectRightsValue,
  type SubjectRightsFieldKind,
  type SubjectRightsFieldMeta,
  type SubjectRightsFieldRow,
  type SubjectRightsSection,
  type SubjectRightsSectionMeta,
} from "./subject-rights-sections.ts";
