// Privacy class of every pet_events payload key (T3-A2b, 2026-09-22).
//
// THE PRINCIPLE (PO decision 5A, 2026-09-22)
// ---------------------------------------------------------------------------
// An art. 16 erasure removes what belongs to the PERSON and never the pet's
// health or compliance history. A vaccination, a bite, a castration, a death, a
// rabies observation, a seizure or a microchip replacement survives in full,
// including who signed it as a professional. Contacts, private names, the
// person's own free text and addresses inside those same events are erased or
// anonymised.
//
// WHAT THIS FILE IS
// ---------------------------------------------------------------------------
// The single source of that decision, per (event type, key path):
//
//   compliance_fact  — a fact about the animal or the sanitary record. Kept.
//   professional_act — written by a professional in that role (the vet's
//                      name on a vaccination, a closure note of a rabies
//                      observation). Kept, even after the professional's own
//                      erasure (art. 16 inc. 5: third parties' legitimate
//                      interest — future holders, the sanitary authority).
//                      `authorGated` makes it conditional: kept only when the
//                      ROW's author_role is in KEPT_AUTHOR_ROLES, otherwise the
//                      stated transform applies (an owner typing a
//                      "diagnosis" is not a professional act).
//   personal_data    — about a person. Erased with the stated transform.
//   mirrored         — `changes[].old/new` of a changelog: the value takes the
//                      class of the field it records (see MIRROR below).
//
// `redactionRules()` flattens this map into the rows of
// `pii.pet_event_redaction_rules`. The migration seeds that table from
// `scripts/generate-pet-event-redaction-rules.ts`, and
// `scripts/check-subject-rights-coverage.ts` asserts the LIVE table equals
// `redactionRules()` in both directions. `scripts/check-event-payload-privacy.ts`
// asserts every leaf of every zod payload schema is classified here, no entry is
// stale, and every transform fits the leaf it is applied to.
//
// Keys a schema does not declare (legacy rows, fixtures) are compliance facts by
// default in SQL: the erasure never touches a key it was not told about.

import type { EventType } from "@dim/contract/events";

/** Replaces redacted free text. Same value 0159 introduced. */
export const SENTINEL = "[dato removido]";

/** author_role values whose professional acts survive erasure. */
export const KEPT_AUTHOR_ROLES = ["vet", "shelter", "govt", "system"] as const;

/**
 * Kept roles that ALSO need `author_verified = true` (PO default, security
 * review of T3-A2b). `shelter` is written by any member of an organization,
 * verified or not; an unverified org is not an institution whose record
 * outlives the person, so its "professional act" is treated as personal data —
 * the safe direction. vet / govt / system rows are institutional by how they
 * are written.
 */
export const VERIFICATION_REQUIRED_ROLES = ["shelter"] as const;

/** Whether a row's author makes its author-gated keys a kept professional act. */
export function authorKept(authorRole: string, authorVerified: boolean): boolean {
  if (!(KEPT_AUTHOR_ROLES as readonly string[]).includes(authorRole)) return false;
  return !(VERIFICATION_REQUIRED_ROLES as readonly string[]).includes(authorRole) || authorVerified;
}

/**
 * A MACHINE CODE a writer stores under a prose key (`reason:
 * "return_to_original_owner"`). The sentinel never overwrites a value of this
 * shape: it is a code, not a person's words. Lowercase snake_case with at least
 * one underscore (a single lowercase word could be a first name), no run of
 * five or more digits (a phone number), at most 64 characters. Must equal
 * pii.pet_event_code_pattern() — lint:subject-rights compares them.
 */
export const CODE_PATTERN = "^[a-z](?!.*[0-9]{5,})[a-z0-9]*(_[a-z0-9]+)+$";
export const CODE_MAX_LENGTH = 64;

export function isMachineCode(value: string): boolean {
  return value.length <= CODE_MAX_LENGTH && new RegExp(CODE_PATTERN).test(value);
}

export const TRANSFORMS = [
  "sentinel",
  "drop",
  "null",
  "empty_array",
  "age_band",
  "coarsen_point",
  "changes_mirror",
] as const;
export type Transform = (typeof TRANSFORMS)[number];

export type PrivacyEntry =
  | { class: "compliance_fact" }
  | {
      class: "professional_act";
      why: string;
      authorGated?: { otherwise: Exclude<Transform, "changes_mirror" | "coarsen_point"> };
      partyKeys?: readonly string[];
      /**
       * authorGated + partyKeys together means the named party can never
       * reach a kept author's words (the gate skips first). The fence refuses
       * the combination unless this says why that is intended.
       */
      gatedPartyReason?: string;
      /** Machine codes writers store under this prose key (see CODE_PATTERN). */
      codes?: readonly string[];
    }
  | {
      class: "personal_data";
      transform: Exclude<Transform, "changes_mirror">;
      why: string;
      /**
       * Payload keys naming the person this value is ABOUT (scope S3). A key
       * `a>b` means: the pet_events row whose id is payload.a, its payload.b.
       */
      partyKeys?: readonly string[];
      /** Machine codes writers store under this prose key (see CODE_PATTERN). */
      codes?: readonly string[];
    }
  | { class: "mirrored"; why: string };

// ---------------------------------------------------------------------------
// Entry builders — keep the table below readable.
// ---------------------------------------------------------------------------

const CF = { class: "compliance_fact" } as const;

function pa(why: string): PrivacyEntry {
  return { class: "professional_act", why };
}

/** Professional act when a kept role wrote the row; otherwise sentinel. */
function paGated(why: string, partyKeys?: readonly string[]): PrivacyEntry {
  return partyKeys
    ? { class: "professional_act", why, authorGated: { otherwise: "sentinel" }, partyKeys }
    : { class: "professional_act", why, authorGated: { otherwise: "sentinel" } };
}

function pd(
  transform: Exclude<Transform, "changes_mirror">,
  why: string,
  partyKeys?: readonly string[],
): PrivacyEntry {
  return partyKeys
    ? { class: "personal_data", transform, why, partyKeys }
    : { class: "personal_data", transform, why };
}

/** A prose key that writers also fill with machine codes; the codes survive. */
function withCodes(e: PrivacyEntry, codes: readonly string[]): PrivacyEntry {
  if (e.class !== "personal_data" && e.class !== "professional_act") return e;
  return { ...e, codes };
}

const MIRROR: PrivacyEntry = {
  class: "mirrored",
  why: "A changelog value takes the privacy class of the field it records.",
};

// Recurring reasons.
const VET_SIGNATURE =
  "Name of the professional who performed the act; the signature of the record.";
const ACTOR_FK = "Opaque actor FK of the professional or official who performed the act.";
const CLINICAL_PROSE =
  "Clinical prose: a professional act when a vet/shelter/govt wrote it, the owner's own words otherwise.";
const OWNER_PROSE = "Free text typed by the person; may name people, places and contacts.";
const INSURANCE = "Insurance contract of the owner — a fact about the person, not the animal.";
const PLACE_PROSE = "A free-text place description tied to a person's home or route.";

// ---------------------------------------------------------------------------
// The classification. Paths use `.` for object keys and `[]` for array
// elements; an entry on an object path covers every leaf below it.
// ---------------------------------------------------------------------------

export const PAYLOAD_PRIVACY: Record<EventType, Record<string, PrivacyEntry>> = {
  // --- Lifecycle -------------------------------------------------------------
  pet_registered: {
    // Catalogue place, as entered and as resolved (lib/events/place-payload.ts):
    // no point, no address — those stay on the row and its own keys.
    place: CF,
    payload_version: CF,
    name: CF,
    species: CF,
    sex: CF,
    breed: CF,
    date_of_birth: CF,
    birth_date_is_estimated: CF,
    color: CF,
    microchip_id: CF,
    microchip_country_code: CF,
    microchip_implanted_at: CF,
    microchip_implanted_by: pa(VET_SIGNATURE),
    microchip_location: CF,
    estimated_weight_kg: CF,
    favourite_foods: CF,
    known_allergies: CF,
    training_level: CF,
    insurance_company: pd("null", INSURANCE),
    insurance_policy_number: pd("null", INSURANCE),
    jurisdiction_province: CF,
    jurisdiction_locality: CF,
    jurisdiction_locality_id: CF,
    potentially_dangerous_breed: CF,
    acquisition_method: CF,
    has_photo: CF,
    has_microchip: CF,
    custody_kind: CF,
  },
  pet_profile_updated: {
    payload_version: CF,
    "changes[].field": CF,
    "changes[].old": MIRROR,
    "changes[].new": MIRROR,
    photo_replaced: CF,
  },
  status_changed: {
    // Catalogue place, as entered and as resolved (lib/events/place-payload.ts):
    // no point, no address — those stay on the row and its own keys.
    place: CF,
    payload_version: CF,
    from_status: CF,
    to_status: CF,
    location_description: pd("sentinel", PLACE_PROSE),
    // Prose from setPetLost; a CODE from the return-to-owner writers.
    reason: withCodes(pd("sentinel", OWNER_PROSE), ["return_to_original_owner"]),
    disclosure_prefs_snapshot: CF,
    "lost_description.accessories_when_lost": pd("sentinel", OWNER_PROSE),
    "lost_description.behavior_notes": pd("sentinel", OWNER_PROSE),
    "lost_description.last_seen_context": pd("sentinel", OWNER_PROSE),
  },
  death_recorded: {
    payload_version: CF,
    cause: CF,
    cause_detail: paGated(CLINICAL_PROSE),
    confirmed_by_vet: CF,
    vet_name: pa(VET_SIGNATURE),
    disposition_method: CF,
    facility: CF,
    death_at_clinic: CF,
    clinic_name: CF,
    vet_contacted_owner: CF,
    vet_decided_alone: CF,
    owner_to_private_crematorium: CF,
    disease_code: CF,
    confirmed_by_lab: CF,
    is_reportable: CF,
    during_rabies_observation: CF,
  },

  // --- Preventive / medication -----------------------------------------------
  vaccination_administered: {
    payload_version: CF,
    vaccine_name: CF,
    brand: CF,
    batch: CF,
    administered_by: pa(VET_SIGNATURE),
    administered_by_organization_id: pa(ACTOR_FK),
    administered_by_user_id: pa(ACTOR_FK),
    next_due_at: CF,
  },
  deworming_administered: {
    payload_version: CF,
    product: CF,
    type: CF,
    administered_by: pa(VET_SIGNATURE),
    administered_by_organization_id: pa(ACTOR_FK),
    administered_by_user_id: pa(ACTOR_FK),
    next_due_at: CF,
  },
  sterilization_performed: {
    payload_version: CF,
    procedure: CF,
    performed_by: pa(VET_SIGNATURE),
    clinic: CF,
    performed_by_organization_id: pa(ACTOR_FK),
    performed_by_user_id: pa(ACTOR_FK),
  },
  medication_started: {
    payload_version: CF,
    drug_name: CF,
    dose: CF,
    frequency: CF,
    prescribed_by: pa(VET_SIGNATURE),
    drug_code: CF,
    first_dose_at: CF,
    duration_days: CF,
    custom_hours: CF,
    schedule_count: CF,
  },
  medication_stopped: {
    payload_version: CF,
    medication_started_event_id: CF,
    reason: paGated(CLINICAL_PROSE),
  },
  medication_dose_taken: {
    payload_version: CF,
    medication_started_event_id: CF,
    scheduled_for: CF,
    reminder_id: CF,
  },

  // --- Clinical --------------------------------------------------------------
  vet_visit_logged: {
    // Catalogue place, as entered and as resolved (lib/events/place-payload.ts):
    // no point, no address — those stay on the row and its own keys.
    place: CF,
    payload_version: CF,
    reason: paGated(CLINICAL_PROSE),
    diagnosis: paGated(CLINICAL_PROSE),
    vet_name: pa(VET_SIGNATURE),
    clinic: CF,
    attended_by_organization_id: pa(ACTOR_FK),
    attended_by_user_id: pa(ACTOR_FK),
    jurisdiction_province: CF,
    jurisdiction_locality: CF,
  },
  weight_recorded: {
    payload_version: CF,
    kg: CF,
  },
  clinical_info_logged: {
    // Catalogue place, as entered and as resolved (lib/events/place-payload.ts):
    // no point, no address — those stay on the row and its own keys.
    place: CF,
    payload_version: CF,
    sub_kind: CF,
    title: paGated(CLINICAL_PROSE),
    details: paGated(CLINICAL_PROSE),
    performed_by: pa(VET_SIGNATURE),
    performed_by_organization_id: pa(ACTOR_FK),
    performed_by_user_id: pa(ACTOR_FK),
    disease_code: CF,
    confirmed_by_lab: CF,
    lab_name: CF,
    lab_report_reference: CF,
    diagnosis_date: CF,
    pregnancy_phase: CF,
    weeks_at_diagnosis: CF,
    outcome: CF,
    live_births_count: CF,
    vet_consulted: pa(VET_SIGNATURE),
    jurisdiction_province: CF,
    jurisdiction_locality: CF,
  },
  disease_reported: {
    payload_version: CF,
    disease: CF,
    confirmed_by_lab: CF,
    date_of_onset: CF,
    clinical_notes: paGated(CLINICAL_PROSE),
  },
  symptom_observed: {
    payload_version: CF,
    source: CF,
    welfare_report_id: CF,
    reporter_role: CF,
    // `.min(1)` — the sentinel keeps the row valid where a drop would not.
    free_text: paGated(CLINICAL_PROSE),
    matched_symptom_codes: CF,
    alerted_disease_codes: CF,
    severity_self_assessed: CF,
    onset_at: CF,
  },
  outbreak_signal: {
    // Catalogue place, as entered and as resolved (lib/events/place-payload.ts):
    // no point, no address — those stay on the row and its own keys.
    place: CF,
    payload_version: CF,
    source_symptom_event_id: CF,
    source_disease_diagnosis_event_id: CF,
    triggered_by: CF,
    confirmed_by_lab: CF,
    disease_code: CF,
    disease_label: CF,
    match_strength: CF,
    pet_jurisdiction_country: CF,
    pet_jurisdiction_province: CF,
    pet_jurisdiction_locality: CF,
    pet_species: CF,
    bite_observation_active: CF,
  },

  // --- Movement / identification --------------------------------------------
  movement_recorded: {
    payload_version: CF,
    sub_kind: CF,
    from_country: CF,
    from_province: CF,
    from_locality: CF,
    to_country: CF,
    to_province: CF,
    to_locality: CF,
    from_locality_id: CF,
    to_locality_id: CF,
    effective_date: CF,
    // jurisdiction_changed.reason and transport_recorded.purpose are prose.
    reason: paGated(
      "Why the pet moved: official prose when an authority wrote it, the owner's otherwise.",
    ),
    origin_country: CF,
    cvi_number: CF,
    issuing_authority: CF,
    issued_date: CF,
    chip_iso_country_code: CF,
    corridor_id: CF,
    direction: CF,
    travel_date: CF,
    mode: CF,
    purpose: paGated("Purpose of a transport: official prose when an authority wrote it."),
  },
  microchip_implanted: {
    payload_version: CF,
    chip_number: CF,
    country_code: CF,
    implanted_by: pa(VET_SIGNATURE),
    implanted_by_organization_id: pa(ACTOR_FK),
    implanted_by_user_id: pa(ACTOR_FK),
    location_on_body: CF,
    implant_date_known: CF,
  },
  microchip_replaced: {
    payload_version: CF,
    previous_chip_number: CF,
    new_chip_number: CF,
    // An ENUM (lost | damaged | …). 0159-0228's key-name sweep destroyed it.
    reason: CF,
    replaced_by: pa(VET_SIGNATURE),
    replaced_at: CF,
    actor_role: CF,
    actor_user_id: pa(ACTOR_FK),
    notes: paGated(CLINICAL_PROSE),
  },
  tattoo_recorded: {
    payload_version: CF,
    tattoo_code: CF,
    location_on_body: CF,
    description: paGated(CLINICAL_PROSE),
    recorded_by: pa(VET_SIGNATURE),
    recorded_by_organization_id: pa(ACTOR_FK),
    recorded_by_user_id: pa(ACTOR_FK),
    recorded_at: CF,
    tattoo_date_known: CF,
  },
  tattoo_updated: {
    payload_version: CF,
    previous_tattoo_code: CF,
    new_tattoo_code: CF,
    reason: paGated(CLINICAL_PROSE),
  },
  dangerous_breed_attested: {
    payload_version: CF,
    registry: CF,
    registry_id: CF,
    attested_at: CF,
  },

  // --- Free-form, scans, incidents ------------------------------------------
  note_added: {
    payload_version: CF,
    category: CF,
    text: paGated(CLINICAL_PROSE),
    kind: CF,
    application_event_id: CF,
    finderName: pd("drop", "Name of the person who found the pet."),
    finderContact: pd("drop", "Phone or email of the person who found the pet."),
    photoStoragePath: CF,
    location_source: CF,
    location_description: pd("sentinel", PLACE_PROSE),
    location: CF,
    // Catalogue place — province, locality name, INDEC id, row id, method
    // (lib/events/place-payload.ts). Deliberately holds no point and no
    // address; those stay on the row and in location_description.
    place: CF,
    petCondition: CF,
    canKeepUntil: pd(
      "drop",
      "Until when the finder can keep the pet — a fact about the finder's home.",
    ),
    canKeepIndefinite: CF,
    message: pd("sentinel", "A finder's or owner's message to the other party; free text."),
    // kind=adoption_info_requested: the shelter's question to an applicant,
    // about the applicant. Its own key since T3-A2b; legacy rows carry it in
    // `text` — see KIND_PAYLOAD_PRIVACY.
    info_request_message: pd(
      "sentinel",
      "A shelter's message to an adoption applicant, about the applicant's application.",
      ["application_event_id>applicant_user_id"],
    ),
  },
  credential_scanned: {
    payload_version: CF,
    is_self_scan: CF,
    viewer_authenticated: CF,
    // Design said drop; the key is required (nullable) inside a strict object,
    // so a drop would fail the schema — null is the fitting transform.
    "scan_ip_area.city": pd("null", "City of the scanning device — locates a person."),
    "scan_ip_area.region": CF,
    "scan_ip_area.country": CF,
    scan_coords: pd("drop", "Precise GPS of the scanning device — locates a person."),
    scan_accuracy_m: pd("drop", "Accuracy of the scanner's GPS fix; only meaningful with it."),
  },
  incident_reported: {
    // Catalogue place, as entered and as resolved (lib/events/place-payload.ts):
    // no point, no address — those stay on the row and its own keys.
    place: CF,
    payload_version: CF,
    incident_type: CF,
    severity: CF,
    injuries_summary: pd("sentinel", "Health data of the bite victim, whoever wrote it (PO 5A)."),
    vet_involved: CF,
    location_description: pd("sentinel", PLACE_PROSE),
    victim_kind: CF,
    victim_contact_name: pd("drop", "Name of the bite victim — a third party."),
    victim_contact_phone: pd("drop", "Phone of the bite victim — a third party."),
    victim_pet_id: CF,
    victim_age_estimate: pd(
      "age_band",
      "Free-text age of the victim; the coarse band is kept, the text is not.",
    ),
    victim_age_band: CF,
    context: paGated("Circumstances of the incident: official prose when a professional wrote it."),
    rabies_vaccine_valid_at_incident: CF,
    reporter_role: CF,
    jurisdiction_province: CF,
    jurisdiction_locality: CF,
    location_source: CF,
  },
  rabies_observation_started: {
    payload_version: CF,
    bite_event_id: CF,
    observation_until: CF,
    observation_days: CF,
    location: CF,
    official_site_organization_id: CF,
  },
  rabies_observation_ended: {
    payload_version: CF,
    bite_event_id: CF,
    observation_started_event_id: CF,
    outcome: CF,
    closed_by_role: CF,
    closure_notes: paGated(CLINICAL_PROSE),
    death_event_id: CF,
  },

  // --- Welfare ---------------------------------------------------------------
  abandonment_reported: {
    payload_version: CF,
    welfare_report_id: CF,
    reporter_role: CF,
    description: paGated("Welfare description: an inspection record when an official wrote it."),
  },
  maltreatment_reported: {
    payload_version: CF,
    welfare_report_id: CF,
    reporter_role: CF,
    description: paGated("Welfare description: an inspection record when an official wrote it."),
    severity: CF,
    kind: CF,
  },

  // --- Custody / adoption ----------------------------------------------------
  shelter_intake_recorded: {
    payload_version: CF,
    intake_reason: CF,
    intake_condition: paGated(
      "Condition of the animal at intake, recorded by the shelter or authority.",
    ),
    rescue_jurisdiction: CF,
    seizure_motive: CF,
    seizure_motive_other_detail: paGated(
      "Reason for a seizure: an official act when govt (decomiso) wrote it.",
    ),
    judicial_proceeding_reference: paGated(
      "Court or expediente reference of a seizure: an official act when govt wrote it.",
    ),
    originating_welfare_report_id: CF,
    intended_receiver_organization_id: CF,
  },
  foster_assigned: {
    payload_version: CF,
    foster_user_id: CF,
    expected_weeks: CF,
    notes: pd("sentinel", "Notes about the foster volunteer and their home.", ["foster_user_id"]),
  },
  foster_ended: {
    payload_version: CF,
    foster_user_id: CF,
    // An ENUM. 0159-0228's key-name sweep destroyed it.
    reason: CF,
    notes: pd("sentinel", "Notes about the foster volunteer and their home.", ["foster_user_id"]),
    death_event_id: CF,
  },
  adoption_finalized: {
    payload_version: CF,
    previous_owner_organization_id: CF,
    adopter_user_id: CF,
    foster_user_id: CF,
    contract_attachment_id: CF,
    post_adoption_followup_months: CF,
    notes: pd("sentinel", "Notes about the adopter or the foster.", [
      "adopter_user_id",
      "foster_user_id",
    ]),
    adopted_from_application_id: CF,
  },
  adoption_reversed: {
    payload_version: CF,
    actor: CF,
    // Always written by the shelter, and ABOUT the adopter: personal data of
    // the adopter, not a gated act (an author gate would never let the
    // adopter's own erasure reach it — security review of T3-A2b).
    reason: pd("sentinel", "Why an adoption was reversed; describes the adopter's circumstances.", [
      "reverted_finalization_event_id>adopter_user_id",
    ]),
    reverted_finalization_event_id: CF,
  },
  adoption_application_submitted: {
    payload_version: CF,
    applicant_user_id: CF,
    related_organization_id: CF,
    housing_type: pd("null", "The applicant's home.", ["applicant_user_id"]),
    other_pets: pd("sentinel", "The applicant's own household, in their words.", [
      "applicant_user_id",
    ]),
    daily_routine: pd("sentinel", "The applicant's own routine, in their words.", [
      "applicant_user_id",
    ]),
    notes: pd("sentinel", OWNER_PROSE, ["applicant_user_id"]),
    profile_sharing_consent_at: CF,
    motivation: pd("sentinel", "The applicant's motivation, in their words.", [
      "applicant_user_id",
    ]),
    prior_pets: pd("null", "The applicant's history with animals.", ["applicant_user_id"]),
  },
  adoption_application_resolved: {
    payload_version: CF,
    application_event_id: CF,
    reviewer_user_id: CF,
    outcome: CF,
    reason: withCodes(
      pd("sentinel", "Why an application was resolved; about the applicant.", [
        "application_event_id>applicant_user_id",
      ]),
      ["manual_rejection", "another_application_finalized", "listing_withdrawn_by_titular"],
    ),
    auto_generated: CF,
    notes: pd("sentinel", "Reviewer notes about the applicant.", [
      "application_event_id>applicant_user_id",
    ]),
  },
  post_adoption_checkin: {
    // Catalogue place, as entered and as resolved (lib/events/place-payload.ts):
    // no point, no address — those stay on the row and its own keys.
    place: CF,
    payload_version: CF,
    related_organization_id: CF,
    photo_attachment_ids: CF,
    notes: pd("sentinel", "Notes about the adopter's home life."),
    jurisdiction_province: CF,
    jurisdiction_locality: CF,
  },
  custody_transferred: {
    payload_version: CF,
    from_user_id: CF,
    from_organization_id: CF,
    to_user_id: CF,
    to_organization_id: CF,
    from_role: CF,
    to_role: CF,
    // An ENUM (both variants). 0159-0228's key-name sweep destroyed it.
    reason: CF,
    matched_against_pet_id: CF,
    foster_ended_event_id: CF,
    notes: pd("sentinel", "Notes about the parties to the transfer.", [
      "from_user_id",
      "to_user_id",
    ]),
    transfer_token: CF,
  },
  ownership_claimed: {
    payload_version: CF,
    claimed_by_user_id: CF,
    identifier_kind: CF,
  },
  custody_transfer_proposed: {
    payload_version: CF,
    from_user_id: CF,
    from_organization_id: CF,
    to_user_id: CF,
    to_organization_id: CF,
    // An ENUM. 0159-0228's key-name sweep destroyed it.
    reason: CF,
    from_role: CF,
    to_role: CF,
    matched_against_pet_id: CF,
    proposed_at: CF,
    notes: pd("sentinel", "Notes about the parties to the transfer.", [
      "from_user_id",
      "to_user_id",
    ]),
  },
  custody_transfer_cancelled: {
    payload_version: CF,
    proposal_event_id: CF,
    cancelled_by: CF,
    // Prose from the owner's rejection; a CODE (failures[0]) from the auto-cancel.
    reason: withCodes(pd("sentinel", "Why a transfer was cancelled, in a party's own words."), [
      "actor_no_longer_holds_custody",
      "pet_not_lost",
      "pet_deceased",
    ]),
  },
  custody_dispute_raised: {
    payload_version: CF,
    raised_by_role: CF,
    raised_by_user_id: CF,
    // An official proceeding reference: kept when govt (or a verified
    // shelter) raised the dispute. No party key — an author gate would stop
    // it firing anyway, and the reference names a case, not the person.
    external_proceeding_reference: paGated(
      "External court or expediente reference: an official act when an authority raised the dispute.",
    ),
    // The raiser's statement of their claim: prose about the person, reached
    // by their own erasure whoever wrote the row (security review of T3-A2b).
    reason: pd("sentinel", "The grounds a party gives for disputing custody, in their own words.", [
      "raised_by_user_id",
    ]),
  },
  custody_dispute_resolved: {
    payload_version: CF,
    raised_event_id: CF,
    resolved_by_role: CF,
    resolved_by_user_id: CF,
    outcome: CF,
    notes: pa("Resolution notes of an admin or govt official — the disposition of the case."),
  },
  foster_proposed: {
    payload_version: CF,
    proposal_public_token: CF,
    volunteer_user_id: CF,
    proposed_duration_weeks: CF,
    match_warnings: pd("empty_array", "Warnings about the volunteer's household.", [
      "volunteer_user_id",
    ]),
  },
  foster_proposal_resolved: {
    payload_version: CF,
    proposal_public_token: CF,
    outcome: CF,
    response_notes: pd("sentinel", "The volunteer's or shelter's reply, in their words."),
    rejection_reason: CF,
    cancellation_reason: withCodes(
      pd("sentinel", "Why a proposal was cancelled, in a party's words."),
      ["volunteer_withdrew", "volunteer_accepted_another"],
    ),
    auto_cancelled: CF,
  },
  foster_co_foster_allowed: {
    payload_version: CF,
    allow_co_foster: CF,
    foster_ownership_id: CF,
  },
  adoption_eligibility_set: {
    payload_version: CF,
    eligible: CF,
    ineligible_reason: CF,
    ineligible_reason_notes: paGated(
      "Why a pet is not adoptable: the shelter's professional judgement.",
    ),
    ineligible_until: CF,
    previous_state: CF,
  },
  event_amended: {
    payload_version: CF,
    target_event_id: CF,
    reason: paGated("Why a record was corrected: a professional act when a vet/govt corrected it."),
    "changes[].field": CF,
    "changes[].old": MIRROR,
    "changes[].new": MIRROR,
    actor_role: CF,
    actor_user_id: pa(ACTOR_FK),
  },
  tag_activated: {
    payload_version: CF,
    serial: CF,
    lote_id: CF,
    source: CF,
  },
  tag_revoked: {
    payload_version: CF,
    serial: CF,
    revoke_reason: CF,
    replacement_serial: CF,
  },
  caretaker_designated: {
    payload_version: CF,
    grant_id: CF,
    grant_public_token: CF,
    caretaker_user_id: CF,
    ends_at: CF,
    note: pd("sentinel", "Owner's note about the caretaker and the household.", [
      "caretaker_user_id",
    ]),
  },
  caretaker_ended: {
    payload_version: CF,
    grant_id: CF,
    outcome: CF,
    ends_at: CF,
  },
  rehome_sponsorship_started: {
    payload_version: CF,
    ownership_id: CF,
    sponsoring_organization_id: CF,
    consented_by_user_id: CF,
    request_case_public_code: CF,
    listing_case_id: CF,
    note: pd("sentinel", OWNER_PROSE),
  },
  rehome_sponsorship_ended: {
    payload_version: CF,
    ownership_id: CF,
    outcome: CF,
    ended_at: CF,
  },
  content_reported: {
    payload_version: CF,
    surface: CF,
    target_event_id: CF,
    target_kind: CF,
    category: CF,
    reason: pd("sentinel", "The reporter's own words about a post."),
  },
};

/**
 * Per-`kind` overrides: rules that apply only when `payload.kind` equals the
 * key, seeded under the pseudo event type `<event_type>:<kind>`. Paths must be
 * paths of the base schema. Used for LEGACY rows whose meaning depends on the
 * kind: until T3-A2b a shelter's info request to an applicant
 * (kind=adoption_info_requested) was written into `text`.
 */
export const KIND_PAYLOAD_PRIVACY: Partial<
  Record<EventType, Record<string, Record<string, PrivacyEntry>>>
> = {
  note_added: {
    adoption_info_requested: {
      text: pd(
        "sentinel",
        "Legacy rows: the shelter's message to the applicant, written into text before info_request_message existed.",
        ["application_event_id>applicant_user_id"],
      ),
    },
  },
};

/**
 * Keys present in historical rows that NO current schema declares (staging
 * census, 2026-09-22 — security review of T3-A2b item 7). Only the ones that
 * need a transform are listed; every other undeclared key found there (source,
 * pet_jurisdiction_*, standard, status, *_id, flags, counters) is a compliance
 * fact, the SQL default. The fence refuses a legacy key a schema now declares.
 */
export const LEGACY_PAYLOAD_PRIVACY: Partial<Record<EventType, Record<string, PrivacyEntry>>> = {
  credential_scanned: {
    viewer_name: pd("drop", "Legacy: the name of the person who scanned the credential."),
    note: pd("sentinel", "Legacy free-text note on a scan; may name the scanner."),
  },
  pet_registered: {
    note: pd("sentinel", "Legacy owner note at registration; the owner's own words."),
  },
  microchip_implanted: {
    note: paGated(CLINICAL_PROSE),
  },
  sterilization_performed: {
    notes: paGated(CLINICAL_PROSE),
  },
  rabies_observation_ended: {
    notes: paGated(CLINICAL_PROSE),
  },
  adoption_eligibility_set: {
    reason: paGated("Legacy shelter prose on eligibility: the shelter's professional judgement."),
  },
  foster_co_foster_allowed: {
    reason: pd("sentinel", "Legacy prose about the fosters' arrangement."),
  },
  foster_proposed: {
    reason: pd("sentinel", "Legacy prose about the proposed volunteer.", ["volunteer_user_id"]),
  },
  custody_dispute_raised: {
    motive: pd("sentinel", "Legacy statement of a custody claim, in the raiser's words.", [
      "raised_by_user_id",
    ]),
  },
  shelter_intake_recorded: {
    notes: paGated(CLINICAL_PROSE),
    location_description: pd("sentinel", PLACE_PROSE),
    location_found: pd("sentinel", PLACE_PROSE),
  },
  note_added: {
    author: pd("sentinel", "Legacy free-text author name on a note."),
  },
};

/**
 * `pet_profile_updated.changes[].field` values. Each changelog entry's old/new
 * takes this class. Unlisted fields are compliance facts in SQL; the fence
 * requires every field a writer emits to be listed here.
 */
export const PROFILE_CHANGE_FIELD_PRIVACY: Record<string, PrivacyEntry> = {
  name: CF,
  species: CF,
  sex: CF,
  breed: CF,
  date_of_birth: CF,
  color: CF,
  estimated_weight_kg: CF,
  favourite_foods: CF,
  known_allergies: CF,
  training_level: CF,
  potentially_dangerous_breed: CF,
  insurance_company: pd("null", INSURANCE),
  insurance_policy_number: pd("null", INSURANCE),
  acquisition_method: CF,
  permanent_conditions: CF,
  permanent_conditions_other: pd("sentinel", "Owner's free-text description of a condition."),
  disclose_conditions_publicly: CF,
};

/** Pseudo event type under which PROFILE_CHANGE_FIELD_PRIVACY is seeded. */
export const PROFILE_CHANGES_NAMESPACE = "pet_profile_updated.changes";

/** Row-level columns of pet_events, keyed by SQL column name. */
export type ColumnEntry =
  | { class: "compliance_fact" }
  | { class: "professional_act"; why: string; authorGated?: { otherwise: "sentinel" } }
  | {
      class: "personal_data";
      transform: "coarsen_point";
      why: string;
      eventTypes: readonly EventType[];
    };

function colPa(why: string): ColumnEntry {
  return { class: "professional_act", why };
}

/**
 * What erasure does to location_lat / location_lng, per event type. FAIL
 * CLOSED: the Record makes every event type state it, and lint:subject-rights
 * fails when a live event type carrying a point is not `coarsen`-classified or
 * kept with a reason. Staging (2026-09-22) stores points on bites, sightings,
 * loss reports, scans, welfare reports (often the owner's home) and — seeded —
 * on vaccinations, sterilizations, deaths, disease and outbreak rows: a point
 * on a pet is where its person lives. 2 decimals (~1.1 km) keep every map.
 */
export type CoordinateEntry = "coarsen" | { keep: string };

export const COORDINATE_PRIVACY: Record<EventType, CoordinateEntry> = {
  pet_registered: "coarsen",
  pet_profile_updated: "coarsen",
  status_changed: "coarsen",
  death_recorded: "coarsen",
  vaccination_administered: "coarsen",
  deworming_administered: "coarsen",
  sterilization_performed: "coarsen",
  medication_started: "coarsen",
  medication_stopped: "coarsen",
  medication_dose_taken: "coarsen",
  vet_visit_logged: "coarsen",
  weight_recorded: "coarsen",
  clinical_info_logged: "coarsen",
  microchip_implanted: "coarsen",
  microchip_replaced: "coarsen",
  tattoo_recorded: "coarsen",
  tattoo_updated: "coarsen",
  dangerous_breed_attested: "coarsen",
  note_added: "coarsen",
  credential_scanned: "coarsen",
  incident_reported: "coarsen",
  rabies_observation_started: "coarsen",
  rabies_observation_ended: "coarsen",
  abandonment_reported: "coarsen",
  maltreatment_reported: "coarsen",
  symptom_observed: "coarsen",
  outbreak_signal: "coarsen",
  disease_reported: "coarsen",
  shelter_intake_recorded: "coarsen",
  foster_assigned: "coarsen",
  foster_ended: "coarsen",
  adoption_finalized: "coarsen",
  adoption_reversed: "coarsen",
  adoption_application_submitted: "coarsen",
  adoption_application_resolved: "coarsen",
  post_adoption_checkin: "coarsen",
  custody_transferred: "coarsen",
  ownership_claimed: "coarsen",
  custody_transfer_proposed: "coarsen",
  custody_transfer_cancelled: "coarsen",
  custody_dispute_raised: "coarsen",
  custody_dispute_resolved: "coarsen",
  foster_proposed: "coarsen",
  foster_proposal_resolved: "coarsen",
  foster_co_foster_allowed: "coarsen",
  adoption_eligibility_set: "coarsen",
  movement_recorded: "coarsen",
  event_amended: "coarsen",
  tag_activated: "coarsen",
  tag_revoked: "coarsen",
  caretaker_designated: "coarsen",
  caretaker_ended: "coarsen",
  rehome_sponsorship_started: "coarsen",
  rehome_sponsorship_ended: "coarsen",
  content_reported: "coarsen",
};

const POINT_EVENT_TYPES: readonly EventType[] = (
  Object.entries(COORDINATE_PRIVACY) as Array<[EventType, CoordinateEntry]>
)
  .filter(([, e]) => e === "coarsen")
  .map(([t]) => t);
const POINT_WHY =
  "A precise point on a pet locates its person's home or route; 2 decimals (~1.1 km) keep every map.";

export const PET_EVENT_COLUMN_PRIVACY: Record<string, ColumnEntry> = {
  id: CF,
  pet_id: CF,
  event_type: CF,
  occurred_at: CF,
  recorded_at: CF,
  recorded_by_user_id: {
    class: "professional_act",
    why: "Actor FK; the profile it points at is anonymised by the same erasure.",
  },
  author_role: CF,
  author_organization_id: {
    class: "professional_act",
    why: "Institutional actor FK of the organization that authored the row.",
  },
  author_verified: CF,
  payload: CF,
  notes: {
    class: "professional_act",
    why: CLINICAL_PROSE,
    authorGated: { otherwise: "sentinel" },
  },
  location_lat: {
    class: "personal_data",
    transform: "coarsen_point",
    why: POINT_WHY,
    eventTypes: POINT_EVENT_TYPES,
  },
  location_lng: {
    class: "personal_data",
    transform: "coarsen_point",
    why: POINT_WHY,
    eventTypes: POINT_EVENT_TYPES,
  },
  case_id: CF,
  client_idempotency_key: CF,
  tipo_evento_code: CF,
  lote_biologico: CF,
  laboratorio: CF,
  vencimiento_biologico: CF,
  via_aplicacion_code: CF,
  vet_matricula: colPa("Professional registration number: the signature of a sanitary act."),
  vet_jurisdiccion_code: colPa("Jurisdiction of the signing professional's registration."),
  establecimiento_renspa: CF,
  proxima_dosis_at: CF,
  firmado_at: colPa("When the professional signed the act."),
  firma_hash: colPa("Hash of the professional's signature over the act."),
  created_at: CF,
};

// ---------------------------------------------------------------------------
// Flattening — the rows that must equal pii.pet_event_redaction_rules.
// ---------------------------------------------------------------------------

export type RedactionRule = {
  event_type: string;
  key_path: string[];
  transform: Transform;
  author_gated: boolean;
  party_keys: string[] | null;
};

/** `a.b[].c` → ["a", "b", "[]", "c"]. */
export function pathToKeyPath(path: string): string[] {
  const out: string[] = [];
  for (const seg of path.split(".")) {
    if (seg.endsWith("[]")) {
      out.push(seg.slice(0, -2), "[]");
    } else {
      out.push(seg);
    }
  }
  return out;
}

function entryRule(eventType: string, path: string[], e: PrivacyEntry): RedactionRule | null {
  if (e.class === "compliance_fact") return null;
  if (e.class === "mirrored") {
    return {
      event_type: eventType,
      key_path: path,
      transform: "changes_mirror",
      author_gated: false,
      party_keys: null,
    };
  }
  if (e.class === "professional_act") {
    if (!e.authorGated) return null;
    return {
      event_type: eventType,
      key_path: path,
      transform: e.authorGated.otherwise,
      author_gated: true,
      party_keys: e.partyKeys ? [...e.partyKeys] : null,
    };
  }
  return {
    event_type: eventType,
    key_path: path,
    transform: e.transform,
    author_gated: false,
    party_keys: e.partyKeys ? [...e.partyKeys] : null,
  };
}

/** Column rules use a `#` prefix on the single key_path element. */
export const COLUMN_RULE_ANY_EVENT = "*";

/** The rules of one `{ path: entry }` table under one (pseudo) event type. */
function tableRules(
  eventType: string,
  paths: Readonly<Record<string, PrivacyEntry>> | undefined,
): RedactionRule[] {
  return Object.entries(paths ?? {}).flatMap(([path, entry]) => {
    const r = entryRule(eventType, pathToKeyPath(path), entry);
    return r ? [r] : [];
  });
}

function columnRules(): RedactionRule[] {
  const rules: RedactionRule[] = [];
  for (const [column, entry] of Object.entries(PET_EVENT_COLUMN_PRIVACY)) {
    if (entry.class === "professional_act" && entry.authorGated) {
      rules.push({
        event_type: COLUMN_RULE_ANY_EVENT,
        key_path: [`#${column}`],
        transform: entry.authorGated.otherwise,
        author_gated: true,
        party_keys: null,
      });
    } else if (entry.class === "personal_data") {
      for (const t of entry.eventTypes) {
        rules.push({
          event_type: t,
          key_path: [`#${column}`],
          transform: entry.transform,
          author_gated: false,
          party_keys: null,
        });
      }
    }
  }
  return rules;
}

export function redactionRules(): RedactionRule[] {
  return [
    ...Object.entries(PAYLOAD_PRIVACY).flatMap(([t, paths]) => tableRules(t, paths)),
    ...Object.entries(KIND_PAYLOAD_PRIVACY).flatMap(([t, kinds]) =>
      Object.entries(kinds ?? {}).flatMap(([kind, paths]) => tableRules(`${t}:${kind}`, paths)),
    ),
    ...Object.entries(LEGACY_PAYLOAD_PRIVACY).flatMap(([t, keys]) => tableRules(t, keys)),
    ...tableRules(PROFILE_CHANGES_NAMESPACE, PROFILE_CHANGE_FIELD_PRIVACY),
    ...columnRules(),
  ].sort(compareRules);
}

export function ruleKey(r: RedactionRule): string {
  return `${r.event_type}|${r.key_path.join("/")}`;
}

function compareRules(a: RedactionRule, b: RedactionRule): number {
  const ka = ruleKey(a);
  const kb = ruleKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Stable text form of a rule — what the DB-backed equality check compares. */
export function ruleSignature(r: RedactionRule): string {
  return `${ruleKey(r)}|${r.transform}|${r.author_gated}|${(r.party_keys ?? []).join(",")}`;
}

/**
 * The top-level payload keys of an event type, as classified here (the fence
 * holds this equal to its zod schema). event_amended's `changes[].field` must
 * be one of these for the target type: a field outside the schema would carry
 * a value no rule classifies (T3-A2b security review, item 9).
 */
export function classifiedTopLevelKeys(eventType: string): ReadonlySet<string> {
  const entries = PAYLOAD_PRIVACY[eventType as EventType] ?? {};
  return new Set(Object.keys(entries).map((p) => (p.split(".")[0] ?? p).replace(/\[\]$/, "")));
}
