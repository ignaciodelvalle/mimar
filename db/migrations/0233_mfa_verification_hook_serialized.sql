-- Migration 0233 — serialize the MFA verification hook per account.
--
-- THE RACE (security review LOW-1 on 0232)
-- ---------------------------------------------------------------------------
-- public.hook_mfa_verification_attempt reads the account's failure buckets,
-- decides, and only then increments them. Under READ COMMITTED two concurrent
-- verifications of the same account both read the same count, both pass the
-- ceiling check, and both get to try a code: a burst of parallel requests
-- could spend more guesses than the 10/h 20/day ceiling allows.
--
-- THE FIX
-- ---------------------------------------------------------------------------
-- The function is redefined IDENTICALLY to 0232 except for one line: a
-- transaction-scoped advisory lock keyed on the account,
--   PERFORM pg_advisory_xact_lock(hashtextextended('mfa_verify:' || v_user::text, 0));
-- taken before the read. Verifications of one account now run one after the
-- other; different accounts never wait on each other. The lock is released when
-- GoTrue's hook transaction ends. Grants and the assertion block are copied
-- unchanged from 0232 (0232 is immutable; this file supersedes its body).
--
-- CORRECTION TO 0232's HEADER. 0232 says that locking an account by spending
-- its budget requires already holding the password ("no session, no verify
-- endpoint"). That is false: any LIVE session of the account suffices — a
-- leftover aal1 token from a stolen device or a shared computer can post codes
-- to /auth/v1/factors/{id}/verify without the password. The conclusion
-- stands (locking an account that is being guessed at is the right outcome),
-- and the remedy is still the admin "Restablecer segundo factor": it rotates
-- the password, ends every session and — since this change — also clears the
-- account's mfa_verify_fail:<user>:* buckets, so the person can enrol again
-- right away instead of waiting for the window to roll over.
--
-- AVAILABILITY is unchanged from 0232: the hook is a Teams / Enterprise
-- feature on hosted Supabase; on Pro the function exists but GoTrue never calls
-- it (docs/ops/cutover-debts.md).

BEGIN;

CREATE OR REPLACE FUNCTION public.hook_mfa_verification_attempt(event jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_factor uuid;
  v_valid boolean;
  v_now timestamptz := now();
  v_hour_start bigint;
  v_day_start bigint;
  v_hour_key text;
  v_day_key text;
  v_hour_count integer;
  v_day_count integer;
  v_factor_status text;
  v_last_sign_in timestamptz;
  c_hour_limit constant integer := 10;
  c_day_limit constant integer := 20;
  c_enrol_window constant interval := interval '15 minutes';
BEGIN
  v_user := (event ->> 'user_id')::uuid;
  v_factor := nullif(event ->> 'factor_id', '')::uuid;
  v_valid := coalesce((event ->> 'valid')::boolean, false);

  v_hour_start := (floor(extract(epoch FROM v_now) / 3600) * 3600 * 1000)::bigint;
  v_day_start := (floor(extract(epoch FROM v_now) / 86400) * 86400 * 1000)::bigint;
  v_hour_key := format('mfa_verify_fail:%s:hour:%s', v_user, v_hour_start);
  v_day_key := format('mfa_verify_fail:%s:day:%s', v_user, v_day_start);

  PERFORM pg_advisory_xact_lock(hashtextextended('mfa_verify:' || v_user::text, 0));

  SELECT coalesce(max(b.count) FILTER (WHERE b.bucket_key = v_hour_key), 0),
         coalesce(max(b.count) FILTER (WHERE b.bucket_key = v_day_key), 0)
    INTO v_hour_count, v_day_count
    FROM public.rate_limit_buckets b
   WHERE b.bucket_key IN (v_hour_key, v_day_key);

  -- Already over the ceiling: nothing gets through, not even a correct code.
  IF v_hour_count >= c_hour_limit OR v_day_count >= c_day_limit THEN
    RETURN jsonb_build_object(
      'decision', 'reject',
      'message', 'Demasiados códigos incorrectos. Esperá y volvé a iniciar sesión, o pedile a un admin que restablezca tu segundo factor.'
    );
  END IF;

  IF NOT v_valid THEN
    INSERT INTO public.rate_limit_buckets (bucket_key, count, expires_at)
    VALUES (v_hour_key, 1, to_timestamp((v_hour_start + 3600000) / 1000.0)),
           (v_day_key, 1, to_timestamp((v_day_start + 86400000) / 1000.0))
    ON CONFLICT (bucket_key) DO UPDATE SET count = public.rate_limit_buckets.count + 1;
    -- A wrong code is refused by GoTrue on its own; `continue` keeps its
    -- default answer (and lets this row commit).
    RETURN jsonb_build_object('decision', 'continue');
  END IF;

  -- A correct code for a factor that is not verified yet is an ENROLMENT.
  SELECT f.status::text INTO v_factor_status FROM auth.mfa_factors f WHERE f.id = v_factor;
  IF v_factor_status IS DISTINCT FROM 'verified' THEN
    SELECT u.last_sign_in_at INTO v_last_sign_in FROM auth.users u WHERE u.id = v_user;
    IF v_last_sign_in IS NULL OR v_last_sign_in < v_now - c_enrol_window THEN
      RETURN jsonb_build_object(
        'decision', 'reject',
        'message', 'Para configurar la verificación en dos pasos tenés que haber iniciado sesión hace menos de 15 minutos. Volvé a iniciar sesión.'
      );
    END IF;
  END IF;

  RETURN jsonb_build_object('decision', 'continue');
END;
$$;

COMMENT ON FUNCTION public.hook_mfa_verification_attempt(jsonb) IS
  'GoTrue MFA verification attempt hook (migration 0232): per-account failure ceiling (10/h, 20/day) and enrolment freshness (last sign-in within 15 min). Executable by supabase_auth_admin only.';

REVOKE ALL ON FUNCTION public.hook_mfa_verification_attempt(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hook_mfa_verification_attempt(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.hook_mfa_verification_attempt(jsonb) FROM authenticated;
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.hook_mfa_verification_attempt(jsonb) TO supabase_auth_admin;

DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.hook_mfa_verification_attempt(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.hook_mfa_verification_attempt(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Migration 0232: the MFA hook is callable through PostgREST';
  END IF;
  IF NOT has_function_privilege('supabase_auth_admin', 'public.hook_mfa_verification_attempt(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Migration 0232: supabase_auth_admin cannot execute the MFA hook';
  END IF;
END
$$;

COMMIT;
