-- Reunification backfill for STAGING — 2026-08-01
--
-- WHY: staging had 4011 pets in status='lost' against a 66,835-pet registry
-- (6% of the national padrón simultaneously missing). A funcionario reads that
-- number and stops trusting the rest of the screen. It is also lopsided against
-- 3 adoptable pets.
--
-- WHAT THIS IS NOT: an UPDATE that rewrites history. A reunification is a NEW
-- status_changed event appended to the spine (invariant #2 — events are
-- append-only, corrections are new events). The original loss event is never
-- touched. pets.status is updated because it is a DECLARED CACHE of the spine
-- (invariant #3), not the source of truth.
--
-- SELECTION is deterministic — md5(pet id), no randomness — so a dry run and
-- the real run pick exactly the same animals, and re-reading the plan later
-- gives the same answer.
--
-- THREE INDEPENDENT HASH SLICES. Reusing one slice for both the selection and
-- the delay would correlate them: every selected pet would have a low value and
-- therefore the same short delay, and the reunification dates would stack into
-- a visible ridge. Slices 1/9/17 are independent.
--
-- RATES BY AGE, not a flat percentage. What was lost months ago is mostly
-- resolved; what was lost this week is mostly still open. A flat rate produces
-- a population no registry ever looks like.
--
-- DATE SPREAD: each reunification lands some days after ITS OWN loss, biased
-- toward the first week (u², squared) with a long tail out to ~60 days. Stamping
-- them all with today's date would draw a vertical cliff on every panorama trend
-- and give the seeding away instantly.
--
-- DRY RUN, measured before writing: 3742 reunify, 269 stay lost (0.40% of the
-- registry), 0 pets without a loss event to work from.
--
-- Run it as one statement. The data-modifying CTE makes the insert and the
-- cache update atomic — there is no window where the spine and the cache
-- disagree.

WITH m AS (
  SELECT p.id,
         (SELECT max(e.occurred_at) FROM pet_events e
          WHERE e.pet_id = p.id AND e.event_type = 'status_changed'
            AND e.payload->>'to_status' = 'lost') AS lost_at
  FROM pets p WHERE p.status = 'lost'
),
h AS (
  SELECT id, lost_at,
         ('x'||substr(md5(id::text), 1,8))::bit(32)::bigint / 4294967296.0 AS u_sel,
         ('x'||substr(md5(id::text), 9,8))::bit(32)::bigint / 4294967296.0 AS u_delay,
         ('x'||substr(md5(id::text),17,8))::bit(32)::bigint % 86400        AS u_secs
  FROM m WHERE lost_at IS NOT NULL
),
rated AS (
  SELECT *, CASE
    WHEN lost_at < now() - interval '90 days' THEN 0.95
    WHEN lost_at < now() - interval '30 days' THEN 0.88
    WHEN lost_at < now() - interval  '7 days' THEN 0.50
    ELSE 0.0 END AS rate
  FROM h
),
todo AS (
  SELECT id, lost_at,
         LEAST(
           lost_at
             + ((1 + floor(60 * u_delay * u_delay))::int || ' days')::interval
             + (u_secs || ' seconds')::interval,
           now() - interval '3 hours'
         ) AS found_at
  FROM rated WHERE u_sel < rate
),
ins AS (
  INSERT INTO pet_events
    (pet_id, event_type, occurred_at, recorded_at, author_role, author_verified, payload)
  SELECT id, 'status_changed', found_at, found_at, 'owner', false,
         jsonb_build_object(
           'from_status',          'lost',
           'to_status',            'active',
           'payload_version',      1,
           'reunified',            true,
           'source',               'reunification-backfill-2026-08-01',
           'location_description', 'Reencuentro con la familia'
         )
  FROM todo
  RETURNING pet_id
)
UPDATE pets SET status = 'active', updated_at = now()
WHERE id IN (SELECT pet_id FROM ins);
