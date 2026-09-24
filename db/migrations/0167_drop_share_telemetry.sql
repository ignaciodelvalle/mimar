-- Migration 0167 — stop collecting libreta share-view telemetry: delete every
-- accumulated row and drop the table (TEL-1, PO decision 2026-08-04).
--
-- WHAT THIS TABLE WAS
-- -------------------
-- share_telemetry (migration 0032) recorded one row per view of a Tier-2
-- libreta share link: pet_id, share_token_id, viewed_at, viewer_ip_hash and
-- user_agent. It was created by the 2026-05-19 event-catalog cleanup, which
-- moved the retired `libreta_shared_viewed` event OUT of pet_events so the
-- clinical spine would stop carrying non-medical noise. The move was right; the
-- destination turned out to have no reader.
--
-- WHY IT GOES
-- -----------
-- Swept the tree on 2026-08-04: the ONLY writer was
-- src/modules/pets/application/libreta-share/log-libreta-share-view.ts, and
-- there was NO production reader — not a query, not a projection, not a screen.
-- The owner-facing "how many people saw your libreta" number does not come from
-- here: it is libreta_share_tokens.view_count_cached / last_viewed_at_cached,
-- maintained by the same use case and untouched by this migration. So the table
-- was pure accumulation: a per-view user_agent string, growing forever, read by
-- nobody.
--
-- Under Ley 25.326 that is data collected without a purpose to serve. The PO
-- decision (2026-08-04, TEL-1) is therefore the strong form: stop collecting
-- AND delete what accumulated. Keeping an unread PII-adjacent log "just in case
-- a product reason appears later" is exactly the posture the privacy review
-- asks this project not to take — if a share-analytics feature is ever
-- specified, it can define its own retention and collect forward from that day.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- DELETE first, then DROP. The DELETE is redundant in pure SQL terms (DROP
-- TABLE removes the rows with it), and it is here on purpose: it makes the
-- irreversible act explicit in the SQL an operator reads before running this
-- against a database that holds real viewer data, instead of hiding it inside a
-- DDL verb.
--
-- IRREVERSIBLE. There is no down migration; the rows do not come back. Applying
-- this to any remote database is the PO's call, not an agent's.
--
-- No FK points AT share_telemetry (it was the referencing side for pets and
-- libreta_share_tokens, never the referenced one), so the DROP needs no CASCADE
-- and takes nothing else with it. Its two indexes go with the table.
--
-- Forward-only and idempotent: the DELETE is guarded by a to_regclass probe (a
-- bare DELETE would error on a re-run, after the DROP has already removed the
-- table), and the DROP carries IF EXISTS.

BEGIN;

DO $$ BEGIN
  IF to_regclass('public.share_telemetry') IS NOT NULL THEN
    DELETE FROM public.share_telemetry;
  END IF;
END $$;

DROP TABLE IF EXISTS public.share_telemetry;

COMMIT;
