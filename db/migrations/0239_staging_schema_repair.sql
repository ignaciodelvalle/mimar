-- Migration 0239 — repair the hand-patched staging schema.
--
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- A read-only audit on 2026-09-22 (engram topic
-- `ops/staging-schema-drift-2026-09-22`) compared the local database with
-- staging (Supabase project agnwyifsdxxoznodutgq). Staging's `_dim_migrations`
-- ledger says every migration through 0238 is applied, but the live schema was
-- patched by hand: whole objects that those migrations create are missing, and
-- one security trigger is still the pre-0015 version. "Applied" is not
-- "present" — the ledger records a checksum, not an effect.
--
-- The drift this file repairs, each from the LATEST migration that defines it:
--
--   1. Schema `ref` and its four SENASA vocabulary tables, with their seed rows
--      (0060_ref_senasa_vocabularies.sql). Absent on staging.
--   2. Triggers `pet_events_case_id_immutable` and `cases_set_updated_at`
--      (0033_cases.sql). Their functions exist on staging (with 0114's
--      search_path pin); only the CREATE TRIGGER blocks never landed.
--   3. SECURITY — `ownerships` still carries `ownerships_admin_no_pets` ->
--      `enforce_admin_no_pets()` (0010, role = 'admin' only) and never got
--      `ownerships_institutional_no_pets` -> `enforce_institutional_no_pets()`
--      (0015, account_type = 'institutional'). A govt account can own a pet.
--      The precondition guard 0015 carried is repeated here, scoped to LIVE
--      ownerships, so the trigger is never wired over bad data in silence.
--   4. SECURITY — the pet_events SELECT policy "Pet events readable by active
--      owner" lacks the hide-from-subject-case guard added by 0115; the owner
--      of a pet can read events attached to a welfare case that is about them.
--      Recreated with the definition as it stands after 0137's initplan
--      rewrite (the latest migration to touch it), which is byte-for-byte the
--      local live `pg_policies.qual`.
--
-- NOT REPAIRED, ON PURPOSE: the three FOREIGN KEYs from 0061
-- (`pet_events.tipo_evento_code` / `via_aplicacion_code` /
-- `vet_jurisdiccion_code` -> `ref.*`). The audit listed them, but they are
-- absent from the CANONICAL build too, not only from staging: bootstrap runs
-- `drizzle-kit push` before replaying migrations, push creates the three
-- columns from db/schema.ts (which declares no `.references()`), and 0061's
-- `ADD COLUMN IF NOT EXISTS ... REFERENCES` is then skipped as a whole —
-- constraint included. Local and CI have never had them; staging matches
-- local here. Adding them in this file would change every correct database
-- and fight schema.ts on the next push, so it belongs to a decision of its
-- own (schema.ts + a migration together), not to a drift repair.
--
-- NO-OP ON A CORRECT DATABASE. Every statement is idempotent and reproduces
-- exactly what a fully migrated database already has: CREATE ... IF NOT
-- EXISTS, INSERT ... ON CONFLICT DO NOTHING, DROP ... IF EXISTS followed by a
-- CREATE of the identical definition. On local it changes no definition and
-- no row (proved with a before/after catalog inventory when it was written).
-- The `ref` tables get no grants and no RLS because 0060 gave them none and no
-- later migration does; `ref` is not a PostgREST-exposed schema.
--
-- The post-condition block at the end asks the catalog for all four repairs,
-- by name and by content, so an apply that "succeeds" without the effect
-- aborts instead of joining the ledger. Fenced in the local database by
-- __tests__/rls/staging-drift-guards.test.ts.

-- ===========================================================================
-- 1. Schema `ref` + SENASA vocabularies (verbatim from 0060)
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS ref;

CREATE TABLE IF NOT EXISTS ref.tipo_evento_sanitario (
  code              text PRIMARY KEY,
  label_es          text NOT NULL,
  norma_origen      text NOT NULL,
  requiere_lote     boolean NOT NULL DEFAULT false,
  requiere_via      boolean NOT NULL DEFAULT false,
  notificable_eno   boolean NOT NULL DEFAULT false
);

INSERT INTO ref.tipo_evento_sanitario(code, label_es, norma_origen, requiere_lote, requiere_via, notificable_eno) VALUES
  ('vacunacion_antirrabica',     'Vacunación antirrábica',                   'Ley 22.953/1983 + Res. MS 1144/2018',   true,  true,  true ),
  ('vacunacion_quintuple',       'Vacunación quíntuple',                     'LSUCyF (SENASA, 2022)',                 true,  true,  false),
  ('vacunacion_sextuple',        'Vacunación séxtuple',                      'LSUCyF (SENASA, 2022)',                 true,  true,  false),
  ('vacunacion_octuple',         'Vacunación óctuple',                       'LSUCyF (SENASA, 2022)',                 true,  true,  false),
  ('vacunacion_triple_felina',   'Vacunación triple felina',                 'LSUCyF (SENASA, 2022)',                 true,  true,  false),
  ('desparasitacion_interna',    'Desparasitación interna',                  'Res. MS 546/1985 (hidatidosis)',        true,  false, false),
  ('desparasitacion_externa',    'Desparasitación externa',                  'LSUCyF (SENASA, 2022)',                 true,  false, false),
  ('prescripcion_electronica',   'Receta Electrónica Veterinaria',           'Res. SENASA 80/2025',                   false, false, false),
  ('consulta_clinica',           'Consulta clínica',                         'Ley 14.072/1951',                       false, false, false),
  ('cirugia_general',            'Cirugía general',                          'Ley 14.072/1951',                       false, false, false),
  ('esterilizacion_quirurgica',  'Esterilización quirúrgica',                'Ley CABA 1.338/2004 / PBA 13.879/2008', false, false, false),
  ('observacion_antirrabica',    'Observación antirrábica (10 días)',        'Ord. CABA 41.831 art. 9°',              false, false, true ),
  ('mordedura_notificada',       'Mordedura — notificación',                 'Ley 15.465/1960 (ENO)',                 false, false, true ),
  ('defuncion',                  'Defunción',                                'Ord. CABA 41.831 art. 11',              false, false, false),
  ('transferencia_tenencia',     'Transferencia de tenencia',                'Art. 1947 CCyCN',                       false, false, false),
  ('extravio_reportado',         'Extravío reportado',                       'Decreto 1.088/2011',                    false, false, false),
  ('recuperacion_reportada',     'Recuperación reportada',                   'Decreto 1.088/2011',                    false, false, false)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS ref.via_aplicacion (
  code     text PRIMARY KEY,
  label_es text NOT NULL
);

INSERT INTO ref.via_aplicacion(code, label_es) VALUES
  ('sc',  'Subcutánea'),
  ('im',  'Intramuscular'),
  ('iv',  'Endovenosa'),
  ('vo',  'Oral'),
  ('top', 'Tópica'),
  ('in',  'Intranasal')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS ref.jurisdiccion_sanitaria (
  code                text PRIMARY KEY,
  label_es            text NOT NULL,
  colegio_veterinario text
);

INSERT INTO ref.jurisdiccion_sanitaria(code, label_es, colegio_veterinario) VALUES
  ('AR-C', 'CABA',         'CVPCABA (Ley 14.072)'),
  ('AR-B', 'Buenos Aires', 'CVPBA (Decreto-Ley 9.686/1981)'),
  ('AR-S', 'Santa Fe',     'Colegio de Médicos Veterinarios de Santa Fe'),
  ('AR-X', 'Córdoba',      'Colegio Médico Veterinario de la Provincia de Córdoba')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS ref.identification_kind_norma (
  kind             identification_kind PRIMARY KEY,
  norma_origen     text NOT NULL,
  estandar_tecnico text
);

INSERT INTO ref.identification_kind_norma(kind, norma_origen, estandar_tecnico) VALUES
  ('microchip_iso',    'Res. SENASA 284/2024',          'ISO 11784:1996 + ISO 11785:1996'),
  ('tattoo',           'Ord. CABA 41.831 art. 4°',      NULL),
  ('collar_tag',       'Uso voluntario',                NULL),
  ('photo_biometric',  'Reservado — no implementado',   NULL)
ON CONFLICT (kind) DO NOTHING;

COMMENT ON SCHEMA ref IS
  'Vocabularios SENASA + ICAR + ISO. Tablas semi-estáticas referenciadas por pet_events y pet_identifications. Compliance handoff PR 3.';

-- ===========================================================================
-- 2. 0033's two trigger blocks (verbatim; functions untouched)
-- ===========================================================================

drop trigger if exists pet_events_case_id_immutable on public.pet_events;
create trigger pet_events_case_id_immutable
  before update on public.pet_events
  for each row
  execute function public.check_pet_event_case_id_immutable();

drop trigger if exists cases_set_updated_at on public.cases;
create trigger cases_set_updated_at
  before update on public.cases
  for each row
  execute function public.cases_set_updated_at();

-- ===========================================================================
-- 3. ownerships: institutional accounts cannot own pets (0015)
-- ===========================================================================

-- Precondition: the trigger below only rejects FUTURE writes. Wiring it over
-- a live institutional ownership would leave that row standing and make every
-- later UPDATE of it (including ending it) fail. Abort instead, with the
-- count, so the data is fixed by a human first.
do $$
declare
  n integer;
begin
  select count(*) into n
  from public.ownerships o
  join public.profiles p on p.id = o.owner_user_id
  where p.account_type = 'institutional'
    and o.ended_at is null;

  if n > 0 then
    raise exception
      'Precondition failed: % live ownership row(s) belong to institutional accounts. Transfer or end these ownerships before applying migration 0239.',
      n
      using errcode = 'check_violation';
  end if;
end $$;

drop trigger if exists "ownerships_admin_no_pets" on "public"."ownerships";

drop function if exists "public"."enforce_admin_no_pets"();

drop trigger if exists "ownerships_institutional_no_pets" on "public"."ownerships";
create trigger "ownerships_institutional_no_pets"
  before insert or update on "public"."ownerships"
  for each row execute function "public"."enforce_institutional_no_pets"();

-- ===========================================================================
-- 4. pet_events owner-read policy with the hide-from-subject guard
--    (created by 0115, USING rewritten by 0137 — copied from 0137)
-- ===========================================================================

DROP POLICY IF EXISTS "Pet events readable by active owner" ON public.pet_events;
CREATE POLICY "Pet events readable by active owner"
  ON public.pet_events FOR SELECT TO authenticated
  USING ((((EXISTS ( SELECT 1
   FROM ownerships o
  WHERE ((o.pet_id = pet_events.pet_id) AND (o.owner_user_id = (select auth.uid())) AND (o.ended_at IS NULL)))) AND ((case_id IS NULL) OR (NOT is_hidden_from_subject_case(case_id)) OR can_read_case(case_id, (select auth.uid())))) OR ((case_id IS NOT NULL) AND can_read_case(case_id, (select auth.uid())))));

-- ===========================================================================
-- 5. Post-condition: ask the catalog for every repair, by name and content
-- ===========================================================================

do $$
declare
  missing text[] := array[]::text[];
  t text;
  q text;
begin
  if not exists (select 1 from pg_namespace where nspname = 'ref') then
    missing := missing || 'schema ref';
  end if;

  foreach t in array array['tipo_evento_sanitario', 'via_aplicacion', 'jurisdiccion_sanitaria', 'identification_kind_norma'] loop
    if to_regclass('ref.' || t) is null then
      missing := missing || ('table ref.' || t);
    end if;
  end loop;

  if to_regclass('ref.tipo_evento_sanitario') is not null
     and (select count(*) from ref.tipo_evento_sanitario) < 17 then
    missing := missing || 'ref.tipo_evento_sanitario seed rows'::text;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'pet_events_case_id_immutable'
      and tgrelid = 'public.pet_events'::regclass
      and tgfoid = 'public.check_pet_event_case_id_immutable()'::regprocedure
      and tgenabled <> 'D'
  ) then
    missing := missing || 'trigger pet_events_case_id_immutable'::text;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'cases_set_updated_at'
      and tgrelid = 'public.cases'::regclass
      and tgfoid = 'public.cases_set_updated_at()'::regprocedure
      and tgenabled <> 'D'
  ) then
    missing := missing || 'trigger cases_set_updated_at'::text;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'ownerships_institutional_no_pets'
      and tgrelid = 'public.ownerships'::regclass
      and tgfoid = 'public.enforce_institutional_no_pets()'::regprocedure
      and tgenabled <> 'D'
  ) then
    missing := missing || 'trigger ownerships_institutional_no_pets'::text;
  end if;

  if exists (select 1 from pg_trigger where tgname = 'ownerships_admin_no_pets')
     or to_regprocedure('public.enforce_admin_no_pets()') is not null then
    missing := missing || 'stale ownerships_admin_no_pets / enforce_admin_no_pets() still present'::text;
  end if;

  select qual into q
  from pg_policies
  where schemaname = 'public'
    and tablename = 'pet_events'
    and policyname = 'Pet events readable by active owner'
    and cmd = 'SELECT';

  if q is null or position('is_hidden_from_subject_case' in q) = 0 then
    missing := missing || 'policy "Pet events readable by active owner" with the hide-from-subject guard'::text;
  end if;

  if array_length(missing, 1) > 0 then
    raise exception 'Migration 0239 post-condition failed; still missing: %', array_to_string(missing, '; ');
  end if;
end $$;
