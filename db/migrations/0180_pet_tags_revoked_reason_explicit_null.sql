-- Migración 0180 — la última diferencia de estructura entre el repo y staging.
--
-- Después de la 0179 quedó UNA, y era de la peor categoría: mismo nombre,
-- definición distinta. Las dos bases creían tener la misma regla.
--
--   repo / local:  revoked_reason IS NULL OR revoked_reason = ANY (ARRAY[...])
--   staging:       revoked_reason = ANY (ARRAY[...])
--
-- FUNCIONALMENTE COINCIDEN, y eso es justamente lo incómodo: `NULL = ANY(...)`
-- evalúa a NULL, y un CHECK se satisface cuando la expresión da NULL —no sólo
-- cuando da TRUE—, así que la versión de staging también acepta el NULL. Nadie
-- se iba a enterar por un error.
--
-- Se unifica igual, por dos razones:
--
--   1. Una regla que depende de la lógica de tres valores para permitir NULL
--      permite NULL por accidente, no por decisión. La versión del repo lo dice.
--   2. Dos definiciones bajo un nombre es la trampa que este proyecto ya pisó:
--      la 0172 borró policies por nombre, el entorno tenía otros, y el
--      `DROP ... IF EXISTS` dijo "ok" sin hacer nada. Una diferencia que hoy no
--      molesta es la que mañana hace que una migración mienta.
--
-- En local es un no-op exacto (la definición ya es esta). `pet_tags` es chica y
-- el CHECK se revalida al agregarlo; no hace falta NOT VALID.

ALTER TABLE pet_tags DROP CONSTRAINT IF EXISTS pet_tags_revoked_reason_valid;
ALTER TABLE pet_tags
  ADD CONSTRAINT pet_tags_revoked_reason_valid
  CHECK (
    revoked_reason IS NULL
    OR revoked_reason IN ('lost', 'damaged', 'transfer', 'fraud', 'owner_request', 'other')
  );
