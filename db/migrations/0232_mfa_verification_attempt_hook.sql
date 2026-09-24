-- Migration 0232 — a per-account ceiling on second-factor guesses that GoTrue
-- itself enforces, plus a freshness rule for enrolling a new factor.
--
-- THE GAP
-- ---------------------------------------------------------------------------
-- T2-S6 spends a per-account budget before the app forwards a TOTP code to
-- GoTrue (mfa-actions.ts, `auth_mfa_code_user`, 5/min 30/h). That budget lives
-- in the APP. Anyone holding an institutional password can sign in straight
-- against GoTrue and post codes to `/auth/v1/factors/{id}/verify` without ever
-- touching the app, and then the only ceiling left is GoTrue's per-IP rate
-- limit — which an attacker rotates away from. Six digits are a million codes
-- (three valid at any moment with the ±1 step window); an unbounded stream of
-- guesses finds one.
--
-- Second, enrolment is trust on first use (mfa-policy.ts). The app refuses to
-- enrol from a session that authenticated more than 15 minutes ago, but the
-- same direct-to-GoTrue caller never runs that check: an old aal1 token of an
-- account WITHOUT a factor (sessions live 30 days) can enrol the attacker's
-- phone.
--
-- THE FIX — GoTrue's "MFA verification attempt" hook
-- ---------------------------------------------------------------------------
-- GoTrue calls this function on EVERY factor verification, app or not, with
-- `{ factor_id, factor_type, user_id, valid }`, and honours `decision:
-- "reject"` — which also signs the user out of every session. So:
--
--   1. FAILURE CEILING, per account: 10 wrong codes in a clock hour or 20 in a
--      UTC day → every further attempt is rejected (even a correct code) until
--      the window rolls over. Counted in public.rate_limit_buckets under
--      `mfa_verify_fail:<user>:hour|day:<window start ms>`, the same key shape
--      and expiry the app's limiter uses (lib/infra/rate-limit.ts), so the
--      existing cleanup cron reaps them. At 20 guesses a day the chance of
--      hitting one of the three live codes is ~6·10⁻⁵ per day. Legitimate
--      mistyping does not come near 10 in an hour.
--
--   2. ENROLMENT FRESHNESS: a CORRECT code for a factor still `unverified` (the
--      enrolment step) is rejected unless the account's last real sign-in
--      (auth.users.last_sign_in_at — set by a password, a link or a code; a
--      token refresh and an MFA verification do NOT move it, measured on local
--      GoTrue v2.188.1) is at most 15 minutes old. Account-level, not session-
--      level (the payload names no session), which is weaker than the app's
--      rule but binds the path the app cannot see.
--
-- LOCKOUT BY AN ATTACKER (the review's LOW-5) is accepted, stated here: to
-- spend this budget one must already hold the password (no session, no verify
-- endpoint). An account being guessed at is an account whose password is out;
-- locking it for the hour is the right outcome, and the remedy is the admin
-- reset, which rotates the password and ends every session.
--
-- AVAILABILITY. This hook is a Teams / Enterprise feature on hosted Supabase
-- (docs: Auth Hooks → "MFA Verification Attempt"). Locally it is enabled in
-- supabase/config.toml [auth.hook.mfa_verification_attempt]. On a Pro project
-- the function exists but GoTrue never calls it: the app-side budget is then
-- the only ceiling and the direct-to-GoTrue path stays open — PO decision,
-- recorded in docs/pilotos/onboarding-municipio.md §3.1.
--
-- SECURITY DEFINER on purpose: rate_limit_buckets is RLS deny-all, and
-- supabase_auth_admin (the role GoTrue calls hooks as) has no BYPASSRLS. The
-- function is executable by supabase_auth_admin ONLY; anon / authenticated /
-- PUBLIC cannot call it through PostgREST.

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
