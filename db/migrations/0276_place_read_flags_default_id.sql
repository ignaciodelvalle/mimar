-- ────────────────────────────────────────────────────────────────────────────
-- 0276_place_read_flags_default_id.sql
-- The id path becomes the factory default for every place consumer that has
-- a reader: scope, routing, rules, coverage and panorama.
--
-- WHY (localidades CABA + Córdoba, 2026-10, change C3; PO decision 2026-10-02)
-- ---------------------------------------------------------------------------
-- 0257 seeded every consumer on the name path, to be flipped by an operator
-- after a parity week. The PO dropped that shadow arrangement (no real users
-- yet): one behaviour everywhere. Flipping only staging by hand would leave CI
-- and every local database testing the name path while staging serves the id
-- path — exactly the split the decision removes. So the flip is a migration,
-- and it lands in every environment the same way.
--
-- WHAT THE ID PATH DOES TO A PROVINCE THAT IS NOT ON UNITS YET
-- ---------------------------------------------------------------------------
-- Nothing. Every id-path reader keeps the legacy branch: a grant with no
-- authority unit (`authority_unit_id IS NULL`) is matched by its (province,
-- locality) name pair exactly as on the name path (govt_scope source
-- 'legacy', lib/place/scope.ts, approval-routing, the rules cascade), and a
-- caller that passes no locality id stays on the name path whatever the flag
-- says. Draft units govern nothing (0260).
--
-- `public_filters` stays on 'name': no code reads it (the consumer is
-- declared in lib/place/flags.ts and nowhere else), so flipping it would only
-- make the table claim a behaviour that does not exist.
--
-- `panorama` reads `event_places`. On an environment where that projection is
-- empty the map is all "Sin localidad" until it is filled:
-- `pnpm place:backfill-event-places --apply` (seed:panorama now runs it).
--
-- Idempotent: the UPDATE sets the same values on a re-run, and the INSERT
-- only adds a missing row. Forward-only.
-- ROLLBACK (no deploy, per consumer): UPDATE public.place_read_flags SET mode
-- = 'name', updated_at = now() WHERE consumer = '<consumer>'.
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO public.place_read_flags (consumer, mode) VALUES
  ('scope', 'id'),
  ('routing', 'id'),
  ('rules', 'id'),
  ('coverage', 'id'),
  ('panorama', 'id'),
  ('public_filters', 'name')
ON CONFLICT (consumer) DO NOTHING;

UPDATE public.place_read_flags
   SET mode = 'id', updated_at = now()
 WHERE consumer IN ('scope', 'routing', 'rules', 'coverage', 'panorama')
   AND mode IS DISTINCT FROM 'id';

COMMENT ON TABLE public.place_read_flags IS
  'Per-consumer switch from the name path to the id path (localidades-por-id D1): name | shadow (serve name, record disagreements) | id. Since 0276 the factory default is id for scope, routing, rules, coverage and panorama (legacy name grants still match on the id path); public_filters has no reader and stays name. Rollback = the row back to name, no deploy.';
