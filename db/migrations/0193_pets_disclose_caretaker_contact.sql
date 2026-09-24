-- 0193 — KEY 1 of the two-key caretaker public-contact model.
--
-- A GAP IN THE PLAN, not a scope extension. The PO decision of 2026-08-19 gave
-- the alternate public contact TWO keys:
--   key 2, the CARETAKER's consent → `pet_caretaker_grants.public_contact_consent_at`,
--          landed in 0189.
--   key 1, the TITULAR's choice    → "rides the existing lost-mode disclosure
--          toggles". Every task written against that sentence (C7's public-page
--          behaviour, C9's toggle UI) assumed the column already existed. It did
--          not: the `disclose_*_when_lost` family is five columns from 0012 and
--          none of them is about a caretaker.
--
-- WHY A COLUMN AND NOT A REUSE OF `disclose_phone_when_lost`: that flag governs
-- the TITULAR's own phone. Reusing it would mean the titular cannot publish
-- their caretaker's number without publishing their own, and — worse — turning
-- their own phone on would silently publish a third party's. The whole point of
-- the two-key model is that these are different consents.
--
-- DEFAULT false, like every disclosure sibling. `disclose_last_location_when_lost`
-- and `allow_finder_form_when_lost` default TRUE (0012) because they disclose
-- nothing about a person; the four that disclose a HUMAN default false. A
-- third party's contact is the strongest case in that group, and even `true`
-- would still be gated by key 2 — which is exactly why the default must not be
-- allowed to carry the argument.
--
-- IDEMPOTENT `IF NOT EXISTS`, matching 0012's shape.

BEGIN;

ALTER TABLE public.pets
  ADD COLUMN IF NOT EXISTS disclose_caretaker_contact_when_lost BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.pets.disclose_caretaker_contact_when_lost IS
  'KEY 1 of the two-key alternate-public-contact model (custodia-temporal, PO 2026-08-19). When the pet is lost AND this is true AND the active grant carries public_contact_consent_at, the public credential may show the caretaker as an alternate contact. Either key missing shows nothing. Off by default, like every disclosure flag that reveals a person.';

-- ---------------------------------------------------------------------------
-- Post-condition fence. "Applied" is not the same as "closed".
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pets'
      AND column_name = 'disclose_caretaker_contact_when_lost'
  ) THEN
    missing := missing || 'pets.disclose_caretaker_contact_when_lost was not created'::text;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pets'
      AND column_name = 'disclose_caretaker_contact_when_lost'
      AND (is_nullable <> 'NO' OR column_default NOT ILIKE '%false%')
  ) THEN
    -- A nullable column, or one defaulting to true, would make "off by default"
    -- a claim in a comment rather than a property of the schema.
    missing := missing || 'pets.disclose_caretaker_contact_when_lost must be NOT NULL DEFAULT false'::text;
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION '0193 post-condition failed: %', array_to_string(missing, '; ');
  END IF;
END
$$;

COMMIT;
