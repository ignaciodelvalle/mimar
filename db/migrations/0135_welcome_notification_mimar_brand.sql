-- Migration 0135: welcome notification uses the MiMAR brand, not the DIM
-- internal codename, and drops the gendered "Bienvenido" salutation.
--
-- WHY
-- ---
-- handle_new_user() (migration 0134) still wrote the welcome notification
-- title as "¡Bienvenido a DIM, {name}!" — DIM is the internal codename
-- (code, schema, DIM-XXXX-XXXX tokens); user-facing copy must say MiMAR
-- (AGENTS.md invariant #4 / CLAUDE.md). "Bienvenido" also assumes a
-- masculine addressee with no gender field on profiles to inflect from —
-- rewritten to the neutral "Te damos la bienvenida" instead of guessing.
--
-- Kept in sync with db/triggers.sql. Idempotent (CREATE OR REPLACE), same
-- function body as 0134 otherwise unchanged.

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
    '¡Te damos la bienvenida a MiMAR, ' || resolved_display_name || '!',
    'La libreta digital de tu mascota empieza acá. Empezá agregando tu primera mascota — vamos a generar su credencial digital y armar el historial juntos.',
    'info'::public.notification_severity,
    'Registrá tu primera mascota',
    '/mis-mascotas/nueva'
  );

  return new;
end;
$$;
