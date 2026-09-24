-- Migración 0178 — cerrar el último hueco de catálogo y reparar la deriva
-- estructural que encontró scripts/check-env-schema-drift.ts el 2026-08-13.
--
-- Tres cosas independientes, todas idempotentes y forward-only.
--
-- ============================================================================
-- 1. approval_requests.approval_type_valid — UN FLUJO ROTO EN TODA BASE NUEVA
-- ============================================================================
-- Lo más grave de la auditoría. Las dos bases creían tener la misma regla:
--
--   staging: type IN ('role_upgrade_vet','organization_verification',
--                     'service_dog_credential_verification')
--   local:   type IN ('role_upgrade_vet','organization_verification')
--
-- Y el código INSERTA el tercero:
-- src/modules/pets/application/service-dog/submit-verification-request.ts:70
-- escribe `type: "service_dog_credential_verification"` — es la solicitud de
-- verificación de credencial de perro de asistencia (Ley 26.858, Dec. 792/2019,
-- RUPGA/ANDIS Res. 2588/2022).
--
-- O sea: la funcionalidad anda en staging ÚNICAMENTE porque alguien parcheó esa
-- constraint a mano ahí. La migración correspondiente nunca llegó al repo. En
-- cualquier base construida desde las migraciones —el local de cualquiera que
-- clone hoy, o producción si se reconstruye— ese flujo falla con violación de
-- constraint. Nadie lo notó porque el clickthrough documentó la pantalla sin
-- enviarla ("dato sensible; alcanza con documentar").
--
-- La dirección del arreglo la decide el código, no la base: el código escribe
-- ese valor, entonces el valor es válido y la constraint estaba corta.

ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_type_valid;
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_type_valid
  CHECK (type IN (
    'role_upgrade_vet',
    'organization_verification',
    'service_dog_credential_verification'
  ));

-- ============================================================================
-- 2. pets.species — la compuerta del régimen PPP, sin guardia
-- ============================================================================
-- `isPotentiallyDangerousBreed` arranca con `if (species !== "dog") return false`.
-- Es la compuerta del régimen entero: un 'Perro', un 'DOG' o un 'dog ' lo apagan
-- por completo y en silencio. La tabla `pets` tiene CHECK para el nivel de
-- energía y el rango etario de un aviso de adopción, y no tenía uno para esto.
--
-- Los seis valores salen de lib/utils/species.ts (speciesLabel), que es la
-- fuente única de verdad de las etiquetas y está guardada por
-- __tests__/species-label-single-source.test.ts.
--
-- Medido antes de escribir esto: staging tiene exactamente cinco de los seis
-- (dog 36.740, cat 25.548, rabbit 2.610, other 1.958, guinea_pig 2) y ningún
-- valor fuera de catálogo. La constraint entra sin migrar un solo dato — que es
-- justamente el momento de ponerla, mientras nadie la violó todavía.

ALTER TABLE pets DROP CONSTRAINT IF EXISTS pets_species_valid;
ALTER TABLE pets
  ADD CONSTRAINT pets_species_valid
  CHECK (species IN ('dog', 'cat', 'rabbit', 'guinea_pig', 'ferret', 'other'));

-- ============================================================================
-- 3. Restos de la migración 0084 que nunca se ejecutaron en staging
-- ============================================================================
-- 0084 dropea `pets_tattoo_location_valid` y `pets_tattoo_code_idx` al mover la
-- identificación a `pet_identifications`. `db/schema.ts` los declara borrados
-- desde entonces. Staging los tiene igual; local no.
--
-- Es el mismo modo de falla que la 0172 de esta misma semana: un entorno
-- baselineado nunca ejecutó las migraciones anteriores al baseline, se las dio
-- por aplicadas. El repo describe una base que no existe.
--
-- En local esto es un no-op (0084 sí corrió acá). Es idempotente, así que
-- también sirve para producción, que muy probablemente esté igual que staging
-- — CHEQUEARLO con check-env-schema-drift.ts antes y después, en vez de asumir
-- que aplicar alcanza. Esa asunción es justo la que falló con la 0172.

ALTER TABLE pets DROP CONSTRAINT IF EXISTS pets_tattoo_location_valid;
DROP INDEX IF EXISTS pets_tattoo_code_idx;
