> **▶ ARCHIVADO 2026-08-04** — triage de planes: el trabajo que describe está shippeado (verificado contra el árbol). Se conserva por su método y su evidencia; como plan de trabajo, está cerrado.

# Plan: Design-System Hardening & Regression Prevention — post-remediación

> **Para Claude Code. Corre DESPUÉS de [`2026-06-20-ux-audit-remediation.md`](./2026-06-20-ux-audit-remediation.md).**
> La remediación *arregla* los hallazgos; este plan los **convierte en guardrails y documentación** para que
> no vuelvan. La tesis de largo plazo: un clickthrough (o un fix puntual) es una foto; un lint rule + un test
> en CI + un catálogo documentado **corren en cada commit para siempre** y componen a medida que crece el
> código y el equipo. *"Si no está documentado/enforced, no existe."*
>
> **Por qué estas 5 jugadas y no las otras** (de las técnicas de QA discutidas): se eligieron las **durables y
> compuestas** (lint, catálogo, axe-CI, smoke-matrix, visual-regression). Quedan **fuera** a propósito:
> property/contract tests de paths puntuales (son tácticos — van con los fixes de Fase 0), y los **métodos
> humanos** (heuristic eval, usability test moderado, field-test del QR impreso) que son los más fuertes para
> *insight* pero **no los puede ejecutar Claude Code** — se recomiendan como cadencia humana recurrente, fuera
> de este plan.
>
> SDD test-first, docs en el mismo PR, sin cambios de schema/rutas salvo aviso. Cada fase es 1+ sesión de CC.

---

## Evidencia base (scan 2026-06-20)

- `lint:tokens` ya existe → `scripts/check-design-tokens.ts` (bloquea utilities de paleta cruda, `dark:`, y
  hex arbitrario), **pero excluye `components/ui/**`** por diseño. Hay codemods de autofix
  (`scripts/codemod-poncho-tokens.ts`, `codemod-purge-dark.ts`, `codemod-status-tints.cjs`).
- **Sin Storybook.** Pero ya existen rutas de galería: `app/(public)/design/page.tsx` (+ `IconSearch.tsx`) y
  `app/(app)/design/dashboards/page.tsx` → extender esto, no traer Storybook.
- Gemelos muertos confirmados: `components/gob/MetricCard.tsx` se usa **solo** en la galería `/design/dashboards`
  (ningún dashboard real); `components/charts/DashboardChart.tsx` tiene **cero** uso en app. Canónico = `OpKpi`.
- `min-h-9` (36px, < 44px) en 10 sitios: `OpRailNav`, `OpMobileDrawer`, `PetQuickActions` (×6), `PeriodPicker`,
  `AppShellDrawer`.

---

## Fase A — Hacer el design system auto-enforcing (lint) · *la jugada #1*

**Tesis:** los hallazgos de consistencia (color-only, hardcoded, 44px, acentos, enums crudos) son infinitos si
se cazan a mano. Un guard en CI los vuelve **imposibles de re-introducir**. Ya hay un guard de tokens — se
**extiende**, no se reinventa.

1. **Ampliar `scripts/check-design-tokens.ts`:** quitar la exclusión de `components/ui/**` (migrar primero los
   hits con los codemods existentes), de modo que los primitives también queden bajo el guard.
2. **Nuevas reglas (mismo guard o un `scripts/check-ui-invariants.ts` hermano, corrido en CI):**
   - **Touch target ≥ 44px:** prohibir `min-h-9`/`h-9`/`min-w-9` en elementos interactivos (button/a/[role=button]/input). Autofix → `min-h-11`. Cubre los 10 hits actuales.
   - **No color-only status:** heurística — un nodo con clase de tono semántico (`text-gob-danger`/`text-ln-err`/`*-warn`/`*-ok`) que no tenga ni `aria-*` ni un `<Icon>`/glyph hermano. Empezar como warn, subir a error tras limpiar.
   - **No enum crudo en JSX:** prohibir literales `SCREAMING_CASE` (`/\b[A-Z]{2,}_[A-Z_]{3,}\b/`) renderizados como texto (catch de "LOST_EPISODE_RESOLVED_OWNER", causas "Euthanasia/Accident", etc.). Deben pasar por un mapa label.
   - **Copy es-AR:** wordlist de acentos faltantes ("Ultimas", "notificacion", "pais", "evaluan", "duenos") + lista de enums en inglés conocidos. Lint sobre strings de usuario.
   - **A11y estructural (vía `eslint-plugin-jsx-a11y`, si no está):** `no-nested-anchors`, label asociado, `fieldset/legend` para radio groups, exactamente un `<main>`. 
3. **`required` consistente:** regla/codemod que asegure que campos con `required` rendericen el marcador `*` vía `LnField`/`OpField` (no a mano).
4. **CI:** agregar todos al job de lint (`pnpm verify`). 
- **Test/acceptance:** cada regla con fixtures pass/fail; el repo entero pasa en verde tras los codemods.

## Fase B — Inventario canónico + documentación viva · *la jugada #2*

**Tesis:** la duplicación (`MetricCard`, `DashboardChart`) existe porque **no hay una fuente única documentada**;
la gente reinventa porque no ve lo que ya hay. Un catálogo documentado + deprecación enforced mata la causa raíz.

1. **Extender las rutas `/design`** a un catálogo de componentes: por cada primitive de `components/ui/*` y
   `components/ui/dashboard/*`, mostrar variantes × estados (default/hover/active/disabled/loading/error/empty),
   props, y notas de a11y (rol/teclado/SR). Usar el formato del skill `/design-system document`.
2. **Marcar canónico vs deprecado:** documentar `OpKpi` como canónico; `MetricCard` y `DashboardChart` como
   **deprecados**. Migrar sus (pocos/cero) usos reales al canónico y a las barras/KPIs correctos, luego:
   - **Borrar** `MetricCard` (+ test) y consolidar charts en `DashboardChart` (que hoy está muerto pero es el mejor — tiene empty states/method notes/export), retirando las barras CSS hand-rolled.
   - **`no-restricted-imports`** (ESLint) que prohíba importar los módulos deprecados → la deprecación se vuelve imposible de ignorar.
3. **Un "component registry" liviano** (`docs/design-system/components.md` o generado del catálogo) listando
   cada componente, su estado (canónico/deprecado), y dónde se usa. 
- **Acceptance:** cero usos de los gemelos deprecados; `/design` renderiza el catálogo; CI falla si se importa un deprecado.

## Fase C — Accesibilidad en CI (axe) · *la jugada #3*

**Tesis:** el sistema ya *declara* intención WCAG (tokens con ratios anotados, `Field` con 44px). axe en CI la
vuelve **verificada y no-regresable**, y respalda la declaración real de `/accesibilidad` (Fase 3.3 de remediación).

1. Agregar `@axe-core/playwright` y correr axe sobre la **matriz de rutas** (ver Fase D) en `e2e/`.
2. Gate: cero violaciones serious/critical en surfaces públicas y en los forms clave; las nuevas violaciones
   rompen el build.
- **Acceptance:** job e2e-a11y verde; baseline documentado; los ítems de Fase 2.4 de remediación quedan cubiertos por test.

## Fase D — Red de seguridad: route-smoke matrix + observabilidad · *durable*

**Tesis:** los 5 crashes sólo se dispararon en estados específicos (pet `lost`, miembro de org, owner con 2000+
pets, token malo). Una matriz que los enumere los vuelve **extintos como clase**, y el monitoreo convierte un
`digest` opaco en un stack trace.

1. **Smoke matrix** en `e2e/`: generar la lista de rutas desde el árbol del App Router y afirmar
   `200 + sin error boundary` para {rol} × {estado de entidad: active/lost/deceased} × {vacío/poblado}. Esto
   captura 0.1–0.4 de la remediación para siempre (hoy `public-smoke.spec.ts` no cubre una credencial `lost`).
2. **Error monitoring (Sentry o equiv.) + source maps:** wire al error boundary de Next; subir source maps en
   build (Vercel). Cada crash de prod → stack real (el `752082971` habría sido obvio al deploy).
3. **Adjuntos menores:** test que corre las proyecciones sobre todas las filas de seed (caza data que rompe
   render *antes* del deploy — habría marcado el crash lost como seed-related al instante); presupuesto de
   tiempo en CI para las páginas pesadas (`/cuenta`, panel de org) usando `seed:perf` (caza el crash de escala).
- **Acceptance:** la matriz falla si cualquier ruta/estado tira 5xx o error boundary; Sentry recibe eventos en preview.

## Fase E — Visual regression + mobile real · *durable, cierra el blind-spot mobile*

**Tesis:** protege el contrato visual del sistema y cubre lo único que el clickthrough no pudo (render mobile —
el viewport de screenshot era fijo ~1220px, y el momento héroe del QR es mobile).

1. Snapshots de Playwright (o Chromatic/Percy) en viewport **desktop y mobile** (≤390px) sobre la matriz de
   rutas + el catálogo `/design`. Captura drift y los bugs visuales que sólo se vieron a ojo (solape del título
   del hero, doble label de Localidad).
2. Lighthouse CI con budgets (PWA/perf/a11y/SEO) sobre las hero surfaces.
- **Acceptance:** baseline de snapshots commiteado; diff visual en cada PR; budgets de Lighthouse en verde.

---

## Orden recomendado y dependencias

```
(remediación 2026-06-20 cierra) 
        │
        ├─ Fase A (lint guardrails)        ← arranca acá: barato, bloquea regresión inmediata
        ├─ Fase B (inventario + deprecación) ← consume la consolidación de Fase 1.4 de remediación
        ├─ Fase C (axe CI)                 ← depende de la matriz de Fase D para rutas
        ├─ Fase D (smoke matrix + Sentry)  ← la red de seguridad; alto valor, hacer temprano junto con A
        └─ Fase E (visual + mobile)        ← último; el más caro de mantener
```

Sugerencia: **A + D primero** (guardrails + red de seguridad, el mejor ratio valor/esfuerzo), luego **B**
(paga la deuda de duplicación), después **C** y **E**.

## Fuera de alcance de este plan (pero recomendado, cadencia humana)

No automatizable por Claude Code — agendar como práctica recurrente del equipo:
- **Heuristic evaluation** (10 de Nielsen) y **cognitive walkthrough** por surface.
- **Usability test moderado** con owners y operadores reales (catch del framing "264 casos como carga", confianza).
- **Field test del momento héroe:** imprimir un QR real, dárselo a un desconocido con un teléfono, observar el reporte de mascota encontrada.

> Al cerrar cada fase, marcar y mover a "Implementado" en `docs/superpowers/README.md`.
