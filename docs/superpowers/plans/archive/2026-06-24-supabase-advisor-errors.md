> **▶ ARCHIVADO 2026-08-04** — triage de planes: el trabajo que describe está shippeado (verificado contra el árbol). Se conserva por su método y su evidencia; como plan de trabajo, está cerrado.

# Plan — Remediación de los 5 errores del Supabase advisor (seguridad)

> **✅ DONE — Implemented in PR #733 / #734 (2026-06-24).**
> - Migration `0113_advisor_security_errors.sql` closed all **5 ERROR** items (RLS deny-all ×4 + drop view).
> - Migration `0114_advisor_security_warns.sql` closed the critical **WARN** items
>   (`function_search_path_mutable` ×7, leaked-password protection, anon RPC grants).
> - The plan below is archived for historical reference.

> **Para Claude Code.** Spec-driven, una sola migración + actualización del test de cobertura RLS.
> Fuente: corrida del Supabase **security advisor** sobre el proyecto `DIM` (`mardurkdicugnzmpirjd`),
> 2026-06-24. Total: **5 ERROR, 21 WARN, 6 INFO**. Este plan cubre **sólo los 5 ERROR** (lo que pidió
> el owner). Los WARN críticos quedan listados al final como *follow-up*, fuera de alcance.

## ⚠️ Tensión de diseño — leer antes de codear

Tres de los cuatro errores `rls_disabled_in_public` (`govt_business_rules`, `jurisdictions_census`,
`rate_limit_buckets`) están **deliberadamente excluidos** de RLS por el propio proyecto:
`db/migrations/0086_track_rls_in_migrations.sql` PART 7 los documenta como exclusiones, y
`__tests__/rls/coverage.test.ts` (`RLS_INTENTIONALLY_EXCLUDED`) **lo testea**. El cuarto,
`_dim_migrations`, también está en esa lista de exclusión.

O sea: el linter y el proyecto **están en desacuerdo a propósito**. La razón de la exclusión fue
"no es PII". La razón del linter es válida igual: con RLS deshabilitada, **cualquiera con la anon /
publishable key puede `SELECT *`** de esas tablas vía PostgREST — y para `rate_limit_buckets`
(contadores de límite) y `_dim_migrations` (historial de migraciones) eso es una fuga operativa
real, aunque no sea "PII".

**Resolución propuesta (cierra el linter sin romper la intención del proyecto):** habilitar RLS
**deny-all** (RLS ON, sin policy) en las cuatro. Es exactamente el patrón PART 6 que ya se usa para
tablas de sistema no-PII (`eno_processing_queue`, `event_notification_outbox`). La app las lee por
**Drizzle / service-role (BYPASSRLS)** — verificado: `lib/rate-limit.ts` importa `db` de `@/db`
(Drizzle); `_dim_migrations` la escribe sólo `scripts/migrate.ts` por la conexión BYPASSRLS. Deny-all
a PostgREST = **cero impacto en la app**, sólo cierra la superficie anónima.

Esto **cambia una decisión documentada**, así que: si al verificar (paso 0) encontrás que algún
**cliente supabase-js anónimo** lee `govt_business_rules` o `jurisdictions_census` (p. ej. una página
pública que use la publishable key en vez de Drizzle), **no uses deny-all en esa tabla** — usá RLS +
policy de lectura pública `for select to anon, authenticated using (true)`. Decisión por tabla en el
paso 2.

## Paso 0 — Verificación previa (obligatoria, no asumir)

1. **¿Algo referencia la vista `pets_with_identifiers`?** Grep en todo el repo (sin `node_modules`):
   ```
   grep -rn "pets_with_identifiers" --include=*.ts --include=*.tsx --include=*.sql .
   ```
   Esperado (verificado 2026-06-24): **sólo** la migración `0056` que la crea y un comentario en
   `db/schema.ts:3723`. Cero usos en app/tests/scripts. Si sigue así → **DROP** (paso 1). Si aparece
   un uso nuevo → no la dropees: recreala `WITH (security_invoker = on)`.
2. **¿Algún cliente supabase-js anónimo lee las tablas de referencia?**
   ```
   grep -rn "from(\"govt_business_rules\"\|from('govt_business_rules'\|from(\"jurisdictions_census\"\|from('jurisdictions_census'" --include=*.ts --include=*.tsx .
   ```
   Si **no hay** (esperado) → deny-all para las dos. Si hay → policy de lectura pública para esa tabla.
3. Confirmá el número de migración siguiente: la última es `db/migrations/0112_*`. **Usá `0113`.**

## Paso 1 — Migración `db/migrations/0113_advisor_security_errors.sql`

Forward-only, idempotente, envuelta en transacción (default del runner `scripts/migrate.ts`).
Estructura sugerida:

```sql
-- 0113 — Remediación de los 5 ERROR del Supabase security advisor (2026-06-24).
-- Cierra: security_definer_view (pets_with_identifiers) + rls_disabled_in_public x4.
-- Patrón deny-all idéntico a 0086 PART 6 (la app llega por Drizzle/BYPASSRLS).
BEGIN;

-- (1) ERROR security_definer_view — pets_with_identifiers.
-- Vista compat obsoleta: las columnas legacy chip/tattoo se dropearon en 0084,
-- y no la referencia código de app ni tests (verificado paso 0). Se elimina.
DROP VIEW IF EXISTS public.pets_with_identifiers;

-- (2-5) ERROR rls_disabled_in_public — deny-all (RLS ON, sin policy).
-- App accede por service-role (BYPASSRLS); deny-all sólo cierra PostgREST anónimo.
ALTER TABLE public.rate_limit_buckets   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._dim_migrations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.govt_business_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jurisdictions_census ENABLE ROW LEVEL SECURITY;
-- Si el paso 0.2 encontró lectura anónima, en vez de deny-all para esa tabla:
--   CREATE POLICY "<tabla> public read" ON public.<tabla>
--     FOR SELECT TO anon, authenticated USING (true);

COMMIT;
```

> `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` es no-op si ya está habilitada → idempotente.
> `DROP VIEW IF EXISTS` también. No requiere `-- dim:no-transaction`.

## Paso 2 — Actualizar `__tests__/rls/coverage.test.ts`

El test **fallará en rojo** si la migración corre sin tocarlo (afirma que estas tablas están
*excluidas*). En el mismo PR:

- Mover `rate_limit_buckets`, `_dim_migrations`, `govt_business_rules`, `jurisdictions_census`
  de `RLS_INTENTIONALLY_EXCLUDED` → `RLS_REQUIRED`, con comentario "deny-all, migración 0113".
- Si alguna quedó con policy de lectura pública (no deny-all), igual va en `RLS_REQUIRED` (el test
  sólo chequea `relrowsecurity = true`, no la policy).
- Dejar en `RLS_INTENTIONALLY_EXCLUDED` sólo lo que sigue sin RLS (`ar_localities*`, `cron_runs`).

## Paso 3 — Actualizar la doc de exclusión

En la migración `0113` (o como comentario), anotar que PART 7 de `0086` queda **superado** para
estas cuatro tablas: ya no son "exclusiones documentadas", ahora son deny-all por defensa en
profundidad. No editar `0086` (las migraciones son inmutables una vez aplicadas) — documentarlo en
`0113` y, si querés, una línea en `AGENTS.md §Privacidad`.

## Test surface (qué tiene que quedar verde)

- `__tests__/rls/coverage.test.ts` — ahora exige RLS en las 4 tablas movidas. **Verde.**
- `pnpm verify` (tsc + Biome + lint:tokens + lint:ui + next build) sin regresiones.
- `pnpm test` con **0 regresiones** sobre el baseline conocido (ver handoff §Baseline).
- Re-correr el Supabase security advisor tras aplicar: los 5 ERROR deben desaparecer.
- Smoke manual: rate limiting sigue andando (`enforceRateLimit` en una denuncia anónima);
  el portal admin lee `govt_business_rules` (visor de reglas) y `jurisdictions_census` (censo) igual
  que antes — porque van por Drizzle, no por la anon key.

## Invariantes a respetar

- **Eventos append-only** — esta remediación no toca datos de eventos; sólo RLS/catálogo. OK.
- **Migraciones forward-only e inmutables** — no editar `0086`; todo va en `0113`.
- **Spanish UI / English code** — N/A acá (sólo SQL + test), pero comentarios en inglés en código.
- Sin `Co-Authored-By`.

## Fuera de alcance (follow-up recomendado, NO en este PR)

Estos son **WARN**, no ERROR — el owner pidió los errores. Vale la pena un PR aparte:
- `erase_subject_data` / `export_subject_data` (funciones de derechos del titular, Ley 25.326)
  son **ejecutables por el rol `anon`** vía RPC. Revisar si deberían exigir auth (revoke EXECUTE a
  anon o `SECURITY INVOKER`).
- **Leaked password protection** deshabilitada en Supabase Auth → habilitar (HaveIBeenPwned).
- `function_search_path_mutable` x7 → `ALTER FUNCTION ... SET search_path = ''` (hardening).
