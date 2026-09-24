-- Bite expedientes for STAGING — 2026-08-01. Run AFTER the two loss scripts.
--
-- THE PROBLEM, measured:
--   3.524  mordeduras reportadas (12 meses)   ← the KPI on the panorama
--       4  expedientes bite_incident           ← in the entire database
--
-- Those two numbers sit on the same screen. Nothing is lying — one counts
-- reported bites, the other opened cases — but a 6.558-to-4 gap reads as a
-- broken join, and it is the first thing a funcionario will point at.
--
-- WHY IT MATTERS BEYOND COSMETICS: commit e99be76d re-pointed the rabies tile
-- from `rabies_observation` (a string nothing opens and nothing closes, so its
-- rows were immortal) to `bite_incident`, on the reasoning that reportBite
-- opens the case and emits rabies_observation_started in the same transaction,
-- "so the two populations coincide by construction". That construction is real
-- in the code and has NEVER RUN on this data — the seed writes bite events
-- directly. So the fix is correct and the tile still shows 0.
--
-- WHAT THIS DOES, in three parts:
--   A. Opens 443 historical expedientes (~12% of the last 12 months' bites,
--      deterministic by md5) and CLOSES them, each with its
--      rabies_observation_started / _ended pair. That is the real-world shape:
--      not every bite becomes a case, and an observation that began months ago
--      has ended. Gives the trend charts and the "reportadas → con expediente"
--      funnel something true to draw.
--   B. Writes ~18 FRESH bite events spread over the last 9 days. Needed because
--      the seed's bites have the same clustering as its losses — 1.592 in 90
--      days but ONE in the last 10 — and a 10-day observation window over
--      month-old bites leaves exactly zero open. Without this, part A alone
--      still shows 0 open.
--   C. Opens those 18 as OPEN expedientes with only the _started event, and
--      sets pets.rabies_observation_status='in_progress'.
--
-- Part C's cache write is not optional. /adoptar filters out pets in
-- observation; an open case whose pet is still listed as adoptable would be two
-- surfaces disagreeing about whether the animal is under quarantine.
--
-- CAST NOTE (hit for real on the first run): author_role is an ENUM, and every
-- literal that feeds it is cast explicitly here. A bare 'system' works in a
-- plain INSERT ... SELECT — Postgres coerces the unknown-type literal to the
-- target column. It does NOT work under UNION ALL: the union resolves both
-- branches' types FIRST, pins them to text, and text -> enum then fails with
-- 42804. Part A is the one with the union, so it is the one that broke.
--
-- Run the parts IN ORDER, one at a time. Each is a single statement.

-- ===========================================================================
-- PART A — historical expedientes, opened and closed
-- ===========================================================================
WITH ev AS (
  SELECT e.id AS ev_id, e.pet_id, e.occurred_at,
         p.jurisdiction_province AS prov, p.jurisdiction_locality AS loc, p.locality_id,
         ('x'||substr(md5(e.id::text),1,8))::bit(32)::bigint / 4294967296.0 AS u
  FROM pet_events e JOIN pets p ON p.id = e.pet_id
  WHERE e.event_type = 'incident_reported'
    AND e.payload->>'incident_type' = 'bite_inflicted'
    AND e.occurred_at > now() - interval '365 days'
    AND NOT EXISTS (
      SELECT 1 FROM cases c WHERE c.case_kind='bite_incident' AND c.primary_pet_id = e.pet_id
    )
),
sel AS (
  SELECT *, row_number() OVER (ORDER BY occurred_at, ev_id) AS rn
  FROM ev WHERE u < 0.12
),
ins AS (
  INSERT INTO cases (
    public_code, case_kind, status, primary_subject_kind, primary_pet_id,
    jurisdiction_province, jurisdiction_locality, locality_id,
    opened_at, opened_reason, closed_at, closed_reason
  )
  SELECT
    'DEMO-BITE-' || lpad(rn::text, 5, '0'),
    'bite_incident', 'closed', 'registered_pet', pet_id,
    prov, loc, locality_id,
    occurred_at,
    'Mordedura reportada — observación antirrábica de 10 días',
    occurred_at + interval '10 days',
    'Observación cumplida sin signos compatibles'
  FROM sel
  RETURNING id, primary_pet_id, opened_at, closed_at
)
INSERT INTO pet_events
  (pet_id, event_type, occurred_at, recorded_at, author_role, author_verified, payload, case_id)
SELECT primary_pet_id, 'rabies_observation_started', opened_at, opened_at, 'system'::author_role, true,
       jsonb_build_object('payload_version', 1, 'source', 'bite-cases-2026-08-01'), id
FROM ins
UNION ALL
SELECT primary_pet_id, 'rabies_observation_ended', closed_at, closed_at, 'system'::author_role, true,
       jsonb_build_object('payload_version', 1, 'outcome', 'sin_signos',
                          'source', 'bite-cases-2026-08-01'), id
FROM ins;

-- ===========================================================================
-- PART B — fresh bite events over the last 9 days
-- ===========================================================================
WITH cand AS (
  SELECT p.id,
         row_number() OVER (ORDER BY md5(p.id::text)) AS rn,
         ('x'||substr(md5(p.id::text), 9,8))::bit(32)::bigint % 9      AS d_ago,
         ('x'||substr(md5(p.id::text),17,8))::bit(32)::bigint % 86400  AS secs
  FROM pets p
  WHERE p.status = 'active'
    AND p.name IS NOT NULL AND p.name <> ''
    AND p.jurisdiction_province IS NOT NULL
    AND p.deleted_at IS NULL
    AND p.rabies_observation_status IS DISTINCT FROM 'in_progress'
    AND NOT EXISTS (
      SELECT 1 FROM pet_events e WHERE e.pet_id = p.id AND e.event_type = 'incident_reported'
    )
    AND NOT EXISTS (
      SELECT 1 FROM cases c WHERE c.primary_pet_id = p.id AND c.case_kind = 'bite_incident'
    )
)
INSERT INTO pet_events
  (pet_id, event_type, occurred_at, recorded_at, author_role, author_verified, payload)
SELECT id,
       'incident_reported',
       now() - ((d_ago) || ' days')::interval - ((secs) || ' seconds')::interval,
       now() - ((d_ago) || ' days')::interval - ((secs) || ' seconds')::interval,
       'owner'::author_role, false,
       jsonb_build_object('incident_type', 'bite_inflicted', 'payload_version', 1,
                          'source', 'fresh-bites-2026-08-01')
FROM cand WHERE rn <= 18;

-- ===========================================================================
-- PART C — the OPEN expedientes for those fresh bites
-- ===========================================================================
WITH ev AS (
  SELECT e.pet_id, e.occurred_at,
         p.jurisdiction_province AS prov, p.jurisdiction_locality AS loc, p.locality_id,
         row_number() OVER (ORDER BY e.occurred_at) AS rn
  FROM pet_events e JOIN pets p ON p.id = e.pet_id
  WHERE e.event_type = 'incident_reported'
    AND e.payload->>'source' = 'fresh-bites-2026-08-01'
),
ins AS (
  INSERT INTO cases (
    public_code, case_kind, status, primary_subject_kind, primary_pet_id,
    jurisdiction_province, jurisdiction_locality, locality_id, opened_at, opened_reason
  )
  SELECT 'DEMO-BITE-OPEN-' || lpad(rn::text, 3, '0'),
         'bite_incident', 'open', 'registered_pet', pet_id,
         prov, loc, locality_id, occurred_at,
         'Mordedura reportada — observación antirrábica de 10 días en curso'
  FROM ev
  RETURNING id, primary_pet_id, opened_at
),
evs AS (
  INSERT INTO pet_events
    (pet_id, event_type, occurred_at, recorded_at, author_role, author_verified, payload, case_id)
  SELECT primary_pet_id, 'rabies_observation_started', opened_at, opened_at, 'system'::author_role, true,
         jsonb_build_object('payload_version', 1, 'source', 'fresh-bites-2026-08-01'), id
  FROM ins
  RETURNING pet_id
)
UPDATE pets SET rabies_observation_status = 'in_progress', updated_at = now()
WHERE id IN (SELECT pet_id FROM evs);

-- ===========================================================================
-- VERIFICATION — run separately
-- ===========================================================================
-- SELECT
--   (SELECT count(*) FROM cases WHERE case_kind='bite_incident')                  AS expedientes,
--   (SELECT count(*) FROM cases WHERE case_kind='bite_incident' AND status='open') AS abiertos,
--   (SELECT count(*) FROM pets WHERE rabies_observation_status='in_progress')      AS en_observacion,
--   (SELECT count(*) FROM pet_events WHERE event_type='incident_reported'
--      AND payload->>'incident_type'='bite_inflicted'
--      AND occurred_at > now() - interval '30 days')                               AS mordeduras_30d;
-- Expected: expedientes ≈ 461, abiertos = 18, en_observacion = 18, mordeduras_30d ≈ 22.
