# Operator nav regrouping (`NavSection[]`) — implementation plan

> Plan ejecutable para Claude Code. Item 1 del paquete metrics-IA. Refactor puro: convierte
> `GOB_NAV`/`ADMIN_NAV`/`buildOrgNav` de listas planas a `NavSection[]` agrupadas, renderizadas por
> el `sections=` que `OpRail` **ya soporta**. Mismas rutas, mismos guards, mismos hrefs.
>
> **Fecha:** 2026-06-18 · **Owner:** Ignacio Del Valle
> **Spec:** `docs/superpowers/specs/2026-06-18-operator-nav-regrouping-design.md` (gana el spec)
> **Tamaño:** 1 archivo de presets + 3 layouts + 1 test, 0 migraciones, 0 RLS, 0 rutas nuevas
> **Estimación:** ~½–1 día, 2 PRs (gob/admin; luego org)
> **Nota de secuencia:** **Item 7** absorbe después la capa de render (`AppShell variant=operator`); este item sigue siendo la **fuente de datos** del nav. Ship standalone igual.

## 0. Antes de tocar nada
1. Leé el spec (arriba) y `components/layout/nav-presets.ts` completo.
2. **Hechos verificados:**
   - `OpRail` (`components/ui/dashboard/OpRail.tsx`) **ya acepta** `sections?: NavSection[]` y `nav?: NavItem[]` (sections tiene precedencia). `OpRailNav` renderiza ambos. No hay que tocar el componente.
   - `NavSection = { label: string; items: NavItem[] }` se exporta desde `components/ui/dashboard/OpRailNav.tsx`.
   - Callers de los presets operadores: `app/gob/layout.tsx` (usa `GOB_NAV`), `app/admin/layout.tsx` (`ADMIN_NAV`), `app/org/[orgToken]/layout.tsx` (`buildOrgNav`). `OWNER_NAV`/`PUBLIC_NAV` los usan owner/público y **no se tocan acá**.
   - Ya existe `components/layout/nav-presets.test.ts` — extendé ese.
   - `buildOrgNav` ya filtra por `requiredCapability` contra `granted`.
3. Baseline verde: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

## 1. Qué construye este plan
`GOB_NAV_SECTIONS` / `ADMIN_NAV_SECTIONS` (constantes `NavSection[]`) + `buildOrgNav` devolviendo `NavSection[]`, y los 3 layouts pasando `sections={…}` a `OpRail`. Cero cambios de comportamiento salvo el agrupamiento visual.

## 2. Decisiones cerradas (del spec)
- Ninguna ruta agregada/quitada; cada href sobrevive exactamente una vez.
- Primera sección = las "primarias"; el orden importa.
- Filtrado de capabilities de org preservado; sección que queda vacía tras filtrar se dropea.
- `/gob/mortalidad` se agrega a "Vigilancia sanitaria" **solo** cuando Item 2 exista (condicional; omitir si no está).

## 3. Plan paso a paso

### PR 1 — gob + admin (1 PR)

**`components/layout/nav-presets.ts`:**
1. Importá `NavSection` (tipo) desde `@/components/ui/dashboard`.
2. Reemplazá `GOB_NAV` por `GOB_NAV_SECTIONS: NavSection[]`:
   - `Panel` (item suelto, sin sección, o sección sin label) → `/gob`.
   - `"Vigilancia sanitaria"` → Vigilancia, Analítica (+ Mortalidad cuando Item 2 esté).
   - `"Casos y cumplimiento"` → Casos, Maltrato, Decomisos, Disputas, Pérdidas.
   - `"Registro y aprobaciones"` → Cola, Organizaciones, Usuarios, Reglas.
   - `"Referencia"` → Catálogo (`/gob/servicios`), Histórico.
3. Reemplazá `ADMIN_NAV` por `ADMIN_NAV_SECTIONS: NavSection[]`:
   - `Dashboard` → `/admin`.
   - `"Operaciones"` → Cola, Casos, Moderación, Observaciones.
   - `"Confiabilidad"` → Sistema, Outbox, Auditoría.
   - `"Identidad y acceso"` → Usuarios, Govts, Admins, Organizaciones.
   - `"Gobernanza"` → Jurisdicciones, Historial, Servicios.
4. Si algún caller necesita lista plana (revisar el badge de outbox en `app/admin/layout.tsx` y cualquier drawer), exportá un derivado `ADMIN_NAV_FLAT = ADMIN_NAV_SECTIONS.flatMap(s => s.items)` en vez de mantener la constante vieja.

**`app/gob/layout.tsx`** y **`app/admin/layout.tsx`:** pasar `sections={GOB_NAV_SECTIONS}` / `sections={ADMIN_NAV_SECTIONS}` a `OpRail` en vez de `nav={…}`. El badge de outbox del meta-strip sigue como está (no es un NavItem).

**Tests (`nav-presets.test.ts`):**
- **Invariante:** la unión de items de las secciones == el set viejo de hrefs (snapshot congelado) — ningún href perdido ni duplicado, para gob y admin.
- **Orden:** primera sección de gob es Panel; "Vigilancia sanitaria" precede a "Casos y cumplimiento".

### PR 2 — org (1 PR)

**`components/layout/nav-presets.ts → buildOrgNav`:** construí la lista filtrada como hoy, luego particioná en secciones por pertenencia de href, dropeando secciones vacías:
- `"Operación"` → Panel, Agenda, Ingresos†, Tránsitos, Voluntarios.
- `"Animales"` → Mascotas, Transferencias.
- `"Adopciones"` → Operaciones, Check-ins†.
- `"Casos"` → Casos, Maltrato, Mordeduras.
- `"Administración"` → Servicios, Miembros, Cobertura, Permisos†, Configuración.
- († gated por `intake.create` / `adoption.review` / `capability.grant` — si la sección queda vacía tras filtrar, no se renderiza.)

**`app/org/[orgToken]/layout.tsx`:** pasar el `NavSection[]` resultante a `OpRail` con `sections={…}`.

**Tests:**
- `buildOrgNav(token, { granted: new Set() })` omite Ingresos/Check-ins/Permisos **y** dropea cualquier sección que quede vacía; con grants completos, las 5 secciones presentes y ordenadas.
- Invariante de no-pérdida de href también para org.

## 4. Verificación final
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verdes.
- Smoke manual: `/gob`, `/admin`, `/org/[token]` renderizan el riel con secciones agrupadas; todos los links viejos siguen funcionando.

## 5. Casos borde
- Item 2 todavía no mergeado → omitir `/gob/mortalidad` de "Vigilancia sanitaria" (condicional).
- Caller que esperaba lista plana → usar el derivado `*_FLAT`, no romper.
- Mobile (`OpMobileDrawer`): si solo acepta `nav` plano, alimentalo con el derivado flat hasta que Item 7 unifique el drawer.

## 6. Cuando termines
- `AGENTS.md → Portal access` (si documenta orden de nav): nota del agrupamiento.
- Header de `nav-presets.ts`: reemplazá el comentario stale "Primary 7 … renders all items flat" por el modelo de secciones.
- Flippeá la fila de Item 1 en `docs/superpowers/README.md` (✅ + SHA).

## 7. Lo que viene después (no en este plan)
**Item 7** reemplaza el render `OpRail`/`OpRailNav` por `AppShell variant=operator`, consumiendo estas mismas `NavSection[]`. No anticipes ese cambio acá; este plan deja los datos listos.
