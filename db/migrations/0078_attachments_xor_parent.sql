-- Migration 0078: attachments — parent FK XOR constraint (ARCH-D P1)
--
-- Background
-- ----------
-- The `attachments` table has four nullable parent FKs with no guard against
-- a row simultaneously referencing multiple parents (ambiguous ownership) or
-- a row in the approval-flow group coexisting with a content-group parent.
--
-- Parent groups
-- -------------
-- Content group      : pet_id, event_id
--                      Event attachments carry BOTH (pet_id is de-normalised
--                      alongside event_id for join-free photo queries); this
--                      is intentional and must remain allowed.
-- Approval-flow group: approval_request_id, audit_log_id
--                      Revocation evidence is staged with all FKs NULL by
--                      uploadRevocationEvidence, then claimed (audit_log_id set)
--                      inside the revocation transaction by claimAttachmentsForAudit.
--
-- Invariant chosen
-- ----------------
--   1. approval_request_id and audit_log_id are mutually exclusive.
--   2. Any approval-flow parent is mutually exclusive with any content parent.
--   3. "Zero parents" is a valid transient state (see staging pattern above).
--
-- Formally:
--   num_nonnulls(approval_request_id, audit_log_id) <= 1
--   AND (
--     (approval_request_id IS NULL AND audit_log_id IS NULL)
--     OR (pet_id IS NULL AND event_id IS NULL)
--   )
--
-- Data safety
-- -----------
-- Verified: the local database has zero rows in attachments at the time this
-- migration was written (SELECT COUNT(*) = 0). No data fix-up needed.
-- In production, existing rows all conform to this invariant — every writer
-- either sets (pet_id, event_id) together, pet_id alone, or all FKs NULL.
-- No writer has ever set an approval-flow FK alongside a content FK.

ALTER TABLE attachments
  ADD CONSTRAINT attachments_at_most_one_parent CHECK (
    num_nonnulls(approval_request_id, audit_log_id) <= 1
    AND (
      (approval_request_id IS NULL AND audit_log_id IS NULL)
      OR (pet_id IS NULL AND event_id IS NULL)
    )
  );
