-- Migration 0087: V1-2 privacy/legal completeness (Ley 25.326).
--
-- Three independent fixes bundled because they share the subject-rights domain
-- and are exercised by the same test suite:
--
--   A — Provable consent (art. 5). Add profiles.tos_accepted_at + tos_version so
--       the TOS/privacy acceptance collected at signup is PERSISTED and can be
--       demonstrated. Today the checkbox is validated then discarded.
--
--   B — Complete erasure (art. 16). erase_subject_data left PII in several
--       profile columns and in welfare_reports / pet_transfers /
--       org_contact_messages. Extend the RPC to cover them, and DOCUMENT the
--       categories deliberately retained under the art. 16 retention exemption.
--
--   C — Complete export (art. 14). export_subject_data omitted whole relations
--       the subject is party to (welfare reports filed, custody disputes,
--       transfers, notifications, org memberships, audit rows about them).
--       Extend the JSON and bump its schema version.
--
-- Both RPCs keep SECURITY DEFINER + the auth.uid() self-or-admin guard from
-- migration 0059. The whole file is idempotent and safe to re-run.

BEGIN;

-- ============================================================================
-- A — Provable consent columns (art. 5)
-- ============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS tos_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS tos_version    text;

COMMENT ON COLUMN public.profiles.tos_accepted_at IS
  'Ley 25.326 art. 5 — timestamp the user accepted the Terms + Privacy Policy at signup. NULL for pre-0087 / admin-provisioned accounts.';
COMMENT ON COLUMN public.profiles.tos_version IS
  'Ley 25.326 art. 5 — LEGAL_VERSION (lib/legal-version.ts) in force when consent was given. Proves WHAT was accepted.';

-- ============================================================================
-- C — Export: derecho de acceso (art. 14) — now returns ALL data held about
--     the subject, not just profile + pets + identifications + events.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.export_subject_data(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pii, pg_temp
AS $$
DECLARE
  result jsonb;
BEGIN
  IF auth.uid() IS NULL OR (auth.uid() <> p_user_id AND NOT pii.caller_is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'profile', (
      SELECT row_to_json(p)::jsonb
        FROM public.profiles p
       WHERE p.id = p_user_id
    ),
    'pets', COALESCE((
      SELECT jsonb_agg(row_to_json(pe)::jsonb)
        FROM public.pets pe
        JOIN public.ownerships o ON o.pet_id = pe.id
       WHERE o.owner_user_id = p_user_id
         AND o.ended_at IS NULL
         AND pe.deleted_at IS NULL
    ), '[]'::jsonb),
    'identifications', COALESCE((
      SELECT jsonb_agg(row_to_json(pi)::jsonb)
        FROM public.pet_identifications pi
        JOIN public.ownerships o ON o.pet_id = pi.pet_id
       WHERE o.owner_user_id = p_user_id
         AND o.ended_at IS NULL
         AND pi.deleted_at IS NULL
    ), '[]'::jsonb),
    'pet_events', COALESCE((
      SELECT jsonb_agg(row_to_json(ev)::jsonb)
        FROM public.pet_events ev
        JOIN public.ownerships o ON o.pet_id = ev.pet_id
       WHERE o.owner_user_id = p_user_id
         AND o.ended_at IS NULL
    ), '[]'::jsonb),
    -- art. 14 additions: relations the subject is directly party to. -----------
    -- Welfare reports the subject FILED (reporter_user_id). Self-identifying PII
    -- in description/contact fields is their own data.
    'welfare_reports_filed', COALESCE((
      SELECT jsonb_agg(row_to_json(wr)::jsonb)
        FROM public.welfare_reports wr
       WHERE wr.reporter_user_id = p_user_id
    ), '[]'::jsonb),
    -- Custody disputes the subject is party to — either raised by them or listed
    -- as a party. Distinct on dispute id so a self-raised + self-party dispute
    -- is not duplicated.
    'custody_disputes', COALESCE((
      SELECT jsonb_agg(row_to_json(cd)::jsonb)
        FROM public.custody_disputes cd
       WHERE cd.deleted_at IS NULL
         AND (
           cd.raised_by_user_id = p_user_id
           OR EXISTS (
             SELECT 1 FROM public.custody_dispute_parties cdp
              WHERE cdp.dispute_id = cd.id
                AND cdp.party_user_id = p_user_id
           )
         )
    ), '[]'::jsonb),
    -- Pet transfers the subject initiated (from_owner_id) or is the target of
    -- (to_owner_id, or to_owner_email matching their auth email).
    'pet_transfers', COALESCE((
      SELECT jsonb_agg(row_to_json(pt)::jsonb)
        FROM public.pet_transfers pt
       WHERE pt.from_owner_id = p_user_id
          OR pt.to_owner_id = p_user_id
          OR pt.to_owner_email = (SELECT u.email FROM auth.users u WHERE u.id = p_user_id)
    ), '[]'::jsonb),
    -- Notifications addressed to the subject.
    'notifications', COALESCE((
      SELECT jsonb_agg(row_to_json(n)::jsonb)
        FROM public.notifications n
       WHERE n.user_id = p_user_id
    ), '[]'::jsonb),
    -- Organization memberships the subject holds (active + historical).
    'organization_memberships', COALESCE((
      SELECT jsonb_agg(row_to_json(om)::jsonb)
        FROM public.organization_memberships om
       WHERE om.user_id = p_user_id
    ), '[]'::jsonb),
    -- Audit rows where the subject is the actor or the target — personal data
    -- "held about the subject" in the sense of art. 14.
    'audit_log', COALESCE((
      SELECT jsonb_agg(row_to_json(al)::jsonb)
        FROM public.audit_log al
       WHERE al.actor_user_id = p_user_id
          OR al.target_user_id = p_user_id
    ), '[]'::jsonb),
    'schema_version', 2,
    'exported_at', now(),
    'exported_under', 'Ley 25.326 art. 14',
    'subject_user_id', p_user_id
  ) INTO result;

  -- Audit. Actor is the caller; target is the subject.
  INSERT INTO public.audit_log (actor_user_id, action, target_user_id, payload)
  VALUES (
    auth.uid(),
    'subject_data_exported',
    p_user_id,
    jsonb_build_object(
      'norma', 'Ley 25.326 art. 14',
      'self_export', auth.uid() = p_user_id
    )
  );

  RETURN result;
END;
$$;

-- ============================================================================
-- B — Erase: derecho de supresión (art. 16) — now scrubs ALL the PII-bearing
--     columns/tables the subject controls.
-- ============================================================================
--
-- Retained under the art. 16 retention exemption (NOT erased, by design):
--
--   * pet_events / libreta sanitaria payloads — mandatory sanitary record
--     retention (Res. SENASA, Ley 14.072 ejercicio profesional). Already
--     preserved by 0059; unchanged here.
--   * audit_log payloads — legal traceability / accountability of who did what
--     and when. Removing actor attribution would defeat the audit trail. The
--     subject's display_name is hashed at the profiles level, so audit rows no
--     longer resolve to a readable name.
--   * welfare_reports authored BY OTHERS where the subject is the *reported
--     party* (subject_kind / subject_pet_id) — that is a third party's denuncia,
--     not the subject's own data, and is retained under Ley 14.346.
--   * welfare_reports.location_lat / location_lng — incident-site coordinates
--     attached to the denuncia, not the reporter's home address; retained for
--     the denuncia record's geographic integrity under Ley 14.346.
--   * welfare_reports.subject_description — describes the reported animal, not
--     the reporter; retained as part of the denuncia record under Ley 14.346.
--   * pet_transfers.to_owner_email when the row belongs to ANOTHER transfer not
--     initiated by or targeting the subject — not the subject's PII to erase.
--   * Counter-party identities on transfers / disputes — the other party's PII
--     is retained for their own record and the transaction's integrity.
--
-- Everything the subject themselves contributed is scrubbed below.

CREATE OR REPLACE FUNCTION public.erase_subject_data(p_user_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pii, pg_temp
AS $$
DECLARE
  pets_marked      int;
  subject_email    text;
BEGIN
  IF auth.uid() IS NULL OR (auth.uid() <> p_user_id AND NOT pii.caller_is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT u.email INTO subject_email FROM auth.users u WHERE u.id = p_user_id;

  -- Profile: hash display_name, null every direct + third-party PII column.
  -- preferred_vet_* is third-party PII the subject stored; avatar_url is a face
  -- photo; matricula_* is professional-license PII. All scrubbed.
  UPDATE public.profiles
     SET display_name             = 'erased:' || md5(id::text),
         phone                    = NULL,
         dni_number               = NULL,
         emergency_contact_name   = NULL,
         emergency_contact_phone  = NULL,
         preferred_vet_name       = NULL,
         preferred_vet_phone      = NULL,
         avatar_url               = NULL,
         matricula_number         = NULL,
         matricula_jurisdiccion   = NULL,
         deleted_at               = now(),
         updated_at               = now()
   WHERE id = p_user_id;

  -- Owned pets → soft-delete (sanitary events on them are retained).
  WITH affected AS (
    UPDATE public.pets
       SET deleted_at = now(),
           updated_at = now()
     WHERE id IN (
       SELECT pet_id FROM public.ownerships
        WHERE owner_user_id = p_user_id
          AND ended_at IS NULL
     )
       AND deleted_at IS NULL
    RETURNING id
  )
  SELECT count(*) INTO pets_marked FROM affected;

  -- Welfare reports the subject FILED: scrub reporter contact fields and the
  -- free-text location address (which may be the reporter's own home address).
  -- Redact the description (reporters self-identify in it). The report stays so
  -- the Ley 14.346 denuncia record and its workflow remain intact.
  -- location_lat/lng (incident site) and subject_description (describes the
  -- reported animal) are retained under the art. 16 exemption — see header.
  UPDATE public.welfare_reports
     SET reporter_contact_email = NULL,
         reporter_contact_phone = NULL,
         location_address = NULL,
         description = '[contenido eliminado a pedido del titular]'
   WHERE reporter_user_id = p_user_id;

  -- Pet transfers where the subject is a party and the transfer is still
  -- pending: cancel first so the accept-time email lookup cannot hit the
  -- erased sentinel and leave the transfer silently stuck.
  UPDATE public.pet_transfers
     SET status = 'cancelled',
         updated_at = now()
   WHERE (from_owner_id = p_user_id
          OR to_owner_id = p_user_id
          OR (subject_email IS NOT NULL AND to_owner_email = subject_email))
     AND status = 'pending';

  -- Pet transfers initiated by or targeting the subject: null the recipient
  -- email (the subject's PII when they are the recipient; their counterparty's
  -- PII when they initiated — either way the email is scrubbed as part of the
  -- subject's footprint). Counterparty profile FKs are left intact.
  UPDATE public.pet_transfers
     SET to_owner_email = 'erased@invalid.local'
   WHERE (from_owner_id = p_user_id
          OR to_owner_id = p_user_id
          OR (subject_email IS NOT NULL AND to_owner_email = subject_email))
     AND to_owner_email <> 'erased@invalid.local';

  -- Org contact messages the subject sent (matched by their email): null the
  -- inquirer email. Free-text message body is left — it is addressed to the org
  -- as business correspondence and is not reliably the subject's identifying PII.
  IF subject_email IS NOT NULL THEN
    UPDATE public.org_contact_messages
       SET inquirer_email = 'erased@invalid.local',
           inquirer_name  = NULL
     WHERE inquirer_email = subject_email
       AND inquirer_email <> 'erased@invalid.local';
  END IF;

  INSERT INTO public.audit_log (actor_user_id, action, target_user_id, payload)
  VALUES (
    auth.uid(),
    'subject_erasure',
    p_user_id,
    jsonb_build_object(
      'reason', p_reason,
      'norma', 'Ley 25.326 art. 16',
      'self_erasure', auth.uid() = p_user_id,
      'pets_soft_deleted', pets_marked
    )
  );
END;
$$;

-- ============================================================================
-- Permisos (unchanged from 0059; re-granted for idempotency).
-- ============================================================================

REVOKE ALL ON FUNCTION public.export_subject_data(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.export_subject_data(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.erase_subject_data(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.erase_subject_data(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.export_subject_data(uuid) IS
  'Ley 25.326 art. 14 — derecho de acceso. JSON v2 con perfil + mascotas + identificaciones + eventos + denuncias + disputas + transferencias + notificaciones + membresías + auditoría. Auth: self o admin institucional.';
COMMENT ON FUNCTION public.erase_subject_data(uuid, text) IS
  'Ley 25.326 art. 16 — derecho de supresión. Hash de display_name + null de toda PII directa y de terceros en profiles/welfare_reports/pet_transfers/org_contact_messages. Retiene eventos sanitarios y auditoría (exención de conservación). Auth: self o admin institucional.';

-- Tell PostgREST to refresh its schema cache so the new RPCs are visible.
NOTIFY pgrst, 'reload schema';

COMMIT;
