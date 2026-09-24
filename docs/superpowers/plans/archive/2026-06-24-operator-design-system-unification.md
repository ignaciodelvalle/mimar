> **▶ ARCHIVADO 2026-08-04** — triage de planes: el trabajo que describe está shippeado (verificado contra el árbol). Se conserva por su método y su evidencia; como plan de trabajo, está cerrado.

# Plan: Tier operador — unificación del design system (estado, badges, botones)

> **Para Claude Code — ejecución 100% autónoma.** Remediación de la critique de frontend del tier **operador**
> (`/admin` + acceso a `/gob`) del 2026-06-24. Fuente de hallazgos:
> [`dim-interno:docs/design/critique-2026-06-24-frontend.md`](../../design/critique-2026-06-24-frontend.md).
> Insumo de Design: [`dim-interno:docs/archive/Hallazgos Design System.md`](../../archive/Hallazgos%20Design%20System.md).
> Severidad: 🔴 correctitud (color que miente) · 🟡 fricción/consistencia · 🟢 polish. **SDD test-first** (AGENTS.md), docs en el mismo PR.
>
> **Antes de tocar código, leer:** (1) el slim index de [`AGENTS.md`](../../../AGENTS.md); (2) la critique linkeada arriba (tiene el mapeo styleguide↔código y los conteos verificados); (3) `app/globals.css` líneas 38–231 (paleta `ln-*` cálida + `ln-op-*` operador); (4) este plan entero antes de abrir el primer PR.

## Decisiones tomadas (no relitigar)
1. **`--st-*` es indirección por piel, NO un hex único compartido.** Un solo hex regresaría el contraste WCAG ya ganado en papel (`ln-warn` se oscureció a `#96600e`). El *nombre* del token se unifica; el *valor* se re-mapea por contexto (cálida vs operador). Ver PR-1.
2. **La piel ciudadana (`Ln*`) NO se rediseña.** Ya consolidó botones en `LnButton` y badges en `LnBadge`/`LnStatusFlag`/`LnVstamp`. Este plan toca **solo** el tier operador. Requisito duro: **cero diff visual en superficies ciudadanas** (`/inicio`, `/mis-mascotas`, `/p/*`).
3. **`OpCodeBadge` se queda para códigos** (`PANO-CASE-*`, `req_…`). No se toca salvo para confirmar que no se usa para estados.
4. **Alcance:** se remedia F1 + F2 + F3 (+ F4 polish). El primer paso de PR-2 es un **bug de correctitud** (color contradictorio), no estética — va primero dentro de su PR.

## Cómo verificar las ubicaciones
**Verificado en vivo el 2026-06-24** contra el working tree (sesión admin logueada; `/admin`, `/admin/casos`, render `/gob/*`). Los anclas (símbolo + quote) son exactos a esa fecha, pero **anclar por símbolo + quote**, no por número de línea. Confirmar con `grep`/`Read` antes de editar. Para ver badges/colas a escala correr `pnpm seed:panorama` (con seed limpio las colas están vacías).

Conteos de referencia (re-verificar con `grep` si cambió el árbol):
- `LnButton` importado en operador: **1** archivo de `app/admin`+`app/gob`.
- `<button>` crudos: **61** en `app/admin` + **72** en `app/gob` = **133**.
- Consumidores de `ln-op-*`: ~**179** archivos (`app/admin app/gob components`).

---

## Hallazgos completos

| # | Hallazgo | Sev | Ubicación / evidencia | Fix |
|---|---|---|---|---|
| **F1** | **Color de estado duplicado por piel, sin capa semántica.** El kit `Ln*` consume `ln-ok/warn/err/rosa/violeta`; el kit `Op*` consume `ln-op-ok/warn/danger/viol`. 8 hexes para 4 estados mantenidos a mano. Además hay **tres violetas** (`ln-rosa`, `ln-violeta #6b4ea8`, `ln-op-viol #6a4c93`). `ln-op-warn #9c6700` y `ln-op-danger #b71c1c` **sin auditoría de contraste registrada** sobre sus `*-bg`. | 🔴 | `app/globals.css` (`@theme`, tokens `--color-ln-*` L60-65 y `--color-ln-op-*` L206-218) | Capa semántica `--color-st-*` con valores re-mapeados por piel. Componentes de estado consumen `st-*`. Auditar contraste op. Colapsar violetas duplicados. |
| **F2** | **Gramática de color de estado contradictoria entre componentes.** Mismo vocablo, color opuesto: **"abierto"** = verde en `CaseStatusBadge` (`open→ok-bg`) pero ámbar en `OpPill` (`open→warn`); **"cerrado"** = neutro en `CaseStatusBadge` (`closed→stripe`) pero verde en `OpPill` (`closed→ok`). Además 3 geometrías para "estado": `OpPill` (`rounded-full` sans 9.5px), `CaseStatusBadge`/`OpStateBadge` (`rounded-[3px]` mono 9px). | 🟡 (paso 1 = 🔴 bug) | `components/ui/dashboard/OpPill.tsx` (`toneClasses`), `CaseStatusBadge.tsx` (`STATUS_CONFIG`), `OpStateBadge.tsx` (`STATE_CLASSES`). Verificado en vivo: `/admin/casos` muestra "Abierto" verde. | (1) Alinear el mapa de tonos `open`/`closed` entre `OpPill` y `CaseStatusBadge` (convención canónica única). (2) Extraer primitivo `OpStatusPill` (geometría única, tono desde `st-*`); los 3 pasan a wrappers semánticos. |
| **F3** | **Sin primitivo `OpButton`.** La piel ciudadana ya tiene `LnButton`; el tier operador casi no lo usa (1 import) y tiene **133 `<button>` crudos**. El "primario/enviar" es **verde** (`OpSubmitButton` → `bg-ln-op-ok`) en un lado y **azul** (`OpBulkBar` → `bg-ln-op-azul`) en otro, con radio (`rounded-md`) distinto al de `LnButton` (`rounded-[3px]`). | 🟡 | `components/ui/dashboard/OpField.tsx` (`OpSubmitButton`), `OpBulkBar.tsx` (botón de acción), + 133 `<button>` en `app/admin`/`app/gob` | Crear `OpButton` (espejo de `LnButton`, acento `ln-op-azul`): `primary/ghost/danger/ok` + `sm/block`, radio único. Migrar `OpSubmitButton`, `OpBulkBar` y los crudos por módulo. |
| **F4** | **Polish de densidad/jerarquía en admin.** Filtros de Casos usan `<select>` nativos en vez de `OpSelect`; filas de casos con alto vertical excesivo para una cola de escaneo en volumen. | 🟢 | `app/admin/casos/page.tsx` (barra de filtros + filas) | Migrar selects a `OpSelect` (`components/ui/dashboard/OpField.tsx`); variante de fila compacta (~40px) preservando target táctil 44px en mobile. |

---

## Secuenciación en PRs (orden de dependencia)

> Branch desde `develop` (o la rama activa que indique `docs/superpowers/README.md`). Naming: `fix/*` para bugs/correctitud, `chore/*` para refactor/polish. Conventional Commits, scope `design` o `admin`. **Sin `Co-Authored-By` ni atribución AI.**
> Cada PR cierra con `pnpm verify` (tsc + Biome + `lint:tokens` + `lint:ui` + build) **y** `pnpm test` verdes, cero regresiones sobre el baseline. Orden semántico: **PR-1 → PR-2 → PR-3** (F1 habilita el `st-*` que PR-2 consume). PR-4 es independiente.

### PR-1 — `fix/operator-status-token-layer` 🔴 (F1 — capa semántica de estado)
Base de todo lo demás. Token-only: sin diff visual.
1. **Definir `--color-st-*` en `app/globals.css`** dentro de `@theme`, mapeados a la piel cálida (valores actuales): `--color-st-ok: var(--color-ln-ok)`, `--st-warn: var(--color-ln-warn)`, `--st-err: var(--color-ln-err)`, `--st-info: var(--color-ln-violeta)`. Incluir los `*-bg`/`*-bd` equivalentes si los componentes los usan.
2. **Re-mapear los mismos nombres bajo contexto operador.** Definir un selector de skin (preferido: wrapper `.op-surface` ya insinuado en `globals.css` L304-305, o el `<body>`/layout de `app/admin` y `app/gob`) donde `--color-st-ok: var(--color-ln-op-ok)`, etc. Verificar qué wrapper envuelve realmente las superficies operador (`grep "op-surface" app components`; si no existe en los layouts, añadirlo en `app/admin/layout.tsx` y `app/gob/layout.tsx`).
3. **Reapuntar los componentes de estado a `st-*`** (no cambia el render porque los valores son idénticos): en una primera pasada, los del kit operador (`OpPill`, `OpStateBadge`, `CaseStatusBadge`, `OpKpi` tone maps). La piel ciudadana puede migrarse en la misma pasada **solo si** el snapshot confirma cero diff.
4. **Quick-wins dentro de PR-1:**
   - Auditar contraste de `ln-op-warn #9c6700` sobre `ln-op-warn-bg #fff4da` y `ln-op-danger #b71c1c` sobre `ln-op-danger-bg #fce7e8`; registrar resultados en `docs/a11y/contrast-audit.md` (mismo formato que la entrada de `ln-warn`). Si algún par falla AA, oscurecer el valor y dejar comentario como en `globals.css` L62.
   - Colapsar violetas: decidir si `ln-violeta` (medicación, ciudadana) y `ln-op-viol` (operador) pueden compartir nombre `st-info` por piel; documentar la decisión en la critique o en un comentario de `globals.css`.
5. **Guarda:** extender `scripts/check-design-tokens.ts` para preferir `st-*` en componentes de estado del tier operador (warn, no error, en esta fase).
6. **Tests:** snapshot de `LnBadge`/`OpPill`/`CaseStatusBadge`/`OpStateBadge` (`vitest` + Testing Library) afirmando que las clases resueltas no cambian para la piel cálida. `pnpm lint:tokens` verde.

### PR-2 — `fix/operator-status-badge-grammar` 🟡 (F2 — gramática + geometría de badges)
Depende de PR-1 (`st-*` disponible).
1. **Paso 1 (🔴 bug — primero). Convención canónica DECIDIDA (Nacho, 2026-06-24) — modelo triage, NO relitigar:**

   | Estado | Tono canónico | Token (`st-*` / operador) |
   |---|---|---|
   | `open` / abierto | **ámbar** (requiere acción) | `st-warn` (`ln-op-warn`) |
   | `escalated` / escalado | **rojo** | `st-err` (`ln-op-danger`) |
   | `closed` / cerrado | **verde** (resuelto) | `st-ok` (`ln-op-ok`) |
   | `merged` / fusionado | **violeta** | `st-info` (`ln-op-viol`) |

   Aplicar a **todo** el tier. Estado actual: `OpPill` (`toneClasses`) **ya cumple** (open=warn, escalated=danger, closed=ok). El que hay que cambiar es **`CaseStatusBadge.STATUS_CONFIG`**: `open` ok→**warn**, `escalated` warn→**danger**, `closed` stripe→**ok**, `merged` viol (queda). Actualizar también los tests/snapshots de `CaseStatusBadge` (cambian 3 tonos) y el screenshot esperado de `/admin/casos` ("Abierto" pasa de verde a ámbar). `OpStateBadge` (published/paused/draft/adopted) es otro enum de dominio — **no se toca** salvo migrarlo a la geometría única en el paso 2.
2. **Paso 2 (geometría):** extraer `components/ui/dashboard/OpStatusPill.tsx` — primitivo de estado con geometría única (`rounded-[3px]`, `font-ln-mono`, tamaño/tracking unificado, punto de color opcional + label, tono por `data-tone` resolviendo a `st-*`). Reescribir `CaseStatusBadge`, `OpStateBadge` y `OpPill` como **wrappers semánticos** sobre `OpStatusPill` (mapean su enum de dominio → `tone`). Conservar la API pública de cada wrapper (props) para no tocar los call-sites.
3. **Confirmar** que `OpCodeBadge` no se usa para estados (`grep "OpCodeBadge" app components`); si aparece algún uso de estado, migrarlo a `OpStatusPill`.
4. **Tests:** test cross-componente "mismo término → mismo tono" (p.ej. `open` produce la misma clase de color en `OpPill` y `CaseStatusBadge`). Unit por wrapper (label + tono). Snapshot de `/admin/casos` (RTL) afirmando el badge correcto.

### PR-3 — `chore/operator-button-primitive` 🟡 (F3 — `OpButton` + migración)
Independiente de PR-1/2 pero conviene después para no chocar diffs.
1. **Crear `components/ui/dashboard/OpButton.tsx`** espejando `components/ui/Button.tsx` (`LnButton`): variantes `primary` (`bg-ln-op-azul`, hover `ln-op-azul-700`), `ghost`, `danger` (`bg-ln-op-danger`), `ok` (`bg-ln-op-ok`); tamaños `sm`/`md`/`lg`; modificadores `block`/`loading`. Radio único **decidido**: definir `--radius-op-btn: 6px` en `globals.css` (= el `rounded-md` que ya usan `OpSubmitButton`/`OpBulkBar`, minimiza el diff). **Primario de acción = azul**; verde solo para confirmación positiva explícita.
2. **Migrar los botones de sistema:** reescribir `OpSubmitButton` (`OpField.tsx`) y el botón de acción de `OpBulkBar.tsx` sobre `OpButton`. Esto resuelve el conflicto verde/azul.
3. **Migrar los 133 `<button>` crudos por módulo** (no en un solo PR si crece): empezar por `app/admin/*`, luego `app/gob/*`. Anclar cada uno por archivo; preservar `onClick`/`type`/`disabled`/`form` actions.
4. **Guarda:** regla `lint:ui` (`scripts/check-ui-invariants.ts`) que marque `<button className=...>` **nuevos** en `app/admin`/`app/gob` (no los legacy mientras dura la migración; usar allowlist decreciente o un TODO contado).
5. **Tests:** `OpButton` (variantes, `disabled`, `loading`, `block`). Verificación por módulo migrado (render + acción).

### PR-4 — `chore/admin-casos-density` 🟢 (F4 — polish, independiente)
1. Migrar los `<select>` de la barra de filtros de `app/admin/casos/page.tsx` a `OpSelect` (`OpField.tsx`).
2. Variante compacta de fila de caso (~40px) preservando target táctil 44px en mobile (media query / `min-h` condicional).
3. **Tests:** RTL del filtro (selección actualiza `searchParams`); visual de densidad opcional.

---

## Definición de "hecho"
- F1+F2+F3 cerrados; F4 opcional según tiempo.
- `pnpm verify` + `pnpm test` verdes en cada PR.
- **Cero diff visual en superficies ciudadanas** (verificado por snapshot).
- `--st-*` es la única fuente de color de estado en el kit operador; `OpStatusPill` la única geometría; `OpButton` el único botón nuevo en operador.
- Critique linkeada (`dim-interno:docs/design/critique-2026-06-24-frontend.md`) actualizada con el estado de cada hallazgo (✅/parcial) al cerrar.
- Contraste op registrado en `docs/a11y/contrast-audit.md`.
