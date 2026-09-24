-- Migration 0175 — pets: eliminar la policy de INSERT para `authenticated`.
-- (Cierre del último miembro de la clase que abrió el hallazgo #2 de la 2a
-- pasada; ver 0173 para el hermano en welfare_reports.)
--
-- LA POLICY
-- ---------
--   "Pets insertable by any authenticated user"
--     on public.pets for insert to authenticated with check (true)
--
-- Sin restricción de columnas: cualquier cuenta con sesión podía crear filas de
-- `pets` por PostgREST con la anon key del bundle, eligiendo `status`,
-- `jurisdiction_*`, `potentially_dangerous_breed` y el resto a gusto.
--
-- POR QUÉ SE ELIMINA, Y POR QUÉ RECIÉN AHORA
-- ------------------------------------------
-- Su justificación en la allowlist de write-path-matrix.test.ts tenía la misma
-- FORMA que la de welfare_reports, que resultó falsa: no decía "la app la
-- necesita", decía "una fila huérfana sin ownership es inerte" — un argumento
-- de daño bajo, no de necesidad. Cuando la justificación de una apertura habla
-- del daño en vez del uso, casi siempre es que nadie la usa.
--
-- No se tocó junto con 0173 porque la única evidencia que había entonces era un
-- grep que no encontraba `from("pets").insert`: evidencia NEGATIVA de una
-- búsqueda, que es exactamente la clase de argumento que falló hoy en dos
-- informes ("los buckets son tres", "pg_net está ausente"). Borrar una policy de
-- la tabla central del producto con esa base habría sido reemplazar un riesgo
-- por otro.
--
-- LA EVIDENCIA POSITIVA QUE FALTABA (medida 2026-08-13, población cerrada):
--
--  1. El cliente de browser (`lib/supabase/client.ts`) se usa en EXACTAMENTE 4
--     archivos —BulkRevokeList, RevokeUserActions, RevokeOrgActions y
--     use-evidence-upload— y los cuatro lo usan SÓLO para
--     `storage.from("revocations")`. Ninguno toca una tabla por PostgREST.
--  2. Nadie construye un cliente de browser fuera de ese wrapper.
--  3. Los tres caminos de alta de producción escriben por Drizzle con BYPASSRLS:
--     pets-repository.ts, execute-decomiso.ts y create-intake.ts.
--  4. Ni `e2e/` ni `scripts/rls-smoke.ts` insertan en `pets` — sólo hacen
--     SELECT, así que ninguno depende de esta policy.
--
--  5. Y lo decisivo: `__tests__/rls/matrix.data.ts` YA DECLARA que el INSERT de
--     `pets` debe ser `deny` para los cuatro roles, incluido owner, con la razón
--     escrita "owner inserts pets only via server action (Drizzle bypasses
--     RLS)". La intención estaba documentada desde antes; la policy la
--     contradecía. Nada lo cazaba porque `OPERATIONS_UNDER_TEST = ["select"]`
--     (matrix.test.ts:64): las celdas de INSERT se declaran y NUNCA se prueban.
--
-- O sea que esta migración no cambia la intención del sistema: hace que la base
-- coincida con lo que el repo ya decía que debía pasar.
--
-- Forward-only e idempotente.

BEGIN;

DROP POLICY IF EXISTS "Pets insertable by any authenticated user" ON public.pets;

COMMIT;
