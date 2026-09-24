# Bidirectional geocoding (map ↔ text) — implementation plan

> Plan ejecutable para Claude Code. Una fase única, un PR. Crea server action de geocoding como proxy a Nominatim/OSM, refactorea `LocationFields` mode="point" para integrar text input + map pin + sync bidireccional, migra `MarkLostForm` para usar el componente unificado.
>
> **Fecha:** 2026-05-17
> **Owner:** Ignacio Del Valle
> **Tamaño:** 1 archivo nuevo, ~3 archivos tocados, 0 migraciones de DB, 0 RLS changes
> **Estimación:** 1 día (~6-8 horas)

---

## 0. Antes de tocar nada

Lectura obligatoria:

1. **`docs/superpowers/specs/2026-05-17-bidirectional-geocoding-design.md`** — el spec. Toda decisión está justificada ahí. Si encontrás algo en este plan que contradice el spec, gana el spec
2. **`components/LocationFields.tsx`** completo — el componente actual con sus dos modes (`jurisdiction` y `point`). El refactor extiende mode="point" sin tocar mode="jurisdiction"
3. **`app/(app)/mis-mascotas/[publicToken]/perdida/MarkLostForm.tsx`** — el form de "Marcar como perdida". Hoy tiene `lastKnownLocation` text input + `<LocationFields mode="point" />` como widgets separados. Vas a migrarlo
4. **`app/actions/events.ts → setPetLostAction`** — el server action que recibe el form. Verificá cómo lee hoy `locationLat`, `locationLng`, y `lastKnownLocation` del FormData. Después del refactor, los nombres de los campos pueden cambiar — coordinate con el componente nuevo
5. **`lib/ar-provincias.ts`** — el lookup de provincias por código ISO. No lo tocás, solo lo uses si necesitás validar `province` en el bias
6. **Nominatim usage policy**: https://operations.osmfoundation.org/policies/nominatim/ — leelo. Es corto. Los requisitos clave: User-Agent identificable, no más de 1 req/sec sostenido por cliente, no abusar caché busters, atribución a OSM cuando corresponda

**Antes de empezar**: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verdes en main. Si hay rojos pre-existentes, parar y avisar a Nacho.

## 1. Qué construye este plan

Tres piezas en un solo PR:

**1.1 Server action `app/actions/geocoding.ts`.** Dos funciones: `geocodeAddressAction(query, bias?)` (forward) y `reverseGeocodeAction(lat, lng)` (reverse). Proxy a Nominatim/OSM con User-Agent identificable, rate limit interno (token bucket de 5 req/sec per-instance), parser de respuestas, error handling.

**1.2 Refactor de `components/LocationFields.tsx` mode="point".** Hoy el componente solo muestra map pin. Pasa a mostrar también un text input arriba del mapa. Los dos campos están sincronizados:
- Cambios en el text input (debounced 600ms) llaman `geocodeAddressAction` → centran el mapa y dropean pin
- Drag o click en el mapa llaman `reverseGeocodeAction` → llenan el text input
- Loading states visibles durante las llamadas
- Empty / error states cuando no hay resultados o falla la API
- Los dos campos siguen editables manualmente (la sync es soft)

**1.3 Migración de `MarkLostForm`.** El form actual tiene dos widgets separados (`lastKnownLocation` input + `<LocationFields mode="point" />`). Pasa a tener un solo `<LocationFields mode="point" />` que integra el text. El server action `setPetLostAction` ajusta el nombre del input field si hace falta (o sigue leyendo `locationDescription` si ya lo hace bien).

## 2. Decisiones cerradas (resumen del spec — NO relitigar)

| # | Decisión | Sección spec |
|---|---|---|
| D1 | Provider de geocoding: Nominatim/OSM via server-side proxy | §2 D1 |
| D2 | Bias por país AR + jurisdicción del pet cuando esté disponible | §2 D2 |
| D3 | Debounce 600ms antes de disparar forward geocoding | §2 D3 |
| D4 | Sin caché en v1 | §2 D4 |
| D5 | Free text, no structured address. Persistimos `display_name` legible | §2 D5 |
| D6 | Graceful degradation: si falla el geocoder, el form sigue funcionando | §2 D6 |
| D7 | Forward + Reverse ambos en v1 | §2 D7 |
| D8 | Reverse solo se dispara con cambios intencionales del pin (drag end / click), no en re-renders | §2 D8 |
| D9 | `LocationFields` mode="point" se vuelve el entry point canónico de captura | §2 D9 |
| D10 | Server NO loguea las queries del usuario. Solo errores y rate-limit hits sin la query | §2 D10 |

## 3. Scope

**Dentro:**
- `app/actions/geocoding.ts` (nuevo) — server action + rate limit + Nominatim wrapper
- `components/LocationFields.tsx` (extender mode="point") — text input integrado + sync logic + states
- `app/(app)/mis-mascotas/[publicToken]/perdida/MarkLostForm.tsx` (migrar) — un solo widget en lugar de dos
- `app/actions/events.ts → setPetLostAction` (ajuste mínimo si cambia el nombre del field) — verificar y actualizar si necesario
- Tests: unit del rate limiter, unit del parser de Nominatim, integration del action con fetch mockeado

**Fuera:**
- Cache server-side de queries (defer hasta que rate-limit sea issue)
- Self-host Nominatim
- Autocomplete-while-typing (suggestions dropdown en cada keystroke)
- Migración de otros forms (vet visit, intake, etc.) — solo MarkLostForm en este PR. Otros forms se migran cuando se los toque por otra razón
- Map de orgs cercanas en discovery — feature separado
- Cualquier change a `LocationFields` mode="jurisdiction" — solo mode="point" se toca
- Cualquier change a schema, RLS, eventos. Es UX puro
- Address structured (street, number, etc.) — solo free text

## 4. Plan paso a paso

### Paso 1 — Server action de geocoding

Crear `app/actions/geocoding.ts`:

```ts
"use server";

// Server-side proxy to Nominatim/OSM for forward and reverse geocoding.
// Wraps the Nominatim API with a per-instance rate limiter (token bucket,
// 5 req/sec) and a stable User-Agent (Nominatim usage policy requirement).
//
// CRITICAL: per the privacy decision D10 in the spec, we do NOT log
// user-supplied query strings. We log only error type and rate-limit hits.
// Do not console.log queries even for debugging in production code.

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const USER_AGENT = "MiMAR/1.0 (https://mimar.ar; contacto: <maintainer contact>)";
const RATE_LIMIT_PER_SECOND = 5;
const REQUEST_TIMEOUT_MS = 8000;

export type GeocodeResult = {
  lat: number;
  lng: number;
  display_name: string;
  province: string | null;
  locality: string | null;
};

export type ReverseGeocodeResult = {
  display_name: string;
  province: string | null;
  locality: string | null;
};

export type GeocodeBias = {
  province?: string | null;
  locality?: string | null;
};

// Token bucket — per-instance. In serverless this is per-warm-instance.
// Worst case (cold start spike) we may briefly exceed but Nominatim
// tolerance + our caller-side debounce keep this fine for v1 traffic.
let bucketTokens = RATE_LIMIT_PER_SECOND;
let bucketLastRefill = Date.now();

function checkRateLimit(): boolean {
  const now = Date.now();
  const elapsedSec = (now - bucketLastRefill) / 1000;
  bucketTokens = Math.min(RATE_LIMIT_PER_SECOND, bucketTokens + elapsedSec * RATE_LIMIT_PER_SECOND);
  bucketLastRefill = now;
  if (bucketTokens >= 1) {
    bucketTokens -= 1;
    return true;
  }
  return false;
}

export async function geocodeAddressAction(
  query: string,
  bias?: GeocodeBias,
): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  if (!checkRateLimit()) {
    console.warn("[geocoding] rate limit hit (forward)");
    throw new Error("rate_limited");
  }

  // Build query: append locality + province as hints to the user's query.
  // Don't overwrite — the user query stays primary. Nominatim handles fuzzy
  // matching well. Country is enforced via countrycodes=ar param.
  const biasParts: string[] = [];
  if (bias?.locality) biasParts.push(bias.locality);
  if (bias?.province) biasParts.push(bias.province);
  const effectiveQuery = [trimmed, ...biasParts].join(", ");

  const url = new URL(`${NOMINATIM_BASE}/search`);
  url.searchParams.set("q", effectiveQuery);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycodes", "ar");
  url.searchParams.set("accept-language", "es");

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    response = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    console.error("[geocoding] fetch failed (forward):", err instanceof Error ? err.name : "unknown");
    throw new Error("fetch_failed");
  }

  if (!response.ok) {
    console.error("[geocoding] non-2xx (forward):", response.status);
    throw new Error("provider_error");
  }

  const raw = (await response.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
    address?: Record<string, string | undefined>;
  }>;

  return raw.map((r) => ({
    lat: Number.parseFloat(r.lat),
    lng: Number.parseFloat(r.lon),
    display_name: r.display_name,
    province: r.address?.state ?? null,
    locality: r.address?.city ?? r.address?.town ?? r.address?.suburb ?? r.address?.village ?? null,
  })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

export async function reverseGeocodeAction(
  lat: number,
  lng: number,
): Promise<ReverseGeocodeResult | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  if (!checkRateLimit()) {
    console.warn("[geocoding] rate limit hit (reverse)");
    return null;
  }

  const url = new URL(`${NOMINATIM_BASE}/reverse`);
  url.searchParams.set("lat", lat.toFixed(7));
  url.searchParams.set("lon", lng.toFixed(7));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "es");

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    response = await fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    console.error("[geocoding] fetch failed (reverse):", err instanceof Error ? err.name : "unknown");
    return null;
  }

  if (!response.ok) {
    if (response.status === 404) return null;
    console.error("[geocoding] non-2xx (reverse):", response.status);
    return null;
  }

  const raw = (await response.json()) as {
    display_name?: string;
    address?: Record<string, string | undefined>;
  };

  if (!raw.display_name) return null;

  return {
    display_name: raw.display_name,
    province: raw.address?.state ?? null,
    locality: raw.address?.city ?? raw.address?.town ?? raw.address?.suburb ?? raw.address?.village ?? null,
  };
}
```

**Notas para Claude Code al implementar esto:**

- El `USER_AGENT` puede necesitar ajuste — chequear si en `package.json` hay un campo de contacto del owner o repo URL más apropiado. La forma "Nombre/Versión (URL; contacto)" es el patrón estándar
- Tests unit cubren: rate limiter (refill correcto, agotamiento), parser (handles missing address.state, falls back through city→town→suburb→village), error cases (timeout, 5xx, malformed JSON)
- Tests integration con fetch mockeado: forward returns array; reverse returns object o null; rate limit throws/returns null según el caso
- **NO testear contra Nominatim real en CI**. Mock siempre

### Paso 2 — Refactor de `LocationFields` mode="point"

Read primero el archivo actual `components/LocationFields.tsx`. Identificá:

- La firma actual del componente (props discriminadas por mode)
- Cómo expone el mapa (probablemente MapLibre via un wrapper)
- Cómo emite cambios (probablemente hidden inputs `locationLat` / `locationLng` que el form lee)

Cambios al componente:

**Paso 2.1 — extender las props de mode="point":**

```tsx
type PointModeProps = {
  mode: "point";
  defaultValue?: {
    lat?: number | null;
    lng?: number | null;
    description?: string | null;
  };
  // Bias the geocoder to the pet's jurisdiction
  biasProvince?: string | null;
  biasLocality?: string | null;
  // Hidden input names (defaults: locationLat, locationLng, locationDescription)
  inputNames?: {
    lat?: string;
    lng?: string;
    description?: string;
  };
};
```

**Paso 2.2 — agregar text input arriba del mapa.** Layout vertical:

```
[ Text input (con loading indicator y error state) ]
[ Map con pin draggable ]
[ Hidden inputs: locationLat, locationLng, locationDescription ]
```

**Paso 2.3 — estado interno del componente:**

```tsx
const [description, setDescription] = useState<string>(defaultValue?.description ?? "");
const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(
  defaultValue?.lat && defaultValue?.lng
    ? { lat: defaultValue.lat, lng: defaultValue.lng }
    : null,
);
const [loading, setLoading] = useState<"none" | "forward" | "reverse">("none");
const [results, setResults] = useState<GeocodeResult[]>([]);
const [error, setError] = useState<"empty" | "failed" | null>(null);

// Programmatic-change flag: when one side updates the other, prevent the
// other from triggering a feedback loop.
const skipNextEffect = useRef<"none" | "forward" | "reverse">("none");
```

**Paso 2.4 — debounce forward effect:**

```tsx
useEffect(() => {
  if (skipNextEffect.current === "forward") {
    skipNextEffect.current = "none";
    return;
  }
  if (description.trim().length < 3) {
    setResults([]);
    setError(null);
    return;
  }

  const timer = setTimeout(async () => {
    setLoading("forward");
    setError(null);
    try {
      const r = await geocodeAddressAction(description, {
        province: biasProvince,
        locality: biasLocality,
      });
      if (r.length === 0) {
        setResults([]);
        setError("empty");
      } else {
        setResults(r);
        // Auto-place pin on top result
        skipNextEffect.current = "reverse";
        setCoords({ lat: r[0].lat, lng: r[0].lng });
      }
    } catch {
      setError("failed");
    } finally {
      setLoading("none");
    }
  }, 600);

  return () => clearTimeout(timer);
}, [description, biasProvince, biasLocality]);
```

**Paso 2.5 — reverse effect (on pin drag/click):**

```tsx
// Handler para el evento del mapa (drag end o click). Esto reemplaza
// el handler actual que probablemente solo setea coords.
async function handleMapPointChange(newCoords: { lat: number; lng: number }) {
  if (skipNextEffect.current === "reverse") {
    skipNextEffect.current = "none";
    setCoords(newCoords);
    return;
  }
  setCoords(newCoords);
  setLoading("reverse");
  setError(null);
  try {
    const r = await reverseGeocodeAction(newCoords.lat, newCoords.lng);
    if (r) {
      skipNextEffect.current = "forward";
      setDescription(r.display_name);
    } else {
      setError("empty");
    }
  } catch {
    setError("failed");
  } finally {
    setLoading("none");
  }
}
```

**Paso 2.6 — UI states:**

```tsx
return (
  <div className="space-y-2">
    <div className="relative">
      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Ej: Plaza Italia, Palermo"
        className="..."
      />
      {loading === "forward" && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-neutral-500">Buscando...</span>
      )}
      {loading === "reverse" && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-neutral-500">Identificando...</span>
      )}
    </div>

    {results.length > 1 && (
      <ul className="border rounded-lg divide-y bg-white text-sm">
        {results.map((r, idx) => (
          <li key={idx}>
            <button
              type="button"
              onClick={() => {
                skipNextEffect.current = "reverse";
                setDescription(r.display_name);
                skipNextEffect.current = "reverse"; // re-set after description triggers
                setCoords({ lat: r.lat, lng: r.lng });
                setResults([]);
              }}
              className="block w-full text-left px-3 py-2 hover:bg-neutral-50"
            >
              {r.display_name}
            </button>
          </li>
        ))}
      </ul>
    )}

    {error === "empty" && (
      <p className="text-xs text-neutral-600 dark:text-neutral-400">
        No encontramos esa dirección. Podés moverte por el mapa.
      </p>
    )}
    {error === "failed" && (
      <p className="text-xs text-amber-700 dark:text-amber-400">
        No pudimos buscar la dirección ahora. Tipeá lo que sepas y movete por el mapa.
      </p>
    )}

    <div className="rounded-lg overflow-hidden border border-neutral-200 dark:border-neutral-800">
      {/* MapPicker existing component, with handleMapPointChange wired up */}
      <MapPicker
        center={coords ?? defaultCenter}
        marker={coords}
        onChange={handleMapPointChange}
      />
    </div>

    <input type="hidden" name={inputNames?.description ?? "locationDescription"} value={description} />
    <input type="hidden" name={inputNames?.lat ?? "locationLat"} value={coords?.lat ?? ""} />
    <input type="hidden" name={inputNames?.lng ?? "locationLng"} value={coords?.lng ?? ""} />
  </div>
);
```

**Paso 2.7 — la lógica de `skipNextEffect` es crítica.** Sin esto, cuando reverse-geocoding setea `description`, el `useEffect` del forward dispara y vuelve a buscar — loop infinito. El flag previene esto. Tests unitarios deberían cubrir el caso de "auto-fill no triggea re-search".

**Paso 2.8 — mode="jurisdiction" no se toca.** Mantener esa rama del componente intacta.

### Paso 3 — Migrar `MarkLostForm`

Read primero `app/(app)/mis-mascotas/[publicToken]/perdida/MarkLostForm.tsx`. Identificá:

- El input separado `lastKnownLocation` (text)
- El widget `<LocationFields mode="point" />`
- El form action y los nombres de los fields que envía

Cambios:

**Paso 3.1 — eliminar el input separado** `lastKnownLocation`. Si el form pasa la prop `pet` o equivalente con jurisdicción, usá esos valores como bias.

**Paso 3.2 — extender el `LocationFields` montado:**

```tsx
<LocationFields
  mode="point"
  biasProvince={pet.jurisdictionProvince}
  biasLocality={pet.jurisdictionLocality}
  inputNames={{
    lat: "locationLat",
    lng: "locationLng",
    description: "lastKnownLocation", // mantener el nombre que el server action ya lee
  }}
/>
```

**Paso 3.3 — verificar `setPetLostAction`.** En `app/actions/events.ts`, leé cómo procesa hoy `lastKnownLocation` y `locationLat`/`locationLng`. Probablemente:

- Mapea `lastKnownLocation` → `payload.location_description`
- Mapea `locationLat`/`locationLng` → `petEvents.locationLat`/`locationLng`

No requiere cambios — el form sigue enviando los mismos field names. **Verificá explícitamente** que es así.

**Paso 3.4 — el form pasa `pet` al componente.** El page `app/(app)/mis-mascotas/[publicToken]/perdida/page.tsx` ya tiene `pet` cargado para validar ownership. Pasalo como prop al `MarkLostForm` si no lo hace ya, y el form lo usa para el bias.

### Paso 4 — Tests

Crear `__tests__/geocoding.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch before import
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { geocodeAddressAction, reverseGeocodeAction } from "@/app/actions/geocoding";

describe("geocodeAddressAction (forward)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("returns empty for query under 3 chars", async () => {
    expect(await geocodeAddressAction("ab")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns parsed results on success", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          lat: "-34.583",
          lon: "-58.421",
          display_name: "Plaza Italia, Palermo, CABA",
          address: { state: "Buenos Aires", city: "Palermo" },
        },
      ],
    });
    const r = await geocodeAddressAction("Plaza Italia");
    expect(r).toHaveLength(1);
    expect(r[0].lat).toBeCloseTo(-34.583);
    expect(r[0].lng).toBeCloseTo(-58.421);
    expect(r[0].province).toBe("Buenos Aires");
    expect(r[0].locality).toBe("Palermo");
  });

  it("falls through address fields city→town→suburb→village", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          lat: "-34", lon: "-58",
          display_name: "Some place",
          address: { state: "X", village: "VillageName" },
        },
      ],
    });
    const r = await geocodeAddressAction("test");
    expect(r[0].locality).toBe("VillageName");
  });

  it("throws on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(geocodeAddressAction("test")).rejects.toThrow("provider_error");
  });

  it("throws on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("net"));
    await expect(geocodeAddressAction("test")).rejects.toThrow("fetch_failed");
  });

  it("appends bias locality and province to query", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await geocodeAddressAction("Plaza", { locality: "Belgrano", province: "AR-C" });
    const call = fetchMock.mock.calls[0][0] as string;
    const url = new URL(call);
    expect(url.searchParams.get("q")).toBe("Plaza, Belgrano, AR-C");
  });
});

describe("reverseGeocodeAction", () => {
  beforeEach(() => fetchMock.mockReset());

  it("returns null on invalid coords", async () => {
    expect(await reverseGeocodeAction(NaN, 0)).toBeNull();
    expect(await reverseGeocodeAction(91, 0)).toBeNull();
    expect(await reverseGeocodeAction(0, 181)).toBeNull();
  });

  it("returns parsed display_name on success", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        display_name: "Plaza Italia, Palermo, CABA",
        address: { state: "Buenos Aires", city: "Palermo" },
      }),
    });
    const r = await reverseGeocodeAction(-34.583, -58.421);
    expect(r?.display_name).toBe("Plaza Italia, Palermo, CABA");
    expect(r?.province).toBe("Buenos Aires");
    expect(r?.locality).toBe("Palermo");
  });

  it("returns null on 404", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    expect(await reverseGeocodeAction(0, 0)).toBeNull();
  });

  it("returns null on missing display_name", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    expect(await reverseGeocodeAction(0, 0)).toBeNull();
  });
});

describe("rate limiter", () => {
  beforeEach(() => fetchMock.mockReset());

  it("allows initial burst up to RATE_LIMIT", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    // 5 quick calls should all succeed (token bucket size = 5)
    for (let i = 0; i < 5; i++) {
      await expect(geocodeAddressAction("test query " + i)).resolves.toBeDefined();
    }
  });

  it("rejects when bucket exhausted", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    // Drain the bucket (5 calls)
    for (let i = 0; i < 5; i++) await geocodeAddressAction("warm " + i);
    // 6th call should hit rate limit
    await expect(geocodeAddressAction("blocked")).rejects.toThrow("rate_limited");
  });
});
```

**Importante:** los tests del rate limiter pueden tener interdependencia (el bucket es module-level state). Si vitest corre tests en paralelo o en el mismo proceso, puede haber flakiness. Mitigación: agregar `beforeEach` que reset el bucket vía export interno, o aceptar que el orden importa. Para v1 OK ser pragmático.

### Paso 5 — Smoke manual end-to-end

`pnpm dev`. Login como owner con al menos un pet con jurisdicción seteada. Navegar a `/mis-mascotas/{token}/perdida`.

Casos a probar:

- **Forward feliz:** tipear "Plaza Italia" → esperar 600ms → mapa centra en Palermo, pin dropea, dropdown opcional con resultados
- **Forward sin match:** tipear "asdfasdf" → mensaje "No encontramos esa dirección"
- **Forward con bias:** tipear "Plaza Italia" con pet en CABA — top result debería ser Palermo (no Mendoza o Córdoba)
- **Reverse feliz:** mover el pin a una calle conocida → text input se actualiza con el display_name
- **Reverse en agua:** mover el pin al Río de la Plata → mensaje "No pudimos identificar esa ubicación", text se mantiene
- **Submit:** llenar el form completo, submit → verificar en Studio que el evento `status_changed → lost` tiene `payload.location_description` (text) y `locationLat`/`locationLng` (coords) correctos
- **Edit mode con coords pre-cargadas:** ir a editar el evento o verificar otro contexto — el reverse NO debería disparar al mount inicial (D8)
- **Sin red:** desconectar wifi, tipear algo, esperar timeout → mensaje "No pudimos buscar la dirección ahora", form sigue submittable manualmente

## 5. Verificación final

1. `pnpm typecheck` cero errores
2. `pnpm lint` cero errores nuevos
3. `pnpm test` todos verdes (los nuevos tests + los existentes)
4. `pnpm build` compila
5. Smoke manual del paso 5 — todos los casos pasan
6. Verificar que **no hay refs a Nominatim en logs de producción con queries del usuario**. Tail de logs durante el smoke debería mostrar solo errores y rate-limit hits, NO queries
7. Existing flows no rotos:
   - El otro form que use `LocationFields mode="jurisdiction"` (probablemente `PetForm` o equivalente) sigue funcionando idéntico
   - `MarkLostForm` con el field viejo `lastKnownLocation` removido sigue submitiendo OK

## 6. Casos borde

- **El bucket de rate limit es module-level state.** En Next.js serverless cada función puede vivir en una instance distinta, así que el limit es per-instance. Con tráfico v1 esto es fine. Si en producción se ve que Nominatim devuelve 429, el primer paso es mover el rate limit a Redis. Anotado pero no implementado
- **El usuario tipea texto que no es dirección** (e.g., "puerta de casa azul"): geocoder returna [] → mostrar empty state. El texto se persiste igual cuando se submitea el form. Para el dueño esto es feature, no bug — quiere registrar contexto que no es geocodificable
- **Coords pre-cargadas en edit mode:** el `defaultValue.lat/lng` pone el pin inicial pero NO dispara reverse (skipNextEffect.current = "reverse" en el init). Esto es D8
- **Description pre-cargado con texto largo:** el debounce arranca al primer render si description.length >= 3. Pero el bias del pet probablemente devuelve el mismo display_name que ya está cargado, así que la sync no rompe nada. Si quisieras evitar la llamada inicial, podés setear skipNextEffect.current = "forward" en el primer render
- **MapPicker existing wrapper:** si el componente actual del map no expone un `onChange` callback con coords, necesitás extenderlo. El cambio debería ser localizado al wrapper, no a MapLibre directamente
- **Tests flaky por bucket compartido:** si pasa, soluciones (en orden de preferencia): (a) exportar una función `resetRateLimitBucketForTests()` que solo se llama en beforeEach, (b) aceptar el orden de tests, (c) split en suites separadas
- **`description` con caracteres especiales (UTF-8, emojis):** `URLSearchParams.set` los encodea correctamente. No requiere handling especial
- **Submit con coords pero sin description (usuario solo dropea pin sin esperar reverse):** el form persiste lat/lng + description vacío. Aceptable — el reverse no es bloqueante

## 7. Cuando termines

1. Marcá los chequeos de §5 como hechos
2. Reportá a Nacho:
   - Resultados del smoke manual (cuáles casos pasaron, si alguno reveló bug)
   - Tests passing count
   - Si cambiaste algo del spec (e.g., field names del form son distintos a lo que asumió el spec), documentalo en el reporte
3. Commit message sugerido:
   ```
   feat(geocoding): bidirectional sync between location text and map pin

   New server action app/actions/geocoding.ts: server-side proxy to
   Nominatim/OSM with stable User-Agent, per-instance token-bucket rate
   limiter (5 req/sec), forward and reverse geocoding. Per spec D10, the
   server does NOT log user-supplied query strings — only error type
   and rate-limit hits.

   Refactor components/LocationFields.tsx mode="point" to integrate the
   address text input alongside the map pin. Typing into the text field
   (debounced 600ms) triggers forward geocoding, which centers the map
   and drops the pin. Dragging/clicking the map triggers reverse
   geocoding, which fills the text field. Both fields remain editable;
   the sync is soft via a skip-next-effect flag that prevents
   feedback loops.

   Graceful degradation: if Nominatim fails or returns empty, the form
   continues working with text + pin as independent fields (the
   pre-existing behavior).

   Migrates MarkLostForm to use the integrated LocationFields. Removes
   the separate lastKnownLocation text input. Form still submits the
   same field names (locationLat, locationLng, lastKnownLocation) so
   setPetLostAction does not require changes.

   Tests cover forward/reverse parsing, error cases, rate limiter, bias
   query construction. Fetch is mocked in CI; no real Nominatim hits.

   No DB changes, no RLS changes, no migration. UX-only feature.

   See docs/superpowers/specs/2026-05-17-bidirectional-geocoding-design.md.
   ```
4. Marcar en `docs/superpowers/README.md` que este plan está completo (cambiar el status a ✅ Implementado en la tabla correspondiente)

## 8. Lo que viene después (no en este PR)

- Si Nominatim rate-limit se vuelve issue real en producción → mover el bucket a Redis o agregar caching server-side de queries (TTL ~24h)
- Si el volumen justifica → self-host Nominatim con docker image, eliminando dependencia externa
- Migrar otros forms a usar `LocationFields` integrado:
  - Forms futuros de scheduling (al crear slots con ubicación específica)
  - Forms futuros de lost-and-found (vecino registrando dónde encontró)
  - Welfare report form si tiene captura de ubicación
- Considerar agregar autocomplete-while-typing (suggestions dropdown en cada keystroke, no solo al debounce final) — distinto de geocoding, más caro
