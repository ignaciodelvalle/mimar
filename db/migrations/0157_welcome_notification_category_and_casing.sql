-- Migration 0157: welcome notification gets a category + the canonical
-- brand casing; heal existing rows.
--
-- WHY
-- ---
-- Owner-notifications badge/page investigation (sweep-fixes-2 2026-07-23)
-- found that handle_new_user() (migrations 0133-0135, db/triggers.sql) has
-- ALWAYS inserted the `welcome` notification without a `category` — this is
-- NOT a seed-only defect, it is the production path every real signup goes
-- through. Two more TS write paths (notifyOwnerOfFirstStrangerScan,
-- app/api/cron/auto-expire-approvals) share the same gap. A hard NOT NULL
-- constraint on notifications.category is therefore deliberately NOT added
-- here — see the follow-up note at the bottom of this file.
--
-- This migration:
--   1. Sets category = 'admin' on the welcome insert (the existing "Sistema"
--      bucket the /notificaciones page already renders NULL-category rows
--      into via `all`; giving welcome an explicit category lets it also
--      surface under the "Sistema" tab instead of only "Todas").
--   2. Recases the title's brand literal "MiMAR" -> "miMAR" (PO decision
--      2026-07-18, scripts/check-brand-casing.ts) — the trigger predates
--      that recase sweep, which only touched app/**+components/** source,
--      never this SQL function body.
--   3. Heals existing rows: any previously-inserted `welcome` notification
--      with category IS NULL gets category = 'admin'; any with the
--      wrong-cased "MiMAR" in its title gets the literal recased in place.
--      Both are plain UPDATEs — no event/projection semantics apply to the
--      notifications table (it is not part of the append-only event log).
--
-- Kept in sync with db/triggers.sql. Idempotent (CREATE OR REPLACE + guarded
-- UPDATEs). Same function body as 0135 otherwise unchanged.

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

  insert into public.notifications (user_id, notification_type, category, title, body, severity, cta_label, cta_url)
  values (
    new.id,
    'welcome',
    'admin',
    '¡Te damos la bienvenida a miMAR, ' || resolved_display_name || '!',
    'La libreta digital de tu mascota empieza acá. Empezá agregando tu primera mascota — vamos a generar su credencial digital y armar el historial juntos.',
    'info'::public.notification_severity,
    'Registrá tu primera mascota',
    '/mis-mascotas/nueva'
  );

  return new;
end;
$$;

-- Heal existing rows (production + seed alike — both went through the same
-- unpatched trigger). Scoped to notification_type = 'welcome' only; never
-- touches any other notification's category or title.
UPDATE public.notifications
SET category = 'admin'
WHERE notification_type = 'welcome'
  AND category IS NULL;

UPDATE public.notifications
SET title = replace(title, 'MiMAR', 'miMAR')
WHERE notification_type = 'welcome'
  AND title LIKE '%MiMAR%';

-- ---------------------------------------------------------------------------
-- Follow-up (NOT done here — recorded so it isn't lost):
--
-- notifications.category is still nullable in the Drizzle schema
-- (db/schema.ts) and several OTHER production write paths omit it besides
-- the trigger fixed above: notifyOwnerOfFirstStrangerScan
-- (lib/infra/notify-owner-of-first-stranger-scan.ts), the
-- approval_request_auto_expired cron (app/api/cron/auto-expire-approvals/
-- route.ts), and multiple direct db.insert(notifications) call sites that
-- bypass createNotification() entirely (lib/infra/owner-disease-alerts.ts,
-- app/(public)/p/[publicToken]/encontre/action.ts,
-- app/actions/decomiso.ts x5). Adding a NOT NULL constraint on `category`
-- today would require auditing and fixing all of those first — a separate,
-- larger change. Tracked in engram (project 'dim', topic
-- 'sweep-fixes-2-2026-07-23') rather than rushed into this migration.
