# Plan de testing — MiMAR

Plan por fases para llegar a pre-release con confianza y, después, escalar a 1M usuarios sin reescribir todo. Cada fase tiene **objetivo**, **tareas concretas**, **criterio de salida** (cuándo está hecha) y **esfuerzo nominal**.

Las **decisiones marcadas** capturan la "doctrina" del proyecto: cómo deben quedar los tests definidos para siempre. Si en el futuro alguien (humano o agente) propone algo contrario, esta sección es la referencia.

---

## Decisiones marcadas (doctrina)

Estas decisiones son transversales a todas las fases.

### D1 — Vitest serial sobre Postgres local
Mantenemos `fileParallelism: false`. Las pruebas comparten una DB Postgres local y el costo de aislar transacciones por archivo no compensa el tiempo de runtime ahorrado. Si en algún momento el suite tarda > 5 min, primero intentamos `forks: true` con DB por fork; recién después consideramos worker pool.

### D2 — Cobertura medida en branches, no en líneas
Las métricas se reportan en branches (`vitest --coverage --reporter=verbose`). Targets por carpeta:

| Carpeta | Branch coverage mínimo |
|---|---|
| `lib/business-rules-*`, `lib/*-rules`, `lib/case-lifecycles` | 90% |
| `lib/*` (resto) | 70% |
| `app/actions/**` | 75% por archivo (cada server action ≥ 1 happy + ≥ 2 negativos) |
| `app/api/**` | 60% (los happy paths + casos de auth/permiso) |
| `components/` | sin mínimo — visual regression cubre lo importante |

### D3 — Fixtures por factory, no por SQL crudo
Toda creación de datos de prueba pasa por **factories** en `__tests__/factories/` (e.g. `createTestPet`, `createTestUser`, `createTestCase`). Las factories internamente llaman a las **mismas inner functions de los server actions reales**. Razones: si el server action cambia, los fixtures se mueven con él; tests no se desincronizan del modelo. **Prohibido** insertar directo con Drizzle en tests excepto cuando lo que se está probando es el repositorio mismo.

### D4 — Property-based para validadores y reglas
Para todo schema zod o función en `lib/business-rules-*` con > 3 ramas, agregamos al menos 1 test de propiedad con `fast-check`. Patrón: un invariante (round-trip, idempotencia, no-cross-state) generado contra 1000 inputs aleatorios. **No** sustituyen a los tests por ejemplo — los complementan.

### D5 — Snapshots solo en outputs visibles al usuario
Snapshots se reservan para: notificaciones (subject/body), descripciones enriquecidas, capability matrices, copy traducible. **Prohibido** snapshotear estructuras de datos internas (shape de DB, IDs, timestamps) — eso lleva a snapshots frágiles y a "actualizá el snapshot" sin pensar.

### D6 — State machines explícitas
Cada dominio con transiciones (`case_lifecycle`, `foster_proposal`, `adoption_application`, `rabies_observation`, `pregnancy`) tiene un archivo `lib/<dominio>/transitions.ts` que exporta una matriz `{ from, event, to, guard? }`. Los tests recorren la matriz completa más un fuzz que dispara eventos aleatorios y verifica que **ningún estado prohibido es alcanzable**. La lógica del server action consume esa misma matriz — no duplicada.

### D7 — RLS testing en dos capas
- **Smoke** (`rls:smoke`, ya existe): cross-account read/write básico contra PostgREST. Corre en CI siempre.
- **Matrix**: matriz `(rol × tabla × operación) → expected` versionada como YAML. Un test la recorre y compara contra Postgres. Si Postgres dice "permitido" donde la matriz dice "no", falla. **Toda nueva política RLS debe actualizar la matriz en el mismo PR** — esto es bloqueante en review.

### D8 — Cron handlers con tres invariantes
Cada handler en `app/api/cron/**` debe tener tests que verifiquen:
1. **Idempotencia**: correr dos veces produce el mismo estado.
2. **Ventana**: la corrida con dataset realista termina en < 50% de su intervalo de cron.
3. **Recovery**: si se interrumpe a la mitad (mock de exception), la próxima corrida termina el trabajo sin duplicar efectos.

Sin estos tres, no se mergea un cron handler nuevo.

### D9 — Event store es sagrado
- Test que verifica que `pet_events` no permite UPDATE ni DELETE (intento debe lanzar).
- Test de **replay determinism**: aplicar el log dos veces produce idéntico estado.
- Job nocturno (no test, pero relacionado) que compara `current_state` contra `replay(log)` y alerta si hay drift.

### D10 — E2E sobre Supabase local, smoke contra staging
- Playwright corre contra `supabase start` (local) en CI. Es lento pero determinístico y aislado.
- Un **smoke** mínimo (login + ver libreta propia + crear evento) corre contra staging después de cada deploy. Si falla, rollback automático.

### D11 — Test data nunca contiene PII real
Las factories generan DNIs sintéticos (rango reservado por convención: prefijo `99`), emails `@test.mimar.local`, nombres con prefijo `Test_`. Si un test necesita "datos plausibles", usa `@faker-js/faker` con seed fijo. Esto permite limpiar test data por convención de naming en cualquier ambiente.

### D12 — Tests no deben tocar internet
Todo servicio externo (geocoding, email, SMS, captcha) tiene un mock por defecto en `__tests__/setup.ts`. Si un test necesita un comportamiento específico, lo customiza con `vi.mock`. Si un test rompe porque no hay internet, es un bug del test, no del entorno.

### D13 — CI bloqueante para tests, lint, typecheck
PR no mergea si: lint falla, typecheck falla, tests fallan, o cobertura cae bajo los mínimos de D2. El job tarda < 8 minutos.

### D14 — Performance budgets versionados
`docs/testing/performance-budgets.md` define umbrales: p95 latency por ruta, queries por request, bytes por response, tiempo de cron. Tests de carga (Fase 3) los verifican. Cambiar un budget requiere PR explícito con justificación.

---

## Fase 0 — Gating (1 día)

**Objetivo**: parar la sangría. No queremos que mientras armamos el resto, sigan entrando PRs que rompen tests existentes.

| Tarea | Esfuerzo | Decisión |
|---|---|---|
| Agregar `pnpm test` a `.github/workflows/ci.yml` después del typecheck | 2h | D13 |
| Configurar Postgres local en CI (Supabase action o docker-compose) | 3h | D1, D12 |
| Definir branch coverage targets en `vitest.config.ts` con `@vitest/coverage-v8` | 1h | D2 |
| Documentar este `PLAN.md` y referenciarlo desde `AGENTS.md` | 1h | — |

**Criterio de salida**: un PR de prueba que rompe un test existente queda bloqueado por CI.

**Diferido a fase posterior**: actualizar tests ya rotos (si los hay). Primero cerramos el portón, después limpiamos lo de adentro.

---

## Fase 1 — Pre-release (4-6 semanas)

**Objetivo**: cerrar los gaps de cobertura críticos y tener flujos E2E corriendo. Estado deseado: cualquier bug serio se cazaría antes del merge.

### 1A — Cerrar gaps de server actions (1.5 semanas)
Prioridad alta, por riesgo de superficie:

1. `auth` (signup, login, logout, password reset, OTP).
2. `bite` (caso de mordida — interactúa con `rabies-observations`).
3. `intake` (alta de mascota — punto de entrada más usado).
4. `welfare-triage` (decisión clave en denuncias).
5. `claim` (transferencia de tenencia — tiene flow de disputas).
6. `transfer` (mover mascota entre cuentas — necesita ambos consentimientos).
7. `pregnancy` (apertura/cierre/aborto de embarazo).
8. `bulk-actions` (operaciones masivas — riesgo de IDOR).

Para cada uno: 1 happy + 2-3 negativos (permisos, validación, estado inválido). Decisiones D3, D6 aplican.

**Diferido**: los 27 server actions restantes con menor superficie de ataque (catálogos, lookup, etc.) — Fase 2.

### 1B — Tests de cron handlers (1 semana)
Los 12 handlers en `app/api/cron/**`. Para cada uno, los 3 invariantes de D8.

Foco especial: `close:rabies-observations`, `materialize:slots`, `auto-expire`, `escalate-disputes` (son los que más estado modifican).

**Diferido**: tuning de batch sizes (eso es Fase 3 cuando tengamos dataset de carga).

### 1C — Playwright E2E (1.5 semanas)
Cinco flujos, no más. Orden de implementación:

1. Registro + verificación DNI + carga de primera mascota.
2. Denuncia D2 → triage → cierre.
3. Adopción end-to-end (refugio → adoptante → transfer).
4. Foster con expiración por tiempo.
5. Compartir libreta vía token público.

Decisión D10: contra Supabase local + smoke (login + libreta) contra staging post-deploy.

**Diferido**: cobertura E2E exhaustiva — solo los 5 críticos por ahora. Visual regression de E2E en Fase 2.

### 1D — RLS matrix testing (3 días)
- Crear `db/rls-matrix.yaml` con la matriz completa rol × tabla × operación.
- Test en `__tests__/rls/matrix.test.ts` que recorre la matriz y compara contra Postgres.
- Decisión D7: PRs que tocan RLS sin tocar la matriz quedan bloqueados (rule de Biome o CODEOWNERS sobre `rls.sql`).

### 1E — State machines explícitas (1 semana)
Decisión D6: extraer las matrices de transición a archivos dedicados, generar tests parametrizados, eliminar duplicación lógica.

Dominios: `case_lifecycle`, `foster_proposal`, `adoption_application`, `rabies_observation`, `pregnancy`.

### 1F — Observabilidad básica (3 días)
- Sentry o equivalente conectado.
- Logs estructurados JSON con `request_id` propagado por middleware → server actions → edge functions → cron.
- Dashboard inicial con error rate, p95 latency, signups/día, denuncias por estado.

Sin esto, los tests de carga de Fase 3 son ciegos.

### 1G — Documentar testing strategy en AGENTS.md (1 día)
Una sección nueva que linkea a este PLAN.md y resume D1-D14. Cualquiera onboarding al repo tiene que poder encontrar la doctrina sin leer 86KB.

**Criterio de salida de Fase 1**:
- CI verde con coverage targets cumplidos.
- 5 flujos E2E corriendo en cada PR.
- 0 cron handlers sin los 3 invariantes.
- Sentry capturando errores de staging.
- RLS matrix bloqueante para cambios.

---

## Fase 2 — Hardening (2-3 semanas, poco después del pre-release)

**Objetivo**: cazar la clase de bugs que escapan a tests por ejemplo. Property-based y dataset adversarial.

### 2A — Property-based testing (1 semana)
Decisión D4. Por cada schema zod crítico y cada función en `lib/business-rules-*` con > 3 ramas, un test con `fast-check`. Invariantes propuestos:

- `validarDNI(rand) === decoder(encoder(rand))`.
- `materializeSlots(rand_settings)` no produce slots superpuestos.
- `closeRabiesObservation(rand_case)` siempre termina en uno de N estados válidos.
- `applyEvent(state, rand_event)` nunca produce estado prohibido por la matriz D6.

### 2B — Dataset adversarial (3 días)
Extender `seed:test` con escenarios límite (no es regression test — es seed):

- Mascotas con datos parciales (sin chip, sin DNI, sin localidad).
- Múltiples claims sobre la misma mascota.
- Adopciones con applicants problemáticos (denuncia previa).
- Slots en husos horarios distintos (CABA vs Ushuaia, con DST).
- Pregnancies vencidas / abandonadas.
- Observaciones de rabia atrasadas con feriado en medio.
- Cuentas en estados de gating intermedios (email confirmado sin DNI, etc.).

El dataset queda disponible para hacer QA manual y como base de los tests de carga (Fase 3).

### 2C — Snapshot tests de outputs (3 días)
Decisión D5. Cubrir:

- `enrichedDescription(case)` por estado del caso.
- `capabilitiesFor(user, role)` por matriz rol × institución.
- Subject/body de notificaciones por evento y locale.
- Copy de empty states, errores, confirmaciones.

### 2D — Visual regression (3 días)
- Chromatic free tier o Playwright snapshots commiteados.
- Captura de pantallas críticas: home, libreta, denuncia, adopción, refugio, admin.
- Decisión: en cada PR que toca `globals.css`, `components/poncho/**` o `app/**/page.tsx`, se ejecutan los snapshots.

### 2E — Resto de server actions (1 semana)
Los 27 server actions de menor superficie que diferimos en 1A.

**Criterio de salida de Fase 2**:
- Coverage en mínimos de D2 para todas las carpetas.
- Property-based corriendo en CI con presupuesto de tiempo (< 30s adicionales).
- Visual regression bloqueante para cambios de UI.
- Dataset adversarial seeded en cada CI run.

---

## Fase 3 — Escala (4-6 semanas, mientras la app crece)

**Objetivo**: validar que la arquitectura aguanta 1M usuarios. No buscamos que el código sea perfecto, sino conocer los cuellos de botella antes de que los descubra un usuario.

### 3A — Performance budgets versionados (2 días)
Decisión D14. Definir umbrales en `docs/testing/performance-budgets.md`:

| Métrica | Budget |
|---|---|
| p95 latency rutas autenticadas | < 500ms |
| p95 latency rutas públicas (libreta por token) | < 300ms |
| Queries por request | < 5 |
| Bytes por response | < 200KB |
| Cron handler — completion time | < 50% de su intervalo |

### 3B — Load testing con k6 (2 semanas)
Scripts versionados en `scripts/loadtest/`. Cinco escenarios:

1. **Baseline**: 50 RPS sostenidas en home + libreta autenticada por 30 min.
2. **Spike**: subida abrupta de 10 → 500 RPS en 30s, ver recovery.
3. **Soak**: 100 RPS sostenidas 24h. Buscar memory leaks, conn pool exhaustion.
4. **Feed con geofilter**: 200 RPS de búsqueda de mascotas perdidas con mapa.
5. **Token público**: 1000 RPS sobre `/p/[token]` (rate limit debería kickear).

Cada uno corre contra staging con el dataset adversarial de 2B + 100k mascotas sintéticas. Output: tabla comparable run-to-run, alertas si rompe presupuestos de 3A.

### 3C — Query performance analysis (1 semana)
- Habilitar `pg_stat_statements` en staging.
- Script en `scripts/explain-top-queries.ts` que toma las top 20 queries del último día y corre `EXPLAIN ANALYZE`. Output: tabla con tipo de scan, índices usados, filas estimadas vs reales.
- Detector de N+1: hook custom de Drizzle que cuenta queries por request en tests. Si supera 5 sin razón documentada, falla.

### 3D — Stress de Supabase Storage (3 días)
- Subir 10k fotos en paralelo y medir rate limits.
- Soak de 24h con uploads esporádicos. Medir si hay degradación.
- Test de quota: detectar antes de que llegue al límite del plan.

### 3E — Database growth simulation (3 días)
- Insertar 10M filas en `pet_events` con dataset realista.
- Medir queries comunes: `lookup by pet_id`, `replay desde checkpoint`, `materialize slot`.
- Verificar que las proyecciones siguen rápidas con esa escala. Si no, índices o particionado.

### 3F — Connection pool tuning (2 días)
- Stress con 4x el límite de conexiones del plan Supabase.
- Verificar que pgbouncer en modo `transaction` aguanta.
- Documentar configuración mínima por plan en `docs/ops/`.

### 3G — VACUUM y bloat monitoring (2 días)
- Dashboard de bloat por tabla en Sentry o equivalente.
- Alertas si una tabla supera 30% de bloat.
- Job manual documentado para `VACUUM ANALYZE` agresivo si es necesario.

**Criterio de salida de Fase 3**:
- Load tests corriendo nocturnos contra staging.
- Top 20 queries con plan de ejecución documentado y aprobado.
- Presupuestos de performance verificados continuamente.
- Capacidad conocida: "soportamos X RPS y Y usuarios concurrentes con la infra actual".

---

## Fase 4 — Resiliencia y seguridad para escala (3-4 semanas)

**Objetivo**: prepararse para fallos del proveedor, ataques, y growth de seguridad.

### 4A — Chaos engineering básico (1 semana)
- Test que simula Supabase caído: verificar que la app degrada con dignidad (pantalla de error informativa, no white screen).
- Test que simula token expirado mid-workflow: el form se debe recuperar, no perder.
- Test que simula email service caído: la creación de cuenta debe hacer rollback transaccional.
- Test que simula geocoding caído: fallback a búsqueda por texto sin mapa.

### 4B — IDOR fuzzing automatizado (1 semana)
Script que con auth de usuario A intenta acceder a recursos de usuario B, variando IDs en todas las rutas REST. Falla si alguno devuelve 200 con datos ajenos.

Combinable con la matriz RLS de D7: si la matriz dice "denegado" y el fuzz encuentra "permitido", es bug crítico.

### 4C — PII leak detection (3 días)
- Linter custom o regex en CI sobre logs y respuestas API buscando DNI, email, dirección sin redact.
- Test que verifica que los logs estructurados de Sentry no contengan PII en payloads.

### 4D — Captcha / bot detection (1 semana)
- Cloudflare Turnstile o hCaptcha en endpoints públicos: registro, búsqueda pública de mascotas, denuncia anónima.
- Tests que verifican que se requiere captcha en cada uno.
- Rate limit por IP además del captcha.

### 4E — Penetration test externo (1 semana, ejecutado por terceros)
- Contratar firma de seguridad para audit de staging.
- OWASP ZAP en CI nocturno como complemento.
- Triage de findings + remediation con prioridad.

### 4F — Migration drills (3 días)
- Test de migración hacia atrás por cada migración.
- Drill manual: migración grande corriendo mientras un load test corre. Documentar runbook.

**Criterio de salida de Fase 4**:
- Cero findings críticos en penetration test.
- Chaos tests corriendo semanalmente.
- IDOR fuzzing en CI nocturno.
- Runbook de migración con zero downtime documentado y probado.

---

## Diferido conscientemente

Estas cosas existen, son valiosas, pero hoy no movemos la aguja:

- **Mutation testing** (Stryker). Caro, no proporcional al beneficio antes de tener cobertura branch sólida (post-Fase 2).
- **Contract testing** entre Next.js y Supabase Edge Functions. Solo si crece el número de funciones edge. Hoy son pocas.
- **Multi-region readiness**. Postergar hasta tener > 100k usuarios activos o regulación que lo requiera.
- **Accessibility testing automatizado** (axe-core en CI). Importante, pero la audit de Fase 1 (manual + skill `accessibility-review`) es suficiente para pre-release. Automatizar en Fase 2 si hay tiempo.
- **Internationalization testing**. La app es es-AR. Solo si se planea sumar otro locale.
- **Mobile native testing** (Detox, Maestro). Si MiMAR sigue siendo web, no aplica. Si hay app nativa, plan separado.
- **GDPR / data deletion drills**. Argentina tiene ley 25.326 pero no es tan estricta. Test de borrado en Fase 4 si hay riesgo regulatorio.
- **Backup / restore drills**. Lo gestiona Supabase. Validar que sus backups funcionan una vez al trimestre, no en cada release.

---

## Resumen ejecutivo (TL;DR)

| Fase | Duración | Foco |
|---|---|---|
| **0 — Gating** | 1 día | CI bloquea PRs que rompen tests. Sin esto, todo lo demás es teatro. |
| **1 — Pre-release** | 4-6 semanas | Cerrar gaps críticos: 8 server actions, 12 crons, 5 E2E, RLS matrix, state machines, observabilidad. |
| **2 — Hardening** | 2-3 semanas | Property-based, dataset adversarial, snapshots, visual regression, resto de actions. |
| **3 — Escala** | 4-6 semanas | Performance budgets, load tests con k6, query analysis, storage stress, DB growth simulation. |
| **4 — Resiliencia** | 3-4 semanas | Chaos, IDOR fuzz, PII leak detection, captcha, pen test externo. |

**Total a 1M usuarios**: ~16-20 semanas de trabajo focalizado.

Las 14 decisiones marcadas (D1-D14) son las que persisten más allá del plan — son cómo MiMAR hace testing, para siempre.
