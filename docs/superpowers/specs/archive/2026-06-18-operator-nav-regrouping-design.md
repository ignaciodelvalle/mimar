# Operator nav regrouping (NavSection) — design spec

> **Status:** ✅ Implementado (#628, #629) · **Date:** 2026-06-18 · **Item 1 of the metrics-IA handoff**
> · Umbrella: `dim-interno:docs/superpowers-private/specs/archive/2026-06-18-metrics-ia-handoff-design.md`
> · **Nota de secuencia:** **Item 7 (unified app shell)** absorbe la *capa de render* de este item — tras Item 7 Phase D (#630–#634), las `NavSection[]` que acá se definen las renderiza `AppShell variant=operator`; `OpRail`/`OpRailNav` son el render bridge interno del shell. Este item sigue siendo la **fuente de datos** del nav operador.

## 1. Por qué este documento existe

The operator portals render their navigation as one flat list each: `/gob` 14 links, `/admin` 15, `/org` 18. There is no visual hierarchy, the stated "Primary 7" for gob (a comment in `components/layout/nav-presets.ts:147`) is not expressed, and each new screen the metrics package adds (e.g. `/gob/mortalidad`) would make a flat list worse. We already own the fix: `components/ui/dashboard/OpRailNav.tsx` exports a `NavSection = { label; items }` type and accepts `sections?: NavSection[]` which "takes precedence over `nav`." The presets just don't use it.

This is a **pure refactor**: same routes, same `href`s, same guards, same capability filtering. Only grouping and order change.

## 2. Decisiones cerradas

- **D1 — No route added or removed.** Every existing `href` survives, exactly once, somewhere in the new sections.
- **D2 — Section labels are short, Spanish, uppercase-rendered** (the rail already uppercases section labels — pass plain strings).
- **D3 — The first section is the "primaries."** Order matters: the design-spec primaries lead.
- **D4 — Org capability filtering is preserved.** `buildOrgNav` keeps filtering by `requiredCapability` against `granted`; sections are built *after* filtering so an empty section is dropped, not rendered empty.
- **D5 — `/gob/mortalidad` is added here as a placeholder section member** (under "Vigilancia sanitaria") only if Item 2 lands first; otherwise Item 2 adds it. To avoid ordering coupling, this spec lists it but marks it conditional — see Phasing.

## 3. Target grouping

### `/gob` (jurisdiction-scoped) — `GOB_NAV` → `GOB_NAV_SECTIONS`

```
Panel                         /gob
Vigilancia sanitaria          /gob/vigilancia · /gob/analytics · /gob/mortalidad†
Casos y cumplimiento          /gob/casos · /gob/maltrato · /gob/decomisos · /gob/disputas · /gob/perdidas
Registro y aprobaciones       /gob/cola · /gob/organizaciones · /gob/usuarios · /gob/reglas
Referencia                    /gob/servicios (Catálogo) · /gob/historial (Histórico)
```
† `/gob/mortalidad` appears only once Item 2 ships (conditional).

### `/admin` (universal) — `ADMIN_NAV` → `ADMIN_NAV_SECTIONS`

```
Dashboard                     /admin
Operaciones                   /admin/cola · /admin/casos · /admin/moderacion · /admin/observaciones
Confiabilidad                 /admin/sistema · /admin/outbox · /admin/auditoria
Identidad y acceso            /admin/usuarios · /admin/govts · /admin/admins · /admin/organizaciones
Gobernanza                    /admin/jurisdicciones · /admin/historial · /admin/servicios
```

### `/org` — `buildOrgNav` → grouped return

```
Operación        Panel · Agenda · Ingresos† · Tránsitos · Voluntarios
Animales         Mascotas · Transferencias
Adopciones       Operaciones · Check-ins†
Casos            Casos · Maltrato · Mordeduras
Administración   Servicios · Miembros · Cobertura · Permisos† · Configuración
```
† capability-gated (`intake.create`, `adoption.review`, `capability.grant`) — section drops if it ends up empty after filtering.

## 4. Implementation

**`components/layout/nav-presets.ts`**
- Add a `NavSection` import (re-export the type from `components/ui/dashboard` or define a local structural twin to avoid a client/server import cycle — prefer importing the type only).
- Replace `GOB_NAV` / `ADMIN_NAV` exports with `GOB_NAV_SECTIONS: NavSection[]` / `ADMIN_NAV_SECTIONS: NavSection[]`. Keep the flat exports as thin `.flatMap(s => s.items)` derivations if any caller (e.g. mobile drawer, header) still needs a flat list — check usages first with a grep for `GOB_NAV`/`ADMIN_NAV`/`buildOrgNav`.
- `buildOrgNav` returns `NavSection[]`: build the flat filtered list as today, then partition into the five sections by `href` membership, dropping empty sections.

**Layouts** (`app/gob/layout.tsx`, `app/admin/layout.tsx`, `app/org/[orgToken]/layout.tsx` and/or the shared `Sidebar`/`OpRailNav` callsite): pass `sections={…}` instead of `nav={…}`. The `OpRailNav` already renders sections; confirm `OpMobileDrawer` handles `sections` too (if it only accepts `nav`, feed it the flat derivation).

## 5. Test plan (test-first)

- **Structural invariant test** (`__tests__/nav-presets.test.ts`): for each portal, assert the union of section items equals the previous flat set (snapshot the old hrefs as a frozen array) — proves no route dropped or duplicated.
- **Org capability test**: `buildOrgNav(token, { granted: new Set() })` omits Ingresos/Check-ins/Permisos AND drops any section left empty; with full grants, all five sections present and ordered.
- **Order test**: first gob section is `Panel`; "Vigilancia sanitaria" precedes "Casos y cumplimiento".
- No new integration/DB test needed (pure module, no async — matches the file's existing "no side effects" contract).

## 6. Docs to update (same PR)

- `AGENTS.md` → **Portal access: capability-driven** / role sections — note the new section grouping if it documents nav order (light touch; the grouping is UI, not policy).
- `docs/superpowers/README.md` — flip this item's row to ✅ + SHA.
- File-header comment in `nav-presets.ts` — replace the now-stale "Primary 7 … sidebar renders all items flat" comment with the section model.

## 7. Lo que NO está acá

- No new screens (except surfacing `/gob/mortalidad` once Item 2 exists).
- No restyle of the rail, no collapsible sections, no per-section badges (the outbox badge stays as-is in the admin meta-strip).
- No change to public/owner nav (`PUBLIC_NAV`, `OWNER_NAV`) — they're short enough.

## 8. Phasing

- **Fase 1 (1 PR):** gob + admin sections + tests + docs. Ship without `/gob/mortalidad` (conditional member omitted).
- **Fase 2 (1 PR):** org `buildOrgNav` sections + capability/empty-section tests.
- **Fase 3 (trivial, fold into Item 2):** add `/gob/mortalidad` to the "Vigilancia sanitaria" section when Item 2 merges.

---

## Próximo paso
Grep callers of `GOB_NAV`/`ADMIN_NAV`/`buildOrgNav` first; if the mobile drawer needs flat, keep a derived flat export. Otherwise this is a clean, well-tested refactor with no behavioral risk.
