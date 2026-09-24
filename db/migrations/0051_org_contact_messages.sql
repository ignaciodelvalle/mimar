-- Inbound contact messages from the public refugio profile (handoff P2-8).
--
-- Anonymous visitors submit via a sheet on /refugios/[orgToken]; the
-- server action writes rows here under rate-limit guards (5/IP/day +
-- 20/org/day per D4 override). Reads are gated to org members via RLS.

CREATE TABLE IF NOT EXISTS org_contact_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  inquirer_name text,
  inquirer_email text NOT NULL,
  message text NOT NULL,
  submitter_ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  archived_at timestamptz,
  CONSTRAINT org_contact_messages_message_length_check CHECK (length(message) <= 500),
  CONSTRAINT org_contact_messages_email_length_check CHECK (length(inquirer_email) <= 254)
);

CREATE INDEX IF NOT EXISTS org_contact_messages_org_idx
  ON org_contact_messages(organization_id);

CREATE INDEX IF NOT EXISTS org_contact_messages_created_at_idx
  ON org_contact_messages(created_at);

COMMENT ON TABLE org_contact_messages IS
  'Inbound messages from /refugios/[orgToken] Contactar sheet. Anonymous-friendly: inquirer_email is the only required PII field.';
COMMENT ON COLUMN org_contact_messages.submitter_ip IS
  'First IP from X-Forwarded-For — used by the rate_limit_buckets cohort key, not for analytics.';

-- RLS — server actions write under service role (bypass); these policies
-- only govern reads via PostgREST.
ALTER TABLE org_contact_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members can read own org messages" ON org_contact_messages;
CREATE POLICY "Org members can read own org messages"
  ON org_contact_messages
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = org_contact_messages.organization_id
        AND om.left_at IS NULL
    )
  );

DROP POLICY IF EXISTS "Platform admins read all org messages" ON org_contact_messages;
CREATE POLICY "Platform admins read all org messages"
  ON org_contact_messages
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM profiles p
      WHERE p.id = auth.uid()
        AND p.role = 'admin'
        AND p.account_type = 'institutional'
        AND p.deactivated_at IS NULL
    )
  );
