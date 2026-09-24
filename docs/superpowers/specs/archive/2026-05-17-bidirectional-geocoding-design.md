# Bidirectional geocoding (map ↔ text) — design spec

> Sincronización bidireccional entre el campo de texto de dirección y el map pin del componente `LocationFields`. El dueño tipea "Plaza Italia, Palermo" → el mapa centra y dropea pin. Mueve el pin en el mapa → el texto se completa con "Plaza Italia, Palermo, CABA". Server-side proxy a Nominatim/OSM. Reutilizable en cualquier form que capture ubicación precisa (lost-pet, vet visit, intake, scheduling slot, etc.).
>
> Auto-contenido; el plan de implementación va aparte.
>
> **Fecha:** 2026-05-17
> **Owner:** Ignacio Del Valle
> **Estado:** ready for review, no code yet
> **Versión:** 1.0

---

## 1. Por qué este documento existe

Hoy `LocationFields` con `mode="point"` muestra un map picker que el dueño usa para dropear pin. Aparte, los forms tienen un input separado de texto para la dirección (e.g., `lastKnownLocation` en MarkLostForm). Los dos campos son **independientes** — el dueño puede dropear pin en CABA y tipear "Mendoza" en el texto, y el sistema acepta ambos sin advertir.

Esa independencia es fricción real:
- El dueño que tipea bien la dirección tiene que ADEMÁS dropear el pin manualmente (doble trabajo)
- El dueño que dropea el pin no tiene contexto legible en el texto del evento (la credencial pública muestra coordenadas raw porque no hay description)
- Refugios que reciben broadcast ven coordenadas o texto disociado, no ambos
- Inconsistencias entre lo que dice el texto y dónde está el pin son silenciosas

Geocoding bidireccional cierra el loop: un solo gesto del dueño produce ambos lados sincronizados. Igual que Google Maps, Uber, Rappi, MercadoLibre — el dueño espera que esto funcione.

**Beneficio secundario importante:** este feature es la oportunidad para **estandarizar `LocationFields`** como entry point único para captura de ubicación. Hoy los forms varían (algunos tienen map+text, otros solo text, otros solo locality picker). Cuando lleguen los planes pesados (scheduling, lost-and-found, symptom-surveillance), el patrón ya estandarizado evita N variantes paralelas.

## 2. Decisiones cerradas

| # | Decisión | Razón |
|---|---|---|
| D1 | **Provider de geocoding: Nominatim/OSM** (https://nominatim.openstreetmap.org/), vía server-side proxy en una server action | DIM ya usa MapLibre + OpenStreetMap (AGENTS.md → Stack). Nominatim es el geocoder OSM oficial, gratis, sin API key, alineado con el stack. Server-side proxy permite controlar User-Agent (requisito de Nominatim), centralizar rate-limit, y eventualmente swap provider sin tocar componentes |
| D2 | **Bias geográfico por país AR + jurisdicción de la mascota** cuando esté disponible. Si la mascota tiene `jurisdiction_province='AR-C'` y `jurisdiction_locality='Belgrano'`, el geocoder prioriza resultados en CABA → Belgrano | Reduce ambigüedad ("Plaza Italia" existe en muchas ciudades). El bias es priority, no filter — el dueño que escribe una dirección de otra provincia igual aparece |
| D3 | **Debounce de input de 600ms** antes de disparar geocoding | Equilibrio razonable: 300ms es agresivo (tira request mientras tipeás), 1s es lento. 600ms es lo que usan apps consumer modernas |
| D4 | **Sin caché en v1**. Cada query a Nominatim. Si rate-limit se vuelve issue (más de 1 req/sec sostenido), agregamos in-memory LRU server-side o tabla `geocode_cache` | Premature optimization. Para tráfico v1 el rate-limit no se va a tocar. Si llega a tocar, ese es señal positiva |
| D5 | **Free text en `location_description`, no structured address**. El input es uno solo: free-text. El geocoder puede returnar address structured pero solo persistimos el `display_name` legible | Coherencia con AGENTS.md y con la flexibilidad del dueño. Pedirle structured (street, number, neighborhood) es fricción de form |
| D6 | **Graceful degradation**: si el geocoder falla (timeout, error, sin resultados), el form sigue funcionando con text + pin como campos independientes (comportamiento actual). Sin error fatal | El feature suma valor cuando funciona; cuando falla, no rompe nada existente |
| D7 | **Forward (text → map) y reverse (map → text) ambos shipean en v1**. No spec futuro, parte del feature ahora | Es trabajo de un día. Splitearlos solo para shipear forward primero no vale el round-trip |
| D8 | **Reverse geocode solo se dispara con cambios "intencionales" del pin** (drag completado, click en map). NO en cada render inicial o re-render cosmético | Evita llamadas innecesarias al API. El pin que aparece pre-cargado de un edit no re-llama Nominatim |
| D9 | **El componente `LocationFields` mode="point" se vuelve la fuente canónica de captura de ubicación precisa** para todos los forms futuros. Forms existentes que tienen text + map separado se migran a usar el componente unificado en una pasada | Reduce drift entre forms |
| D10 | **Privacy: el server log NO persiste las queries de geocoding**. Solo se loggean errores y rate-limit hits (sin la query original) | Evita acumular un dataset de "qué direcciones busca cada usuario" — bajo overhead, alta sensibilidad |

## 3. Glosario

| Término | Qué es |
|---|---|
| **Forward geocoding** | Texto libre → coordenadas (lat/lng). "Plaza Italia, Palermo" → `{lat: -34.583, lng: -58.421, display_name: "Plaza Italia, Palermo, ..."}` |
| **Reverse geocoding** | Coordenadas → texto legible. `{lat: -34.583, lng: -58.421}` → `"Plaza Italia, Palermo, CABA, Argentina"` |
| **Bias** | Hint al geocoder para priorizar resultados en una región. No filtro estricto |
| **Nominatim** | Geocoder oficial de OpenStreetMap. HTTP API libre, sujeto a usage policy (1 req/sec sostenido, User-Agent identificable) |
| **Display name** | El string legible que returna Nominatim como descripción de un lugar. Es lo que persistimos en `payload.location_description` |

## 4. Domain model

### 4.1 Sin cambios de schema

Este feature **no agrega tablas ni columnas**. Reutiliza:
- `pet_events.location_lat` y `location_lng` para coordenadas (ya existen)
- `pet_events.payload.location_description` (text) para el string legible (ya existe en `status_changed → lost`)

### 4.2 Una server action nueva

`app/actions/geocoding.ts` (nuevo):

```ts
"use server";

export type GeocodeResult = {
  lat: number;
  lng: number;
  display_name: string;
  // Optional structured fields for future use
  province?: string | null;
  locality?: string | null;
};

export type ReverseGeocodeResult = {
  display_name: string;
  province?: string | null;
  locality?: string | null;
};

/**
 * Forward geocode: text query → coordinates + display_name.
 * Returns up to 5 results, ordered by relevance.
 * Empty array on no match.
 * Throws on hard errors (network, rate-limited) so the client can show a fallback.
 *
 * Bias hint accepts province (ISO 3166-2:AR code, e.g. 'AR-C') and locality
 * to prioritize results in that area. Country is always Argentina in v1.
 */
export async function geocodeAddressAction(
  query: string,
  bias?: { province?: string | null; locality?: string | null },
): Promise<GeocodeResult[]>;

/**
 * Reverse geocode: coordinates → display_name.
 * Returns null on no match or on hard error (caller decides UX).
 */
export async function reverseGeocodeAction(
  lat: number,
  lng: number,
): Promise<ReverseGeocodeResult | null>;
```

Implementación llama a `https://nominatim.openstreetmap.org/search` (forward) y `/reverse` (reverse) con:
- `User-Agent: MiMAR/1.0 (https://mimar.ar; nacho@dim.ar)` — requerido por Nominatim usage policy
- `countrycodes=ar` para forward
- `viewbox=<bounding_box>&bounded=1` cuando bias está set (encierra la búsqueda a la jurisdicción)
- `format=jsonv2&addressdetails=1&limit=5` para forward; `limit=1` para reverse
- `Accept-Language: es` para resultados en español

### 4.3 Refactor de `LocationFields` componente

`components/LocationFields.tsx` (tocar):

**Estado actual del componente** (verificar al implementar): tiene un `mode="jurisdiction"` (province + locality select) y `mode="point"` (map pin picker). El text de dirección hoy está en cada form que lo necesita, no en el componente.

**Estado target:**
- En `mode="point"`, el componente integra el text input además del map
- Los dos campos están sincronizados:
  - Cambios en text → debounced (600ms) → `geocodeAddressAction` → si hay resultado, centra y dropea pin
  - Drag/click en map → `reverseGeocodeAction` → fill text input
- Los dos siguen siendo editables independientemente — la sync es soft (un edit no triggea el otro cuando vino del otro side)
- Loading state visible mientras la API responde (spinner chico al lado del input, opacity en el map mientras se actualiza)
- Empty state cuando no hay resultados ("No encontramos esa dirección. Podés moverte por el mapa.")
- Error state cuando el API falla ("No pudimos buscar la dirección ahora. Tipeá lo que sepas y movete por el mapa.")

**Props del componente extendido:**

```tsx
type LocationFieldsProps =
  | { mode: "jurisdiction"; defaultValue?: JurisdictionDefault; name?: string }
  | {
      mode: "point";
      defaultValue?: PointDefault;
      // Bias el geocoder a la jurisdicción de la mascota (cuando se conoce).
      // Si null/undefined, no bias.
      biasProvince?: string | null;
      biasLocality?: string | null;
      // El name de los inputs hidden que el form va a leer.
      // Por convención: locationLat, locationLng, locationDescription
      inputNames?: {
        lat?: string;
        lng?: string;
        description?: string;
      };
    };
```

### 4.4 Form integrations

Forms que actualmente tienen text+map separados se migran a usar el componente integrado:

- `MarkLostForm` (`app/(app)/mis-mascotas/[publicToken]/perdida/MarkLostForm.tsx`): hoy tiene `lastKnownLocation` text input + `<LocationFields mode="point" />` separados. Pasa a un solo `<LocationFields mode="point" />` con el text integrado
- Forms futuros (scheduling slot creation, lost-and-found enriched description, etc.) usan el patrón unificado desde el inicio

Server actions de cada form leen los mismos input names (`locationLat`, `locationLng`, `locationDescription` — convención). Casi cero cambio en server-side; el feature es UX-only.

## 5. UX detallado

### 5.1 Estado inicial

Cuando el componente se monta (e.g., al abrir el form de "Marcar como perdida"):
- Si hay defaults (edit mode): texto y pin se muestran sincronizados a los defaults. No se llama geocoder
- Si no hay defaults (create mode): texto vacío, mapa centrado en la jurisdicción del pet (province + locality) o en CABA si no hay jurisdicción

### 5.2 Forward (text → map)

```
Usuario tipea: "P"
  → 600ms timer arranca

Usuario tipea: "Plaza Italia"
  → timer se resetea cada keystroke

Usuario para de tipear por 600ms
  → spinner aparece al lado del input
  → server action geocodeAddressAction("Plaza Italia", { province: pet.province, locality: pet.locality })

Si returns array con >=1 result:
  → top result: mapa centra a esas coordenadas, pin se dropea ahí
  → si results > 1: dropdown abajo del input con los 5 results
    (el usuario puede clickear otro si el top está mal)
  → spinner desaparece

Si returns []:
  → mensaje sutil bajo el input: "No encontramos esa dirección"
  → mapa queda donde está (no se modifica)
  → pin queda donde está
  → spinner desaparece

Si throw (timeout, rate-limit, etc.):
  → mensaje bajo el input: "No pudimos buscar la dirección ahora"
  → mapa queda donde está
  → spinner desaparece
  → el usuario puede usar el mapa manualmente y/o el texto puede persistirse igual
```

### 5.3 Reverse (map → text)

```
Usuario drag-and-drops el pin (o click en mapa para mover el pin)
  → on `drag end` / `click`: spinner aparece al lado del input
  → server action reverseGeocodeAction(lat, lng)

Si returns result:
  → text input se actualiza con result.display_name
  → spinner desaparece

Si returns null:
  → text input se mantiene como estaba
  → mensaje sutil bajo el input: "No pudimos identificar esa ubicación"
  → spinner desaparece
```

### 5.4 Edición manual sin trigger

Para evitar loops y comportamiento sorpresivo:

- Cuando el text se actualiza POR reverse geocoding (D8), el debounce timer del forward NO arranca (es un programmatic change, no user input)
- Cuando el pin se mueve POR forward geocoding, el reverse NO se dispara (mismo razonamiento)
- El usuario que edita el text después de un reverse-geocode auto-fill ve que su edit "reemplaza" la auto-completion — y el forward geocode se vuelve a triggear con el nuevo text. Esto es ok porque el usuario está SIENDO explícito sobre re-buscar

### 5.5 Mobile

- Pin clickeable más grande que el desktop (tap target ≥44px)
- Map drag se prefiere sobre pin drag en mobile (más natural con dedo)
- Text input arriba del mapa (no abajo), porque el teclado mobile empuja el mapa fuera de viewport si está debajo

## 6. Privacy y rate limiting

**Privacy:**
- Las queries que el usuario tipea van a Nominatim. Nominatim opera bajo la usage policy de OSM Foundation y no almacena queries indefinidamente, pero conceptualmente la consulta sale de nuestro server
- **NO logueamos las queries en nuestros logs**. Solo errores HTTP y rate-limit hits, sin la query original
- Las coordenadas finales (lat/lng + display_name) se persisten en `pet_events` como hoy — esto no es info nueva, es el data que ya estaba diseñado para guardarse
- A futuro: si el volumen lo justifica, self-host Nominatim para que las queries no salgan de infraestructura nuestra. AGENTS.md → Aggregation & privacy policy permite esto cuando llegue el momento

**Rate limiting (Nominatim usage policy: 1 req/sec sostenido):**
- Server action implementa rate-limit interno: máximo 5 req/sec totales (margen sobre el límite teórico para no rascar la regla)
- Si se excede, return 429 al cliente. El cliente muestra fallback "No pudimos buscar ahora" y el usuario puede tipear/mover-pin libre
- Si en producción este rate-limit se vuelve issue (e.g., picos de uso), considerar self-hosted Nominatim — la docker image existe

## 7. Casos borde

- **Usuario tipea texto que no es dirección** (e.g., "como cuando se escapó la última vez"): geocoder returna [], se muestra "No encontramos esa dirección". El texto se persiste igual al submit. Para el dueño esto es feature, no bug — quiere notar contexto que no es dirección geocodificable
- **Coordenadas en el medio del agua / sin dirección reverse**: returna null, text queda vacío o como el usuario lo tenía. Pin se mantiene
- **Usuario en una zona rural sin cobertura OSM detallada**: forward returna ciudad más cercana o region; reverse returna provincia. Aceptable — el dueño puede refinar manualmente
- **Pin movido a otro país**: D2 bias es priority, no filter. Si el dueño explícitamente mueve a Brasil, el reverse devuelve dirección brasilera. No queremos prohibir esto (DIM podría tener users de extranjero algún día)
- **Edit mode con coordenadas históricas**: el reverse NO se dispara automáticamente (D8). El texto se renderiza desde el `location_description` ya persistido. Si el usuario quiere refrescar, mueve el pin y eso triggea reverse
- **Mapa no carga (offline / network bloqueado)**: el componente cae a un fallback "Sin mapa disponible, podés tipear la dirección manualmente". El texto sigue siendo persistible; solo no hay coordenadas
- **Bias por jurisdicción cuando la mascota está en proceso de cambiar jurisdicción**: el bias usa los valores actuales de `pets.jurisdiction_*`. No hay race condition relevante

## 8. RLS y security

**Server action `geocodeAddressAction` / `reverseGeocodeAction`:**
- Auth requerido (`requireAuthenticated()` o equivalente). Anonymous no pueden geocodificar — protege contra abuso
- Las queries no leen ni escriben en nuestra DB. Son proxies externos
- Output al cliente es structured data sin PII propietaria de DIM (solo lo que Nominatim ya devolvía)

**Nominatim usage policy compliance:**
- User-Agent identificable
- Cache buster siempre `false` (no abusamos el caché de ellos)
- Una request por user-keystroke-batch (debounce client-side asegura esto)
- 5 req/sec global del server (margen sobre 1 req/sec sostenido del policy)

## 9. Phasing

Una fase, un PR:

**Fase única — server action + LocationFields integration (1 PR):**
- Crear `app/actions/geocoding.ts` con `geocodeAddressAction` y `reverseGeocodeAction`
- Implementar el proxy a Nominatim con User-Agent + rate-limit interno
- Refactor de `components/LocationFields.tsx` mode="point" para integrar text input + map + sync logic
- Migración de `MarkLostForm` para usar el componente integrado en lugar de campos separados
- Tests: unit del rate-limit, unit del normalizador de bias, integration mock-fetch de geocoding action (no hit real Nominatim en CI)
- Smoke manual end-to-end

**Estimación:** 1 día.

**Fuera de fase única (opcional, posterior):**
- Cache de queries con TTL (si rate-limit se vuelve issue)
- Self-host Nominatim
- Address suggestions while typing (autocompletar tipo Google Places) — distinto de geocoding, más caro
- Migración de otros forms (vet visit, intake) cuando los toques por otra razón

## 10. Lo que NO está en este diseño

- **Autocompletar mientras tipeás** (Google Places style con suggestions dropdown): el feature actual muestra dropdown SOLO cuando geocoder returna multiple results AFTER full debounced query, no en cada keystroke
- **Address structured** (street, number, neighborhood, postal code separados): un solo text field free, comportamiento current
- **PostGIS migration**: separate concern, ya está en AGENTS.md → Scaling roadmap con trigger condition propio
- **Self-hosted Nominatim**: defer hasta que rate-limit se vuelva real issue
- **Caching server-side**: defer
- **Multi-country support**: D2 bias es AR-only en v1. Cuando se internacionalice, parametrizamos el country
- **Map de orgs cercanas en discovery** (e.g., en `/turnos/buscar`): feature separado. Este spec solo cubre captura
- **Geocoding offline / sin conexión**: graceful degradation pero sin offline mode
- **A/B test de UX**: ship el v1, observamos

---

## Próximo paso

Cuando este diseño tenga OK, el plan ejecutable es chico (~1 día, 1 PR). Lo arma en formato estándar de `docs/superpowers/plans/`.

Si querés ajustar antes del plan:
- Provider (Nominatim vs alternativa)
- Debounce timing
- Si Forward+Reverse en una sola fase o split
- Defaults del bias (siempre por jurisdicción del pet, o configurable por form)
- Copy de los empty/error states

Decímelo antes y lo reflejo acá. Cambiar después del plan cuesta más.
