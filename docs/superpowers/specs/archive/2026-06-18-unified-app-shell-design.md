# Unified app shell — one shell, role variants — design spec

> **Status:** 🟢 Ready for Claude Code — **todas las decisiones cerradas (sin pendientes del dueño)** · **Date:** 2026-06-18 · **Item 7 of the metrics-IA handoff**
> · Umbrella: `dim-interno:docs/superpowers-private/specs/archive/2026-06-18-metrics-ia-handoff-design.md` · Depende de **Item 1** (nav data) · De la crítica de navegación 2026-06-18.

## 1. Por qué este documento existe

Hoy conviven **tres sistemas de chrome** que reinventan la misma función (navegar):

- **Owner `(app)`** → `LnOwnerNav` (masthead azul-900) + `LnOwnerSubBar` (breadcrumb).
- **Público `(public)`** → `AppHeader` (faja Argentina + nav) + `AppFooter`.
- **Operadores (gob/admin/org)** → `OpShell` + `OpRail` (riel lateral navy).

Esto produjo, con evidencia de código:

1. **Inconsistencia de ubicación**: ciudadano navega desde una **barra superior**, operador desde un **riel lateral**. Misma tarea, dos lugares, tres componentes.
2. **Usuario logueado varado en surfaces públicas**: `(public)/layout.tsx` renderiza `nav={PUBLIC_NAV}` y **reemplaza todo el nav del rol**; la única vuelta es el chip de nombre truncado (`href = homeHref`) — lee como "cuenta", no como "volver a mis mascotas".
3. **Identidad visual cambia** al cruzar a público (faja Argentina + `AppFooter`) → "se ve raro / parece otro sitio".
4. **Tres duplicaciones de nav**: `LnOwnerNav.NAV_ITEMS` ≠ `OWNER_NAV` (una tiene "Denuncias", la otra no); `AppHeader.DEFAULT_NAV` ≠ `PUBLIC_NAV` (y "Inicio"→`/` vs el `/inicio` del owner). "Inicio" significa cosas distintas según el chrome.
5. **Escape hatches ad-hoc**: linkcitos `/admin`, `/gob`, `/cuenta`, `/mis-mascotas` distintos por rol, sin un patrón de "cambiar de contexto".

La opción elegida por el dueño es **(c): un shell único con variantes por rol**. Este spec lo define con **todas las decisiones tomadas** — no hay open questions; está listo para que Claude Code lo planifique y ejecute.

## 2. Decisiones cerradas (todas — sin pendientes del dueño)

- **D1 — Un solo `AppShell`** con prop `variant: 'citizen' | 'operator'`.
  - `citizen` = masthead superior horizontal. Cubre owner + público + público-logueado.
  - `operator` = riel lateral izquierdo. Cubre gob/admin/org; **absorbe** el actual `OpShell`/`OpRail`/`OpTopbar`.
- **D2 — Fuente única de nav: `components/layout/nav-presets.ts`.** Se eliminan `LnOwnerNav.NAV_ITEMS` y `AppHeader.DEFAULT_NAV`. La verdad es `OWNER_NAV` / `PUBLIC_NAV` / (operador) las `NavSection[]` de **Item 1**. Reconciliar `OWNER_NAV` incluyendo "Denuncias" (la versión más completa).
- **D3 — El nav se elige por estado de auth, no por route-group.** El `AppShell citizen` decide: anónimo → `PUBLIC_NAV`; **logueado → el nav del rol** (owner → `OWNER_NAV`), con las secciones públicas accesibles. Una surface pública **nunca** reemplaza el nav del rol. Esto arregla el varado (#2).
- **D4 — Retorno persistente garantizado.** En toda surface pública con sesión, el masthead del rol queda visible con "Inicio" del rol. El retorno no depende del chip de nombre.
- **D5 — "Inicio" desambiguado.** El **logo/brand** → landing pública `/`. El **item "Inicio"** → home del rol (`/inicio` para owner; el panel del operador para gob/admin/org). La landing pública no se etiqueta "Inicio".
- **D6 — Switcher de contexto único** en el masthead (slot `actions` del topbar operador; equivalente en citizen). Muestra **solo destinos a los que el usuario tiene derecho**: admin↔gob por `govt_assignments`; owner→sus orgs si es miembro; "volver a ciudadano" desde operador. Reemplaza los linkcitos ad-hoc. Si el usuario tiene un solo contexto, el switcher no se muestra.
- **D7 — Identidad visual por variante.** La **faja institucional Argentina (`GobStripe`)** se mantiene en `citizen` (owner + público) como franja superior fina; `operator` conserva su identidad **navy control-room** (sin faja). Un masthead component por variante, tokens compartidos.
- **D8 — Drawer mobile único.** Consolidar los tres drawers izquierdos (`LnOwnerNav` drawer, `OpMobileDrawer`, `HeaderNav` drawer) en uno (`AppShellDrawer`) parametrizado por variante. Los tres ya abren desde la izquierda — la base común existe.
- **D9 — Footer.** `citizen` conserva un `AppFooter` mínimo (legales + accesibilidad, Ley 26.653); `operator` sin footer.
- **D10 — Migración strangler, sin big-bang** (ver §6 phasing). Construir → migrar operador (1:1, bajo riesgo) → migrar ciudadano (arregla varado + "Inicio") → borrar lo viejo.
- **D11 — a11y preservada.** Se mantiene `#main-content` (skip link), focus-trap del drawer, `aria-current` en activos, contraste por tokens. No regresar lo cerrado en Track E (Ley 26.653 / WCAG AA).
- **D12 — Dependencia explícita: Item 7 consume Item 1.** Las `NavSection[]` operadoras de Item 1 alimentan el `variant=operator`. Tras Item 7, `OpShell`/`OpRail`/`OpRailNav` quedan absorbidos por `AppShell`; Item 1 sigue siendo la **fuente de datos** del nav, Item 7 la **capa de render**.

## 3. Target design

```
AppShell (variant)
 ├─ citizen:                              ├─ operator:
 │   GobStripe (faja AR, 4px)             │   (sin faja)
 │   Masthead horizontal:                 │   OpRail (riel lateral 224px):
 │     [logo→/]  [nav del rol o público]  │     [brand]  [NavSection[] de Item 1]
 │     [switcher]  [bell] [user/cuenta]   │   Topbar:
 │   main #main-content                   │     [crumbs] [scope chip] [switcher] [user]
 │   AppFooter (mínimo)                   │   main #main-content
 └─ AppShellDrawer (mobile, izq, único)   └─ AppShellDrawer (mobile, izq, único)
```

- **Una decisión de nav central** (`resolveShellNav(role, session, pathname)`): devuelve el nav + la variante. Anónimo en surface pública → citizen + `PUBLIC_NAV`. Owner en cualquier ruta (incluida pública) → citizen + `OWNER_NAV`. Operador → operator + `NavSection[]`. Operador que abre una surface pública → su variante operador con retorno (no se "cae" a citizen-público).
- **Switcher** (`ContextSwitcher`): lee los contextos del usuario (rol + `govt_assignments` + membresías de org) y lista solo los habilitados.

## 4. Implementation

- **`components/layout/AppShell.tsx`** (nuevo): el shell con `variant`. El `operator` reusa internamente la maquetación de `OpShell` (riel + topbar) — portar, no reescribir. El `citizen` reusa el masthead del owner.
- **`components/layout/AppShellDrawer.tsx`** (nuevo): drawer mobile único parametrizado por variante; reemplaza `OpMobileDrawer` + el drawer de `LnOwnerNav` + el de `HeaderNav`.
- **`components/layout/ContextSwitcher.tsx`** (nuevo): switcher; va en el slot `actions` del topbar (operador) y en el masthead (citizen).
- **`components/layout/nav-presets.ts`**: única fuente. Borrar `LnOwnerNav.NAV_ITEMS` y `AppHeader.DEFAULT_NAV`; reconciliar `OWNER_NAV`. Las `NavSection[]` operadoras vienen de Item 1.
- **`lib/shell-nav.ts`** (nuevo): `resolveShellNav(role, session, pathname)` — la decisión auth-aware (D3). Pura, testeable.
- **Layouts**: `app/(app)/layout.tsx`, `app/(public)/layout.tsx`, `app/gob|admin|org/.../layout.tsx` pasan a renderizar `<AppShell variant=… nav=…>`. Borrar `LnOwnerNav`, `LnOwnerSubBar` (su breadcrumb se reimplanta como crumbs del shell si se quiere), `AppHeader`, `OpShell` una vez migrados.

## 5. Test plan (test-first)

- **`lib/shell-nav.test.ts`** (pura): anónimo+pública → citizen+`PUBLIC_NAV`; owner+`/adoptar` → citizen+`OWNER_NAV` (no varado); operador+`/refugios` → operator + retorno; admin con assignments → switcher con gob; usuario mono-contexto → sin switcher.
- **Invariante de retorno** (test de integración/e2e): un owner logueado en `/adoptar`, `/refugios`, `/denuncias` **siempre** tiene visible "Inicio" del rol y un retorno ≤1 click. (Regresión directa del bug reportado.)
- **Nav único**: assert que no existen `NAV_ITEMS`/`DEFAULT_NAV` y que owner/público leen de `OWNER_NAV`/`PUBLIC_NAV` (grep-test o import-test).
- **Switcher entitlements**: solo lista destinos habilitados; nunca expone gob/admin a un owner.
- **a11y**: `axe` sin regresiones en masthead + drawer; focus-trap del drawer; `#main-content` presente en ambas variantes (liga con Track E).
- **Paridad operador**: snapshot de que gob/admin/org renderizan las mismas secciones que con `OpShell` (no se perdió ningún ítem en la migración).

## 6. Phasing (strangler — D10)

- **Fase A (1 PR):** `AppShell` + `AppShellDrawer` + `ContextSwitcher` + `lib/shell-nav.ts` + tests. Sin migrar layouts todavía (componentes nuevos, no cableados).
- **Fase B (1 PR):** migrar **operadores** (gob/admin/org) de `OpShell` → `AppShell variant=operator`, consumiendo las `NavSection[]` de Item 1. Paridad 1:1 (menor riesgo). Switcher reemplaza los linkcitos `/admin`,`/gob`,`/cuenta`,`/mis-mascotas`.
- **Fase C (1–2 PRs):** migrar **owner `(app)`** y **público `(public)`** a `variant=citizen`. Acá se arregla el **varado** (D3/D4) y se desambigua **"Inicio"** (D5). Reconciliar `OWNER_NAV`.
- **Fase D (1 PR):** borrar `LnOwnerNav`, `LnOwnerSubBar`, `AppHeader`, `OpShell`/`OpRail`/`OpRailNav`, `OpMobileDrawer`, `NAV_ITEMS`, `DEFAULT_NAV`. Docs.

## 7. Docs to update (en el PR que corresponda)

- `AGENTS.md → Design rules (UI conventions)`: nueva convención "un solo `AppShell` con variantes `citizen`/`operator`; nav desde `nav-presets`; retorno del rol siempre presente en surfaces públicas".
- `README.md → Portal surfaces`: aclarar que todos los portales comparten `AppShell` (variante por rol).
- `docs/superpowers/specs/2026-06-18-operator-nav-regrouping-design.md` (Item 1): nota de que su capa de render (`OpRailNav sections=`) queda absorbida por `AppShell variant=operator`; Item 1 sigue siendo la fuente de datos.
- `docs/superpowers/README.md`: fila ✅ + SHA.

## 8. Lo que NO está acá

- **Sin rediseño visual** de tokens/colores: se unifica estructura y ubicación, no la paleta (citizen sigue cálido/azul, operador navy).
- **Sin cambios de datos / rutas / capabilities**: es chrome. Las rutas y guards no cambian.
- **Sin tocar el contenido interno** de las pantallas (el perfil de mascota es Item 6; los dashboards Items 2–4): solo el shell que las envuelve.
- **Sin nav inferior (bottom tab bar)**: los drawers mobile quedan laterales (consistencia con lo existente).

## 9. Consistencia con el resto del paquete

- **Item 1 (nav regrouping):** produce las `NavSection[]` operadoras que el `variant=operator` consume. Si Item 1 mergea primero, sigue válido; Item 7 reemplaza su render (`OpRailNav`) por `AppShell`. **Orden recomendado: Item 1 → Item 7.**
- **Item 6 (perfil v2.1):** el perfil vive dentro de `variant=citizen`; sus tabs internas (Resumen/Libreta/…) son ortogonales al shell. Sin conflicto. El `PetAlertStrip` y el hero son contenido del `main`, no del shell.
- **Items 2–4 (dashboards):** viven dentro de `variant=operator`; heredan el shell unificado sin cambio funcional.
- **Item 0 / Item 5:** no se tocan (proyecciones / `/inicio` data). `/inicio` sigue siendo el home del rol owner (D5) y el agregador de Item 5.

---

## Próximo paso
Decisiones cerradas → listo para `plans/`. Sugerencia: ejecutar **Item 1 → Item 7 (Fases A→D)** como un tren de navegación, antes o en paralelo a Items 2–6 (que heredan el shell). Cuando quieras, escribo el `plans/` ejecutable de Item 7 con el detalle file-by-file de las 4 fases.
