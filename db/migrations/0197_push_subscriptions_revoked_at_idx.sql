-- 0197 — an index for the revoked-row purge on push_subscriptions
-- (RN re-run HIGH follow-up, 2026-08-22; batch A2 / U2).
--
-- THE SCAN THIS CLOSES
-- ---------------------------------------------------------------------------
-- lib/infra/data-lifecycle.ts `purgeRevokedPushSubscriptions` deletes
--   WHERE revoked_at IS NOT NULL AND revoked_at < <cutoff>
-- in 500-row batches under the daily cron's fair share. The table's only
-- index, 0152's `push_subscriptions_user_active_idx (user_id) WHERE revoked_at
-- IS NULL`, covers the send path — exactly the rows the purge never touches.
-- So each purge batch was a sequential scan of the whole table, and a scan
-- whose cost grows with the table is the wrong shape for the job that exists
-- to keep the table from growing.
--
-- WHY PARTIAL ON `revoked_at IS NOT NULL`
-- ---------------------------------------------------------------------------
-- Live rows — one per browser per user, the common case — never enter the
-- index, so registration and delivery pay nothing to maintain it. Only a
-- revocation (the user's toggle, or the push service's 404/410) writes an
-- entry, and the purge removes it again once the TTL has passed. The index's
-- predicate is the purge's predicate, so `revoked_at < cutoff` becomes an
-- index-range scan over the revoked population alone.
--
-- NOT CONCURRENTLY, on purpose: push_subscriptions is small (one row per
-- browser registration) and this runs inside the runner's transaction, which
-- is what makes the post-condition below roll back with the CREATE if either
-- fails. A CONCURRENTLY build would need `-- dim:no-transaction` and could
-- leave an INVALID index behind on failure, with no fence to say so.
--
-- Drizzle mirror: db/schema.ts `revokedAtIdx` on `pushSubscriptions`, so a
-- `drizzle-kit push` after bootstrap keeps the index and generate parity
-- holds (docs/ops/migrations.md: schema.ts and the migration land together).
--
-- Remote application (staging, prod) is Ignacio-gated, as every migration is;
-- this file was applied and verified on the local stack only.

BEGIN;

CREATE INDEX IF NOT EXISTS push_subscriptions_revoked_at_idx
  ON public.push_subscriptions (revoked_at)
  WHERE revoked_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Post-condition fence. "Applied" is not the same as "closed".
-- ---------------------------------------------------------------------------
-- `CREATE INDEX IF NOT EXISTS` reports success when a same-named index already
-- exists — with ANY definition (docs/ops/migrations.md, the 0172 lesson). An
-- environment patched by hand with this name and another predicate would pass
-- the statement and keep the purge on a sequential scan. Verify the EFFECT,
-- by definition, and that the send-path sibling was not touched.
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  purge_def text;
  send_def text;
BEGIN
  SELECT indexdef INTO purge_def
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'push_subscriptions'
    AND indexname = 'push_subscriptions_revoked_at_idx';

  IF purge_def IS NULL THEN
    missing := missing || 'push_subscriptions_revoked_at_idx was not created'::text;
  ELSE
    IF purge_def LIKE '%UNIQUE INDEX%' THEN
      missing := missing || 'push_subscriptions_revoked_at_idx is UNIQUE (it must not be: many rows revoke at the same instant)'::text;
    END IF;
    IF purge_def NOT LIKE '%(revoked_at)%' THEN
      missing := missing || 'push_subscriptions_revoked_at_idx is not keyed on (revoked_at) alone'::text;
    END IF;
    IF purge_def NOT LIKE '%revoked_at IS NOT NULL%' THEN
      missing := missing || 'push_subscriptions_revoked_at_idx lost its partial predicate (revoked_at IS NOT NULL)'::text;
    END IF;
  END IF;

  -- The sibling this file must not touch.
  SELECT indexdef INTO send_def
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'push_subscriptions'
    AND indexname = 'push_subscriptions_user_active_idx';
  IF send_def IS NULL THEN
    missing := missing || '0197 touched push_subscriptions_user_active_idx (absent)'::text;
  ELSIF send_def NOT LIKE '%(user_id)%' OR send_def NOT LIKE '%revoked_at IS NULL%' THEN
    missing := missing || '0197 touched push_subscriptions_user_active_idx (definition changed)'::text;
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION '0197 post-condition failed: %', array_to_string(missing, '; ');
  END IF;
END
$$;

COMMIT;
