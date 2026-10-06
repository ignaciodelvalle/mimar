// `NOTIFICATION_KINDS` — every notification type a writer can emit, and what it
// is ABOUT (notificaciones-destinos, 2026-10).
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// `notifications.notification_type` is free text with no CHECK, and until this
// file nothing anywhere listed the values. Each writer chose a type string, a
// title and a `cta_url`, and the `cta_url` was the only statement of where the
// notification led. The 2026-10-06 audit (engram `notifications/destinations-
// audit`) found three ways that statement went wrong: a case link sent to an org
// party `canReadCase` refuses, a pet link sent to somebody who no longer holds
// the pet, and a web path the app has no screen for. None of them was visible
// from the writer, because the writer is the one place that cannot know who
// will be reading the row a month later.
//
// So the DESTINATION is decided at read time, by the server resolver
// (`resolveNotificationTarget`), and this table is what it reads: for each type,
// the subject the notification is about, the destination to try first, and who
// has to act while the matter is pending. `scripts/check-notification-kinds.ts`
// scans every writer and fails when a type is emitted that is not here, so a new
// notification cannot ship without saying where it goes.
//
// WHAT IT IS NOT
// ---------------------------------------------------------------------------
// It is not the copy of the notification (writers keep their own titles), and it
// is not an access rule. `primaryDestination` is where the resolver LOOKS first;
// whether the viewer may open it is decided by the same access functions the
// destination page runs (`canReadCase`, `resolvePetHolderAccess`, ...). A kind
// whose destination is gone for this viewer resolves to the explanation state,
// never to a 404.
//
// Zero runtime dependencies, like the rest of the package.

import type { NotificationCategoryV1 } from "../api/my-notifications.ts";

/** What the notification is about. */
export const NOTIFICATION_SUBJECTS = [
  "case",
  "pet",
  "account",
  "organization",
  "jurisdiction",
] as const;
export type NotificationSubject = (typeof NOTIFICATION_SUBJECTS)[number];

/**
 * Where the resolver looks first.
 *
 *   · `case`    — the related case (`related_case_id`, or the `/casos/{code}` the
 *                 writer stored), if the viewer can read it.
 *   · `pet`     — the related pet (`related_pet_id`, or the `/mis-mascotas/{token}`
 *                 the writer stored), through holder access or the former-owner
 *                 read during an open custody episode.
 *   · `section` — the page the writer stored (a list, a hub, a token page), if
 *                 the viewer can enter it.
 *   · `none`    — an informational notice with nothing to open. It still lands
 *                 on the explanation state, which says so in words.
 *
 * Whatever the first choice, the resolver falls back in the fixed order
 * case → pet → section → explanation.
 */
export const NOTIFICATION_DESTINATIONS = ["case", "pet", "section", "none"] as const;
export type NotificationDestination = (typeof NOTIFICATION_DESTINATIONS)[number];

/**
 * Who has to act while the matter is still pending.
 *
 *   · `recipient`    — the person reading it (`action` says what to do).
 *   · `counterparty` — the other party: an organization or a person
 *                      (`counterpartyAction` says what they have to do).
 *   · `authority`    — the authority of the jurisdiction decides.
 *   · `none`         — nothing is pending; the notification reports a fact.
 */
export const NOTIFICATION_PENDING_ACTORS = [
  "recipient",
  "counterparty",
  "authority",
  "none",
] as const;
export type NotificationPendingActor = (typeof NOTIFICATION_PENDING_ACTORS)[number];

export type NotificationKindSpec = {
  readonly subject: NotificationSubject;
  readonly primaryDestination: NotificationDestination;
  readonly pendingActor: NotificationPendingActor;
  readonly category: NotificationCategoryV1 | null;
  /**
   * es-AR imperative, completing «Te toca a vos: …». Required when
   * `pendingActor` is `recipient`.
   */
  readonly action?: string;
  /**
   * es-AR subjunctive, completing «Falta que {parte} …». Required when
   * `pendingActor` is `counterparty`.
   */
  readonly counterpartyAction?: string;
  /**
   * es-AR sentence for a `none` destination: why there is nothing to open.
   * Required when `primaryDestination` is `none`.
   */
  readonly informational?: string;
  /**
   * For a `pet` destination whose writer stored no pet path (or an external
   * link): the pet-scoped page to open, relative to `/mis-mascotas/{token}/`.
   */
  readonly petFace?: string;
};

// Compact constructors. They exist so the table below reads as one line per
// kind; every field still lands in a plain object literal.
type Extra = Pick<
  NotificationKindSpec,
  "action" | "counterpartyAction" | "informational" | "petFace"
>;
const caseKind = (
  pendingActor: NotificationPendingActor,
  category: NotificationCategoryV1 | null,
  extra: Extra = {},
): NotificationKindSpec => ({
  subject: "case",
  primaryDestination: "case",
  pendingActor,
  category,
  ...extra,
});
const petKind = (
  pendingActor: NotificationPendingActor,
  category: NotificationCategoryV1 | null,
  extra: Extra = {},
): NotificationKindSpec => ({
  subject: "pet",
  primaryDestination: "pet",
  pendingActor,
  category,
  ...extra,
});
const sectionKind = (
  subject: NotificationSubject,
  pendingActor: NotificationPendingActor,
  category: NotificationCategoryV1 | null,
  extra: Extra = {},
): NotificationKindSpec => ({
  subject,
  primaryDestination: "section",
  pendingActor,
  category,
  ...extra,
});
const noticeKind = (
  subject: NotificationSubject,
  category: NotificationCategoryV1 | null,
  informational: string,
): NotificationKindSpec => ({
  subject,
  primaryDestination: "none",
  pendingActor: "none",
  category,
  informational,
});

const REVIEW = "revisalo y decidí cómo seguir";
const PPP_ACTION = "registrá la atestación de raza potencialmente peligrosa";

/**
 * The table. Keys are the exact `notification_type` strings writers store.
 * Sorted, so a diff adding a kind reads as one line in the right place.
 */
export const NOTIFICATION_KINDS = {
  admin_deactivated: sectionKind("account", "none", "admin"),
  admin_event_amended: petKind("none", "health"),
  adoption_application_approved: sectionKind("account", "counterparty", "adoption", {
    counterpartyAction: "se comunique con vos para coordinar la adopción",
  }),
  adoption_application_closed: sectionKind("account", "none", "adoption"),
  adoption_application_received: sectionKind("organization", "recipient", "adoption", {
    action: "revisá la postulación",
  }),
  adoption_application_rejected: sectionKind("account", "none", "adoption"),
  adoption_application_withdrawn: sectionKind("organization", "none", "adoption"),
  adoption_finalized: petKind("none", "adoption"),
  adoption_info_requested: sectionKind("account", "recipient", "adoption", {
    action: "respondé lo que te pidió el refugio",
  }),
  adoption_reversed: petKind("none", "adoption"),
  alert_authority_contacted: sectionKind("jurisdiction", "recipient", "health", {
    action: REVIEW,
  }),
  anonymous_reports_overflow: petKind("none", "perdidas"),
  appointment_attended: sectionKind("account", "none", null),
  appointment_cancelled_by_org: sectionKind("account", "none", null),
  appointment_cancelled_by_owner: sectionKind("organization", "none", null),
  appointment_no_show: sectionKind("account", "none", null),
  approval_request_approved: sectionKind("account", "none", "admin"),
  approval_request_auto_expired: sectionKind("account", "none", "admin"),
  approval_request_info_requested: sectionKind("account", "recipient", "admin", {
    action: "respondé el pedido de información",
  }),
  approval_request_pending_authority: sectionKind("account", "recipient", "admin", {
    action: "revisá la solicitud",
  }),
  approval_request_proposed_authority: sectionKind("account", "recipient", "admin", {
    action: "revisá la propuesta",
  }),
  approval_request_rejected: sectionKind("account", "none", "admin"),
  approval_request_submitted_self: sectionKind("account", "authority", "admin"),
  bite_reported_authority: caseKind("recipient", "health", { action: REVIEW }),
  bite_reported_by_org_owner: petKind("authority", "health"),
  capability_approved: sectionKind("organization", "none", "admin"),
  capability_denied: sectionKind("organization", "none", "admin"),
  capability_granted: sectionKind("organization", "none", "admin"),
  capability_request: sectionKind("organization", "recipient", "admin", {
    action: "revisá el pedido de permiso",
  }),
  capability_revoked: sectionKind("organization", "none", "admin"),
  caretaker_death_recorded: petKind("none", "custody"),
  caretaker_grant_ended: petKind("none", "custody"),
  caretaker_grant_ending_soon: petKind("none", "custody"),
  caretaker_invitation_accepted: petKind("none", "custody"),
  caretaker_invitation_cancelled: noticeKind(
    "account",
    "custody",
    "La persona titular canceló la invitación antes de que la respondieras. No tenés que hacer nada.",
  ),
  caretaker_invitation_expired: petKind("none", "custody"),
  caretaker_invitation_received: sectionKind("account", "recipient", "custody", {
    action: "aceptá o rechazá la invitación",
  }),
  caretaker_invitation_rejected: petKind("none", "custody"),
  case_escalated_by_operator: caseKind("recipient", null, { action: REVIEW }),
  case_place_resolved_authority: caseKind("recipient", null, { action: REVIEW }),
  chip_match_notification_owner: petKind("recipient", "perdidas", {
    action: "coordiná la devolución",
    petFace: "devolucion",
  }),
  clinical_event_recorded: petKind("none", "health"),
  cross_org_transfer_accepted_receiver: caseKind("none", "custody"),
  cross_org_transfer_accepted_sender: caseKind("none", "custody"),
  cross_org_transfer_cancelled_receiver: caseKind("none", "custody"),
  cross_org_transfer_expired_receiver: caseKind("none", "custody"),
  cross_org_transfer_expired_sender: caseKind("none", "custody"),
  cross_org_transfer_proposed_receiver: caseKind("recipient", "custody", {
    action: "aceptá o rechazá el traspaso",
  }),
  cross_org_transfer_proposed_sender: caseKind("counterparty", "custody", {
    counterpartyAction: "acepte el traspaso",
  }),
  cross_org_transfer_rejected_sender: caseKind("none", "custody"),
  custody_dispute_party_added: caseKind("authority", "custody"),
  custody_dispute_raised_against_you: caseKind("authority", "custody"),
  custody_dispute_raised_by_you: caseKind("authority", "custody"),
  custody_dispute_resolved: caseKind("none", "custody"),
  custody_dispute_stale: caseKind("recipient", "custody", {
    action: "hacé el seguimiento de la disputa",
  }),
  custody_transfer_accepted_owner_side: petKind("none", "custody"),
  custody_transfer_auto_cancelled: petKind("none", "custody"),
  custody_transfer_proposal_owner: petKind("recipient", "custody", {
    action: "aceptá o rechazá la devolución",
    petFace: "devolucion",
  }),
  decomiso_confirmed_admin: caseKind("none", "custody"),
  decomiso_confirmed_govt: caseKind("none", "custody"),
  decomiso_handoff_accepted_govt: caseKind("none", "custody"),
  decomiso_handoff_accepted_receiver: caseKind("none", "custody"),
  decomiso_handoff_proposed_receiver: caseKind("recipient", "custody", {
    action: "aceptá o rechazá recibir al animal",
  }),
  decomiso_handoff_rejected_govt: caseKind("recipient", "custody", {
    action: "asigná otro refugio o mantené al animal en custodia oficial",
  }),
  decomiso_handoff_stale: caseKind("recipient", "custody", {
    action: "asigná otro refugio o mantené al animal en custodia oficial",
  }),
  decomiso_owner_lost_custody: petKind("authority", "custody"),
  decomiso_returned_to_owner: petKind("none", "custody"),
  disease_public_alert: petKind("none", "health"),
  eno_disease_diagnosis: sectionKind("jurisdiction", "recipient", "health", { action: REVIEW }),
  eno_pet_disease_diagnosis: petKind("none", "health"),
  first_stranger_scan: petKind("none", "perdidas"),
  foster_assigned: petKind("none", "custody"),
  foster_converted_to_owner: petKind("none", "custody"),
  foster_ended: petKind("none", "custody"),
  foster_ended_by_adoption: petKind("none", "adoption"),
  foster_ended_by_death: petKind("none", "custody"),
  foster_ended_by_transfer: petKind("none", "custody"),
  foster_proposal_accepted_org: sectionKind("organization", "none", "custody"),
  foster_proposal_auto_cancelled_org: sectionKind("organization", "none", "custody"),
  foster_proposal_cancelled_volunteer: sectionKind("account", "none", "custody"),
  foster_proposal_expired: sectionKind("account", "none", "custody"),
  foster_proposal_received: sectionKind("account", "recipient", "custody", {
    action: "aceptá o rechazá la propuesta de tránsito",
  }),
  foster_proposal_rejected_org: sectionKind("organization", "none", "custody"),
  foster_volunteer_reenroll_prompt: sectionKind("account", "recipient", "custody", {
    action: "decidí si querés seguir ofreciéndote como tránsito",
  }),
  free_pet_claimed: petKind("none", "custody"),
  govt_deactivated: sectionKind("account", "none", "admin"),
  govt_locality_assigned: sectionKind("account", "none", "admin"),
  govt_locality_revoked: sectionKind("account", "none", "admin"),
  govt_self_deactivated_admin_notice: sectionKind("account", "none", "admin"),
  govt_self_deactivated_cascade_notice: sectionKind("account", "none", "admin"),
  institutional_account_created: sectionKind("account", "none", "admin"),
  jurisdiction_admin_appointed: sectionKind("jurisdiction", "none", "admin"),
  jurisdiction_admin_revoked: sectionKind("jurisdiction", "none", "admin"),
  lost_episode_resolved_broadcast: sectionKind("pet", "none", "perdidas"),
  lost_episode_resolved_owner: petKind("none", "perdidas"),
  lost_pet_broadcast: sectionKind("pet", "none", "perdidas"),
  microchip_duplicate_detected: caseKind("recipient", null, { action: REVIEW }),
  microchip_fraud_detected: caseKind("recipient", null, { action: REVIEW }),
  microchip_updated_by_institution: petKind("none", "health"),
  operator_credentials_reset: sectionKind("account", "none", "admin"),
  org_contact_message: sectionKind("organization", "recipient", null, {
    action: "respondé el mensaje",
  }),
  org_invitation_accepted: sectionKind("organization", "none", "admin"),
  org_invitation_created: sectionKind("organization", "none", "admin"),
  org_membership_removed: sectionKind("account", "none", "admin"),
  org_verification_granted: sectionKind("organization", "none", "admin"),
  org_verification_revoked: sectionKind("organization", "none", "admin"),
  org_volunteer_message: sectionKind("organization", "recipient", null, {
    action: "respondé el mensaje",
  }),
  origin_shelter_pet_found: sectionKind("pet", "none", "perdidas"),
  outbreak_signal_detected: sectionKind("jurisdiction", "recipient", "health", {
    action: REVIEW,
  }),
  pet_found_report: petKind("recipient", "perdidas", {
    action: "comunicate con quien la encontró",
  }),
  pet_in_possession: petKind("recipient", "perdidas", {
    action: "comunicate con quien la tiene para coordinar el reencuentro",
  }),
  pet_sighting: petKind("none", "perdidas"),
  pet_transfer_accepted: petKind("none", "custody"),
  pet_transfer_cancelled: noticeKind(
    "account",
    "custody",
    "Quien te ofrecía la mascota canceló la transferencia antes de que la respondieras. No tenés que hacer nada.",
  ),
  pet_transfer_expired: petKind("none", "custody"),
  pet_transfer_initiated: sectionKind("pet", "counterparty", "custody", {
    counterpartyAction: "acepte la transferencia",
  }),
  pet_transfer_received: sectionKind("pet", "recipient", "custody", {
    action: "aceptá o rechazá la transferencia",
  }),
  pet_transfer_rejected: petKind("none", "custody"),
  post_adoption_checkin_due: petKind("recipient", "adoption", {
    action: "contale al refugio cómo está",
    petFace: "eventos/nuevo/checkin",
  }),
  post_adoption_checkin_missed: sectionKind("organization", "none", "adoption"),
  post_adoption_checkin_received: sectionKind("organization", "none", "adoption"),
  ppp_breed_list_updated_now_applies: petKind("recipient", null, {
    action: PPP_ACTION,
    petFace: "eventos/atestar-raza-peligrosa",
  }),
  ppp_registration_reminder: petKind("recipient", null, {
    action: PPP_ACTION,
    petFace: "eventos/atestar-raza-peligrosa",
  }),
  ppp_weight_threshold_updated_now_applies: petKind("recipient", null, {
    action: PPP_ACTION,
    petFace: "eventos/atestar-raza-peligrosa",
  }),
  pregnancy_ended_owner: petKind("none", "health"),
  pregnancy_started_owner: petKind("none", "health"),
  professional_event_amended: petKind("none", "health"),
  profile_self_updated: sectionKind("account", "none", null),
  rabies_observation_completed_dead_authority: sectionKind("jurisdiction", "recipient", "health", {
    action: REVIEW,
  }),
  rabies_observation_completed_professional_owner: petKind("none", "health"),
  rabies_observation_escalation_owner: petKind("recipient", "health", {
    action: "seguí las indicaciones de la observación antirrábica",
  }),
  rabies_observation_pending_review: sectionKind("jurisdiction", "recipient", "health", {
    action: REVIEW,
  }),
  rabies_observation_positive_authority: sectionKind("jurisdiction", "recipient", "health", {
    action: REVIEW,
  }),
  rabies_observation_started_owner: petKind("recipient", "health", {
    action: "cumplí la observación antirrábica",
  }),
  rabies_observation_window_expired_owner: petKind("none", "health"),
  rehome_request_accepted: caseKind("none", "custody"),
  rehome_request_declined: caseKind("none", "custody"),
  rehome_request_received: caseKind("recipient", "custody", {
    action: "respondé la solicitud",
  }),
  rehome_request_withdrawn: caseKind("none", "custody"),
  rehome_sponsorship_ended_by_death: caseKind("none", "custody"),
  rehome_sponsorship_withdrawn: caseKind("none", "custody"),
  revocation_executed_org: sectionKind("organization", "none", "admin"),
  revocation_executed_vet: sectionKind("account", "none", "admin"),
  self_resignation_confirmed: sectionKind("account", "none", "admin"),
  service_dog_credential_revoked: petKind("none", null, { petFace: "asistencia" }),
  service_offering_approved: sectionKind("organization", "none", null),
  service_offering_pending_authority: sectionKind("jurisdiction", "recipient", null, {
    action: "revisá el servicio",
  }),
  service_offering_rejected: sectionKind("organization", "none", null),
  service_offering_submitted: sectionKind("organization", "authority", null),
  shelter_intake_confirmed: sectionKind("organization", "none", "custody"),
  stub_profile_claimed: sectionKind("pet", "none", "custody"),
  tag_activated: sectionKind("account", "none", null),
  tag_revoked: sectionKind("account", "none", null),
  vaccine_due: petKind("recipient", "health", {
    action: "registrá la vacuna",
    petFace: "eventos/nuevo/vacuna",
  }),
  welcome: sectionKind("account", "recipient", null, { action: "cargá tu primera mascota" }),
  welfare_denuncia_stale_govt: caseKind("recipient", "welfare", { action: REVIEW }),
  welfare_org_intervention_note: sectionKind("jurisdiction", "none", "welfare"),
  welfare_org_intervention_returned: sectionKind("jurisdiction", "recipient", "welfare", {
    action: "decidí a quién derivar la denuncia",
  }),
  welfare_org_intervention_taken: sectionKind("jurisdiction", "none", "welfare"),
  welfare_org_side_confirmed_reporter: caseKind("authority", "welfare"),
  welfare_org_side_critical_received: caseKind("recipient", "welfare", { action: REVIEW }),
  welfare_report_derived_to_org: sectionKind("organization", "recipient", "welfare", {
    action: "hacé el seguimiento de la denuncia",
  }),
  welfare_report_rederived_away: sectionKind("organization", "none", "welfare"),
  welfare_report_status_changed: sectionKind("account", "authority", "welfare"),
} as const satisfies Record<string, NotificationKindSpec>;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

/** Every registered kind, sorted. */
export const NOTIFICATION_KIND_NAMES: readonly NotificationKind[] = (
  Object.keys(NOTIFICATION_KINDS) as NotificationKind[]
).sort();

/** The spec for a stored `notification_type`, or `null` for one the table does not name. */
export function notificationKindSpec(type: string): NotificationKindSpec | null {
  // `hasOwnProperty.call` rather than `Object.hasOwn`: this module also runs on
  // Hermes, and a stored type such as "constructor" must not reach the prototype.
  if (!Object.prototype.hasOwnProperty.call(NOTIFICATION_KINDS, type)) return null;
  return (NOTIFICATION_KINDS as Record<string, NotificationKindSpec | undefined>)[type] ?? null;
}

/**
 * The spec a row whose type this table does not name is resolved under.
 *
 * NOT A FAILURE AT READ TIME. The static fence keeps every CURRENT writer in the
 * table, but stored rows outlive the writers that made them: a type retired a
 * year ago still sits in somebody's inbox. Such a row resolves like a section
 * notice — its stored link if the viewer can open it, the explanation state
 * otherwise — rather than failing.
 */
export const UNKNOWN_NOTIFICATION_KIND_SPEC: NotificationKindSpec = {
  subject: "account",
  primaryDestination: "section",
  pendingActor: "none",
  category: null,
};
