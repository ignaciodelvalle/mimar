-- Migration 0174 — pinnear el search_path de la última función SECURITY DEFINER
-- que no lo tenía, y sacar un grant inerte.
-- (2a pasada de auditoría, hallazgo #8 — pero por una razón más fuerte que la
-- que decía el informe; ver abajo.)
--
-- QUÉ CAMBIA
-- ----------
-- 1. `public.is_hidden_from_subject_case(uuid)` pasa de `search_path=public` a
--    `search_path=''`. Su cuerpo ya califica todo (`public.cases`), así que el
--    cambio no altera resolución alguna — lo alinea con `can_read_case`, su
--    hermana del mismo dominio, que ya usaba `''`.
-- 2. Se revoca el EXECUTE de `authenticated` sobre `pii.caller_is_admin(uuid)`.
--
-- POR QUÉ (1) NO ES COSMÉTICO, QUE ES LO QUE EL INFORME ASUMIÓ
-- -----------------------------------------------------------
-- El informe clasificó esto como COSMÉTICO porque la función califica sus
-- referencias, y eso es cierto. Pero al medir el sustrato contra la base VIVA
-- aparecieron dos cosas que el barrido por SQL versionado no podía ver:
--
--   · `pg_net` ESTÁ INSTALADO (schema `extensions`). El informe afirmó lo
--     contrario — "Ausentes (verificado): pg_net, http, dblink, pgjwt → sin
--     superficie SSRF/HTTP" — y sobre esa premisa falsa concluyó que no había
--     superficie. La instala la plataforma Supabase, no nuestras migraciones,
--     que es exactamente por qué un barrido de SQL versionado no la ve. El
--     propio informe lo había anticipado en su sección "Qué NO pude verificar".
--   · `extensions` está en `extra_search_path` de TODA request
--     (supabase/config.toml:15), y `anon`/`authenticated` tienen EXECUTE
--     explícito sobre `extensions.http_get` y `extensions.http_post`.
--
-- Verificado que HOY no es alcanzable por la API: PostgREST expone sólo
-- `public` y `graphql_public`, así que un RPC a `http_get` responde PGRST202
-- (probado contra el stack local). O sea que no hay un agujero abierto.
--
-- Pero la combinación —capacidad de HTTP saliente, ejecutable por roles de baja
-- confianza, con su schema en el search_path de toda request— es justo el
-- escenario donde una función SECURITY DEFINER sin search_path pinneado deja de
-- ser cosmética: cualquier referencia sin calificar dentro de ella se resuelve
-- por búsqueda, y la búsqueda incluye `extensions`. Pinnear a `''` cierra esa
-- clase entera por construcción, en vez de depender de que cada autor futuro se
-- acuerde de calificar.
--
-- POR QUÉ (2)
-- -----------
-- `pii.caller_is_admin` tiene EXECUTE para `authenticated`, pero el schema `pii`
-- no otorga USAGE a nadie (nspacl NULL), así que el grant no habilita nada: es
-- inerte. Un grant que no hace nada es peor que ninguno — el próximo que audite
-- tiene que gastar tiempo en demostrar que no sirve, como se gastó acá.
--
-- LO QUE NO SE TOCA, Y POR QUÉ
-- ----------------------------
-- `pg_trgm` y `unaccent` viven en `public` en vez de un schema dedicado. Se
-- dejan como están: moverlas exige recrear todo índice y operador que las
-- referencie, y el beneficio es de higiene, no de seguridad (no exponen
-- capacidad de red ni de escritura). Si alguna vez se hace, es su propia
-- migración con su propio plan de reindexado, no un renglón de esta.
--
-- Forward-only e idempotente.

BEGIN;

-- (1) Pinnear el search_path. El cuerpo ya califica `public.cases`.
ALTER FUNCTION public.is_hidden_from_subject_case(uuid) SET search_path = '';

-- (2) Sacar el grant inerte.
REVOKE EXECUTE ON FUNCTION pii.caller_is_admin(uuid) FROM authenticated;

COMMIT;
