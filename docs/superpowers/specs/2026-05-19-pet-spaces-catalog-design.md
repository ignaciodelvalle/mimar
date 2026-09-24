# Catálogo de espacios para mascotas — design spec

> Cataloga los lugares físicos relevantes para la vida cotidiana de una mascota — caniles públicos, postas de vacunación, refugios, veterinarias, pet shops, crematorios, cementerios y centros municipales de manejo animal — y los expone a los owners como un mapa filtrable en la app. Datos curados por admin en v1 (seed con los 113 "Espacios para Mascotas" del GCBA + las sedes de Mascotas CABA), transferibles al govt scoped por jurisdicción cuando madure, con un canal de auto-postulación para que cualquier organización verificada solicite aparecer en el mapa con su ubicación exacta y disclosure prefs propias. Es **informativo** — no genera eventos en `pet_events`. Resuelve un agujero conocido: hoy el owner abre la app y no encuentra dónde llevar a su perro a correr suelto, dónde vacunarlo gratis, ni a qué refugio recurrir si su mascota muere.
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Estado:** 🟡 Spec only — pending review + plan
> **Versión:** 1.0

### Changelog

| Versión | Fecha | Cambios |
|---|---|---|
| v1.0 | 2026-05-19 | Versión inicial. Catálogo polimórfico con 7 `kind`s en v1, surfaces owner-only, ownership híbrido admin-seed → govt-curation → org self-request, sin event_types nuevos (informativo puro). |

---

## 1. Por qué este documento existe

El owner abre MiMAR y la pregunta más obvia del día a día — *¿a dónde voy con mi mascota?* — no tiene respuesta dentro del app. Hoy responde Google Maps, foros de Facebook, el feed del gobierno porteño, o nadie. Tres consecuencias:

1. **Pierde valor de adopción.** Un PWA que solo registra eventos médicos no es lo bastante útil para que el owner lo abra cada semana. Un mapa con caniles cercanos + vacunatorios gratuitos + refugios verificados sí lo es. Es retention layer, no feature extra.
2. **Desperdicia data ya pública.** El GCBA mantiene la lista de los 113 espacios para mascotas con direcciones precisas, las sedes de Mascotas CABA están publicadas, los refugios verificados de la red DIM ya están en `organizations`. Importar y mostrarlas es horas de trabajo, no semanas.
3. **Rompe el North Star.** Si el owner no sabe a dónde llevar su mascota a vacunar gratis, las campañas de antirrábica del govt no llegan a la población, y los dashboards de cobertura van a mostrar el mismo 6% de gatos sin antirrábica que mostraba la EAH 2018. El mapa es la última milla del flow "el govt programa campaña → owner se entera → owner aparece".

Este spec define el catálogo (tabla + atributos + ownership), las surfaces owner-facing (mapa filtrable + cards + detalle de cada espacio), el flujo de auto-postulación de organizaciones para aparecer en el mapa, y la semilla inicial CABA. **No** registra visitas ni cambia el event log.

## 2. Decisiones cerradas (confirmadas con Nacho 2026-05-19)

| # | Decisión | Razón |
|---|---|---|
| D1 | **Tabla única `pet_spaces` polimórfica con campo `kind`** en lugar de N tablas separadas por tipo de lugar | Los atributos comunes (nombre, geo, jurisdicción, horarios, contacto, status) cubren ~80% del modelo. Los atributos específicos por kind viven en un campo `attributes jsonb` con Zod schema por kind. Un solo índice GIST, un solo RLS set, un solo typeahead. Si un kind crece complicado más adelante, se promueve a tabla propia sin breaking change |
| D2 | **Catálogo es informativo. Visitar un espacio NO genera evento en `pet_events`** | Confirmado con Nacho. El catálogo es referencia, no parte del event log. La consecuencia operativa: no hay schema delta a event-schemas.ts, no hay nuevo capability, no hay nuevo case-attachment rule. v2 puede agregar `pet_space_visited` event si el dato resulta valioso para dashboards govt — pero no estira el primer PR |
| D3 | **7 `kind`s en v1**: `public_pet_space`, `vaccination_point`, `shelter`, `vet_clinic`, `pet_store`, `crematorium`, `pet_cemetery`, `municipal_pet_handling_facility` | Cubre la grilla operativa de la vida de una mascota: ejercicio (canil) → atención preventiva (vacunación) → atención clínica (vet) → emergencia/perdido (refugio) → consumo (pet shop) → fin de vida (crematorio/cementerio) → manejo institucional (zoonosis municipal). La octava categoría sensible (`municipal_pet_handling_facility`) entra con disclaimer obligatorio — ver D14 |
| D4 | **`kind`s `shelter` y `vet_clinic` referencian `organizations` vía FK opcional**, no duplican el dato. Los demás kinds no tienen FK a orgs | Una org verificada que es un refugio ya tiene su `legal_name`, `jurisdiction_*`, `verified=true`. Cuando se lista en el mapa, la row de `pet_spaces` lleva `organization_id` apuntando a esa org y deriva nombre/jurisdicción de ahí. Permite renderizar la card con el badge "verified" oficial. Los caniles y los crematorios NO son orgs DIM — viven solo en `pet_spaces` con sus datos propios |
| D5 | **Ownership híbrida en v1: admin seedea, govt cura, org se auto-postula** | Tres caminos coexisten: (a) admin importa el seed inicial CABA vía script; (b) govts con scope sobre la jurisdicción del espacio editan/agregan/dan de baja; (c) cualquier org verificada inicia un `approval_request` tipo `map_listing_request` para aparecer con su ubicación exacta. Owners NO pueden crear espacios — solo reportar inexactitud (D11) |
| D6 | **Surface owner-facing es 100% interna a la app**: `/inicio` widget mini + `/mis-mascotas/espacios` mapa completo + `/mis-mascotas/espacios/[publicToken]` detalle | Confirmado con Nacho: el mapa vive dentro del app, requiere login. Mantiene la regla "owner-facing en `/(app)/mis-mascotas/*`" del actual layout. No se publica versión `/p/`-style hasta tener un caso de uso claro de exposición pública (v2+) |
| D7 | **Stack de mapa = MapLibre + OpenStreetMap** ya canónico en el repo (AGENTS.md → Stack). Tiles vía proxy server-side. Token bucket compartido con el de geocoding | Ya está montado para `LocationFields` mode="point" y `LocationPicker`. Reusamos el componente base y agregamos modo "many-markers + clustering" sin tocar el resto |
| D8 | **Filtrado por jurisdicción con cascada**: comuna/barrio CABA > localidad > provincia > "todo el país". Default = jurisdicción del owner derivada de su pet activa (o "CABA" si no tiene pet con jurisdicción seteada) | Coherente con `LocalityCombobox` y el modelo INDEC. Owner en Mataderos ve por default los espacios de Comuna 9; toggle expande a CABA, AMBA, o nacional |
| D9 | **Geometría: punto + radio efectivo opcional**. `latitude`/`longitude` + `effective_radius_m` (nullable) | v1 representa los espacios como puntos en el mapa con tooltip. Algunos espacios (Parque Centenario tiene 3 caniles distintos) se modelan como 3 rows separadas con coordenadas distintas — más simple y más útil que polígonos. `effective_radius_m` opcional para casos donde "el canil ocupa media manzana" da contexto visual al renderizar buffer en el mapa |
| D10 | **Auto-postulación de organizaciones: nuevo `approval_request.type='map_listing_request'`** | Reusa la infra existente. Aprobada por govt scope-matching (jurisdiction) o admin fallback. La org sube evidencia opcional (foto del frente, comprobante de domicilio) en `approval_evidence`. Al aprobar: server materializa una row en `pet_spaces` con `organization_id` apuntando a la org y `kind` derivado de `org.org_type` (`clinic` → `vet_clinic`, `shelter` → `shelter`, `rescue_network` → `shelter` también) |
| D11 | **Owner puede reportar inexactitud de un espacio existente** vía botón "Sugerir corrección" en `/mis-mascotas/espacios/[publicToken]`. NO puede crear ni editar directamente. Las correcciones llegan como un `approval_request.type='pet_space_correction'` que decide el govt scoped | Defense en profundidad. Owners son la población con más eyes-on-the-ground; capturar su input sin convertir al mapa en wiki abierto. El govt revisa, decide, audit |
| D12 | **Mismo paradigma del lost-and-found: el espacio tiene su propio `publicToken`** formato `SPC-XXXX-XXXX` | Permite links profundos (`/mis-mascotas/espacios/SPC-XXXX-XXXX`), referencias futuras desde dashboards de campañas/scheduling, y compartir un espacio específico por chat sin exponer IDs internos. Formato análogo a `DIM-XXXX-XXXX` (publicToken de pets) y `MIM-XXXX` (welfare report code) |
| D13 | **Status = `active`, `provisional`, `archived`, `disputed`**. Renderizado en mapa: `active` siempre, `provisional` con badge "Por verificar", `archived` solo admin, `disputed` **visible con badge "En revisión" para todos** mientras se resuelve (Q7 cerrada) | El catálogo se mantiene fresco distinguiendo lo verificado de lo pendiente sin descartar reportes. Owners ven los reportes en flight con transparencia (badge visible) — coherente con cómo orgs no-verified ya aparecen con disclaimer. GCBA puede cerrar un canil; admin/govt lo pasa a `archived`, deja de aparecer en el mapa pero la row sobrevive para audit y para evitar re-creación |
| D14 | **`municipal_pet_handling_facility` (zoonosis / perreras municipales) renderiza con disclaimer obligatorio** explicando que es facilidad oficial de manejo animal según ordenanzas locales, con anclaje legal Ley 14.346 + ordenanzas municipales. Owner NO puede recomendarlas con corazoncito | Categoría sensible en AR. Históricamente las perreras municipales tienen mala reputación; no podemos ocultarlas (existen, son data oficial, los owners necesitan saber dónde están si su mascota perdida llega ahí) pero tampoco podemos presentarlas como "lugar amigable para llevar a tu pet". Disclaimer + ausencia de reacciones owner = balance honesto. Anclaje legal evita ambigüedad |
| D15 | **`pet_spaces.attributes` validado con Zod por kind** — schema discriminado en `lib/pet-space-schemas.ts` similar al patrón de `event-schemas.ts`. Una `validatePetSpaceAttributes(kind, attrs)` que se llama en cada write | Mismo defensivo que event payloads. Si un day-1 govt mete un atributo extra, falla loud. Si necesitamos agregar atributo a un kind, se versiona el schema y se migra como cualquier otro |
| D16 | **El mapa NO tracking owners por defecto.** Posición del owner solo se usa para centrar el mapa, no se persiste. `navigator.geolocation` con prompt explícito; si lo niega, default = centroide de la jurisdicción del pet activa | Privacidad. El mapa no necesita saber quién está dónde para servir caniles cercanos. AGENTS.md → privacy principles cubre esto |

## 3. Glosario

| Término | Qué es | Vive en |
|---|---|---|
| **Espacio (pet space)** | Lugar físico relevante para mascotas. Una row de `pet_spaces` | Tabla `pet_spaces` |
| **`kind`** | Tipo de espacio. Enum de 7 valores en v1. Determina qué atributos válidos lleva la row | `pet_spaces.kind` |
| **`publicToken`** del espacio | Identificador URL-safe `SPC-XXXX-XXXX`. Equivalente al `publicToken` de pets, pero para espacios | `pet_spaces.public_token` |
| **`attributes jsonb`** | Atributos específicos por kind. Schema validado por Zod en `lib/pet-space-schemas.ts` | `pet_spaces.attributes` |
| **`effective_radius_m`** | Radio en metros (opcional) para contextualizar visualmente espacios grandes (parques) en el mapa | `pet_spaces.effective_radius_m` |
| **Auto-postulación** | Flujo de org verificada que solicita aparecer en el mapa. Crea un `approval_request.type='map_listing_request'` | Server action |
| **Corrección sugerida por owner** | Flujo de owner que reporta inexactitud sobre un espacio existente. Crea `approval_request.type='pet_space_correction'` | Server action |
| **Disclaimer institucional** | Banner obligatorio en kinds sensibles (`municipal_pet_handling_facility`) | UI condicional |
| **Mascotas CABA** | Programa GCBA de atención veterinaria gratuita. Sus sedes son la semilla inicial del kind `vaccination_point` | Seed data |

## 4. Domain model

### 4.1 Tabla `pet_spaces`

```sql
create table pet_spaces (
  id                    uuid primary key default gen_random_uuid(),
  public_token          text not null unique,                  -- "SPC-3F9A-K7XQ"

  -- Type discriminator
  kind                  text not null,                         -- see CHECK constraint below

  -- Identity
  display_name          text not null,                         -- "Plaza Lavalle", "Mascotas CABA — Comuna 4"
  description           text,                                  -- free text, owner-facing card subtitle

  -- Geometry
  latitude              numeric(10, 7) not null,
  longitude             numeric(10, 7) not null,
  effective_radius_m    integer,                               -- optional; null = point-only

  -- Address (mirrors LocationFields shape)
  address_line          text not null,                         -- "Talcahuano 678"
  address_locality      text not null,                         -- "San Nicolás" (CABA barrio) or "La Plata"
  address_province      text not null,                         -- "AR-C", "AR-B", etc. (ISO 3166-2:AR)
  address_country       text not null default 'AR',
  ar_locality_id        uuid references ar_localities(id),     -- canonical FK when matched

  -- Operational
  status                text not null default 'active',
  attributes            jsonb not null default '{}'::jsonb,    -- validated per kind by Zod
  opening_hours         jsonb,                                 -- per-day structure, see §4.3
  contact               jsonb,                                 -- phone, email, social (optional)

  -- Provenance / ownership
  source                text not null default 'admin_seed',    -- 'admin_seed' | 'govt_curated' | 'org_self_request' | 'corrected'
  organization_id       uuid references organizations(id) on delete set null,  -- nullable; only for shelter/vet_clinic
  created_by_user_id    uuid references profiles(id),
  approved_by_user_id   uuid references profiles(id),
  approved_at           timestamptz,

  -- Lifecycle
  archived_at           timestamptz,
  archived_reason       text,
  disputed_at           timestamptz,
  disputed_by_user_id   uuid references profiles(id),
  disputed_reason       text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint pet_spaces_kind_valid check (kind in (
    'public_pet_space',
    'vaccination_point',
    'shelter',
    'vet_clinic',
    'pet_store',
    'crematorium',
    'pet_cemetery',
    'municipal_pet_handling_facility'
  )),
  constraint pet_spaces_status_valid check (status in ('active','provisional','archived','disputed')),
  constraint pet_spaces_source_valid check (source in ('admin_seed','govt_curated','org_self_request','corrected')),
  constraint pet_spaces_org_only_for_orgs check (
    organization_id is null
    or kind in ('shelter','vet_clinic','pet_store','vaccination_point','crematorium','pet_cemetery')
  ),
  constraint pet_spaces_radius_positive check (
    effective_radius_m is null or effective_radius_m > 0
  ),
  constraint pet_spaces_province_valid check (address_province ~ '^AR-[A-Z]$')
);

-- Indexes
create index pet_spaces_kind_idx       on pet_spaces (kind) where status = 'active';
create index pet_spaces_locality_idx   on pet_spaces (address_province, address_locality) where status = 'active';
create index pet_spaces_ar_locality_idx on pet_spaces (ar_locality_id) where status = 'active' and ar_locality_id is not null;
create index pet_spaces_org_idx        on pet_spaces (organization_id) where organization_id is not null;
create index pet_spaces_geo_idx        on pet_spaces using gist (
  ll_to_earth(latitude::float8, longitude::float8)
) where status = 'active';
create index pet_spaces_token_idx      on pet_spaces (public_token);
```

**Notas de schema:**

- `public_token` formato `SPC-XXXX-XXXX` generado por el helper análogo a `lib/publicToken.ts` (codename DIM intacto en pets; espacios estrenan prefijo `SPC` por "espacio"). Bumpear `lib/publicToken.ts` para soportar prefijos múltiples o crear `lib/spacePublicToken.ts` (decisión chica del plan).
- `attributes jsonb` valida server-side en cada write con `lib/pet-space-schemas.ts`. Ejemplo `public_pet_space`: `{ fenced: boolean, has_water: boolean, surface: 'grass'|'sand'|'mixed'|'paved', separated_small_large: boolean, lighting: 'none'|'partial'|'full', size_sqm?: number, rules: string[], allowed_breeds?: 'all'|'non_ppp' }`.
- `opening_hours jsonb` con shape `{ mon: { open: "06:00", close: "22:00", closed?: false }, tue: ..., ... , exceptions: [{ date: "2026-12-25", closed: true, note: "Navidad" }] }`. Permite "abierto 24h" (open=00:00, close=24:00) y "cerrado" (`closed: true`).
- `ar_locality_id` se popula cuando el script de seed (o el form de govt) matchea el address contra `ar_localities` — defense in depth para que el filtrado por jurisdicción siempre encuentre el espacio aunque alguien tipee mal el string.
- Índice GIST sobre `earthdistance` permite query `SELECT * FROM pet_spaces WHERE earth_distance(ll_to_earth(lat,lng), ll_to_earth($1, $2)) < $3 AND status='active'` en O(log n). Requiere extensión `earthdistance` + `cube` (Postgres core).

### 4.2 Tabla auxiliar `pet_space_attachments` (opcional v1)

Para fotos del espacio. Patrón análogo a `approval_evidence` pero con FK al espacio.

```sql
create table pet_space_attachments (
  id                  uuid primary key default gen_random_uuid(),
  pet_space_id        uuid not null references pet_spaces(id) on delete cascade,
  storage_path        text not null,                         -- Supabase Storage path
  caption             text,
  uploaded_by_user_id uuid references profiles(id),
  uploaded_at         timestamptz not null default now()
);

create index pet_space_attachments_space_idx on pet_space_attachments (pet_space_id);
```

**Stretch v1.** Empezamos sin fotos (basta el ícono por `kind` en el mapa). Si el tiempo lo permite, se incluye en la última fase.

### 4.3 Shape de `opening_hours`

```typescript
type OpeningHours = {
  mon: DaySchedule;
  tue: DaySchedule;
  wed: DaySchedule;
  thu: DaySchedule;
  fri: DaySchedule;
  sat: DaySchedule;
  sun: DaySchedule;
  exceptions?: Exception[];
  timezone?: string; // default "America/Argentina/Buenos_Aires"
};

type DaySchedule =
  | { closed: true }
  | { open: "HH:MM"; close: "HH:MM"; closed?: false; notes?: string };

type Exception = {
  date: string;       // "YYYY-MM-DD"
  closed?: boolean;
  open?: "HH:MM";
  close?: "HH:MM";
  note?: string;      // "Feriado nacional", "Mantenimiento"
};
```

Helper `lib/opening-hours.ts`:

- `isOpenNow(hours, when?: Date): boolean`
- `nextOpening(hours, from: Date): { date: Date, weekday: string } | null`
- `humanize(hours): string` → "Abierto hoy hasta las 22:00" / "Cierra hoy a las 18:00" / "Abre mañana a las 06:00"

### 4.4 Atributos por kind (`pet_spaces.attributes`)

Cada kind tiene su Zod schema en `lib/pet-space-schemas.ts`. Resumen v1:

**`public_pet_space`** (canil / plaza para mascotas)
```
{ fenced: boolean, has_water: boolean, surface: 'grass'|'sand'|'mixed'|'paved',
  separated_small_large: boolean, lighting: 'none'|'partial'|'full', size_sqm?: number,
  rules: string[], allowed_breeds?: 'all'|'non_ppp' }
```

**`vaccination_point`** (postas de antirrábica, Mascotas CABA, etc.)
```
{ services: ('antirabica'|'triple'|'sextuple'|'sterilization'|'consultation'|'other')[],
  free_of_charge: boolean, walk_in: boolean, requires_appointment: boolean,
  documentation_required: string[], program_name?: string }
```

**`shelter`** (refugio verificado o postulado a aparecer en mapa)
```
{ species_accepted: ('dog'|'cat'|'rabbit'|'guinea_pig'|'ferret'|'other')[],
  capacity?: number, adoption_open: boolean, intake_open: boolean,
  volunteer_program: boolean, foster_program: boolean }
```

**`vet_clinic`**
```
{ services: ('general'|'specialty'|'surgery'|'imaging'|'lab'|'emergency')[],
  emergency_24h: boolean, accepts_walk_in: boolean,
  specialties?: string[] }
```

**`pet_store`**
```
{ sells: ('food'|'accessories'|'grooming'|'toys')[],
  grooming_service: boolean, delivery: boolean }
```

**`crematorium`**
```
{ services: ('individual'|'communal')[], pickup_service: boolean,
  ash_return: boolean, species_accepted: ('dog'|'cat'|'rabbit'|'other')[],
  certificate_issued: boolean }
```

**`pet_cemetery`**
```
{ burial_types: ('individual_plot'|'communal'|'mausoleum')[],
  perpetual_care: boolean, religious_services_available: boolean }
```

**`municipal_pet_handling_facility`** (zoonosis / centro de manejo animal municipal)
```
{ functions: ('zoonosis_control'|'lost_pet_holding'|'mandatory_quarantine'|'rabies_observation'|'euthanasia'|'sterilization_campaign')[],
  legal_authority: string,   // "Decreto N° XXX/AAAA, Municipalidad de ..."
  contact_for_lost_pets: boolean,
  hold_period_days?: number,
  notes_for_owners?: string  // mostrar como disclaimer
}
```

Cada schema vive en `lib/pet-space-schemas.ts` con `petSpaceAttributesByKind = { public_pet_space: ZodSchema, ... }` y `validatePetSpaceAttributes(kind, attrs)`.

### 4.5 Relación con `organizations`

| Caso | `organization_id` | Source de `display_name` y datos |
|---|---|---|
| Canil GCBA (admin seed) | `null` | `pet_spaces.display_name` directo |
| Posta Mascotas CABA | `null` | `pet_spaces.display_name` (el programa, no una org DIM) |
| Refugio verificado que se auto-postula | FK a `organizations` | `display_name` deriva de `org.display_name` en el render, pero `pet_spaces.display_name` se persiste por si la org cambia nombre |
| Clínica vet que se auto-postula | FK a `organizations` | Idem |
| Centro municipal de zoonosis | `null` | Es entidad estatal, no `organization` DIM |

**Decisión**: `pet_spaces.display_name` se persiste siempre, incluso cuando hay `organization_id`. Es snapshot en el momento de aprobar la listing. Si el día de mañana la org cambia su nombre, el mapa se mantiene estable hasta que un govt re-edite el espacio. Evita ghost rows que cambian solas.

## 5. Surfaces y UX

### 5.1 `/inicio` widget mini "Cerca tuyo"

Top 4 espacios más cercanos al pet activo del owner. Card chiquita con:
- Ícono por kind
- Nombre + barrio
- Distancia ("a 350 m")
- Botón "Ver mapa" → `/mis-mascotas/espacios`

Esquina superior derecha: filtro toggle (íconos compactos de los 7 kinds; click toggle on/off; persiste en `localStorage` per user).

### 5.2 `/mis-mascotas/espacios` — mapa completo

Layout:
- Header con título "Espacios" + buscador (typeahead sobre `display_name` + `address_line`)
- Lado izquierdo (desktop) / drawer bottom (mobile): lista filtrada ordenada por distancia
- Centro: mapa MapLibre con marcadores clusterizados (uno por kind), tooltip al hover, click → side panel con detalle
- Filtros:
  - **Kind** (multi-select toggle, default todos activos)
  - **Jurisdicción** (`LocalityCombobox` reusado): default = jurisdicción del pet activa
  - **Distancia** (slider: 500 m / 1 km / 2 km / 5 km / "sin límite")
  - **Abierto ahora** (toggle, requiere `opening_hours` cargadas en la row)

Listado: card con ícono + display_name + barrio + chip de kind + 2-3 atributos destacados (ej. para canil: "Cercado", "Con agua"; para vacunatorio: "Antirrábica", "Gratis").

Estado vacío: "No hay espacios cerca con esos filtros. Probá ampliar la distancia o sacar filtros de kind." + sugerir el link "Sugerir agregar un espacio" (D11 reverso — owner reporta a govt que falta uno).

### 5.3 `/mis-mascotas/espacios/[publicToken]` — detalle de un espacio

- Header con nombre + kind chip + status badge (si `provisional`, banner amarillo "Por verificar")
- Mapa enfocado al espacio (zoom 17) con marker + radio efectivo si aplica
- Sección "Datos":
  - Dirección + link a Google Maps / Apple Maps
  - Horarios humanizados ("Abierto hasta las 22:00 — cierra en 4 horas")
  - Contacto si está cargado
  - Atributos del kind (renderer condicional por kind)
- Sección "Reglas y servicios" (si aplica al kind)
- **Si `kind='municipal_pet_handling_facility'`**: banner permanent rojo claro con disclaimer "Esta es una facilidad oficial de manejo animal según [legal_authority]. Si tu mascota está perdida, consultá si fue ingresada acá." Anclaje legal Ley 14.346.
- **Si `kind='shelter'` con `organization_id`**: link a `/refugios/[orgToken]` (página pública de la org existente).
- Botones:
  - "Sugerir corrección" (D11) → modal con texto libre + opción de adjuntar foto
  - "Compartir" → copia URL `/mis-mascotas/espacios/[publicToken]`

### 5.4 `/gob/espacios` — gestión govt scoped

Lista de espacios en la jurisdicción asignada al govt. Filtros por kind + status. Acciones:
- Crear nuevo espacio (form con `LocationFields` mode="point", `LocalityCombobox`, selector de kind, attributes form dinámico por kind)
- Editar espacio existente (mismo form)
- Archivar (con razón obligatoria)
- Aprobar `pet_space_correction` requests pendientes
- Aprobar `map_listing_request` de orgs en la jurisdicción

### 5.5 `/admin/espacios` — gestión admin universal

Igual que `/gob/espacios` pero sin scope-limit. Adicional:
- "Importar lote" → script wrapper para correr seeds (CABA spaces, Mascotas CABA postas, etc.)
- Ver espacios `disputed` cross-jurisdicción

### 5.6 `/cuenta/organizacion/aparecer-en-mapa` — auto-postulación org

Visible para users con `org_admin` o `org_coordinator` capability en una org `verified=true`. Form:
- `LocationFields` mode="point" (drag pin o tipear dirección)
- Selector de `kind` (limitado a los compatibles con `org.org_type`)
- Attributes form por kind
- Opening hours
- Contacto público
- Upload de evidencia (frente del local, comprobante de domicilio) — opcional pero recomendado
- Disclosure prefs: "¿Mostrar contacto en el mapa? ¿Mostrar dirección exacta o solo barrio?"

Submit → crea `approval_request.type='map_listing_request'` con jurisdiction derivada del address. Notifica al govt scoped (admin fallback). Aprobación materializa la row de `pet_spaces`. Rechazo notifica al org admin con motivo.

## 6. Server actions

Todos en `app/actions/pet-spaces.ts`. Convención: nombres descriptivos, validan capabilities/RLS, devuelven `{ ok: true, ... } | { ok: false, error: string }`.

| Action | Quién | Qué hace |
|---|---|---|
| `searchPetSpacesAction({ kind?, jurisdiction?, near?, radiusM?, query?, openNow? })` | autenticado | Read-only typeahead/búsqueda. Server-side filtering + ordering por distancia |
| `getPetSpaceAction(publicToken)` | autenticado | Lee una row + agrega cómputo `is_open_now` + lista de attachments |
| `createPetSpaceAction(...)` | govt/admin | Insert nuevo espacio. Valida jurisdiction scope-match + Zod attributes |
| `updatePetSpaceAction(publicToken, patch)` | govt/admin | Patch. Mismo scope check |
| `archivePetSpaceAction(publicToken, reason)` | govt/admin | Status → archived |
| `suggestPetSpaceCorrectionAction(publicToken, { field, suggested, evidenceFiles? })` | owner | Crea `approval_request.type='pet_space_correction'` |
| `submitMapListingRequestAction({ orgId, kind, location, attributes, hours, contact, disclosureLevel, evidenceFiles? })` | org admin/coordinator | Crea `approval_request.type='map_listing_request'` con `target_organization_id=orgId` |
| `approveMapListingRequestAction(requestId, { adjustments? })` | govt/admin | Materializa row en `pet_spaces` con `source='org_self_request'`. Audit log |
| `approvePetSpaceCorrectionAction(requestId, { applied: boolean, notes? })` | govt/admin | Aplica el patch sugerido o rechaza. Audit log |
| `bulkImportPetSpacesAction({ records, source })` | admin only | Server-side wrapper del script de seed. Audit log entrada por entrada |

## 7. RLS

Archivo `db/pet_spaces_rls.sql`. Política mínima:

**`pet_spaces` SELECT**:
- Cualquier user autenticado puede leer rows con `status in ('active', 'provisional')`.
- Govt/admin pueden leer todas (incluido `archived` y `disputed`).

**`pet_spaces` INSERT/UPDATE/DELETE**:
- Solo govt con jurisdiction scope match + admin. RLS chequea contra `address_province`, `address_locality` o `ar_locality_id` cruzado con `govt_assignments`.
- Owners no pueden mutar — los reportes pasan por `approval_requests`.

**`pet_space_attachments` SELECT**:
- Mismo que el parent (`pet_spaces`).

**`pet_space_attachments` INSERT/DELETE**:
- Solo creator + govt/admin con scope-match al espacio parent.

## 8. Seed inicial — script y data CABA

Script en `scripts/import-caba-pet-spaces.ts`. Patrón análogo a `import-indec-localities.ts`:

- Tabla `pet_space_import_runs` para trazabilidad.
- Idempotente: re-correr no duplica.
- Source data hardcoded como const TypeScript (el dump que pasaste). Cada entrada se enriquece:
  - `kind='public_pet_space'`
  - `address_locality` ← barrio CABA (Constitución, San Nicolás, etc.) — matcheable contra `ar_localities` post-import de CABA barrios (priority #6 del README de superpowers).
  - `address_province='AR-C'`
  - `address_country='AR'`
  - Geocoding inicial: stretch para v1. Si no se geocodifica en seed, las rows quedan con `latitude=0/longitude=0` y `status='provisional'` hasta que un govt CABA pase el geocode batch (server action `geocodeAllProvisionalSpacesAction`). Recomendado: usar `lib/geocoding.ts` (Nominatim proxy ya construido) en una pasada batch con throttle.
  - `attributes`: default `{ fenced: true, has_water: false, surface: 'mixed', separated_small_large: false, lighting: 'partial', rules: [], allowed_breeds: 'all' }` — placeholders, los corrige el govt cuando audite.
  - `opening_hours`: default null hasta que el govt los cargue.
  - `source='admin_seed'`, `approved_by_user_id` = bootstrap admin.

Script secundario `scripts/import-mascotas-caba-points.ts` para las sedes del programa GCBA Mascotas CABA. Data a relevar (gob.ar). Stretch v1.

## 9. Validación

| Capa | Qué se valida |
|---|---|
| Zod schemas (`lib/pet-space-schemas.ts`) | Shape de `attributes` por kind, `opening_hours` shape, contact shape |
| Server action `createPetSpaceAction` | Jurisdiction scope-match govt; existence de `ar_locality_id` si está set; ownership de la org si `organization_id` está set |
| Server action `submitMapListingRequestAction` | El requester pertenece a la org, la org está verified, el kind es compatible con `org_type` |
| DB CHECKs | Enum de `kind`, `status`, `source`, formato de `address_province`, signo de `effective_radius_m`, exclusiones de `organization_id` por kind |
| RLS | Toda mutación contra scope (ver §7) |

## 10. Notifications

| Trigger | Recipient | Subject |
|---|---|---|
| `map_listing_request` creada | govt scoped + admin fallback | "Nueva solicitud de listado en mapa de la org [name]" |
| `map_listing_request` aprobada | org admin | "Tu organización [name] ya aparece en el mapa de MiMAR" |
| `map_listing_request` rechazada | org admin | "Solicitud de listado en mapa rechazada — motivo: [...]" |
| `pet_space_correction` creada | govt scoped + admin fallback | "Corrección sugerida sobre el espacio [name]" |
| `pet_space_correction` aplicada | reporter owner | "Tu corrección sobre [name] fue aplicada — gracias" |
| `pet_space_correction` rechazada | reporter owner | "Tu corrección sobre [name] no fue aplicada — motivo: [...]" |

Email + in-app via `lib/notifications.ts`. Reuso del patrón existente del admin page.

## 11. Métricas / observability

Tabla `pet_space_views` (opcional v1, recomendado v1.1):

```sql
create table pet_space_views (
  id              uuid primary key default gen_random_uuid(),
  pet_space_id    uuid not null references pet_spaces(id) on delete cascade,
  viewer_user_id  uuid references profiles(id),
  viewed_at       timestamptz not null default now(),
  user_locality   text,                                 -- denormalized for k-anonymity dashboards
  user_province   text
);
create index pet_space_views_space_idx on pet_space_views (pet_space_id, viewed_at);
```

**Stretch v1.** Habilita dashboards govt "espacios más consultados en tu jurisdicción" — útil para campañas. Privacy: aggregations con k-anonimity threshold k=10 igual que el resto del proyecto.

## 12. Fases de implementación

| Fase | Qué |
|---|---|
| **A — Schema + Zod + RLS** | Migration `pet_spaces` + `pet_space_attachments` + `pet_space_import_runs`. `lib/pet-space-schemas.ts`. `db/pet_spaces_rls.sql` aplicable en Studio. Helper `lib/spacePublicToken.ts` (o extensión de `lib/publicToken.ts`). Update `APPROVAL_REQUEST_TYPES` con `map_listing_request` y `pet_space_correction` |
| **B — Server actions read-only** | `searchPetSpacesAction`, `getPetSpaceAction`. Tests unitarios |
| **C — Seed CABA** | `scripts/import-caba-pet-spaces.ts` con los 113 espacios. Geocoding batch con throttle. Smoke test: SELECT count distinct address_locality FROM pet_spaces WHERE source='admin_seed' → debería rondar 48 (= barrios CABA cubiertos) |
| **D — Surface owner (mapa + lista + detalle)** | `/mis-mascotas/espacios`, `/mis-mascotas/espacios/[publicToken]`. Componente `<PetSpacesMap>` reusando `LocationPicker` base. Widget en `/inicio` |
| **E — Helpers de horarios** | `lib/opening-hours.ts` con `isOpenNow`, `humanize`, `nextOpening`. Tests con TZ AR |
| **F — Server actions de mutación (govt/admin)** | `createPetSpaceAction`, `updatePetSpaceAction`, `archivePetSpaceAction`, attrs form dinámico por kind |
| **G — Surface govt (`/gob/espacios`) + admin (`/admin/espacios`)** | CRUD UI + tabs por kind |
| **H — Auto-postulación org** | `/cuenta/organizacion/aparecer-en-mapa` + `submitMapListingRequestAction` + `approveMapListingRequestAction`. Notifications |
| **I — Correcciones owner** | Modal "Sugerir corrección" + `suggestPetSpaceCorrectionAction` + `approvePetSpaceCorrectionAction`. Notifications |
| **J — Polish + tests E2E** | Mobile drawer, filtros persistidos en localStorage, empty states, accesibilidad |

Estimado: 2-3 semanas. Fase A bloquea todo; B+C en paralelo después; D+E en paralelo; F-G dependen de D; H-I al final.

## 13. Tests

- `lib/pet-space-schemas.test.ts` — Zod schemas por kind, casos válidos e inválidos
- `lib/opening-hours.test.ts` — TZ AR, exceptions, "abierto ahora" en bordes
- `lib/spacePublicToken.test.ts` — formato + uniqueness + no-ambig chars
- `__tests__/pet-spaces-server-actions.test.ts` — happy path + scope-match denial
- `__tests__/pet-spaces-import.test.ts` — idempotencia del seed CABA
- `__tests__/map-listing-request-flow.test.ts` — org request → govt approve → row materializada
- Smoke E2E (no Playwright): mock createClient, validar que un owner con jurisdiction CABA-Comuna 4 ve espacios de Comuna 4 ordenados por distancia

## 14. Riesgos

| Riesgo | Mitigación |
|---|---|
| **Geocoding del seed falla / Nominatim rate-limits** | Throttle a 1 req/sec, retry con backoff, batch chunked. Status `provisional` permite shipping con coords missing y batch-fix later |
| **Mapa pesado en mobile** | MapLibre con clustering nativo + lazy-load del componente con `next/dynamic({ssr:false})` |
| **Privacidad de orgs auto-postuladas** | Disclosure prefs explícitas (mostrar contacto sí/no, dirección exacta vs barrio). Default conservador |
| **`municipal_pet_handling_facility` percibido como aval** | Disclaimer obligatorio + anclaje legal visible. NO permitir reacciones positivas owner (corazón, share) sobre este kind |
| **Data desactualizada del GCBA** | Status `provisional` + `pet_space_correction` flow + auditoría trimestral govt CABA |
| **Owner busca espacio en provincia sin govts asignados** | Fallback: cualquier read sigue funcionando (rows con `source='admin_seed'`); las correcciones/listings caen al admin queue por `approval_requests` jurisdiction-fallback existente |
| **Org con multi-locations (cadena vet)** | Cada location es una row separada con su `organization_id`. La org cuenta como una sola entity en `organizations`, varias entries en `pet_spaces` |
| **`kind` cambia post-aprobación** (ej. una vet se convierte en pet shop) | Mismo flow que archivar + crear nueva row. Status history vive en `audit_log` |

## 15. Decisiones cerradas — Round 2 (Q1-Q8, confirmadas con Nacho 2026-05-19)

| # | Decisión | Razón |
|---|---|---|
| Q1 | **`pet_space_attachments` (fotos) deferred a v1.1**. v1 muestra solo ícono por kind | Achica el primer PR + posterga decisiones de moderación / RLS de storage / límites de tamaño. La tabla queda definida en §4.2 pero no se ship hasta v1.1 |
| Q2 | **Geocoding del seed CABA entra en el primer PR**. Throttle 1 req/sec contra Nominatim, batch nocturno desde script, retry con backoff | Sin coords reales el mapa es inservible. Provisional con (0,0) ship-able pero feo. Lo hacemos derecho de entrada |
| Q3 | **Solo orgs con `verified=true` pueden auto-postularse al mapa**. Si una org nueva quiere salir, primero pasa `org_registration` (existente) y después `map_listing_request` (nuevo). Dos approvals, no uno | Separa verificación de listado. El govt que verifica una org no necesariamente la quiere ver en el mapa todavía (puede faltar geo precisa, fotos, etc.). Single-responsibility por approval |
| Q4 | **Widget `/inicio` arranca expandido condicional**: expandido si hay ≥1 espacio dentro de 1 km del pet activo; colapsado si no | Premia la cercanía; no satura dashboards en zonas sin coverage. Persiste preferencia en `localStorage` después de la primera interacción del owner (si lo colapsa manualmente, queda colapsado) |
| Q5 | **`municipal_pet_handling_facility` arranca OFF en el filtro de kind**. Owner activa explícitamente si quiere verlos | Reduce ruido + respeta sensibilidad. Disclaimer permanente cuando se muestran (D14) |
| Q6 | **`vaccination_point` conecta con scheduling por display + linkout**: detail page muestra "Próxima campaña antirrábica acá: 12 de junio" y linkea al booking del scheduling existente | No duplica el flow de booking. Reusa el spec de health-campaigns implementado. Si el espacio no tiene campañas programadas, la sección no aparece |
| Q7 | **Espacios `disputed` quedan visibles en el mapa con badge "En revisión"** (no ocultos como pensé inicialmente) | Transparencia coherente con cómo orgs `verified=false` y `provisional` ya aparecen con disclaimer. El owner viendo el badge entiende que el dato puede tener errores y decide si confiar o no. Más honesto que esconder mientras el govt resuelve |
| Q8 | **Búsqueda = prefix match ILIKE** sobre `display_name`, `address_line` y `address_locality`. Index B-tree | Suficiente para 113 + N rows. Cero infra extra (sin pg_trgm, sin tsvector). Si el catálogo crece a 10K+ rows o emergen casos de typos, se reevalúa con FTS o pg_trgm |

## 16. Anclaje legal / framework normativo

- **Ley 14.346** — Maltrato animal nacional. Anclaje del disclaimer de `municipal_pet_handling_facility`.
- **Ordenanzas municipales por jurisdicción** — el campo `attributes.legal_authority` del kind sensible se completa con la cita específica del decreto u ordenanza que crea esa facilidad.
- **Ley CABA 1.777/2005** — define barrios CABA, usados como `address_locality`.
- **Ley CABA 4078 / Ley Prov 14.107** — PPP. Relevante para `public_pet_space.attributes.allowed_breeds='non_ppp'` (algunos caniles tienen restricciones explícitas).
- **Decreto 4669/1973 PBA + Ord. CABA 41.831/1987** — observación de rabia. Conexión: `municipal_pet_handling_facility.attributes.functions` puede incluir `rabies_observation`.
- **Programa Mascotas CABA** (GCBA) — fuente de datos del kind `vaccination_point` en CABA.

## 17. Out of scope v1

Cosas que **NO** entran a este spec — para evitar scope-creep, listadas para futuro:

- **Event `pet_space_visited`** — visitas al timeline del pet. v2+ cuando haya caso de uso claro de dashboard govt o achievement.
- **Reacciones owner** sobre espacios (favorito, recomendado, foto subida por owner) — v1.1 mínimo, considerar moderación.
- **Reseñas / rating** — modelo Yelp, NO se hace. DIM no es Tripadvisor de caniles. Si emerge demanda, requiere spec dedicado con anti-spam, moderación y disclosure.
- **Push notifications de proximidad** ("Hay un canil a 100 m") — privacy-sensitive, deferred.
- **Integración con scheduling para booking en `vaccination_point`** — display sí, booking flow sigue siendo del spec de scheduling.
- **API pública** del catálogo — sin caso de uso comercial / partnership a la vista.
- **Versión `/p/`-style pública del mapa** — owner-only en v1; si ONGs piden link compartible para difundir caniles, se evalúa por caso.
- **Datos fuera de AR** — el `address_country` queda `'AR'` hardcoded. Extender requiere repensar `ar_localities`.

---

**Próximos pasos**:
1. Review de este spec — cerrar preguntas abiertas §15.
2. Una vez OK → escribir `plans/2026-05-19-pet-spaces-catalog.md` con detalle ejecutable por fase.
3. Ejecutar fases A→B→C en el primer PR para tener el mapa CABA navegable end-to-end con read-only; el resto en PRs subsecuentes.
