-- Subject rights RPCs (compliance handoff PR 1, Ley 25.326 arts. 14 + 16).
--
-- export_subject_data(p_user_id) — derecho de acceso (Art. 14). Devuelve un
-- JSON con el perfil del usuario + sus mascotas + identificaciones + eventos.
-- Solo accesible al propio sujeto o a un admin institucional activo.
--
-- erase_subject_data(p_user_id, p_reason) — derecho de supresión (Art. 16).
-- Soft-delete con hash de PII; conserva datos cuya retención es obligatoria
-- por norma (eventos sanitarios, libreta).
--
-- Ambos son SECURITY DEFINER porque corren con auth.uid() vs la fila objetivo.

BEGIN;

-- ----------------------------------------------------------------------------
-- Helper local: verifica si el caller es un admin institucional activo.
-- Inline para no depender de un is_admin() externo (no existe en el repo).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pii.caller_is_admin(p_caller_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = p_caller_id
       AND role = 'admin'
       AND account_type = 'institutional'
       AND deactivated_at IS NULL
  );
$$;

-- ----------------------------------------------------------------------------
-- Export — Art. 14 Ley 25.326 (derecho de acceso)
-- ----------------------------------------------------------------------------

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

-- ----------------------------------------------------------------------------
-- Erase — Art. 16 Ley 25.326 (derecho de supresión)
-- ----------------------------------------------------------------------------
-- Soft-delete: el perfil queda con PII hasheada y deleted_at marcado.
-- Las mascotas asociadas reciben deleted_at; sus eventos sanitarios (libreta)
-- se preservan para la conservación obligatoria por norma (Res. SENASA, Ley
-- 14.072 ejercicio profesional, etc).

CREATE OR REPLACE FUNCTION public.erase_subject_data(p_user_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pii, pg_temp
AS $$
DECLARE
  pets_marked int;
BEGIN
  IF auth.uid() IS NULL OR (auth.uid() <> p_user_id AND NOT pii.caller_is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  UPDATE public.profiles
     SET display_name = 'erased:' || md5(id::text),
         phone = NULL,
         dni_number = NULL,
         emergency_contact_name = NULL,
         emergency_contact_phone = NULL,
         deleted_at = now(),
         updated_at = now()
   WHERE id = p_user_id;

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

-- ----------------------------------------------------------------------------
-- Permisos: solo authenticated puede llamar; service_role queda libre.
-- ----------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.export_subject_data(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.export_subject_data(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.erase_subject_data(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.erase_subject_data(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION pii.caller_is_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pii.caller_is_admin(uuid) TO authenticated;

COMMENT ON FUNCTION public.export_subject_data(uuid) IS
  'Ley 25.326 art. 14 — derecho de acceso. Devuelve JSON con datos del sujeto. Auth: self o admin institucional.';
COMMENT ON FUNCTION public.erase_subject_data(uuid, text) IS
  'Ley 25.326 art. 16 — derecho de supresión. Soft-delete + hash de PII. Auth: self o admin institucional.';

-- Tell PostgREST to refresh its schema cache so the new RPCs are visible
-- without a service restart. Harmless if PostgREST is not running.
NOTIFY pgrst, 'reload schema';

COMMIT;
