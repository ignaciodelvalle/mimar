-- Migración 0176 — cerrar los buckets de export en los entornos que fueron
-- PARCHEADOS A MANO. Continuación de 0172, que sólo alcanzó a los nombres que
-- declara el repo.
--
-- QUÉ PASÓ
-- --------
-- 0172 cerró la clase entera de buckets de export borrando por nombre las dos
-- policies que declara db/exports_storage.sql:
--
--   export_buckets_authenticated_upload
--   export_buckets_authenticated_read      (una sola, con bucket_id IN (...))
--
-- En LOCAL eso cerró el agujero: verificado, el fence quedó limpio.
--
-- En STAGING no. Medido el 2026-08-13 con scripts/list-storage-policies.ts:
-- staging tenía SEIS policies distintas, una por bucket, con otros nombres:
--
--   exports_authenticated_read_welfare_exports    ← LECTURA ABIERTA
--   exports_authenticated_read_ppp_exports        ← LECTURA ABIERTA
--   exports_authenticated_read_travel_exports     ← LECTURA ABIERTA
--   exports_authenticated_upload_welfare_exports
--   exports_authenticated_upload_ppp_exports
--   exports_authenticated_upload_travel_exports
--
-- Las creó a mano el hot-patch del primer deploy a staging — el propio header de
-- db/exports_storage.sql lo documenta: "the exact gap that had to be hot-patched
-- by hand on the first staging deploy". Nombres distintos, agujero idéntico, y
-- `DROP POLICY IF EXISTS` por nombre no las tocó: se aplicó, dijo "ok", y dejó
-- el hallazgo crítico #1 vivo en staging.
--
-- O sea que durante meses el repo describía un entorno que no existía. El SQL
-- versionado dice lo que NOSOTROS creamos, no lo que HAY; un entorno parcheado a
-- mano diverge y la divergencia es invisible desde el repo. La única razón por la
-- que esto se encontró es haber corrido el fence de RLS contra la base REAL en
-- vez de confiar en que la migración "se aplicó ok".
--
-- POR QUÉ SE BORRAN TAMBIÉN LOS UPLOAD
-- ------------------------------------
-- Las de lectura son lo grave: `bucket_id = '<x>'` como predicado completo hace
-- que POST /storage/v1/object/list/{bucket} devuelva TODO el bucket a cualquier
-- cuenta autenticada — el corpus nacional de bundles MPF para fiscalía, el padrón
-- PPP y los bundles de viaje.
--
-- Las de upload van igual porque los writers ya escriben por service-role desde
-- 0172 (lib/analytics/welfare-exports.ts, travel-exports.ts): esa policy no la
-- usa nadie y deja a cualquier autenticado plantar archivos en un bucket de
-- documentos legales.
--
-- No se crea policy de reemplazo. Con RLS habilitado y sin policy para
-- anon/authenticated, la respuesta es deny — que es lo que corresponde a buckets
-- que sólo escribe y firma el servidor.
--
-- EN LOCAL ESTA MIGRACIÓN ES UN NO-OP (esos nombres nunca existieron acá). Es
-- forward-only e idempotente, así que también sirve para PRODUCCIÓN, que muy
-- probablemente tenga el mismo parche a mano — CHEQUEARLO con
-- `DATABASE_URL=<prod> pnpm exec tsx scripts/list-storage-policies.ts` antes y
-- después, en vez de asumir que aplicar alcanza. Esa asunción es justo la que
-- falló acá.

BEGIN;

-- Lecturas abiertas (lo crítico).
DROP POLICY IF EXISTS "exports_authenticated_read_welfare_exports" ON storage.objects;
DROP POLICY IF EXISTS "exports_authenticated_read_ppp_exports" ON storage.objects;
DROP POLICY IF EXISTS "exports_authenticated_read_travel_exports" ON storage.objects;

-- Uploads sin consumidor (los writers usan service-role desde 0172).
DROP POLICY IF EXISTS "exports_authenticated_upload_welfare_exports" ON storage.objects;
DROP POLICY IF EXISTS "exports_authenticated_upload_ppp_exports" ON storage.objects;
DROP POLICY IF EXISTS "exports_authenticated_upload_travel_exports" ON storage.objects;

COMMIT;
