# Contrast audit — WCAG 2.1 AA baseline

**Norma:** Ley 26.653 (Accesibilidad de la Información en las Páginas Web) + Disp. ONTI 6/2019 (adopta WCAG 2.1 AA).

**Fecha de auditoría:** 2026-05-28 (compliance handoff PR 2). **Realineado a la paleta LN vigente:** 2026-07-04 (a11y audit sweep — ver `dim-interno:docs/design/handoffs/2026-07-04-wcag-a11y-audit.md`).

## Resumen ejecutivo

Las combinaciones canónicas de texto sobre superficie en uso en MiMAR (tokens Libreta Nacional, `app/globals.css` `@theme`) fueron auditadas con la fórmula WCAG 2.1 ([Relative luminance + contrast ratio](https://www.w3.org/WAI/GL/wiki/Contrast_ratio)). Los semánticos de texto (`ln-ink`, `ln-ink-2`, `ln-mute`, `ln-faint`, `ln-azul`, `ln-ok`, `ln-err`, `ln-warn`, `ln-seal`) pasan AA o mejor. El único token que fallaba como texto normal era `--color-ln-celeste` — usado en dos sitios de cuerpo de texto (`EventCatcher.tsx`) y en el subtítulo del masthead sobre banda navy (`AppCitizenMasthead.tsx`); los tres se corrigieron el 2026-07-04 (ver tabla de abajo). El focus ring vigente (`:focus-visible` azul 3px) cumple WCAG 2.1 SC 1.4.11 (Non-text Contrast) por geometría — ancho de borde (3px) + offset — no por ratio de color.

## Tokens auditados

> **Nota (actualización 2026-07-04):** la tabla original de este documento
> auditaba la paleta Poncho v1 pre-LN (`--color-foreground: #000000`,
> `--color-ring: #ffce1c`, etc.), que ya no está en uso — la migración a la
> paleta Libreta Nacional (LN) la reemplazó por completo. La tabla de abajo
> refleja los tokens LN vigentes en `app/globals.css` `@theme` (líneas 41-65).
> El focus ring vigente es `:focus-visible` azul 3px (`app/globals.css:368-372`),
> no el amarillo maíz Poncho v1 — su nota de "cumple por geometría" ya no aplica
> a ese token específico, aunque el principio (ancho + offset suple ratio de
> color) se mantiene documentado en Reglas operativas.

Definidos en `app/globals.css` `@theme` (líneas 41-65):

| Token | Valor | Uso |
| --- | --- | --- |
| `--color-ln-ink` | `#1b2a33` | Texto cuerpo principal |
| `--color-ln-ink-2` | `#3c4b55` | Texto secundario (breed line, subtítulos) |
| `--color-ln-mute` | `#616e77` | Help text / labels mono |
| `--color-ln-faint` | `#646f78` | Texto terciario ("opcional", hints) |
| `--color-ln-paper` | `#fbfaf5` | Bg superficie (papel) |
| `--color-ln-card` | `#ffffff` | Bg tarjeta |
| `--color-ln-azul` | `#0e5a99` | CTAs, links, tabs activos, texto "info" normal |
| `--color-ln-azul-900` | `#0a3556` | Bg masthead / drawer (banda navy) |
| `--color-ln-celeste` | `#4e97d1` | Chrome / iconos / rings / **texto grande únicamente** |
| `--color-ln-celeste-100` | `#dcebf7` | Texto claro sobre bandas navy (azul-900) |
| `--color-ln-ok` | `#2b7449` | Confirmaciones / éxito |
| `--color-ln-err` | `#c0392b` | Errores / destructivo |
| `--color-ln-warn` | `#96600e` | Advertencias (ver actualización 2026-06-11) |
| `--color-ln-seal` | `#a23a2c` | Asterisco requerido, acentos seal |

## Combinaciones canónicas

| Combinación | Ratio | Veredicto WCAG |
| --- | --- | --- |
| `#1b2a33` (ink) sobre `#fbfaf5` (paper) — cuerpo principal | **14.1 : 1** | ✅ AAA |
| `#3c4b55` (ink-2) sobre `#fbfaf5` (paper) — texto secundario | **8.6 : 1** | ✅ AAA |
| `#616e77` (mute) sobre `#fbfaf5` (paper) — help / labels | **5.0 : 1** | ✅ AA |
| `#646f78` (faint) sobre `#fbfaf5` (paper) — terciario | **4.92 : 1** | ✅ AA |
| `#0e5a99` (azul) sobre `#fbfaf5` (paper) — CTA / link / tab activo | **6.8 : 1** | ✅ AA |
| `#2b7449` (ok) sobre `#fbfaf5` (paper) — éxito | **5.44 : 1** | ✅ AA |
| `#c0392b` (err) sobre `#fbfaf5` (paper) — error | **5.2 : 1** | ✅ AA |
| `#a23a2c` (seal) sobre `#fbfaf5` (paper) — asterisco requerido | **6.3 : 1** | ✅ AA |
| `#96600e` (warn) sobre `#ffffff` — advertencia | **5.28 : 1** | ✅ AA (ver 2026-06-11) |
| `#4e97d1` (celeste) sobre `#fbfaf5` (paper) — **texto normal** | **~3.1 : 1** | ❌ Falla AA. Reservado a texto grande (≥18pt), iconos, o chrome — nunca cuerpo de texto. (Corregido 2026-07-04: `EventCatcher.tsx` pasó a `ln-azul`.) |
| `#4e97d1` (celeste) sobre `#0a3556` (azul-900) — subtítulo masthead 9-9.5px | **~4.0 : 1** | ❌ Falla AA en texto de ese tamaño. (Corregido 2026-07-04: `AppCitizenMasthead.tsx` pasó a `celeste-100`.) |
| `#dcebf7` (celeste-100) sobre `#0a3556` (azul-900) — subtítulo masthead | **~10.4 : 1** | ✅ AAA — reemplazo vigente |
| `:focus-visible` azul 3px outline (`app/globals.css:368-372`) | n/a (geometría) | ✅ Cumple SC 1.4.11 por ancho (3px) + offset — no requiere ratio de color |

## Reglas operativas

1. **Texto normal (< 18pt regular o < 14pt bold) sobre `ln-paper`/`ln-card`**: usar `--color-ln-ink`, `--color-ln-ink-2`, `--color-ln-mute`, o `--color-ln-faint`. Todos ≥ AA.
2. **Texto grande sobre paper**: cualquiera de los semánticos (`ln-ok`/`ln-err`/`ln-warn`) si la jerarquía visual lo justifica.
3. **`--color-ln-celeste` (#4e97d1) NO se usa para texto normal**, sea sobre `ln-paper` (~3.1:1) o sobre la banda navy `ln-azul-900` a tamaños chicos (~4.0:1 a 9-9.5px). Reservado para iconos / bordes / rings / texto grande. Sobre paper, usar `--color-ln-azul` o `--color-ln-ink-2` para cuerpo de texto; sobre `ln-azul-900`, usar `--color-ln-celeste-100` (10.4:1) o `text-white/80`.
4. **Focus ring vigente**: `:focus-visible` 3px azul (`app/globals.css:368-372`), no el amarillo maíz Poncho v1 (retirado con la migración a LN). El principio de "cumplimiento por geometría" (SC 1.4.11: ancho ≥3px + offset compensan un color-contrast bajo) sigue aplicando a cualquier indicador de foco no basado en texto — mantener ≥3px si se ajusta el estilo.
5. **Warning text sobre paper**: usar `--color-ln-warn` (#96600e, ya oscurecido a 5.28:1) — nunca un amarillo/dorado sin oscurecer.

## Cómo se midió

Fórmula WCAG 2.1:
1. Relative luminance de cada color: `L = 0.2126·R + 0.7152·G + 0.0722·B` donde cada canal está sRGB-linearizado.
2. Contrast ratio: `(L1 + 0.05) / (L2 + 0.05)` donde L1 es el más claro.

Valores verificados manualmente contra [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/). Margen de redondeo ± 0.1 :1.

## Actualización — 2026-06-11

### `--color-ln-warn` (texto de advertencia)

| Token | Valor anterior | Valor nuevo | Motivo |
| --- | --- | --- | --- |
| `--color-ln-warn` | `#b0771a` | `#96600e` | El valor anterior daba 3.82:1 sobre blanco (fallo AA). |

**Nuevas ratios verificadas:**

| Combinación | Ratio | Veredicto |
| --- | --- | --- |
| `#96600e` sobre `#ffffff` (texto normal) | **5.28 : 1** | ✅ AA |
| `#96600e` sobre `#fdf2e0` (`--color-ln-warn-050`) | **4.77 : 1** | ✅ AA |
| `#96600e` sobre `#fdf6ea` (`--color-ln-warn-025`) | **4.92 : 1** | ✅ AA |

El token `--color-gob-warning-text` (alias legacy) fue actualizado en paralelo para mantener consistencia.

---

## Actualización — 2026-06-24

### Operator status tokens — `--color-ln-op-warn` and `--color-ln-op-danger`

Audited as part of the `st-*` semantic token layer (design PR-1, branch `fix/operator-status-token-layer`).

| Token | Foreground | Background | Ratio | Veredicto |
| --- | --- | --- | --- | --- |
| `--color-ln-op-warn` (antes `#9c6700`) | `#9c6700` | `#fff4da` (`ln-op-warn-bg`) | **4.41 : 1** | ❌ AA fail (< 4.5 : 1) |
| `--color-ln-op-warn` (nuevo `#96600e`) | `#96600e` | `#fff4da` (`ln-op-warn-bg`) | **4.83 : 1** | ✅ AA |
| `--color-ln-op-warn` (nuevo `#96600e`) | `#96600e` | `#ffffff` (blanco) | **5.28 : 1** | ✅ AA |
| `--color-ln-op-danger` (`#b71c1c`) | `#b71c1c` | `#fce7e8` (`ln-op-danger-bg`) | **5.55 : 1** | ✅ AA |

**Acción:** `--color-ln-op-warn` darkened from `#9c6700` → `#96600e` (coincide con `--color-ln-warn` citizen, misma ratio). `--color-ln-op-sev-med` actualizado en paralelo (mismo valor). Sin cambio en `ln-op-danger`.

### Violetas — decisión de unificación st-info

| Token | Valor | Superficie | Ratio sobre bg | Veredicto |
| --- | --- | --- | --- | --- |
| `--color-ln-violeta` (citizen) | `#6b4ea8` | `--color-ln-violeta-050` `#f0ecf8` | **5.51 : 1** | ✅ AA |
| `--color-ln-op-viol` (operator) | `#6a4c93` | `--color-ln-op-viol-bg` `#ece5f5` | **5.57 : 1** | ✅ AA |

**Decisión:** Los dos violetas tienen valores distintos a propósito — el operator (`#6a4c93`) fue calibrado sobre la paleta cool-tone navy; el citizen (`#6b4ea8`) sobre el fondo cálido. Ambos pasan AA. Comparten el **nombre** `st-info` por contexto de skin (ver `.op-surface` en globals.css); el valor NO se unifica. Una hex compartida regresaría el contraste ya ganado en una de las dos superficies.

---

## Actualización — 2026-07-12

### Panorama a11y round — tokens de texto muted del operador (`ln-op-mute` / `ln-op-faint` / `ln-op-rail-mute`)

La auditoría a11y de la consola Panorama (axe-core + medición manual, `dim-interno:docs/reviews/2026-07-12-panorama-a11y-audit.md`) oscureció tres tokens de texto secundario del skin operador. Las metas 9-10px del rail, la copia de ayuda por capa y el chip k-anon fallaban AA sobre sus superficies. Medido con la fórmula WCAG 2.1 (ver "Cómo se midió"), sobre las DOS superficies operador reales: la tarjeta blanca (`#ffffff`, chrome flotante sobre el mapa) y el lienzo de página (`--color-ln-op-page` `#eef1f4`, fondo del AppShell operador y color de tierra del basemap).

| Token | Valor anterior | Valor vigente | Superficie | Ratio | Veredicto |
| --- | --- | --- | --- | --- | --- |
| `--color-ln-op-mute` | `#66727c` | `#616c76` | `#eef1f4` (page) | **4.73 : 1** | ✅ AA (antes 4.35:1 ❌) |
| `--color-ln-op-mute` | `#66727c` | `#616c76` | `#ffffff` (card) | **5.36 : 1** | ✅ AA |
| `--color-ln-op-faint` | `#95a0a8` → `#6a7580` | `#646f79` | `#eef1f4` (page) | **4.53 : 1** | ✅ AA (el paso intermedio `#6a7580` daba 4.14:1 ❌ sobre `#eef1f4` — solo pasaba sobre blanco; re-oscurecido en la ronda 2 de review) |
| `--color-ln-op-faint` | `#95a0a8` → `#6a7580` | `#646f79` | `#ffffff` (card) | **5.13 : 1** | ✅ AA |
| `--color-ln-op-rail-mute` | `#7c93ac` | `#93a8bf` | `#0a3556` (navy rail) | **5.19 : 1** | ✅ AA (antes 4.00:1 ❌) |

**Notas:**
- `--color-ln-op-faint` (`#646f79`) queda apenas más claro que `--color-ln-op-mute` (`#616c76`), preservando la jerarquía mute → faint; ambos pasan AA sobre las dos superficies. La ronda a11y inicial lo había dejado en `#6a7580`, que solo pasaba sobre blanco (su comentario reclamaba únicamente `#fff`); la ronda 2 lo re-oscureció para cubrir también `#eef1f4`.
- `--color-ln-op-rail-mute` (`#93a8bf`) está **reservado a la banda navy del rail** (`#0a3556`): sobre blanco/`#eef1f4` da ~2.4:1 y NO debe usarse ahí (es un aclarado deliberado para levantar contraste sobre navy, el inverso de los otros dos).

## Cuándo re-auditar

- Cuando se agregue un nuevo `--color-*` token a `app/globals.css`.
- Cuando se modifique un valor existente.
- Antes de cada release que rediseñe componentes (cards, banners, badges).

## Out of scope de este audit

- **Componentes individuales** (Button, Badge, ReminderCard, etc.) no se auditan rojo por uno. Heredan del token; si el token pasa, el componente pasa salvo que mezcle colores no canónicos.
- **Estados hover/active** se cubren por la misma regla (ratio sobre fondo del estado).
- **Imágenes / iconos decorativos** no requieren contrast ratio (SC 1.4.5 exime decorativos).
- **Texto sobre imágenes de fondo** no se usa en MiMAR.

## Referencias

- WCAG 2.1 Quick Reference: https://www.w3.org/WAI/WCAG21/quickref/
- SC 1.4.3 Contrast (Minimum) — texto normal 4.5:1
- SC 1.4.6 Contrast (Enhanced) — texto normal 7:1 (AAA, opcional)
- SC 1.4.11 Non-text Contrast — componentes UI / focus indicators 3:1 (cumplible por geometría)
- Disp. ONTI 6/2019 — adopta WCAG 2.1 nivel AA como mínimo para sitios web del Estado argentino
