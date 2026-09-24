-- Migration 0238 — the pet_events override audit's "enum-shaped value" test is
-- too permissive. Fresh-context review, pre-push (item 8).
--
-- enforce_pet_events_append_only() (0127, tightened in 0235) copies a
-- top-level string value into the override audit's pre/post images when its
-- key is a known enum key (sub_kind, kind, category, source, …) AND the value
-- matches `^[a-z0-9_]{1,64}$`. That character class allows a value that is
-- ENTIRELY DIGITS — which an enum column never legitimately is (every real
-- enum in this codebase is a lowercase snake_case WORD: 'open', 'bite_incident',
-- 'scanner') — so a digits-only string sitting under an enum-shaped key, such
-- as a phone number accidentally written to `source` or `channel`, was copied
-- into the audit trail as if it were a safe token. audit_log is append-only
-- (0235's own header) and nothing erases it, so that copy outlives any later
-- redaction.
--
-- THE FIX: require a leading letter (`^[a-z]`) and forbid five or more
-- consecutive digits anywhere in the value, via a negative lookahead
-- (`(?!.*[0-9]{5,})` — PostgreSQL's regex engine supports lookahead
-- assertions). A leading letter alone would still admit a value like
-- 'x14155551212' (one letter, ten digits) if nothing else were tightened, so
-- both rules apply together: no legitimate enum token in this codebase starts
-- with a digit OR carries a run of 5+ consecutive digits, and a phone number
-- (any plausible national or international format) always does.
--   ^[a-z](?!.*[0-9]{5,})[a-z0-9_]{0,63}$
--
-- ADDITIVE: CREATE OR REPLACE FUNCTION, same body as 0235 except this one
-- regex. Forward-only. db/triggers.sql carries the identical function body,
-- because bootstrap re-runs it after migrations — the two must stay
-- byte-identical.

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
                     -- Migration 0238: leading letter required, 5+ consecutive
                     -- digits forbidden — a digits-only value (a phone number)
                     -- under an enum-shaped key must never look like a safe token.
                     and (v #>> '{}') ~ '^[a-z](?!.*[0-9]{5,})[a-z0-9_]{0,63}$')
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
