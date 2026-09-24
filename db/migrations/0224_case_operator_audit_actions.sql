-- Migration 0224 — tres actos de operador sobre un expediente entran al registro.
--
-- QUÉ AGREGA
-- ---------------------------------------------------------------------------
--   case_note_recorded        una autoridad asentó una nota en un expediente
--   case_closed_manually      una autoridad dio por terminado un expediente
--   case_escalated_manually   una autoridad subió un expediente, sin esperar al cron
--
-- POR QUÉ AHORA, porque estas tres estuvieron esperando una decisión
-- ---------------------------------------------------------------------------
-- `scripts/audit-log-coverage-baseline.json` traía a dos de ellas desde el
-- 2026-08-16 con una pregunta abierta escrita al lado: el hecho ya vive en la
-- espina append-only `case_events`, que carga su propio autor, así que
-- "¿la consulta de rendición de cuentas espera encontrar esto en audit_log?"
-- era una decisión de producto y no una omisión.
--
-- Se responde que SÍ, y el motivo es la asimetría del costo. Una fila redundante
-- no le hace daño a nadie. Una consulta bajo la Ley 25.326 que NO encuentra que
-- una autoridad identificada cerró un expediente legal sí — y la ausencia de esa
-- fila es permanentemente indistinguible de la ausencia del acto que habría
-- descrito. La espina sigue registrando la AFIRMACIÓN; estas filas registran el
-- ACTO ADMINISTRATIVO, con su estado anterior y posterior.
--
-- Es el mismo argumento que escribió el cierre profesional de observación
-- antirrábica el 2026-08-17, aplicado al vecino.
--
-- LA TERCERA NACIÓ AUDITADA. `case_escalated_manually` acompaña a la escalada
-- manual que cierra #41: hasta hoy escalar existía SÓLO por cron (una disputa
-- sube a los 365 días, un handoff de decomiso trabado a los 7), y un operador
-- que veía hoy que hacía falta otra mirada no tenía cómo pedirla.
--
-- POR QUÉ EL ARCHIVO ES TAN LARGO
-- ---------------------------------------------------------------------------
-- Postgres no sabe agregar un valor a un CHECK: hay que soltarlo y rescribirlo
-- entero. La lista se GENERA desde `AUDIT_LOG_ACTIONS` (db/schema.ts), que es
-- el catálogo que la aplicación usa para tipar cada escritura, así que el CHECK
-- y el tipo no pueden divergir por un tipeo. `__tests__/audit-log-action-check.test.ts`
-- compara los dos conjuntos y falla si alguien rompe esa correspondencia.
--
-- Va ordenada alfabéticamente por la misma razón que sus predecesoras: un diff
-- de la próxima muestra la línea que se agregó y nada más.

ALTER TABLE public.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_action_valid;
ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_action_valid
  CHECK (action IN (
    'admin_deactivated_by_admin',
    'admin_seeded',
    'adopter_pii_viewed',
    'adoption_application_resolved',
    'adoption_application_submitted',
    'analytics_export_generated',
    'approval_request_withdrawn_by_applicant',
    'approval_request_withdrawn_by_system',
    'audit_log_mutation_override',
    'bite_reported_by_org',
    'capability_denied',
    'capability_granted',
    'capability_revoked',
    'caretaker_designated',
    'caretaker_grant_accepted',
    'caretaker_grant_cancelled',
    'caretaker_grant_rejected',
    'caretaker_grant_revoked',
    'caretaker_grant_withdrawn',
    'case_closed_manually',
    'case_escalated_manually',
    'case_events_mutation_override',
    'case_note_recorded',
    'claim_dispute_submitted',
    'cross_org_transfer_accepted',
    'cross_org_transfer_auto_expired',
    'cross_org_transfer_cancelled_by_sender',
    'cross_org_transfer_proposed',
    'cross_org_transfer_rejected',
    'decomiso_executed',
    'decomiso_handoff_accepted',
    'decomiso_handoff_cancelled',
    'decomiso_handoff_rejected',
    'decomiso_returned_to_owner',
    'dispute_escalated',
    'dispute_party_added',
    'dispute_raised',
    'dispute_resolved',
    'dispute_withdrawn',
    'dni_verified_self',
    'eno_backfill_run_completed',
    'eno_notification_emitted',
    'event_amended_sensitive',
    'evidence_viewed',
    'free_pet_claimed',
    'gob_dashboard_export_generated',
    'govt_business_rule_created',
    'govt_business_rule_deleted',
    'govt_business_rule_updated',
    'govt_deactivated_by_admin',
    'govt_locality_assigned',
    'govt_self_deactivated',
    'institutional_admin_created',
    'institutional_create_orphan_auth_user',
    'institutional_govt_created',
    'microchip.replace',
    'notification_fanout_empty',
    'operator_credentials_reset',
    'org_member_added',
    'org_member_event_write_changed',
    'org_member_removed',
    'org_member_role_changed',
    'org_unverified',
    'org_verified',
    'outbreak_investigation_closed_dismissed',
    'outbreak_investigation_closed_resolved',
    'outbreak_investigation_escalated',
    'outbreak_investigation_note_added',
    'outbreak_investigation_opened',
    'outreach_reminder_sent',
    'personal_self_deactivated',
    'personal_self_reactivated',
    'pet_events_mutation_override',
    'pet_transfer_accepted',
    'pet_transfer_cancelled',
    'pet_transfer_expired',
    'pet_transfer_initiated',
    'pet_transfer_rejected',
    'pii_queried',
    'ppp_export_generated',
    'profile_avatar_updated',
    'profile_avatar_upload_failed',
    'profile_self_updated',
    'rabies_observation_closed_professional',
    'request_approved',
    'request_info_requested',
    'request_rejected',
    'request_viewed',
    'revocation_admin_role',
    'revocation_govt_assignment',
    'revocation_govt_role',
    'revocation_org_verified',
    'revocation_scheduling',
    'revocation_vet_role',
    'scan_event_purged',
    'self_resignation_admin',
    'self_resignation_govt',
    'self_resignation_vet',
    'senasa_export_generated',
    'service_dog_credential_revoked',
    'sessions_revoked_self',
    'subject_data_exported',
    'subject_erasure',
    'tag.activate',
    'tag.lote_issue',
    'tag.revoke',
    'travel_export_generated',
    'welfare_location_viewed',
    'welfare_mpf_export_generated',
    'welfare_report_closed',
    'welfare_report_confirmed_spam',
    'welfare_report_derived_to_org',
    'welfare_report_escalated_to_admin',
    'welfare_report_started',
    'welfare_report_submitted_by_org',
    'welfare_report_triaged',
    'welfare_report_unflagged'
  ));
