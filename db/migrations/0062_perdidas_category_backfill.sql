-- Backfill: set category = 'perdidas' for existing pet_found_report notifications
-- that were inserted before P0b (category was omitted → NULL).
--
-- Safe to run multiple times: the WHERE clause filters to only NULL-category rows
-- of the relevant notification_type, so already-categorised rows are untouched.

BEGIN;

UPDATE notifications
SET    category = 'perdidas'
WHERE  notification_type = 'pet_found_report'
  AND  category IS NULL;

COMMIT;
