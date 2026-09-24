-- Migration 0235 — the pet_events override audit keeps an allowlisted pre-image,
-- the scan purge gets an accountable system actor, and custody_disputes can
-- say 'escalated'. Findings A08-2, A08-6 and A09-3 (2026-09 fresh review).
--
-- 1. A08-2 — THE OVERRIDE AUDIT ROW RECORDED NO PRE-IMAGE
-- ---------------------------------------------------------------------------
-- enforce_pet_events_append_only() (0127, mirrored in db/triggers.sql) lets an
-- accountable override UPDATE or DELETE a pet_events row, and logs
-- `pet_events_mutation_override` with operation / pet_event_id / pet_id /
-- event_type / occurred_at only — every one of them `coalesce(new.X, old.X)`,
-- which on UPDATE resolves to NEW. An audited rewrite left no record anywhere
-- of what the row said before. The row now carries `old` and `new` images and
-- `changed_keys`; the legacy top-level keys stay as they were, so no reader of
-- the old shape changes.
--
-- THE IMAGES ARE AN ALLOWLIST, NOT A DENYLIST. audit_log is append-only and
-- nothing erases it, while the one live consumer of this hatch,
-- erase_subject_data (0129 → 0228), opens it precisely to REDACT PII inside
-- payloads. Any value copied into an image outlives that erasure. A first
-- draft of this migration excluded the keys the erase RPC redacts, and the
-- security review showed that list is itself incomplete (note_added.text /
-- finderName / finderContact / message, incident_reported.injuries_summary /
-- victim_age_estimate, symptom_observed.free_text, the adoption application's
-- motivation / daily_routine / other_pets, shelter intake's
-- seizure_motive_other_detail / judicial_proceeding_reference,
-- death_recorded.cause_detail, clinical_info_logged.details,
-- vet_visit_logged.diagnosis) — and any key added tomorrow would leak too. So
-- a top-level payload value is copied ONLY when it is structurally incapable
-- of carrying a name, a contact or prose:
--   · a boolean or a JSON null;
--   · a number under `payload_version` or a key ending in `_code`;
--   · a string under `id` / `*_id` / `*Id` that is uuid-shaped;
--   · a string under `*_at` / `*_on` / `*_date` / `*_until` that is
--     ISO-date-shaped;
--   · a string under a known enum key (sub_kind, kind, category, …) that is a
--     single lowercase snake_case token.
-- Every other key — strings, nested objects, arrays, a display name sitting
-- under an `*_id` key in seeded rows — is recorded by NAME only, in
-- `redacted_keys`. `changed_keys` names every key whose value differs between
-- old and new, redacted or not, so a rewrite of a redacted key is visible as a
-- change without its content. The `notes` column is prose: the images record
-- only whether it was set, and the row records `notes_changed`.
-- The honest cost: the old value of a non-structural key is not reconstructable
-- from the trail. That is the trade an erasure promise requires. A payload that
-- is not a JSON object gets a null image instead of an error.
--
-- 2. A08-6 — THE SCAN PURGE WROTE actor_user_id = NULL
-- ---------------------------------------------------------------------------
-- The general hatch refuses to act without an accountable uuid; the narrow
-- scan-purge path (0104) logged `scan_event_purged` with a null actor, the one
-- audited mutation with nobody behind it. It now names a fixed system profile,
-- seeded here the way 0039 / 0066 / 0079 seeded their backfill actors
-- (`system:%` display name, is_system = true — the C21 service-account flag
-- that keeps it out of the human-admin floor, admin search and notification
-- recipients). It has no auth.users row, so it can never sign in. The uuid is
-- `SCAN_PURGE_SYSTEM_ACTOR_ID` in lib/infra/scan-retention.ts.
-- The purge path's payload is UNCHANGED: it gets no pre-image, because the
-- purge exists precisely to stop retaining the scan location it would copy.
--
-- 3. A09-3 — custody_disputes COULD NOT SAY 'escalated'
-- ---------------------------------------------------------------------------
-- escalate-stale-disputes moves the linked `cases` row to 'escalated'; the
-- dispute row could not follow, because custody_disputes_status_valid allowed
-- only open / resolved / withdrawn. Widening that CHECK alone would be a lie:
-- custody_disputes_resolution_consistent admits exactly two shapes (open +
-- unresolved, or resolved/withdrawn + resolver), so an 'escalated' row would
-- still be refused. Both constraints widen together; 'escalated' takes the
-- unresolved shape, like 'open'.
-- This migration makes the value REPRESENTABLE. Nothing writes it yet, on
-- purpose: every reader keys on status = 'open' — the one-open-dispute-per-pet
-- unique index, pets.in_custody_dispute (rederive-pet-cache.ts), open-dispute,
-- report-dispute-tip and the resolve guard — and switching the cron to write
-- 'escalated' would silently release the custody lock on an escalated
-- dispute. That reader contract is the next change, not this one.
--
-- ADDITIVE AND IDEMPOTENT: CREATE OR REPLACE FUNCTION; the profile insert is
-- ON CONFLICT DO UPDATE of the flag only; both constraints are dropped IF
-- EXISTS and re-added wider (every existing row satisfies the wider form, so
-- the validating scan cannot fail). Forward-only. db/triggers.sql carries the
-- same function body, because bootstrap re-runs it after migrations.

-- 2. The system actor (before the function that references it) --------------

insert into public.profiles (id, role, display_name, is_system, created_at, updated_at)
values (
  '00000000-0000-0000-0000-000000000235',
  'admin',
  'system:cron-scan-retention',
  true,
  now(),
  now()
)
on conflict (id) do update set is_system = true;

-- 1 + 2. The trigger function --------------------------------------------------

create or replace function public.enforce_pet_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  override_actor uuid;
  retention_days int := 90;
  -- Migration 0235: the system profile the scan purge is attributed to.
  scan_purge_actor constant uuid := '00000000-0000-0000-0000-000000000235';
  -- Migration 0235: keys whose value is copied into the audit images when it
  -- is a single lowercase snake_case token. See the migration header.
  enum_keys constant text[] := array[
    'sub_kind', 'kind', 'category', 'incident_type', 'severity', 'status',
    'outcome', 'type', 'source', 'from_role', 'to_role', 'reporter_role',
    'victim_kind', 'method', 'route', 'result', 'decision', 'resolution',
    'channel', 'surface', 'action', 'custody_kind', 'species', 'sex'
  ];
  images jsonb[] := array[null, null]::jsonb[];
  src jsonb;
  kept jsonb;
  redacted jsonb;
  changed jsonb := null;
begin
  -- -------------------------------------------------------------------------
  -- Path 1: general mutation escape hatch.
  -- -------------------------------------------------------------------------
  if current_setting('app.allow_event_mutation', true) = 'true' then
    override_actor := nullif(current_setting('app.allow_event_mutation_actor', true), '')::uuid;
    if override_actor is null then
      raise exception 'pet_events mutation override requires app.allow_event_mutation_actor (uuid) to be set in the same session'
        using errcode = 'restrict_violation';
    end if;

    -- Allowlisted pre/post images (migration 0235, finding A08-2). Index 1 is
    -- OLD, index 2 is NEW (null on DELETE).
    for i in 1..2 loop
      continue when i = 2 and tg_op <> 'UPDATE';
      src := case i when 1 then old.payload else new.payload end;
      if jsonb_typeof(src) = 'object' then
        select
          coalesce(jsonb_object_agg(e.k, e.v) filter (where e.keep), '{}'::jsonb),
          coalesce(jsonb_agg(e.k order by e.k) filter (where not e.keep), '[]'::jsonb)
        into kept, redacted
        from (
          select k, v,
            (
              jsonb_typeof(v) in ('boolean', 'null')
              or (jsonb_typeof(v) = 'number'
                  and (k = 'payload_version' or k ~ '_code$'))
              or (jsonb_typeof(v) = 'string' and (
                   (k ~ '(^id|_id|Id)$'
                     and (v #>> '{}') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
                   or (k ~ '(_at|_on|_date|_until)$'
                     and (v #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]+)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$')
                   or (k = any(enum_keys)
                     and (v #>> '{}') ~ '^[a-z0-9_]{1,64}$')
                 ))
            ) as keep
          from jsonb_each(src) as t(k, v)
        ) e;
      else
        kept := null;
        redacted := null;
      end if;
      images[i] := jsonb_build_object(
        'event_type',    case i when 1 then old.event_type else new.event_type end,
        'occurred_at',   case i when 1 then old.occurred_at else new.occurred_at end,
        'notes_present', case i when 1 then old.notes is not null else new.notes is not null end,
        'payload',       kept,
        'redacted_keys', redacted
      );
    end loop;

    if tg_op = 'UPDATE'
       and jsonb_typeof(old.payload) = 'object'
       and jsonb_typeof(new.payload) = 'object' then
      select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into changed
      from (
        select k from jsonb_object_keys(old.payload) as a(k)
        union
        select k from jsonb_object_keys(new.payload) as b(k)
      ) u
      where (old.payload -> u.k) is distinct from (new.payload -> u.k);
    end if;

    insert into public.audit_log (actor_user_id, action, payload)
    values (
      override_actor,
      'pet_events_mutation_override',
      jsonb_build_object(
        'operation',     tg_op,
        'pet_event_id',  coalesce(new.id,          old.id),
        'pet_id',        coalesce(new.pet_id,      old.pet_id),
        'event_type',    coalesce(new.event_type,  old.event_type),
        'occurred_at',   coalesce(new.occurred_at, old.occurred_at),
        'old',           images[1],
        'new',           images[2],
        'changed_keys',  changed,
        'notes_changed', tg_op = 'UPDATE' and new.notes is distinct from old.notes
      )
    );

    return coalesce(new, old);
  end if;

  -- -------------------------------------------------------------------------
  -- Path 2: narrow scan-purge exception (Wave 5 Item 28).
  -- DELETE only; scanner events only; older than retention window only.
  -- Attributed to the system actor (migration 0235, finding A08-6). No
  -- pre-image: the purge exists to stop retaining what it would copy.
  -- -------------------------------------------------------------------------
  if tg_op = 'DELETE'
     and current_setting('app.allow_scan_purge', true) = 'true'
     and old.author_role::text = 'scanner'
     and old.event_type = 'credential_scanned'
     and old.occurred_at < (now() - (retention_days || ' days')::interval)
  then
    insert into public.audit_log (actor_user_id, action, payload)
    values (
      scan_purge_actor,
      'scan_event_purged',
      jsonb_build_object(
        'pet_event_id', old.id,
        'pet_id',       old.pet_id,
        'occurred_at',  old.occurred_at,
        'retention_days', retention_days
      )
    );

    return old;
  end if;

  -- -------------------------------------------------------------------------
  -- Default: block all other mutations.
  -- -------------------------------------------------------------------------
  raise exception 'pet_events is append-only (AGENTS.md). % blocked.', tg_op
    using errcode = 'restrict_violation';
end;
$$;

-- 3. custody_disputes can hold 'escalated' ---------------------------------------

alter table public.custody_disputes
  drop constraint if exists custody_disputes_status_valid;
alter table public.custody_disputes
  add constraint custody_disputes_status_valid
  check (status in ('open', 'escalated', 'resolved', 'withdrawn'));

alter table public.custody_disputes
  drop constraint if exists custody_disputes_resolution_consistent;
alter table public.custody_disputes
  add constraint custody_disputes_resolution_consistent
  check (
    (status in ('open', 'escalated')
      and resolution is null and resolved_by_user_id is null and resolved_at is null)
    or (status in ('resolved', 'withdrawn')
      and resolved_by_user_id is not null and resolved_at is not null)
  );
