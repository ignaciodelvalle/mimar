-- Fresh losses for STAGING — 2026-08-01. Run AFTER the reunification backfill.
--
-- THE PROBLEM THIS SOLVES, measured not guessed:
--
--   ventana    pérdidas   reencuentros
--   90 días      1908         1203      ← the panorama default; ratio holds
--   30 días        16          406      ← 25x more found than lost
--
-- A funcionario who clicks "30 días" — the most natural drill-down there is —
-- reads 16 lost and 406 found and concludes the arithmetic is broken.
--
-- THE ROOT CAUSE IS THE SEED, not the reunification backfill. Every bulk loss
-- in this database is stamped 2026-06-20: one single day, 42 days back. Almost
-- none land in the last 30. The reunifications, dated loss+1..60 days, mostly
-- do. The backfill did not create the lopsidedness — it made it visible.
--
-- WHAT THIS DOES: marks 48 pets lost across the last 28 days, two per province,
-- so the recent window has real losses in it. It also gives /perdidas a fresh,
-- geographically varied first page — which is what the demo actually shows, and
-- what the photo-loading list depends on.
--
-- WHO IT PICKS: active, named, in a province, and with NO status_changed event
-- of any kind. That last predicate matters — without it this could re-lose an
-- animal the backfill just reunited hours ago, which is a story no registry
-- tells. 55,244 pets qualify; two per province is 48.
--
-- Deterministic (md5 on the pet id), and the same data-modifying-CTE shape as
-- the backfill: the spine event and the cache update are atomic.

WITH cand AS (
  SELECT p.id,
         row_number() OVER (PARTITION BY p.jurisdiction_province ORDER BY md5(p.id::text)) AS rn,
         ('x'||substr(md5(p.id::text), 9,8))::bit(32)::bigint % 27     AS d_ago,
         ('x'||substr(md5(p.id::text),17,8))::bit(32)::bigint % 86400  AS secs
  FROM pets p
  WHERE p.status = 'active'
    AND p.name IS NOT NULL AND p.name <> ''
    AND p.jurisdiction_province IS NOT NULL
    AND p.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pet_events e
      WHERE e.pet_id = p.id AND e.event_type = 'status_changed'
    )
),
todo AS (
  SELECT id,
         (now() - ((d_ago + 1) || ' days')::interval - (secs || ' seconds')::interval) AS lost_at
  FROM cand WHERE rn <= 2
),
ins AS (
  INSERT INTO pet_events
    (pet_id, event_type, occurred_at, recorded_at, author_role, author_verified, payload)
  SELECT id, 'status_changed', lost_at, lost_at, 'owner', false,
         jsonb_build_object(
           'from_status',     'active',
           'to_status',       'lost',
           'payload_version', 1,
           'source',          'recent-losses-2026-08-01'
         )
  FROM todo
  RETURNING pet_id
)
UPDATE pets SET status = 'lost', updated_at = now()
WHERE id IN (SELECT pet_id FROM ins);

-- Verification — paste separately after the statement above.
--   SELECT count(*) FILTER (WHERE payload->>'to_status'='lost'
--            AND occurred_at > now() - interval '30 days') AS perdidas_30d,
--          count(*) FILTER (WHERE payload->>'to_status'='active'
--            AND occurred_at > now() - interval '30 days') AS reencuentros_30d
--   FROM pet_events WHERE event_type='status_changed';
