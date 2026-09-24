# Plan — Precisión de coordenadas de denuncia por audiencia (legal-safe)

> **Status:** 🟢 Ready for Claude Code · **Date:** 2026-06-19 · **Standalone.**
> · **Origen:** auditoría de rutas públicas anónimas (2026-06-19). De toda la superficie pública, las coordenadas del comprobante de denuncia son el único sobre-exponer real; el resto (token de libreta, invite, refugios) quedó verificado como bien gateado.
> · **Estado al escribir:** el comprobante público sigue con `toFixed(6)` (`app/(public)/denuncias/codigo/[code]/page.tsx:266`). El RLS de respaldo sobre `welfare_reports` ya existe (`db/welfare_rls.sql`) pero **no cubre esto**: Drizzle corre como service-role y bypassa RLS, así que la precisión en la página pública depende sólo del código de la página. Por eso este fix sigue siendo necesario.
> · **Anclaje legal:** **Ley nac. 14.346** (maltrato — penal; UFEMA/Fiscalía/MPF) · **Ley CABA 6173 + 6839/2025** ("Ley Huellas" — contravencional) · **Ley 25.326** (Protección de Datos Personales — minimización). Ver `docs/legal-framework-full.md` §6.9 y §"Maltrato y denuncia".
>
> ⚠️ **Coordinación con CC en vivo (Wave 5 corriendo).** Wave 5 está en ejecución y su Item 27 (cierre de fugas de PII) puede tocar el mismo comprobante. **SECUENCIA: correr al FINAL del bloque autónomo de Wave 5 — NO reordenar ni interrumpir lo en curso.** Si al llegar acá Wave 5 ya tocó las coordenadas del comprobante, **este plan es el spec de referencia del enfoque precisión-por-audiencia: reconciliar, no duplicar** (verificar que la autoridad ve exacta + logueada y el público ve aproximada; si ya está, sólo cerrar gaps). Antes de tocar archivos, `git status` para ver qué dejó Wave 5 en el árbol.

---

## Problema (y por qué NO es "borrar las coordenadas")

La denuncia de maltrato es el form online de un **proceso real**: la autoridad (govt jurisdiccional / admin → Fiscalía/UFEMA) necesita **ubicación precisa** para intervenir y eventualmente ejecutar decomiso (Ley 14.346). **Las coordenadas precisas se conservan.**

El problema es de **audiencia**, no de existencia: hoy el **comprobante público** `app/(public)/denuncias/codigo/[code]/page.tsx:266` renderiza `lat.toFixed(6), lng.toFixed(6)` (~0,1 m) + pin exacto en mapa, accesible por **cualquiera que tenga el reference code** `DEN-XXXX-XXXX`. Eso entrega la ubicación exacta del sitio denunciado (y por elevación, puede des-anonimizar al denunciante o a la víctima) a un tenedor del código — más precisión de la que el **recibo de seguimiento** necesita. La autoridad ya ve las coordenadas en superficies autenticadas (`/gob/maltrato/[id]`, `/admin/moderacion/[id]`).

**Principio (Ley 25.326, minimización):** cada audiencia ve **la mínima precisión que su función requiere**.

| Audiencia | Superficie | Precisión | Por qué |
|---|---|---|---|
| **Autoridad** (govt scoped + admin) | `/gob/maltrato/[id]`, `/admin/moderacion/[id]` | **Exacta** (valor `numeric(10,7)`) + dirección completa | Investiga / interviene / decomisa. Acceso autenticado + **logueado** (audit). |
| **Denunciante / tenedor del código** | `/denuncias/codigo/[code]` (público) | **Aproximada** (localidad/barrio + mapa redondeado) — sin decimales exactos ni pin a nivel calle | Es un **recibo de seguimiento**: confirmar "tu denuncia en {área} está {estado}". No necesita el pin exacto. |

---

## 0. Antes de tocar nada
- Leer `AGENTS.md` (data model + privacy tiers + welfare/denuncia) y `docs/legal-framework-full.md` §6.9.
- Confirmar el esquema: `welfareReports.locationLat/Lng = numeric(10,7)` (`db/schema.ts:1442`), `locationAddress`, `jurisdictionProvince/Locality`. **Sin cambios de schema en este plan** (la precisión de almacenamiento no cambia — sólo la de *presentación* por audiencia; ver Fase D para la decisión opcional de retención).
- Localizar el helper de lectura de punto: `readPoint(report)` en `lib/location.ts` (ya usado por el comprobante).
- Localizar el patrón canónico de **PII-query logging** (usado en `/gob/usuarios` y en el omnibox operador — `app/actions/omnibox-search.ts` / `lib/omnibox-search.ts`). Reusarlo en Fase C; **no** inventar uno nuevo.

---

## Fase A — Helper de coarsening puro (`lib/location.ts`)
Agregar una función pura, testeable sin DB:

```ts
// Reduce la precisión de un punto a una grilla, para presentación pública.
// NO muta el valor almacenado; sólo la salida de presentación.
export type PointPrecision = "exact" | "approx";

export function coarsenPoint(
  point: { lat: number; lng: number },
  precision: PointPrecision,
): { lat: number; lng: number } {
  if (precision === "exact") return point;
  // ~3 decimales ≈ ~110 m en lat (decisión abierta D1 — ver abajo).
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { lat: round(point.lat), lng: round(point.lng) };
}
```

- **Determinístico** (redondeo a grilla), **no** jitter aleatorio — para que no varíe entre cargas (evita triangulación por múltiples lecturas).
- Exportar `PointPrecision`. Documentar el porqué con comentario que cite Ley 25.326 minimización + Ley 14.346 (la exacta vive para la autoridad).
- **Tests** (`lib/location.test.ts` o `__tests__/location.test.ts`): redondeo correcto, `exact` pasa sin tocar, estabilidad (misma entrada → misma salida), bordes (negativos AR, null-safety vía `readPoint`).

---

## Fase B — Comprobante público: aproximado (`app/(public)/denuncias/codigo/[code]/page.tsx`)
- Reemplazar `locationPoint.lat.toFixed(6), lng.toFixed(6)` por la versión **aproximada**: `const shown = coarsenPoint(locationPoint, "approx")`.
- El `<LocationMap>` recibe el punto **aproximado**; quitar la leyenda de coordenadas exactas a nivel calle. Etiquetar el mapa como **"Ubicación aproximada"** (label visible + `aria-label`).
- **Dirección**: en el comprobante público mostrar **localidad + provincia** (`jurisdictionLocality, jurisdictionProvince`), **no** `locationAddress` a nivel calle/número. (El denunciante reconoce su denuncia por área + kind + fecha + reference code, sin exponer el domicilio exacto a un tenedor del código.)
- Mantener todo lo que ya está bien: contacto enmascarado (`maskEmail`/`maskPhone`), estado, kind, fecha, reference code.
- Si el comprobante **descargable** (`DescargarComprobante.tsx`) necesita más detalle para el denunciante: mantenerlo **igual de aproximado** que la pantalla (no reintroducir precisión por el PDF). Si el dueño decide que el PDF lleve dirección completa, eso es decisión D2 — no asumir.

---

## Fase C — Superficies de autoridad: exacta + logueada (`/gob/maltrato/[id]`, `/admin/moderacion/[id]`)
- Confirmar que renderizan el punto **`exact`** + `locationAddress` completo (es su función investigativa). Si hoy ya muestran el valor crudo, **no degradar**.
- Etiquetar la sección como **"Ubicación exacta — uso oficial (Ley 14.346)"** para dejar explícito el propósito.
- **Loguear el acceso** a las coordenadas exactas reusando el patrón PII-query-logging existente: registrar `{ actorUserId, welfareReportId, action: "welfare_location_viewed", at }`. Scope govt = jurisdicción (ya aplica el gating de `/gob`).
- Verificar que el acceso sigue **scoped** (govt sólo su jurisdicción; admin universal).

---

## Fase D — Retención (decisión opcional del dueño — D3)
Propuesta (NO implementar sin OK):
- Conservar coordenadas **exactas** mientras el caso/denuncia está **abierto** + ventana de retención legal posterior a la resolución.
- Pasada esa ventana: **coarsen-at-rest** (sobreescribir lat/lng con la versión aproximada) o purgar, vía cron (patrón de los crones existentes, p.ej. `close-rabies-observations`).
- Anclar la ventana a criterio legal (Ley 25.326: no conservar más de lo necesario para la finalidad). **Definir la ventana con el dueño** antes de codificar.

---

## Legal — dejar el anclaje explícito
- Agregar `lib/welfare-legal-anchors.ts` (o una sección en `docs/legal-framework-full.md §6.9`) que mapee: precisión-por-audiencia ↔ Ley 14.346 (necesidad investigativa) + Ley 25.326 (minimización en el recibo público) + Ley CABA 6173/6839. Comentario de referencia en `coarsenPoint` y en las 3 páginas.

---

## Edge / a11y
| Caso | Comportamiento |
|---|---|
| denuncia sin coordenadas (`readPoint` null) | comprobante muestra sólo localidad/provincia textual; sin mapa. Autoridad igual. |
| punto exacto = (0,0) o fuera de AR | tratar como dato presente; el coarsening no rompe; la autoridad ve lo que hay. |
| mapa aproximado | `aria-label="Ubicación aproximada de la denuncia"`; no sugerir precisión que no tiene. |
| reducer-motion / sin JS | el comprobante no depende del mapa para el dato clave (texto de área presente). |

---

## Tests (SDD test-first)
- `coarsenPoint`: redondeo, `exact` passthrough, estabilidad, null-safety.
- Comprobante público: **assert de que la respuesta/markup NO contiene `toFixed(6)` ni el valor exacto**; sí contiene localidad/provincia. (Test de la forma renderizada, no sólo del componente.)
- Autoridad: el detalle de `/gob/maltrato/[id]` muestra el punto exacto **y** escribe el log de acceso (assert del insert de audit).
- Scope: govt fuera de jurisdicción no accede (reusa el gating existente).

---

## Verificación final
- `pnpm verify` (typecheck + lint + lint:tokens + build) verde.
- `pnpm test` de los nuevos tests verde.
- Grep de control: ningún `toFixed(6)` / render de coordenada exacta en `app/(public)/**`.
- Docs en el mismo PR; **flippear la fila** en `docs/superpowers/README.md`.

---

## Decisiones abiertas (resolver con el dueño antes o durante)
- **D1 — Precisión pública.** ¿`approx` = 3 decimales (~110 m) o 2 (~1,1 km) o sólo localidad/barrio sin mapa? (Default propuesto: 3 decimales + localidad.)
- **D2 — PDF comprobante.** ¿Mismo nivel aproximado que pantalla (default) o dirección completa para el denunciante?
- **D3 — Retención (Fase D).** ¿Se implementa coarsen/purge-at-rest? ¿Qué ventana post-resolución?

## Lo que NO está en este plan
- Cambios de schema (la precisión almacenada sigue `numeric(10,7)`; Fase D es opcional y aparte).
- **Predicado de lost-location** (`src/modules/lost/infrastructure/lost-listing-read.ts:170` — hoy filtra en JS, no en el `WHERE`): mismo patrón "minimización en la query", pero es otra ruta. Hacerlo en un PR aparte si se prioriza.
- **Payloads de adopción** (lecturas autenticadas org/owner sobre-fetcheando PII): es over-fetch autenticado, no exposición pública — fuera de scope acá.
- **RLS de respaldo:** `db/welfare_rls.sql` ya existe; no se toca acá (no cubre la ruta pública vía service-role de todos modos).
