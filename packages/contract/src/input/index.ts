// `@dim/contract/input` — what a CLIENT is allowed to send.
//
// The rest of the package describes the domain (event vocabulary) and how to
// draw it (visualization scales). This entry point describes the other
// direction: the shape of a write request, before any domain resolution runs.
// It is the reason the package takes its one dependency, zod — see the note in
// scripts/check-contract-purity.ts.
export {
  ADOPTION_APPLICATION_INPUT_CODES,
  ADOPTION_HOUSING_TYPES,
  ADOPTION_MOTIVATION_MIN_LENGTH,
  ADOPTION_PRIOR_PETS,
  ADOPTION_TEXT_MAX_LENGTH,
  type AdoptionApplicationInput,
  type AdoptionApplicationInputCode,
  type AdoptionHousingType,
  type AdoptionPriorPets,
  adoptionApplicationInputSchema,
  firstAdoptionApplicationInputCode,
} from "./adoption-application.ts";
// EXPORTED ON ITS OWN, not only through the two schemas that `.refine()` with
// it. A QUERY STRING carries dates too, and a search floor is a filter rather
// than a field — so `/api/v1/appointments` needs the rule without needing a zod
// schema to hang it on. Its header records the rollover it exists for: a regex
// accepts `2026-02-31`, `new Date` does not throw and is not `NaN`, and the
// value silently becomes 3 March. Exporting it is what keeps the third door from
// writing a fourth copy of the calendar.
export { isRealArDay } from "./ar-calendar-day.ts";
export {
  AMEND_EVENT_INPUT_CODES,
  AMEND_REASON_MIN_LENGTH,
  NON_AMENDABLE_PAYLOAD_KEYS,
  type AmendEventInput,
  type AmendEventInputCode,
  amendEventInputSchema,
  firstAmendEventInputCode,
} from "./amend-event.ts";
export {
  LOGIN_INPUT_CODES,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RESET_REQUEST_INPUT_CODES,
  SIGNUP_INPUT_CODES,
  type LoginInput,
  type LoginInputCode,
  type PasswordResetRequestInput,
  type PasswordResetRequestInputCode,
  type SignupInput,
  type SignupInputCode,
  firstInputCode,
  loginInputSchema,
  passwordResetRequestInputSchema,
  signupInputSchema,
} from "./auth.ts";
// Signup STEP 2, which `./auth.ts` above deliberately does not carry: that module
// is the three GoTrue-shaped acts (login, signup, password reset) and this one
// writes a `profiles` column. Kept apart so a client that only signs in does not
// import the identity rules, and so the two files' codes cannot be confused for
// one vocabulary.
export {
  COMPLETE_IDENTITY_INPUT_CODES,
  IDENTITY_NAME_MAX_LENGTH,
  type CompleteIdentityInput,
  type CompleteIdentityInputCode,
  type IdentityNameField,
  completeIdentityInputSchema,
  firstCompleteIdentityInputCode,
  firstCompleteIdentityIssue,
  identityDisplayName,
} from "./complete-identity.ts";
export {
  CREATE_INTAKE_INPUT_CODES,
  CUSTODY_ROLES,
  type CreateIntakeInput,
  type CreateIntakeInputCode,
  type CustodyRole,
  INTAKE_REASONS,
  type IntakeReason,
  PET_SEXES,
  type PetSex,
  createIntakeInputSchema,
  firstIntakeInputCode,
} from "./intake.ts";
export {
  DISCLOSURE_KEYS,
  LOST_COMMAND_INPUT_CODES,
  LOST_DISCLOSURE_KEYS,
  TITULAR_ONLY_DISCLOSURE_KEYS,
  type DisclosureKey,
  type LostCommand,
  type LostCommandInput,
  type LostCommandInputCode,
  type LostDisclosureKey,
  type TitularOnlyDisclosureKey,
  firstLostCommandInputCode,
  lostCommandInputSchema,
} from "./lost-mode.ts";
export {
  CLAIM_DISPUTE_REASON_MAX_LENGTH,
  CLAIM_DISPUTE_REASON_MIN_LENGTH,
  CLAIM_EVIDENCE_CONTENT_TYPES,
  CLAIM_EVIDENCE_MAX_FILES,
  type ClaimEvidenceContentType,
  MICROCHIP_DIGITS,
  PET_CLAIM_COMMAND_INPUT_CODES,
  PET_CLAIM_IDENTIFIER_KINDS,
  type PetClaimCommand,
  type PetClaimCommandInput,
  type PetClaimCommandInputCode,
  type PetClaimDisputeInput,
  type PetClaimIdentifierKind,
  firstPetClaimCommandInputCode,
  petClaimCommandInputSchema,
} from "./pet-claim.ts";
export {
  PET_PHOTO_COMMAND_INPUT_CODES,
  PET_PHOTO_CONTENT_TYPES,
  type PetPhotoCommand,
  type PetPhotoCommandInput,
  type PetPhotoCommandInputCode,
  type PetPhotoContentType,
  firstPetPhotoCommandInputCode,
  petPhotoCommandInputSchema,
} from "./pet-photo.ts";
export {
  LIBRETA_SHARE_EXPIRY_DAYS,
  LIBRETA_SHARE_LABEL_MAX,
  MAX_ACTIVE_LIBRETA_SHARES,
  SHARE_COMMAND_INPUT_CODES,
  TIER2_WINDOWS,
  type LibretaShareExpiryDays,
  type ShareCommand,
  type ShareCommandInput,
  type ShareCommandInputCode,
  type Tier2Window,
  firstShareCommandInputCode,
  shareCommandInputSchema,
} from "./share.ts";
export {
  BITE_SEVERITIES,
  BITE_VICTIM_KINDS,
  CLINICAL_SUB_KINDS,
  DANGEROUS_BREED_REGISTRIES,
  DEATH_CAUSES,
  DEWORMING_TYPES,
  DISPOSITION_METHODS,
  MAX_CUSTOM_HOURS,
  MAX_DURATION_DAYS,
  MAX_LIVE_BIRTHS,
  MAX_WEIGHT_KG,
  MAX_WEEKS_AT_DIAGNOSIS,
  MEDICATION_FREQUENCIES,
  MICROCHIP_REVOCATION_REASONS,
  MIN_CUSTOM_HOURS,
  MIN_DURATION_DAYS,
  NOTE_CATEGORIES,
  OWNER_MICROCHIP_REPLACE_REASONS,
  PREGNANCY_OUTCOMES,
  RECORD_EVENT_INPUT_CODES,
  STERILIZATION_PROCEDURES,
  SYMPTOM_SEVERITIES,
  TATTOO_LOCATIONS,
  VET_CONTACT_VALUES,
  type BiteSeverity,
  type BiteVictimKind,
  type ClinicalSubKind,
  type DangerousBreedRegistry,
  type DeathCause,
  type DewormingType,
  type DispositionMethod,
  dangerousBreedRegistryLabel,
  type MedicationFrequency,
  type NoteCategory,
  type OwnerMicrochipReplaceReason,
  type PregnancyOutcome,
  type RecordEventInput,
  type RecordEventInputCode,
  type RecordEventKind,
  type SterilizationProcedure,
  type SymptomSeverity,
  type TattooLocation,
  type VetContactValue,
  firstRecordEventInputCode,
  recordEventInputSchema,
} from "./record-event.ts";
export {
  NOTIFICATION_COMMAND_INPUT_CODES,
  NOTIFICATION_MARK_READ_MAX_IDS,
  type NotificationCommand,
  type NotificationCommandInput,
  type NotificationCommandInputCode,
  firstNotificationCommandInputCode,
  notificationCommandInputSchema,
} from "./notification.ts";
export { AR_PHONE_RE, looksLikeArPhone } from "./ar-phone.ts";
export {
  CONTACT_NAME_MAX_LENGTH,
  CONTACT_PHONE_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  MY_PROFILE_EDIT_INPUT_CODES,
  type MyProfileEditInput,
  type MyProfileEditInputCode,
  firstMyProfileEditInputCode,
  myProfileEditInputSchema,
} from "./my-profile-edit.ts";
export {
  ERASURE_REASON_MAX_LENGTH,
  ERASURE_REASON_MIN_LENGTH,
  SUBJECT_RIGHTS_COMMAND_INPUT_CODES,
  type SubjectRightsCommand,
  type SubjectRightsCommandInput,
  type SubjectRightsCommandInputCode,
  firstSubjectRightsCommandInputCode,
  subjectRightsCommandInputSchema,
} from "./subject-rights.ts";
export {
  OWNER_TRANSFER_REASONS,
  TRANSFER_COMMAND_INPUT_CODES,
  TRANSFER_EXPIRY_DAYS,
  TRANSFER_NOTE_MAX,
  type OwnerTransferReason,
  type TransferCommand,
  type TransferCommandInput,
  type TransferCommandInputCode,
  firstTransferCommandInputCode,
  transferCommandInputSchema,
} from "./transfer.ts";
export {
  APPOINTMENT_COMMAND_INPUT_CODES,
  type AppointmentCommand,
  type AppointmentCommandInput,
  type AppointmentCommandInputCode,
  appointmentCommandInputSchema,
  firstAppointmentCommandInputCode,
} from "./appointment.ts";
export {
  CARETAKER_COMMAND_INPUT_CODES,
  CARETAKER_INVITATION_EXPIRY_DAYS,
  CARETAKER_MAX_DURATION_DAYS,
  CARETAKER_NOTE_MAX,
  type CaretakerCommand,
  type CaretakerCommandInput,
  type CaretakerCommandInputCode,
  caretakerCommandInputSchema,
  firstCaretakerCommandInputCode,
} from "./caretaker.ts";
export {
  OWNER_RETURN_REASONS,
  PET_RETURN_COMMAND_INPUT_CODES,
  RETURN_NOTES_MAX,
  RETURN_REJECT_REASON_MAX,
  type OwnerReturnReason,
  type PetReturnCommand,
  type PetReturnCommandInput,
  type PetReturnCommandInputCode,
  firstPetReturnCommandInputCode,
  petReturnCommandInputSchema,
} from "./pet-return.ts";
export {
  MOVE_REASON_MAX,
  PET_MOVE_COMMAND_INPUT_CODES,
  type PetMoveCommand,
  type PetMoveCommandInput,
  type PetMoveCommandInputCode,
  firstPetMoveCommandInputCode,
  petMoveCommandInputSchema,
} from "./pet-move.ts";
export {
  EMERGENCY_CONTACT_NAME_MAX,
  EMERGENCY_CONTACT_PHONE_MAX,
  PET_COLOR_MAX,
  PET_NAME_MAX,
  PET_PROFILE_COMMAND_INPUT_CODES,
  type PetIdentityLengthResolution,
  type PetProfileCommand,
  type PetProfileCommandInput,
  type PetProfileCommandInputCode,
  type StoredPetIdentityText,
  firstPetProfileCommandInputCode,
  petIdentityFieldCap,
  petProfileCommandInputSchema,
  resolvePetIdentityLengths,
} from "./pet-profile-edit.ts";
export {
  EXPO_PUSH_TOKEN_PREFIX,
  PUSH_ANDROID_CHANNEL_ID,
  PUSH_ANDROID_HEALTH_CHANNEL_ID,
  PUSH_APP_VERSION_MAX_LENGTH,
  PUSH_PLATFORMS,
  PUSH_REGISTRATION_INPUT_CODES,
  type PushPlatform,
  type PushRegistrationCommand,
  type PushRegistrationInput,
  type PushRegistrationInputCode,
  firstPushRegistrationInputCode,
  pushRegistrationInputSchema,
} from "./push-registration.ts";
// EXPORTED ON ITS OWN, like `isRealArDay` above and for the same reason: the
// rule has doors that are not zod schemas. `update-profile.ts` validates a
// display name with a hand-rolled server schema, and a name rule that only the
// contract's schemas carry is a rule that door does not have.
export { isWritableName } from "./writable-name.ts";
export {
  ACQUISITION_METHODS,
  MAX_ESTIMATED_WEIGHT_KG,
  MAX_PET_AGE_MONTHS,
  MAX_PET_AGE_YEARS,
  PET_SPECIES,
  REGISTER_PET_INPUT_CODES,
  type AcquisitionMethod,
  type PetSpecies,
  type RegisterPetInput,
  type RegisterPetInputCode,
  firstRegisterPetInputCode,
  registerPetInputSchema,
} from "./register-pet.ts";
export {
  REHOME_COMMAND_INPUT_CODES,
  REHOME_COMMANDS_REQUIRING_IDEMPOTENCY_KEY,
  type RehomeCommand,
  type RehomeCommandInput,
  type RehomeCommandInputCode,
  firstRehomeCommandInputCode,
  rehomeCommandInputSchema,
} from "./rehome.ts";
export {
  VACCINE_REMINDER_COMMAND_INPUT_CODES,
  type VaccineReminderCommand,
  type VaccineReminderCommandInput,
  type VaccineReminderCommandInputCode,
  firstVaccineReminderCommandInputCode,
  vaccineReminderCommandInputSchema,
} from "./vaccine-reminder.ts";
export {
  WELFARE_ADDRESS_MAX_LENGTH,
  WELFARE_DESCRIPTION_MAX_LENGTH,
  WELFARE_DESCRIPTION_MIN_LENGTH,
  WELFARE_EVIDENCE_CONTENT_TYPES,
  WELFARE_EVIDENCE_MAX_FILES,
  WELFARE_EVIDENCE_STAGED_PATH_RE,
  WELFARE_REPORT_CITIZEN_SEVERITIES,
  WELFARE_REPORT_INPUT_CODES,
  WELFARE_REPORT_KINDS,
  WELFARE_REPORT_SUBJECT_KINDS,
  WELFARE_SUBJECT_DESCRIPTION_MAX_LENGTH,
  type WelfareEvidenceContentType,
  type WelfareReportCitizenSeverity,
  type WelfareReportCommand,
  type WelfareReportCommandInput,
  type WelfareReportContactMode,
  type WelfareReportInput,
  type WelfareReportInputCode,
  type WelfareReportKind,
  type WelfareReportSubjectKind,
  firstWelfareReportInputCode,
  welfareReportCommandInputSchema,
  welfareReportEvidenceTicketInputSchema,
  welfareReportFileInputSchema,
  welfareReportResolveLocationInputSchema,
} from "./welfare-report.ts";
export {
  GEOCODING_INPUT_CODES,
  GEOCODING_QUERY_MAX_LENGTH,
  GEOCODING_QUERY_MIN_LENGTH,
  type GeocodingCommandInput,
  type GeocodingInputCode,
  firstGeocodingInputCode,
  geocodingCommandInputSchema,
} from "./geocoding.ts";
export {
  FOSTER_COMMAND_INPUT_CODES,
  FOSTER_REJECTION_REASONS,
  FOSTER_RESPONSE_NOTES_MAX,
  type FosterCommand,
  type FosterCommandInput,
  type FosterCommandInputCode,
  type FosterRejectionReason,
  firstFosterCommandInputCode,
  fosterCommandInputSchema,
} from "./foster.ts";
