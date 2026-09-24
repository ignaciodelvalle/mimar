# Design system — dos modos, un ADN

**Origen**: cursor sentiment review (2026-07-24), recomendación #1 y #8. Decisión PO: documentar.
No es código — es la doctrina que ya vive implícita en el producto, escrita para que ningún
rediseño futuro la rompa.

## La tesis

miMAR tiene DOS audiencias con metáforas opuestas — el ciudadano (libreta/credencial) y el
operador (centro de situación) — que **comparten tokens pero divergen en arquitectura de página**.
Esa dualidad es la diferenciación del producto, no una inconsistencia a "unificar para ahorrar".
El riesgo NO es que se vean iguales; es que el operador se vuelva demasiado SaaS-dashboard y el
ciudadano se diluya en micrositio ministerial.

Regla madre: **compartir tokens (color, tipografía, badge, botón, radio), nunca layouts.**

## Los dos modos

### Modo Ciudadano (wallet / libreta)
- **Metáfora**: la libreta sanitaria argentina. Un objeto protagonista por pantalla (la credencial
  o la mascota).
- **Fondo**: paper/cream cuando aplica; foto grande de la mascota.
- **Tipografía**: serif en los títulos de documento cívico; sans en la UI.
- **Composición**: la mascota/credencial arriba de todo (el home del dueño redirige a ella). CTAs
  sticky en mobile (ver credencial P3). Footer legal COLAPSADO ("Acerca de miMAR").
- **Superficies**: `/inicio`, `/p/[token]`, `/mis-mascotas`, denuncia pública, landing.

### Modo Operador (console)
- **Metáfora**: turno de trabajo. Una pregunta por vista, no un catálogo de módulos.
- **Fondo**: rail navy + canvas gris.
- **Tipografía**: sans dominante, densidades KPI.
- **Composición**: rail de 5 jobs + "Administración" colapsada (dieta nav refugio R1); Panel = work
  queue + north-stars, no un segundo sitemap. KPIs con contención de color (semáforo disciplinado,
  no sirena).
- **Superficies**: `/gob/*`, `/admin/*`, `/org/[token]/*`.

## Lo que COMPARTEN (el ADN, un solo set de tokens)

| Token | Dónde vive | Regla |
|---|---|---|
| Color (azul institucional, semáforo ok/atención/riesgo/neutral) | `app/globals.css` (`--color-*`), `packages/contract/src/viz/viz-scales.ts` (`@dim/contract/viz`) | 4 tonos de estado máximo; sin verde-rojo adyacente (CVD) |
| Tipografía (`--text-*`, `--font-ln-*`) | `app/globals.css` | Escala tokenizada; sin `text-[Npx]` crudo (fence `lint:tokens`) |
| Radio (`--radius-*`) | idem | Tokenizado; sin `rounded-[Npx]` crudo |
| Botones | `components/ui/Button.tsx` (Ln*, ciudadano), `components/ui/dashboard/OpButton.tsx` (Op*, operador) | Sin `<button>` crudo (fences `lint:buttons`) |
| Badges/pills, cards | shared primitives | Un solo lenguaje de tarjeta por modo |
| Estados vacíos | `LnEmptyState` (ciudadano), estados in-map/in-chart (operador) | Epistémicos: qué, por qué, qué hacer |

## Lo que NO se comparte (por diseño)
- **Arquitectura de página**: wallet (objeto protagonista) vs console (rail + queue). NUNCA fusionar
  ciudadano y operador en un solo shell "para ahorrar" — sentiment #8, evitar explícito.
- **Chrome**: topnav wallet vs sidebar operador.
- **Densidad**: aérea (ciudadano) vs alta-pero-con-una-pregunta-por-vista (operador).

## Cómo se defiende (fences existentes)
La disciplina de tokens ya la fuerza CI: `lint:tokens` (sin px/hex crudos), `lint:buttons`,
`lint:select`, `lint:ui`, `lint:brand`, `lint:icons`, `lint:screens` (manifiesto por ruta),
`view-scope`, `metric-contract`, `empty-states`. Un rediseño que meta px crudo, un botón nativo,
o un estado vacío pelado falla el build. Lo que NO tiene fence — y por eso vive en este doc — es
la separación de arquitectura de página: es una decisión de criterio, no mecánica.

## Scores de referencia (sentiment 2026-07-24, para no regresionar)
Credencial pública 9/10 · libreta dueño 8,5/10 · landing 8/10 · son las anclas de calidad del
modo ciudadano. Panel gob/admin 7/10 · el trabajo de operador es contención de alertas + dieta de
rails, no reiniciar la marca.
