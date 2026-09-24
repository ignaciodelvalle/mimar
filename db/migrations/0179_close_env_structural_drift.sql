-- Migración 0179 — cerrar las 19 diferencias estructurales que quedaban entre
-- el repo y staging, medidas con scripts/check-env-schema-drift.ts el 2026-08-13.
--
-- Las tres son idempotentes y forward-only: en el entorno que ya está bien, cada
-- bloque es un no-op. No hay una "dirección correcta" única — cada grupo se
-- resolvió mirando qué dice el repo y por qué.
--
-- ============================================================================
-- GRUPO A — índices que una migración dropeó y staging nunca ejecutó
-- ============================================================================
-- Mismo modo de falla que los restos de la 0084 que cerró la 0178: un entorno
-- baselineado dio por aplicadas migraciones que nunca corrieron. Estos cuatro
-- índices los borran explícitamente 0095 y 0096, y en staging seguían vivos:
--
--   appointments_pet_idx                → DROP en 0096 (lo reemplaza
--                                          appointments_pet_status_idx)
--   foster_volunteers_user_idx          → DROP en 0095
--   libreta_share_tokens_token_idx      → DROP en 0095
--   organization_memberships_active_idx → DROP en 0095
--
-- Un índice de más no rompe nada, pero cuesta escritura y —peor— desmiente al
-- repo: alguien lee 0096 y cree que ese índice ya no existe en ningún lado.

DROP INDEX IF EXISTS public.appointments_pet_idx;
DROP INDEX IF EXISTS public.foster_volunteers_user_idx;
DROP INDEX IF EXISTS public.libreta_share_tokens_token_idx;
DROP INDEX IF EXISTS public.organization_memberships_active_idx;

-- ============================================================================
-- GRUPO B — la misma regla con dos nombres distintos
-- ============================================================================
-- Estos cinco existen en las dos bases y hacen exactamente lo mismo; lo que
-- cambia es el nombre. Staging tiene el que Postgres autogenera (`_check`,
-- `_key`, `_pkey`) porque nació de SQL sin nombrar la constraint; el repo
-- declara uno explícito en db/schema.ts.
--
-- POR QUÉ IMPORTA, aunque "funcione igual": este proyecto ya perdió una
-- corrida entera por esto. La migración 0172 borraba policies POR NOMBRE, el
-- entorno tenía otros nombres, el `DROP ... IF EXISTS` dijo "ok" sin hacer
-- nada, y un hallazgo crítico quedó vivo durante días. Dos nombres para la
-- misma regla es una trampa cargada esperando la próxima migración que
-- referencie una por nombre.
--
-- RENAME y no DROP+CREATE: preserva el índice subyacente y no toma un lock de
-- reconstrucción sobre tablas con datos.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pet_tags_status_check')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pet_tags_status_valid') THEN
    ALTER TABLE pet_tags RENAME CONSTRAINT pet_tags_status_check TO pet_tags_status_valid;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pet_tags_revoked_reason_check')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pet_tags_revoked_reason_valid') THEN
    ALTER TABLE pet_tags
      RENAME CONSTRAINT pet_tags_revoked_reason_check TO pet_tags_revoked_reason_valid;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_subscriptions_endpoint_key')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_subscriptions_endpoint_unique')
  THEN
    ALTER TABLE push_subscriptions
      RENAME CONSTRAINT push_subscriptions_endpoint_key TO push_subscriptions_endpoint_unique;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'panorama_cube_pkey')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'panorama_cube_metric_unit_level_unit_code_pk'
     ) THEN
    ALTER TABLE panorama_cube
      RENAME CONSTRAINT panorama_cube_pkey TO panorama_cube_metric_unit_level_unit_code_pk;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'panorama_kpi_cube_pkey')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'panorama_kpi_cube_scope_kpi_pk'
     ) THEN
    ALTER TABLE panorama_kpi_cube
      RENAME CONSTRAINT panorama_kpi_cube_pkey TO panorama_kpi_cube_scope_kpi_pk;
  END IF;
END $$;

-- ============================================================================
-- GRUPO C — columnas muertas que la 0103 borró y staging conservó
-- ============================================================================
-- Este grupo empezó siendo otro: creí que `organizations_coordinates_pair_check`
-- era una guarda sana que staging tenía y el repo no declaraba, y la primera
-- versión de esta migración la CREABA en el local. Falló al aplicarse — "column
-- latitude does not exist" — y esa falla fue el hallazgo:
--
-- La migración 0103 borra `organizations.latitude` y `.longitude` (numeric(9,6),
-- reemplazadas por location_lat/location_lng con más precisión). Staging nunca
-- la ejecutó, así que conserva LAS DOS COLUMNAS y el CHECK que las vigila. No
-- era una guarda de más: era el resto de datos que no deberían existir.
--
-- Lo encontró un error de aplicación, no una revisión, porque el comparador de
-- entornos miraba constraints e índices y NO columnas. Ya mira columnas.
--
-- Dropear las columnas se lleva puesto el CHECK que depende de ellas. En local
-- es no-op (0103 sí corrió acá).

ALTER TABLE organizations
  DROP COLUMN IF EXISTS latitude,
  DROP COLUMN IF EXISTS longitude;

-- Las dos guardas de tabla singleton (id = 1) sí son eso: sanas, presentes en
-- staging y ausentes del repo. Se CREAN donde falten en vez de borrarse donde
-- están — bajar una guarda correcta para que dos bases coincidan es igualar
-- para abajo.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'panorama_cube_meta_id_check'
      AND conrelid = 'public.panorama_cube_meta'::regclass
  ) THEN
    ALTER TABLE panorama_cube_meta
      ADD CONSTRAINT panorama_cube_meta_id_check CHECK (id = 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'panorama_kpi_cube_meta_id_check'
      AND conrelid = 'public.panorama_kpi_cube_meta'::regclass
  ) THEN
    ALTER TABLE panorama_kpi_cube_meta
      ADD CONSTRAINT panorama_kpi_cube_meta_id_check CHECK (id = 1);
  END IF;
END $$;
