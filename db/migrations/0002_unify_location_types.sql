-- Unify welfare_reports.location_lat / location_lng to numeric(10,7).
-- ------------------------------------------------------------------
-- pet_events uses numeric(10,7); welfare_reports historically used
-- doublePrecision. The new location accessor (lib/location.ts) reads both
-- tables through the same helper; having mixed underlying types meant
-- `Number(row.locationLat)` returned a string for one table and a number
-- for the other. Unifying simplifies the helper and removes a subtle
-- "works on this table, breaks on that one" bug class.
--
-- Apply once per environment by pasting into Supabase Studio → SQL Editor,
-- or via `docker exec -i supabase_db_DIM psql -U postgres -d postgres`.
-- Idempotent — safe to re-run because the ALTER COLUMN ... TYPE is a no-op
-- when the column is already numeric(10,7).
--
-- DO NOT use `pnpm db:push` — would propose dropping welfare / organizations /
-- owner-facing RLS policies. See gotcha `gotchas/drizzle-rls-drift`.

do $$
declare
  current_type text;
begin
  select data_type into current_type
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'welfare_reports'
    and column_name = 'location_lat';

  if current_type = 'double precision' then
    alter table public.welfare_reports
      alter column location_lat type numeric(10, 7) using location_lat::numeric(10, 7),
      alter column location_lng type numeric(10, 7) using location_lng::numeric(10, 7);
  end if;
end $$;
