-- Migration 0073: unique constraint + NOT NULL on organization_coverage.
--
-- W1/C1 — two changes to organization_coverage:
--
-- 1. UNIQUE constraint on (organization_id, jurisdiction_province, jurisdiction_locality)
--    with NULLS NOT DISTINCT (Postgres 15+).
--    Rationale: prevents an org from registering the same (province, locality)
--    pair twice. NULLS NOT DISTINCT means two province-level rows (locality IS NULL)
--    for the same org/province are treated as duplicates — exactly what we want.
--
--    Name follows Drizzle's auto-generated convention:
--    <table>_<col1>_<col2>_<col3>_unique
--
-- 2. jurisdiction_province NOT NULL.
--    Pre-check: verified zero existing rows with null jurisdiction_province.
--    Without province, a coverage row is meaningless (it cannot match any pet's
--    jurisdiction) and triggers an early-return in broadcastLostPet anyway.

-- Step 1: add the unique constraint with NULLS NOT DISTINCT.
-- Name is deliberately shortened to stay under Postgres's 63-char NAMEDATALEN limit.
ALTER TABLE organization_coverage
  ADD CONSTRAINT org_coverage_org_province_locality_unique
  UNIQUE NULLS NOT DISTINCT (organization_id, jurisdiction_province, jurisdiction_locality);

-- Step 2: add NOT NULL on jurisdiction_province.
-- Safe: zero existing rows have a null value here (verified before migration).
ALTER TABLE organization_coverage
  ALTER COLUMN jurisdiction_province SET NOT NULL;
