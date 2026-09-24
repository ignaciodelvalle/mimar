-- Add `kind` to org_contact_messages so the Ser voluntario sheet can
-- write to the same table without forking a parallel schema (handoff
-- P2-9b). New kinds = one CHECK update — no schema migration.
--
-- Default 'contact' keeps existing rows valid; the volunteer sheet
-- explicitly sets kind='volunteer' on insert.

ALTER TABLE org_contact_messages
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'contact';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'org_contact_messages_kind_check'
  ) THEN
    ALTER TABLE org_contact_messages
      ADD CONSTRAINT org_contact_messages_kind_check
      CHECK (kind IN ('contact', 'volunteer'));
  END IF;
END $$;

COMMENT ON COLUMN org_contact_messages.kind IS
  'Surface that produced the message. Today: contact (Contactar sheet) | volunteer (Ser voluntario sheet).';
