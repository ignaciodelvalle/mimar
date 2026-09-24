-- Migration 0223 — push_targets learns to remember one Expo receipt id, so a
-- dead device can be revoked by the answer that actually carries the news.
--
-- THE NUMBER. Recounted at the moment of writing (2026-09-15) by listing
-- db/migrations and reading the highest on disk: 0222_push_targets.sql, this
-- branch's own, applied locally and nowhere else. 0223 was confirmed free by
-- COUNTING matches rather than by trusting an exit code. There are gaps at 0009
-- and 0057, so a file count is not the number — see 0222's header for the time
-- this rule was learned the expensive way on this very table.
--
-- WHY THIS IS A SECOND MIGRATION AND NOT AN EDIT TO 0222
-- ---------------------------------------------------------------------------
-- 0222 has been APPLIED to a local database, and the runner tracks applied
-- files by name in public._dim_migrations. Editing it now would produce a file
-- that no environment ever runs: every database that already has 0222 skips it
-- forever, and the columns below would exist only where the table happened to
-- be created after the edit. Forward-only is not a style rule here; it is the
-- only shape that converges.
--
-- WHY A COLUMN AT ALL — THE PROBLEM THIS SOLVES
-- ---------------------------------------------------------------------------
-- Expo answers a send in TWO stages and only the first one is synchronous.
--
--   · The TICKET comes back from `sendPushNotificationsAsync` immediately and
--     says whether Expo ACCEPTED the message. A `status: "ok"` ticket carries a
--     receipt id and nothing else.
--   · The RECEIPT, fetched later by that id, says what FCM and APNs did with
--     it. `DeviceNotRegistered` — the app was uninstalled, the token was
--     invalidated, the person wiped the phone — arrives HERE in the ordinary
--     case, because Expo has not talked to the store yet when it writes the
--     ticket.
--
-- The sender has only ever read tickets. So the one signal that says a delivery
-- address is dead mostly never arrived, dead rows accumulated in
-- `push_targets` forever, and every subsequent send paid to address a phone
-- that no longer exists. `push_targets_user_active_idx` is partial on the live
-- population, so the cost is not hypothetical: the index grows with the corpse
-- count and every notification for that person carries the extra message.
--
-- Reading a receipt needs the id, and the id is only known at send time — on the
-- request path, minutes or hours before the answer is worth asking for. It has
-- to be written down somewhere, and this table is where the row it belongs to
-- already lives.
--
-- ONE RECEIPT PER DEVICE, NOT A QUEUE, AND THAT IS DELIBERATE
-- ---------------------------------------------------------------------------
-- A device that receives three pushes in an evening overwrites the first two
-- ids with the third, and only the third is ever reconciled. That is a real
-- loss of information and it is worth almost nothing, because of what the
-- signal IS: `DeviceNotRegistered` is a PERSISTENT condition, not an event. An
-- uninstalled app does not become installed again between two sends. The
-- newest receipt answers the same question the older two would have, and it
-- answers it about the most recent attempt.
--
-- The alternative — a `push_receipts` table, one row per message, with its own
-- purge and its own growth — buys the ability to attribute a `MessageTooBig` to
-- a particular notification, which nothing in this system does anything with
-- (§3.6 of the handoff: no delivery-observability surface, no counters, no
-- operator tile). Two columns on a table that already exists is the whole cost
-- of the part that matters.
--
-- WHY NO `NOT NULL` AND NO DEFAULT. Both columns are absent for a row that has
-- never been delivered to, and absent again once its receipt has been read.
-- `pending_receipt_id IS NOT NULL` is the work queue, and a queue expressed as
-- "this column is set" needs no second state column to say the same thing.
--
-- RLS IS UNCHANGED AND THAT IS ON PURPOSE. 0222 narrowed this table to
-- SELECT-only for `authenticated`, with no INSERT, UPDATE or DELETE policy at
-- all, because the row carries a delivery credential. These two columns are
-- written by the same server-side path as every other column here — the Drizzle
-- (BYPASSRLS) connection, from `lib/infra/push-target-store.ts` — so no policy
-- is consulted for them and none is added. A reader checking whether this
-- migration widened anything: it did not, and the owner SELECT now also returns
-- these two fields, which name no third party and say nothing the owner does
-- not already know about their own device.
--
-- NOTHING IS CARRIED FORWARD HERE. `erase_subject_data` and
-- `export_subject_data` already reach `push_targets` as a whole row (0222,
-- parts B and C): the erase DELETEs from the table and the export selects the
-- row, so two new columns on it are covered by definitions that were written
-- against the table and not against a column list. Re-declaring the RPCs to add
-- nothing would be two more copies of two long functions to keep in agreement.
--
-- IDEMPOTENCY. ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS. Safe to
-- replay. No BEGIN/COMMIT: scripts/migrate.ts wraps each file in a transaction.

ALTER TABLE public.push_targets
  -- The id Expo's ticket handed back for the last message this device accepted.
  -- Set on a successful ticket, cleared when its receipt has been read.
  ADD COLUMN IF NOT EXISTS pending_receipt_id text,
  -- When that id was written. It is the TTL, not a timestamp anybody reads:
  -- Expo keeps receipts for roughly 24 hours and answers nothing for an id
  -- older than that, so a pending id that has aged out is cleared unasked
  -- rather than re-queried nightly forever.
  ADD COLUMN IF NOT EXISTS pending_receipt_at timestamptz;

-- The reconciliation job's read: every device with a receipt still owed,
-- oldest first. Partial on the PENDING population for the same reason
-- push_targets_revoked_at_idx is partial on the revoked one — the overwhelming
-- majority of rows at any moment have no receipt outstanding, and a full index
-- would be maintained on every send to answer a question about a handful.
CREATE INDEX IF NOT EXISTS push_targets_pending_receipt_idx
  ON public.push_targets (pending_receipt_at)
  WHERE pending_receipt_id IS NOT NULL;

COMMENT ON COLUMN public.push_targets.pending_receipt_id IS
  'Expo receipt id from the last accepted message, awaiting reconciliation. DeviceNotRegistered arrives in the receipt rather than in the ticket, and this is how the nightly job finds the row it belongs to. Cleared once read, or once it has aged past Expo''s ~24h retention. See migration 0223.';

COMMENT ON COLUMN public.push_targets.pending_receipt_at IS
  'When pending_receipt_id was written. Its only use is the age cutoff: Expo answers nothing for a receipt id older than roughly 24 hours. See migration 0223.';
