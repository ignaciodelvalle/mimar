# Poncho redesign — design + execution contract

> **Fecha:** 2026-05-26
> **Owner:** Ignacio Del Valle
> **Estado:** 🟢 Active — ready to execute once precondition merges
> **Versión:** 1.0
> **Plan ejecutable companion:** `<repo>\plan-cc-2026-05-26.md`
> **Insumos de diseño:** carpeta `%USERPROFILE%\Downloads\Pantallas` — 30+ JSX boards + `poncho.css` (137KB)
> **Precondición bloqueante:** PR #164 (`feat/tier2-public-window` → develop) mergeado a develop ANTES de arrancar Fase 1.

---

## 0. Por qué este documento existe

El redesign Poncho lleva el portal completo (owner / org / gob / admin / public) al design system oficial. Este spec captura las decisiones doctrinales que el plan ejecutable consume — taxonomías, naming, arquitectura de sheets, estrategia de PRs. El plan tiene los chunks; este spec tiene los porqués.

Cualquier ajuste en estas decisiones requiere bumpear este spec antes de tocar código.

---

## 1. Decisiones cerradas (DP18 – DP20)

### DP18 — Status taxonomy reducida

Solo 4 valores visibles en UI ahora:

| Status | Color del aro de `<Photo>` | Cuándo se muestra |
|---|---|---|
| `ok` | neutral (gris) | Default |
| `lost` | rojo | `pet.status = 'lost'` |
| `found` | verde | Estado transicional cerrado por owner |
| `deceased` | gris oscuro + cinta negra | `pet.status = 'deceased'` |

Cualquier status interno (`pending_claim`, `transfer_in_progress`, etc.) se difiere a redesign futuro. La fuente de verdad sigue siendo `pets.status`.

### DP19 — Mapeo board → page

Ver `Apéndice A` al final de este spec.

### DP20 — PR strategy: chained < 400 LOC

Branch base `feat/poncho-redesign`. Sub-branches por sub-fase. ~11 sub-PRs chained, cada uno < 400 LOC objetivo, cumpliendo el skill `chained-pr`. Sin `size:exception` salvo emergencia justificada.

Estructura de sub-PRs:

| Sub-PR | Branch | Scope |
|---|---|---|
| Fase 1 | `feat/poncho-1-foundation` | Tokens + 10 primitives + Sheet wrapper Vaul |
| Fase 2 | `feat/poncho-2-shells` | 4 layout shells (app / org / gob / admin) + public minimal |
| Fase 3a | `feat/poncho-3a-home-list` | EventCatcher + `/inicio` + `/mis-mascotas` + pet-detail base |
| Fase 3b | `feat/poncho-3b-tabs-banners` | Tabs libreta/historial + StatusBannerStack + Lost + Memoriam |
| Fase 3c | `feat/poncho-3c-sheets-quick` | 5 sheets quick-capture + `/mis-mascotas/nueva` + borrado de rutas viejas |
| Fase 3d | `feat/poncho-3d-sheets-actions` | 7 sheets de acciones + Tier 2 público UI |
| Fase 4a | `feat/poncho-4a-org` | 6 pantallas org |
| Fase 4b | `feat/poncho-4b-gob` | 9 pantallas gob + JurisdictionSwitcher |
| Fase 4c | `feat/poncho-4c-admin` | 1 pantalla admin home |
| Fase 5 | `feat/poncho-5-public` | Credenciales + portales públicos + `/refugios/[orgToken]` reescrito |

Cada sub-PR depende del anterior — `gh pr create --base feat/poncho-3a-home-list` etc.

---

## 2. Naming convention — componentes Poncho

- Prefijo `Poncho*` (PonchoCard, PonchoButton, PonchoPhoto, etc.) — desambigua del legado.
- Viven en `components/poncho/`.
- Cada componente exporta default + tipo de props nombrado `PonchoCardProps`, etc.
- Tests en `components/poncho/__tests__/<Component>.test.tsx`.

Excepción: shells (Sidebar, Topbar, NavItem, Crumbs) NO llevan prefijo porque son singletons del layout, no primitives reusables.

---

## 3. Sheet architecture

### 3.1 Librería

**Vaul** (`npm i vaul`). Razones:
- Bottom-sheet mobile + side-drawer desktop con una sola API
- Soporta nested sheets para flujos como Vacuna → Catálogo de vacunas
- Respeta `prefers-reduced-motion`
- Bundle size ~8KB

Alternativas consideradas: Radix Dialog (no soporta drag-to-close en mobile), Headless UI (no tiene la API responsive).

### 3.2 Deep-link strategy

Las pages **server components** leen `searchParams.sheet` y montan la sheet abierta server-side. Navegación interna usa `router.replace('?sheet=<id>')` sin recargar.

**Prohibido**: check `typeof window === 'undefined'`. Server components no tienen `window` nunca — el check es semánticamente vacío y confunde a futuros lectores. La estrategia SSR-first cubre share/SEO sin necesidad de fallback no-JS separado.

**Rutas viejas** (`app/(app)/mis-mascotas/[token]/eventos/nuevo/[tipo]/page.tsx` y similares) se **BORRAN** en Sub-PR 3c. Sin coexistencia.

### 3.3 API

```tsx
<PonchoSheet id="vacuna" title="Registrar vacuna" side="right" size="md">
  <VaccinationForm petToken={pet.token} />
</PonchoSheet>
```

- `id` mapea 1-a-1 con el valor de `?sheet=<id>` que la abre
- `side`: `bottom` (mobile default) | `right` (desktop default) — Vaul switchea automático en breakpoint `md`
- `size`: `sm | md | lg` (320 / 480 / 640 px right-drawer; mobile siempre full-width)

---

## 4. Tokens migration

`poncho.css` define tokens `--p-*`. Se importan al `@theme` de Tailwind v4 en `app/globals.css`. Los `--gob-*` actuales se mantienen como **aliases**:

```css
@theme {
  --color-gob-primary: var(--p-blue);
  --color-gob-success: var(--p-green);
  /* etc */
}
```

Esto permite migración progresiva — el código viejo sigue funcionando con `bg-gob-primary`, el código nuevo usa `bg-p-blue` directo. Cuando todas las superficies migren a Poncho, los aliases se borran (no en este redesign — posterior).

---

## 5. Precondición Tier 2 público

**Bloqueante**: PR #164 (`feat/tier2-public-window` → develop) tiene que estar en develop ANTES de `git checkout -b feat/poncho-redesign-1-foundation`.

Razón: el redesign asume que `pets.tier2_public_enabled_until` ya existe en schema + las server actions `enableTier2PublicAction` / `revokeTier2PublicAction` ya están en `app/actions/tier2-public.ts`. Sub-PR 3d solo agrega el sheet UI consumiendo el toggle existente.

Si Tier 2 PR no merge, Sub-PR 3d queda bloqueado (pero 1, 2, 3a-3c pueden seguir).

---

## 6. EventCatcher placement

EventCatcher **NO** es foundation pura — tiene business logic (parse intent, redirect a sheet correcto, queries reales). Por eso vive en **Sub-PR 3a** (C3a.1), no en Fase 1.

Fase 1 queda con solo primitives sin opinión de dominio: Photo, Card, Panel, Stripe, Button, Chip, Badge, Banner, NavItem, Sidebar, Topbar, Crumbs, Sheet.

---

## 7. Tab "Vacunas" diferido

El board de `Tab Vacunas` en `/mis-mascotas/[publicToken]?tab=vacunas` NO existe todavía. Sub-PR 3b implementa solo `resumen | libreta | historial`. Cuando ese tab esté diseñado (Fase 12), se agrega sin breaking change — el switch en server component es exhaustivo y agregar un caso no rompe los existentes.

Mientras tanto, links que apunten a `?tab=vacunas` redirigen server-side a `?tab=libreta` con nota en `docs/poncho/follow-ups.md`.

---

## 8. Cross-cutting policies

| # | Policy | Razón |
|---|---|---|
| 1 | No tocar DB schema sin migración Drizzle separada | Migraciones tienen su propio review + tests |
| 2 | Reusar forms existentes envueltos en sheets | No re-escribir lógica que ya funciona |
| 3 | Tests obligatorios por componente nuevo (render + interacción primaria) | Mantiene baseline de confianza |
| 4 | Append-only commits con conventional commit format | Trazabilidad + auto-changelog |
| 5 | Sin nuevas dependencias salvo Vaul + lucide-react (si no está) | Cada dep nueva requiere ADR |
| 6 | Server components por default; `"use client"` solo donde hay estado/efectos | Performance + RSC payload |
| 7 | A11y check por fase: focus-visible + 44×44 touch + WCAG AA contrast | No-regression en accesibilidad |

---

## Apéndice A — Mapeo board JSX → page Next.js

| Board JSX | Path Next.js | Sub-PR |
|---|---|---|
| board-home.jsx | app/(app)/inicio/page.tsx | 3a |
| board-pet-list.jsx | app/(app)/mis-mascotas/page.tsx | 3a |
| board-pet-detail.jsx | app/(app)/mis-mascotas/[publicToken]/page.tsx | 3a |
| board-pet-libreta.jsx | …/[publicToken]/page.tsx?tab=libreta | 3b |
| board-pet-historial.jsx | …/[publicToken]/page.tsx?tab=historial | 3b |
| board-lost.jsx | …/[publicToken] cuando status='lost' | 3b |
| board-memoriam.jsx | …/[publicToken] cuando status='deceased' | 3b |
| board-pet-nueva.jsx | app/(app)/mis-mascotas/nueva/page.tsx | 3c |
| board-sheets.jsx (quick-capture) | components/sheets/* + ?sheet= URL | 3c |
| board-sheets.jsx (acciones) | components/sheets/* + ?sheet= URL | 3d |
| board-org-home.jsx | app/org/[orgToken]/page.tsx | 4a |
| board-org-agenda.jsx | app/org/[orgToken]/agenda/page.tsx | 4a |
| board-org-agenda-detail.jsx | app/org/[orgToken]/agenda/turnos/[token]/page.tsx | 4a |
| board-org-pets.jsx | app/org/[orgToken]/mascotas/page.tsx | 4a |
| board-org-services.jsx | app/org/[orgToken]/servicios/page.tsx | 4a |
| board-org-adopciones.jsx | app/org/[orgToken]/adopciones/page.tsx | 4a |
| board-org-equipo.jsx | app/org/[orgToken]/equipo/page.tsx | 4a |
| board-gob-home.jsx | app/gob/page.tsx | 4b |
| board-gob-caba.jsx | app/gob/vigilancia/page.tsx | 4b |
| board-gob-cola.jsx | app/gob/cola/page.tsx | 4b |
| board-gob-cola-detail.jsx | app/gob/cola/[token]/page.tsx | 4b |
| board-gob-organizaciones.jsx | app/gob/organizaciones/page.tsx | 4b |
| board-gob-servicios.jsx | app/gob/servicios/page.tsx | 4b |
| board-gob-servicio-detalle.jsx | app/gob/servicios/[token]/page.tsx | 4b |
| board-gob-usuarios.jsx | app/gob/usuarios/page.tsx | 4b |
| board-gob-casos.jsx | app/gob/casos/page.tsx | 4b |
| board-gob-maltrato.jsx | app/gob/maltrato/page.tsx | 4b |
| board-gob-maltrato-detalle.jsx | app/gob/maltrato/[id]/page.tsx | 4b |
| board-gob-catalogo.jsx | app/gob/catalogo/page.tsx | 4b |
| board-admin-home.jsx | app/admin/page.tsx | 4c |
| board-credentials.jsx | app/(public)/p/[publicToken]/page.tsx | 5 |
| board-public-adoptar.jsx | app/(public)/adoptar/page.tsx | 5 |
| board-public-perdidas.jsx | app/(public)/perdidas/page.tsx | 5 |
| board-public-denuncias.jsx | app/(public)/denuncias/{nueva,buscar,codigo/[c]}/page.tsx | 5 |
| `Perfil de Refugio.html` | app/(public)/refugios/[orgToken]/page.tsx (REESCRITO con Poncho) | 5 |

---

## Apéndice B — Fases diferidas (Fase 6 – 12)

Fases 6 – 12 dependen de wireframes adicionales y NO arrancan hasta que claude.ai/design produzca los boards faltantes. Ver `plan-cc-2026-05-26.md` Fases 6-12 para el inventario.

Cuando esos boards lleguen, se bumpea este spec a v1.1 con el detalle de cada fase nueva.
