-- DIM notifications.related_reminder_id — schema migration
-- ---------------------------------------------------------
-- Adds a nullable FK from notifications → reminders so cron-emitted
-- notifications keyed off a specific reminder (post_adoption_checkin family,
-- and future multi-reminder-per-source-event flows) can dedupe per-reminder.
--
-- relatedEventId stays reserved for pet_events FK semantics. Each adoption
-- can spawn up to four post-adoption reminders sharing one source event id,
-- so source-event dedupe alone cannot distinguish 1m/3m/6m/12m windows.
--
-- Apply once per environment by pasting into Supabase Studio → SQL Editor.
-- Idempotent — safe to re-run.
--
-- DO NOT apply this via `pnpm db:push`. See engram gotcha
-- `gotchas/drizzle-rls-drift`.

alter table "public"."notifications"
  add column if not exists "related_reminder_id" uuid
  references "public"."reminders" ("id") on delete set null;

create index if not exists "notifications_related_reminder_idx"
  on "public"."notifications" ("related_reminder_id")
  where "related_reminder_id" is not null;
