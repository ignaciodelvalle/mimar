// Single source of truth for audit-log action → human es-AR label.
//
// Admin fresh-sweep A5: /admin/auditoria and /admin/historial each carried their
// OWN inline ACTION_LABELS map. The auditoria one had only 11 entries, so most
// actions (e.g. pet_events_mutation_override) rendered as the raw code. This is
// the union (historial's comprehensive map); both pages import it via
// auditActionLabel().
//
// "Add new actions here when they appear" was the whole mechanism, and a request
// is not a mechanism: 11 codes drifted out of this map unnoticed, among them
// case_events_mutation_override — the sibling of the very action cited above as
// the reason this file exists. The drift was invisible twice over.
// auditActionLabel() falls back to the raw code, so an operator just read English
// snake_case; and buildAuditActionOptions() builds the filter <select> by
// iterating THIS object, so an unlabeled action had no option at all and its rows
// were unreachable through the product's own filter on all three audit screens.
// An auditor could not ask "who amended a sensitive event".
//
// The completeness check below is the mechanism. Note what it does NOT do: key
// the object on AuditLogAction. Tried that first, and it is wrong — this map
// deliberately holds RETIRED codes alongside current ones (revocation_org,
// microchip_replaced, deactivation_govt …) so that buildAuditActionOptions can
// group by label and emit one option whose value carries every alias, keeping
// historical rows filterable. audit_log is permanent; a code leaving the SSOT
// does not delete decades of rows written under it. So: extra keys allowed,
// missing keys forbidden.

import type { AuditLogAction } from "@/db";

// No `Record<string, string>` annotation: it erases the literal keys, and the
// literal keys are exactly what the completeness check at the bottom needs.
export const AUDIT_ACTION_LABELS = {
  // Approval queue
  request_approved: "Solicitud aprobada",
  request_rejected: "Solicitud rechazada",
  request_info_requested: "Más información solicitada",
  request_viewed: "Solicitud vista",
  evidence_viewed: "Evidencia vista",
  approval_request_withdrawn_by_applicant: "Solicitud retirada por aplicante",
  approval_request_withdrawn_by_system: "Solicitud vencida (sistema)",
  // Revocations
  revocation_vet: "Revocación matrícula",
  revocation_vet_role: "Revocación matrícula veterinaria",
  revocation_org: "Revocación verificación org",
  revocation_org_verified: "Revocación verificación org",
  revocation_govt_assignment: "Revocación localidad gobierno",
  revocation_govt_role: "Revocación rol gobierno",
  revocation_admin_role: "Revocación rol admin",
  revocation_scheduling: "Revocación scheduling",
  service_dog_credential_revoked: "Credencial animal de asistencia revocada",
  // Deactivations
  deactivation_govt: "Desactivación cuenta gobierno",
  deactivation_admin: "Desactivación cuenta admin",
  govt_deactivated_by_admin: "Desactivación cuenta gobierno (por admin)",
  admin_deactivated_by_admin: "Desactivación cuenta admin (por admin)",
  govt_self_deactivated: "Baja voluntaria cuenta gobierno",
  // Admin actions
  pii_queried: "Búsqueda de información personal",
  admin_seeded: "Admin inicializado",
  operator_credentials_reset: "Credenciales de operador reiniciadas",
  mfa_factor_enrolled: "Segundo factor configurado",
  mfa_factors_reset_by_admin: "Segundo factor restablecido por un admin",
  institutional_create_orphan_auth_user: "Usuario institucional creado sin perfil",
  institutional_govt_created: "Cuenta gobierno creada",
  institutional_admin_created: "Cuenta admin creada",
  institutional_national_created: "Observador nacional creado",
  govt_locality_assigned: "Localidad asignada a usuario gobierno",
  // Profile / account
  profile_self_updated: "Perfil actualizado",
  profile_avatar_updated: "Avatar actualizado",
  profile_avatar_upload_failed: "Subida de avatar fallida",
  self_resignation_vet: "Baja voluntaria matrícula veterinaria",
  self_resignation_govt: "Baja voluntaria cuenta gobierno",
  self_resignation_admin: "Baja voluntaria cuenta admin",
  dni_verified_self: "DNI verificado por el titular",
  // B11. Names the ACT, not the button: an operator reading a trail after an
  // incident cares that every session was cut, not which surface asked.
  sessions_revoked_self: "Cierre de sesión en todos los dispositivos",
  // Disputes
  dispute_raised: "Disputa de custodia abierta",
  dispute_party_added: "Parte añadida a disputa",
  dispute_resolved: "Disputa de custodia resuelta",
  dispute_withdrawn: "Disputa de custodia retirada",
  dispute_escalated: "Disputa escalada a vía judicial",
  claim_dispute_submitted: "Reclamo de custodia enviado",
  free_pet_claimed: "Animal sin dueño reclamado",
  // Welfare
  welfare_report_triaged: "Denuncia de maltrato en revisión",
  welfare_report_started: "Seguimiento de denuncia iniciado",
  welfare_report_closed: "Denuncia de maltrato cerrada",
  welfare_report_unflagged: "Denuncia desflagged (moderación)",
  welfare_report_confirmed_spam: "Denuncia marcada como spam",
  welfare_report_submitted_by_org: "Denuncia enviada por organización",
  welfare_report_derived_to_org: "Denuncia derivada a organización",
  welfare_location_viewed: "Ubicación de caso consultada",
  welfare_mpf_export_generated: "Exportación MPF generada",
  welfare_report_escalated_to_admin: "Denuncia escalada a administración",
  // Decomisos
  decomiso_executed: "Decomiso ejecutado",
  decomiso_handoff_accepted: "Entrega de decomiso aceptada",
  decomiso_handoff_rejected: "Entrega de decomiso rechazada",
  decomiso_handoff_cancelled: "Entrega de decomiso cancelada",
  decomiso_returned_to_owner: "Decomiso: animal devuelto a su titular",
  // Cross-org transfers
  cross_org_transfer_proposed: "Transferencia entre orgs propuesta",
  cross_org_transfer_accepted: "Transferencia entre orgs aceptada",
  cross_org_transfer_rejected: "Transferencia entre orgs rechazada",
  cross_org_transfer_cancelled_by_sender: "Transferencia entre orgs cancelada",
  cross_org_transfer_auto_expired: "Transferencia entre orgs vencida",
  // Adoption
  adoption_application_submitted: "Solicitud de adopción enviada",
  adoption_application_resolved: "Solicitud de adopción resuelta",
  // Business rules
  govt_business_rule_created: "Regla de negocio creada",
  govt_business_rule_updated: "Regla de negocio actualizada",
  govt_business_rule_deleted: "Regla de negocio eliminada",
  // Org membership
  org_member_added: "Miembro agregado a organización",
  org_member_removed: "Miembro removido de organización",
  org_member_role_changed: "Rol de miembro cambiado",
  org_member_event_write_changed: "Acceso clínico de miembro actualizado",
  org_verified: "Organización verificada",
  org_unverified: "Verificación de organización revocada",
  // Microchip
  "microchip.replace": "Microchip reemplazado",
  microchip_replaced: "Microchip reemplazado",
  // Outbreak
  outbreak_investigation_opened: "Investigación de brote abierta",
  outbreak_investigation_escalated: "Investigación de brote escalada",
  outbreak_investigation_closed_resolved: "Investigación de brote cerrada (resuelta)",
  outbreak_investigation_closed_dismissed: "Investigación de brote cerrada (descartada)",
  outbreak_investigation_note_added: "Nota de investigación de brote añadida",
  // Rabies observation
  rabies_observation_closed_professional: "Observación antirrábica cerrada por profesional",
  bite_reported_by_org: "Mordedura reportada por organización",
  // ENO
  eno_notification_emitted: "Notificación ENO emitida",
  eno_backfill_run_completed: "Backfill ENO ejecutado",
  // Pet transfers
  pet_transfer_initiated: "Transferencia de mascota iniciada",
  pet_transfer_accepted: "Transferencia de mascota aceptada",
  pet_transfer_rejected: "Transferencia de mascota rechazada",
  pet_transfer_cancelled: "Transferencia de mascota cancelada",
  pet_transfer_expired: "Transferencia de mascota vencida",
  // Cuidador temporal (custodia-temporal). "Cuidador", never "custodia" — the
  // vocabulary MasSheet.helpers.test.ts locks for this feature.
  caretaker_designated: "Cuidador temporal designado",
  caretaker_grant_accepted: "Cuidado temporal aceptado",
  // The four ENDINGS read differently on purpose: the actor is what the reader
  // is looking for, and "terminado" four times would erase exactly that.
  // Rechazada/cancelada are the invitation (nobody was caring yet); revocado y
  // dado de baja son el cuidado en curso.
  caretaker_grant_rejected: "Invitación de cuidado rechazada",
  caretaker_grant_cancelled: "Invitación de cuidado cancelada",
  caretaker_grant_revoked: "Cuidado temporal revocado",
  caretaker_grant_withdrawn: "Cuidado temporal dado de baja por el cuidador",
  // Exports
  analytics_export_generated: "Exportación analytics generada",
  gob_dashboard_export_generated: "Exportación CSV de dashboard",
  // Named for the DATA CLASS, not the destination: this is the one govt export
  // in the list that ships one row per animal, and the filter dropdown is where
  // an auditor has to be able to tell it apart from the aggregate ones.
  senasa_export_generated: "Exportación SENASA (lote de eventos sanitarios)",
  ppp_export_generated: "Exportación PPP generada",
  travel_export_generated: "Exportación de viaje generada",
  // Pet events override
  pet_events_mutation_override: "Mutación forzada de evento de mascota (override)",
  // The sibling this file's header cites, and the one that drifted out of it.
  case_events_mutation_override: "Mutación forzada de evento de caso (override)",
  // Actos de operador sobre un expediente (#41). El hecho ya vive en la espina
  // append-only `case_events`, que carga su propio autor; estas filas registran
  // el ACTO ADMINISTRATIVO, que es lo que una consulta de rendición de cuentas
  // sobre `audit_log` espera encontrar. Mismo argumento que el cierre
  // profesional de observación antirrábica escribió el 2026-08-17.
  case_note_recorded: "Nota de operador asentada en un expediente",
  case_closed_manually: "Expediente cerrado a mano por un operador",
  case_escalated_manually: "Expediente escalado a mano por un operador",
  audit_log_mutation_override: "Mutación forzada del registro de auditoría (override)",
  // Chapas físicas (tag lifecycle). Dotted codes, like microchip.replace.
  "tag.lote_issue": "Lote de chapas emitido",
  "tag.activate": "Chapa activada",
  "tag.revoke": "Chapa revocada",
  // Sensitive-event amendment and purge
  event_amended_sensitive: "Evento sensible corregido",
  scan_event_purged: "Escaneo purgado por retención",
  // Outreach
  outreach_reminder_sent: "Recordatorios de alcance enviados",
  // Account lifecycle
  personal_self_deactivated: "Baja voluntaria de cuenta personal",
  personal_self_reactivated: "Reactivación voluntaria de cuenta personal",
  // Subject rights
  subject_data_exported: "Datos del titular exportados",
  subject_erasure: "Datos del titular eliminados",
  // PII
  adopter_pii_viewed: "Datos del adoptante vistos",
  // Capability grant lifecycle (Lote B1)
  capability_granted: "Permiso concedido",
  capability_denied: "Permiso denegado",
  capability_revoked: "Permiso revocado",
  // Routing (migration 0187) — the notification reached NOBODY. Labelled as the
  // operational gap it is, not as an action somebody performed.
  notification_fanout_empty: "Aviso sin destinatarios",
};

/**
 * COMPLETENESS CHECK. Every action in the SSOT must have a label here; retired
 * codes may also appear and are deliberate (see the header).
 *
 * When this breaks, the compiler error names the offenders directly: it reads
 * "Type 'true' is not assignable to type '<the codes you forgot>'". That is the
 * whole point — `pnpm typecheck` runs first in `pnpm verify`, so a code added to
 * AUDIT_LOG_ACTIONS without a label here cannot reach a build, let alone an
 * operator's screen or a filter dropdown that silently omits it.
 */
type UnlabelledAuditActions = Exclude<AuditLogAction, keyof typeof AUDIT_ACTION_LABELS>;
const _everyAuditActionHasALabel: [UnlabelledAuditActions] extends [never]
  ? true
  : UnlabelledAuditActions = true;
void _everyAuditActionHasALabel;

/** Human es-AR label for an audit action, falling back to the raw code. */
export function auditActionLabel(action: string): string {
  // The cast is the price of literal keys above. It is safe and the fallback is
  // load-bearing: audit_log rows are permanent, so this renders codes retired
  // before an alias was ever added for them.
  return (AUDIT_ACTION_LABELS as Record<string, string>)[action] ?? action;
}
