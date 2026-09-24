-- 0091_welcome_notification_cta
-- ------------------------------
-- Add a CTA to the `welcome` notification seeded by the handle_new_user
-- trigger so the user's first inbox row is actionable ("Registrá tu primera
-- mascota" → /mis-mascotas/nueva). Until now welcome was a dead informational
-- row (no cta_label/cta_url), so NotificationCard rendered no button.
--
-- This CREATE OR REPLACE mirrors db/triggers.sql (kept in sync). Idempotent —
-- safe to re-run. Does not touch the trigger binding (on_auth_user_created).

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

  insert into public.profiles (id, role, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'user_role', '')::public.user_role,
      'owner'::public.user_role
    ),
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
