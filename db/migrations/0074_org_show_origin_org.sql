ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tier_0_show_origin_org boolean NOT NULL DEFAULT false;
