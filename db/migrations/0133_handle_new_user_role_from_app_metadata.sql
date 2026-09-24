-- Migration 0133: handle_new_user() reads the initial role from app_metadata,
-- not user_metadata (CRITICAL-1 — self-minted admin).
--
-- Adversarial authz audit 2026-07-04 finding CRITICAL-1. The signup trigger
-- handle_new_user() set profiles.role from
--   new.raw_user_meta_data->>'user_role'
-- but raw_user_meta_data IS user_metadata — CLIENT-WRITABLE via the public
-- anon key. Any anonymous caller could self-mint an admin with:
--   supabase.auth.signUp({ email, password,
--     options: { data: { user_role: 'admin' } } })
-- because options.data lands in raw_user_meta_data, which the trigger trusted.
--
-- Fix: read the role from raw_APP_meta_data instead. app_metadata is writable
-- ONLY by the service role (supabase.auth.admin.createUser({ app_metadata }))
-- or server-side admin APIs — never by the anon/authenticated client. The value
-- is validated against the user_role enum and defaults to 'owner' on anything
-- unexpected (an invalid enum cast would otherwise abort the entire signup
-- insert).
--
-- Regular self-serve citizen signups carry no app_metadata.user_role → they
-- correctly become 'owner'. Institutional (govt/admin) accounts are created by
-- the service role, which now passes app_metadata.user_role; those flows also
-- UPDATE the role explicitly inside their transaction, so they are unaffected
-- either way.
--
-- Kept in sync with db/triggers.sql. Idempotent (CREATE OR REPLACE).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_display_name text;
  requested_role text;
  resolved_role public.user_role;
begin
  resolved_display_name := coalesce(
    new.raw_user_meta_data->>'display_name',
    split_part(new.email, '@', 1)
  );

  -- Role is read from app_metadata (service-role-only), never user_metadata
  -- (client-writable). Validate against the allowed set and fall back to
  -- 'owner' on anything unexpected.
  requested_role := nullif(new.raw_app_meta_data->>'user_role', '');
  resolved_role := case
    when requested_role in ('owner', 'vet', 'govt', 'admin')
      then requested_role::public.user_role
    else 'owner'::public.user_role
  end;

  insert into public.profiles (id, role, display_name)
  values (
    new.id,
    resolved_role,
    resolved_display_name
  );

  insert into public.notifications (user_id, notification_type, title, body, severity, cta_label, cta_url)
  values (
    new.id,
    'welcome',
    '¡Bienvenido a DIM, ' || resolved_display_name || '!',
    'La libreta digital de tu mascota empieza acá. Empezá agregando tu primera mascota — vamos a generar su credencial digital y armar el historial juntos.',
    'info'::public.notification_severity,
    'Registrá tu primera mascota',
    '/mis-mascotas/nueva'
  );

  return new;
end;
$$;
