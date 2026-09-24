-- Migration 0134: handle_new_user() NEVER trusts request metadata for the role.
-- Every trigger-created profile defaults to 'owner'; privileged roles are set
-- EXCLUSIVELY by an explicit service-role UPDATE after the auth user exists.
--
-- WHY (supersedes 0133's app_metadata read)
-- ------------------------------------------
-- 0133 closed CRITICAL-1 (self-minted admin) by reading the role from
-- raw_app_meta_data instead of raw_user_meta_data. The SECURITY property held
-- — a client-writable user_metadata.user_role can no longer elevate a signup.
-- But the app_metadata read is a DEAD path in practice: GoTrue's
-- admin.createUser({ app_metadata }) does INSERT-then-UPDATE — it inserts the
-- auth.users row (firing this trigger) with app_metadata containing only
-- {provider, providers}, and merges the caller's custom app_metadata in a
-- SEPARATE UPDATE that lands AFTER the trigger has already run. So at trigger
-- time raw_app_meta_data->>'user_role' is always NULL, and every account —
-- including genuine service-role admin/govt creates — resolved to 'owner'.
--
-- Verified empirically (2026-07-07): admin.createUser({app_metadata:{user_role:
-- 'admin'}}) yields profiles.role='owner', while a DIRECT auth.users INSERT
-- carrying user_role in raw_app_meta_data yields 'admin' — proving the read
-- worked but GoTrue's timing never delivers the value.
--
-- THE HONEST, MOST-SECURE DESIGN
-- ------------------------------
-- The trigger no longer reads ANY metadata for the role. It always writes
-- 'owner'. Role elevation is a deliberate, explicit service-role UPDATE:
--   * demo seed (scripts/seed-test-users.ts bootstrapAdmin) — already does it
--   * genesis seed (scripts/seed-genesis-admin.ts) — now does it
--   * institutional onboarding — already UPDATEs role inside its transaction
-- This removes the GoTrue-timing fragility entirely and makes the invariant
-- unconditional: NO request-controllable input (user_metadata OR app_metadata)
-- can ever set a privileged role at signup. display_name stays sourced from
-- user_metadata — it is non-privileged and purely cosmetic.
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
begin
  resolved_display_name := coalesce(
    new.raw_user_meta_data->>'display_name',
    split_part(new.email, '@', 1)
  );

  -- Role is NEVER derived from request metadata. Every trigger-created profile
  -- is an 'owner'. Privileged roles (vet/govt/admin) are granted only by an
  -- explicit service-role UPDATE after the user exists — see migration 0134.
  insert into public.profiles (id, role, display_name)
  values (
    new.id,
    'owner'::public.user_role,
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
