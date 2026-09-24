# Adoption-listing público (`/adoptar`) — design spec

> Surface pública donde cualquiera (logeado o no) descubre mascotas en adopción en refugios/rescue networks verificados, las filtra por especie / zona / talle / energía, y arranca el flujo de adopción. La página es una **proyección** sobre `pets` + `ownerships` + `organizations` — no agrega tablas nuevas, sí agrega un puñado de columnas "listing" que cura el refugio y una columna de toggle público/pausado. El "reservar" del visitante se materializa como `adoption_application_submitted` (evento ya en el catálogo, ver `org-portal-event-flows.md` Flow 6) y exige cuenta DIM — si no la tiene, gate de signup con `returnTo` y un `apply_intent` token que sobrevive al redirect.
>
> **Fecha:** 2026-05-18
> **Owner:** Ignacio Del Valle
> **Estado:** 🟢 Ready for CC
> **Versión:** 1.4 — consent + history sharing del postulante con el refugio. Agrega D22 que introduce un consent checkbox obligatorio en el form "Postularme" (`profile_sharing_consent_at` en `adoption_applications`), una vista nueva "Historial del postulante en MiMAR" accesible al refugio SOLO mientras la application está abierta (scope-bound vía RLS), y políticas RLS adicionales sobre `pets` y `ownerships` que abren acceso read-only del refugio a las mascotas-del-postulante durante el review. Materializa la idea: el postulante acepta compartir su trayectoria para que el refugio tome mejor decisión. Sin esto, el refugio decidía a ciegas o pedía info ad-hoc fuera del sistema.
>
> **Versiones previas:** 1.3 — cross-spec consistency guards (D18-D21). 1.2 — el listing nunca se pausa por tener postulaciones en curso (D15), auto-rejection de pending al `adoption_finalized` (D16), adoptante nunca ve a su "competencia" (D17). 1.1 — "Postularme" (no "Reservar"), bucket de edad granular de 5 niveles. 1.0 — diseño inicial.

---

## 1. Por qué este documento existe

`AGENTS.md → Open questions / future work` lo lista como uno de los huecos que cierran el loop del org portal:

> **Adoption-listing public surface (`/adoptar`)** — projection over (`pets` where current `Ownership` is org-held by `org_type` in (`shelter`, `rescue_network`), not death, not paused). Filters, region, species. UX and listing copy open.

Lo que ya tenemos en el repo:

- Eventos de adopción completos (`adoption_application_submitted`, `_reviewed`, `_approved`, `_rejected`, `adoption_finalized`, `post_adoption_checkin`, `adoption_revoked`) — implementados en el org portal.
- Flow 6 y 7 de `docs/org-portal-event-flows.md` ya describen la submission (autenticada) y la finalización transaccional. Asumen que el visitante llega vía `/adoptar/{petToken}`.
- `pets` con custody polimórfica via `ownerships.owner_organization_id` y rol `shelter_custody` — la proyección que necesitamos está a un JOIN de distancia.
- `organization_coverage` con jurisdicción province + locality — sirve para filtrar por zona del refugio (no por zona del adoptante).
- Credencial pública `/p/[publicToken]` Tier 0 — existe y muestra el mínimo. **No alcanza** para listing de adopción: faltan personalidad, historia, requisitos del refugio, foto-de-cara-tierna.

Lo que **falta** para que `/adoptar` sea entregable:

🔴 **El listing en sí.** No hay ruta pública que muestre N mascotas filtrables. La credencial pública es per-pet por QR, no exploratoria.

🔴 **Contenido listing-friendly.** `pets` tiene `name`, `breed`, `color`, `distinguishing_features` — útil para credencial-como-DNI. No tiene historia ("Negrita llegó rescatada de Constitución..."), requisitos ("buscamos hogar sin perros chicos"), nivel de energía, talle, edad estimada en bucket. El refugio cura ese contenido aparte.

🔴 **Toggle público / pausado.** No toda mascota en `shelter_custody` está lista para adopción (rehab, cuarentena sanitaria, en evaluación conductual). El refugio decide cuándo publica.

🔴 **Gate de auth en "Postular".** Hoy `adoption_application_submitted` exige `recorded_by_user_id`. La spec no decía qué pasa si el visitante anónimo clickea "Quiero adoptar a Negrita". Ese gate es la pregunta principal de la consigna.

🔴 **Paginación, filtros, copy.** Sin política explícita, cada implementador inventa la suya.

🟡 **Diferenciar `/adoptar/{petToken}` (ficha de adopción) de `/p/{publicToken}` (credencial-DNI).** Mismos datos del pet pero distinto framing. Hoy se confunden.

Este doc cierra esos seis huecos. Schema mínimo (un alter sobre `pets`, una columna en `organizations` opcional), proyección con JOINs estándar, una nueva ruta `/adoptar` + `/adoptar/{petToken}` + form `/adoptar/{petToken}/postular`, gate de auth con `apply_intent` token, copy en es-AR, paginación keyset.

## 2. Decisiones cerradas (no relitigar)

| # | Decisión | Razón |
|---|---|---|
| D1 | **El listing es una proyección, no una tabla.** `pets` + `ownerships` + `organizations` con WHERE current shelter_custody by verified shelter/rescue_network + `pets.adoption_listed_at IS NOT NULL` + `adoption_listing_paused_at IS NULL` + `status != 'deceased'` | Coherente con el principio "projections are first-class" de AGENTS.md. Cero tablas nuevas, cero duplicación, el refugio cambia la custody o pausa la listing y el listing se actualiza solo |
| D2 | **El refugio decide cuándo listar.** `adoption_listed_at` arranca NULL al intake. El operador del refugio toca explícitamente "Publicar en /adoptar" desde `/org/[orgToken]/mascotas/{petToken}` | Algunas mascotas no están listas (rehab, evaluación). Default opt-in sería irresponsable |
| D3 | **El refugio puede pausar sin despublicar.** `adoption_listing_paused_at` timestamp; cuando set, la mascota sale del listing pero conserva su listing copy + foto. Unpause = poner NULL | Pausas comunes (mascota enferma esta semana, refugio sin capacidad de visitas). No queremos perder el storytelling cada vez |
| D4 | **Contenido listing-curado vive en columnas de `pets`** (no tabla aparte). Story, requisitos, energy level, age bucket, talle estimado, fee | Una sola fila por pet. El refugio edita en un form, el listing lee directo. Una tabla `adoption_listings` peer sería overkill para v1 |
| D5 | **`/adoptar/{petToken}` es ruta nueva, distinta de `/p/{publicToken}`.** Misma identidad del pet, distinto framing: el listing es "conocé a Negrita, ¿la querés adoptar?"; la credencial es "este es el DNI de Negrita" | Audiencia distinta, copy distinto, CTA distinto. Confundirlos forzaría toggles condicionales feos. Comparten componentes (foto, identidad) pero composición distinta |
| D6 | **El "Postular" del visitante exige cuenta DIM.** Click → si no auth, redirigir a signup/login con `?returnTo=/adoptar/{token}/postular` Y un `apply_intent` token efímero que captura `{petToken, browsedAtBarrio?}` para no perder el contexto | El evento `adoption_application_submitted` necesita `applicant_user_id` (no aceptamos anónimos). Y el refugio quiere conocer a la persona — un email es el piso. Crear cuenta es asumir la responsabilidad de adoptar |
| D7 | **No existe "reserva" en `/adoptar`. Punto.** El botón dice "Postularme para adoptar a {name}". El refugio recibe la postulación, la revisa según sus criterios, y elige. Múltiples postulaciones simultáneas para el mismo pet son normales y esperadas. El sistema NUNCA bloquea a un pet "porque alguien lo reservó" — eso le quita agencia al refugio. La palabra "reservar" no aparece en ningún copy, label de botón, ni email | Reflejar el proceso de adopción responsable real (matching mutuo, no first-come-first-served). "Reservar" prometería un hold que no estamos dando y daría falsas expectativas al postulante |
| D8 | **Paginación keyset por `(adoption_listed_at DESC, id DESC)`.** 24 mascotas por página. Sin contador total exacto (`SELECT COUNT(*)` con filtros es caro a escala) — la UI usa "Mostrar más" / "Ver más" | Volumen esperado: bajo a mediano (cientos, no decenas de miles). Keyset es estable bajo updates en vivo, no tiene "saltos" de items cuando alguien lista una nueva mientras navegás |
| D9 | **Filtros por query-params, URL como source of truth.** `/adoptar?especie=perro&provincia=CABA&localidad=Belgrano&edad=cachorro&talle=mediano&energia=baja` etc. Compartibles, marcables, indexables | Permite que un refugio comparta "perros en Caballito" como link, y que Google los rankee con coverage geográfico real |
| D10 | **Branding del refugio visible en cada card.** Logo + nombre del refugio en cada listing item, no escondido. Click en el badge → `/refugios/{orgToken}` (página del refugio) | Trust signal directo. El adoptante quiere saber a qué refugio le está postulando antes de clickear la ficha. Y le da reach gratuito a los refugios verified |
| D11 | **Pagination + filtros se ejecutan server-side, página server-rendered.** Next.js App Router con `searchParams`. Sin estado client-only que se desincronice del URL | SEO-friendly (Google crawlea las páginas filtradas), shareable, los filtros sobreviven a refresh y back/forward |
| D12 | **Sin "favoritos" en v1.** Solo "Postularme" como acción transactional | Favoritos requieren sesión persistente y agregar tabla. No es bloqueante para el North Star (matching real entre adoptante y refugio). Lo agregamos cuando se justifique por uso medido |
| D13 | **Pets unchipped son listables igual.** El chip es deseable pero no requisito legal para que el refugio busque adoptante | Refugios reciben strays sin chip a diario. Si forzamos chip no listamos al 80% del backlog real |
| D14 | **El listing NUNCA expone teléfono del refugio.** El visitante contacta vía DIM (postulación) o vía la página del refugio (`/refugios/{orgToken}`). El refugio elige cómo se expone ahí | DIM es la capa de coordinación; el teléfono se ofrece a quien postuló y el refugio decidió contactar. Evita scraping para spam, además |
| D15 | **El listing NUNCA se pausa automáticamente por tener postulaciones en curso.** Aunque haya 1, 5 o 50 `adoption_application_submitted` pending para el mismo pet, la mascota sigue visible en `/adoptar` y aceptando nuevas postulaciones. El refugio puede avanzar con 1 o varias en paralelo (review, visita, evaluación) y eventualmente otorga la adopción a 1 solo (`adoption_finalized`). El listing sale del feed **únicamente** cuando: (a) el current ownership deja de ser `shelter_custody`, o (b) el refugio toca explícitamente "Despublicar / Pausar" en `/org/[orgToken]/mascotas/{petToken}` (D3) | Refleja la realidad operativa del refugio responsable: no hay "primer postulante gana", el matching mutuo necesita pool de candidatos. Esconder el pet al primer apply nos pondría en la trampa de first-come-first-served (lo opuesto a D7). Cerrar la lista cuando "todavía no decidimos" reduce las opciones del refugio sin razón válida |
| D16 | **Al `adoption_finalized`, las otras postulaciones pending para ese mismo pet se cierran automáticamente con `adoption_application_rejected` y reason `another_application_finalized`.** Es parte del Flow 7 transaccional, no del listing per se | Si no las cerramos, quedan zombies con el adoptante esperando respuesta para siempre. Notificación clara al postulante: "Otra postulación para {pet.name} fue finalizada. Sabemos que es decepcionante; {Refugio} tiene otras mascotas en adopción en MiMAR." con link a `/adoptar?org={orgToken}`. Cerrar **explícitamente** preserva audit trail y es menos cruel que ghosting |
| D17 | **El postulante NUNCA ve cuántas otras postulaciones hay para el mismo pet.** Ni count, ni nombres, ni indicación de posición en cola | Mostrar competencia genera urgencia falsa, presiona a postular impulsivamente y va contra el espíritu de adopción responsable. Cada postulante ve solo su propio estado. El refugio sí ve la lista completa internamente |
| D18 | **`pets.status='lost'` excluye del listing.** Si una pet listada se escapa del refugio (real, pasa), el WHERE del query la filtra automáticamente. El refugio NO tiene que despublicarla manualmente — vuelve sola al listing cuando emite `status_changed: lost → home` post-recuperación | Coherencia operativa: un pet perdido no está disponible para adopción. Y el listing mostrando "Conocé a Negrita" con foto cuando Negrita está perdida es contradictorio y crea expectations rotas. La exclusión es automática vía WHERE — sin acción del refugio, sin riesgo de olvido |
| D19 | **`pets.adoption_eligible=false` excluye del listing** (cross-spec con foster-volunteers v1.4 D14). Además, `setAdoptionListingStatusAction` (toggle Publicar/Pausar de §12 Fase 2) valida que `adoption_eligible=true` antes de permitir publicación. Si está `false` o `NULL`, error: "Esta mascota no está apta para adopción todavía. Marcala apta primero en /org/[orgToken]/mascotas/[petToken]." | Cross-consistency con el spec de foster-volunteers v1.4 que define el flag de eligibility como gate operativo del refugio (medical_treatment / quarantine / legal_hold / etc.). Sin este guard, el refugio podría tocar "Publicar" sobre un pet en cuarentena por parvo y aparecería en `/adoptar` — riesgo sanitario + violación de la decisión del propio refugio. Doble guard (DB filter + server validation) defensive |
| D20 | **`pets.in_custody_dispute=true` excluye del listing** (cross-spec con event-catalog-cleanup + custody disputes Fase 10 del admin). Una pet en disputa de titularidad está bloqueada para transfer/adopción por decisión del cleanup plan. El listing la oculta automáticamente; cuando la dispute se resuelve (status='resolved' o 'withdrawn' del `custody_disputes` table → flag baja a `false`), el pet vuelve al listing si seguía con `adoption_listed_at` set | Lógica: no podés adoptar lo que no se sabe de quién es legalmente. El refugio que tiene el pet en custodia mientras la dispute corre no puede ofrecerla en adopción hasta que se resuelva. Misma exclusión defensive automática vía WHERE — sin acción manual del refugio |
| D21 | **`pets.rabies_observation_status='active'` excluye del listing** (cross-spec con bite-rabies-observation spec). Pet en cuarentena de observación 10 días post-mordedura (Decreto 4669/1973 PBA + Ord. CABA 41.831/1987) NO debe aparecer en listing público — riesgo sanitario + obligación legal del refugio de mantenerla aislada. Cuando la observación cierra negativa (cron auto-close o veterinario), el flag baja y el pet vuelve al listing si seguía con `adoption_listed_at` set | Idem D20: la cuarentena sanitaria es un estado temporal que bloquea muchas cosas, incluyendo aparición pública. La exclusión automática evita que el refugio tenga que recordar despausar/republicar manualmente |
| D22 | **Consent obligatorio de compartir historial + ventana de acceso scope-bound al refugio.** Al postularse, el visitante debe tildar un checkbox: *"Acepto compartir con [refugio name] mi historial de adopciones, fosters y mascotas registradas en MiMAR para esta postulación. El refugio solo accederá mientras mi postulación esté abierta."* Sin tilde → el form no submitea (CHECK constraint también en DB defensive). Se persiste `adoption_applications.profile_sharing_consent_at` (timestamp). RLS sobre `pets`, `ownerships` y `pet_events` se extiende: el refugio de la org receptora de una `adoption_application open` con consent active puede READ las pets del applicant + sus ownerships + eventos non-sensitive (libreta sanitaria del applicant pet, ownership history). NO puede ver: notificaciones, otras applications del applicant a OTRAS listings, denuncias welfare en las que el applicant sea reporter. Cuando la application cierra (resolved / cancelled / cascade), el acceso revoca instantáneamente vía la cláusula RLS basada en `cases.status`. **Habilita** la nueva vista "Historial del postulante en MiMAR" en el detail de la application en el org portal (§13.3 nueva sub-sección) | El refugio que recibe N postulaciones a una pet hoy decide casi a ciegas: ve `housing_type`, `other_pets`, `daily_routine`, `notes` del form, y nada más. Saber si el postulante ya adoptó antes (y cómo le fue: checkins post-adopción regulares? adoption_reversed?) es señal de fondo. El consent explícito + scope temporal + RLS hard la implementan limpio. Por defecto OFF en el form (la persona lo tilda activamente), nunca on hidden. Compatible con Ley 25.326 (consent informado, propósito específico, ventana temporal acotada) |

## 3. Glosario

| Término | Qué es |
|---|---|
| **Listing** | El registro público de `pets.adoption_listed_at IS NOT NULL` en `/adoptar`. No es una tabla — es un estado computado |
| **Ficha de adopción** | La página `/adoptar/{petToken}` con la historia, los requisitos, la galería |
| **Postulación** | Acción del visitante autenticado: completa el form, emite `adoption_application_submitted`. Vive su ciclo en el org portal según Flow 6 de event flows |
| **Apply intent** | Token efímero (15 min, JWT firmado) que captura el `petToken` y filtros browseo cuando un visitante anónimo clickea "Postular" y va a signup/login. Le permite volver al form post-auth sin perder contexto |
| **Listing copy** | Contenido curado por el refugio: historia, requisitos, energy level, talle, edad bucket. Vive en columnas nuevas de `pets` |
| **Pausa** | Estado intermedio entre "publicada" y "despublicada": `adoption_listing_paused_at` set, `adoption_listed_at` también set. La ficha está oculta del listing pero conserva todo el contenido |

## 4. Domain model

### 4.1 Lo que ya existe (no se toca)

- `pets` con identidad básica (name, species, breed, color, sex, DOB, distinguishing_features, primary_photo_id, status, microchip_*, jurisdiction_*)
- `ownerships` polimórfica con `owner_user_id | owner_organization_id` XOR y `role='shelter_custody'`
- `organizations` con `org_type ∈ {clinic, shelter, rescue_network, sanitary_authority, other}`, `verified`, `status`, `public_token`, `display_name`, `avatar_url`, jurisdicción
- `organization_coverage` con `(province, locality)` per-org (zona donde opera, distinto a `pets.jurisdiction_*` que es la jurisdicción del pet)
- Eventos: `adoption_application_submitted` y resto del pipeline (Flow 6/7 de event flows)
- `attachments` con `pet_id` para fotos múltiples (galería)

### 4.2 Lo nuevo en `pets` — listing copy

```sql
alter table pets
  -- Toggle público/pausado controlado por el refugio
  add column adoption_listed_at        timestamptz null,
  add column adoption_listing_paused_at timestamptz null,

  -- Contenido curado por el refugio (todo opcional, todo editable)
  add column adoption_story            text null,
  add column adoption_requirements     text null,
  add column adoption_energy_level     text null, -- 'low' | 'medium' | 'high'
  add column adoption_size_estimate    text null, -- 'small' | 'medium' | 'large' | 'xl'
  add column adoption_age_bucket       text null, -- 'puppy' | 'junior' | 'young' | 'adult' | 'senior'
  add column adoption_good_with_kids   boolean null,
  add column adoption_good_with_dogs   boolean null,
  add column adoption_good_with_cats   boolean null,
  add column adoption_needs_yard       boolean null,
  add column adoption_fee_ars          integer null;
```

Notas:

- **Nullable everywhere.** El refugio puede listar con info mínima (story + size) y agregar más después. Forzar todos a la vez sería fricción innecesaria.
- **`energy_level`, `size_estimate`, `age_bucket` son `text` con CHECK constraint**, no enum. Mismo razonamiento que para `event_type`: agregar variantes (e.g., `'giant'`) no debe forzar migración.
- **`good_with_*` son tri-state booleans** (null = "no sabemos / no aplica"). Un refugio que rescató al perro hace 3 días no sabe si tolera gatos. El listing lo refleja con un "—" en lugar de inventar un "no".
- **`age_bucket` es independiente de `pets.date_of_birth`**. La DOB suele ser estimada para rescates; el bucket es lo que el refugio reporta operacionalmente. La ficha muestra ambos si están: "Edad: Adulta (~4 años estimados)".
- **Cinco buckets de edad, no cuatro.** Diferenciamos `puppy` (cachorra ≤ 6 meses) de `junior` (6m – 1 año) porque el público interesado y los requisitos del hogar son distintos — un cachorra de 2 meses necesita destete reciente y socialización, una junior de 8 meses ya está en adolescencia. Conservamos `young` (1–3a), `adult` (3–7a), `senior` (7+a). Los rangos son guidance para el refugio; no se enforce contra `date_of_birth` (la DOB suele ser estimada y los rangos son aproximados — un perro grande de 6 años puede operacionalmente ser "senior" antes que un chico). Lo importante: copy y filtros usan los 5 niveles consistentemente.

  Mapping canónico DB → label es-AR (vive en `lib/adoption-listing.ts` junto al type `AgeBucket`):

  | DB value  | Label UI (femenino / masculino)        | Rango orientativo |
  |-----------|----------------------------------------|-------------------|
  | `puppy`   | Cachorra / Cachorro                    | 0 – 6 meses       |
  | `junior`  | Junior                                 | 6 meses – 1 año   |
  | `young`   | Joven                                  | 1 – 3 años        |
  | `adult`   | Adulta / Adulto                        | 3 – 7 años        |
  | `senior`  | Adulta mayor / Adulto mayor (Senior)   | 7 años en adelante|

  Femenino vs masculino se resuelve con `pets.sex`. `unknown` cae al masculino genérico ("Adulto") para no inventar género. La forma "Adulta mayor" es la que se ve en refugios reales de Argentina; "Senior" entre paréntesis es el ancla internacional para que la gente lo encuentre por búsqueda.
- **`adoption_fee_ars`** es opcional. Algunos refugios cobran fee de adopción para cubrir vacunas/castración; otros no. UI muestra "Adopción solidaria: $XXX" cuando hay valor, omitir cuando NULL.

CHECK constraints:

```sql
alter table pets
  add constraint pets_adoption_energy_level_valid check (
    adoption_energy_level is null
    or adoption_energy_level in ('low', 'medium', 'high')
  ),
  add constraint pets_adoption_size_estimate_valid check (
    adoption_size_estimate is null
    or adoption_size_estimate in ('small', 'medium', 'large', 'xl')
  ),
  add constraint pets_adoption_age_bucket_valid check (
    adoption_age_bucket is null
    or adoption_age_bucket in ('puppy', 'junior', 'young', 'adult', 'senior')
  ),
  add constraint pets_adoption_fee_nonneg check (
    adoption_fee_ars is null or adoption_fee_ars >= 0
  );
```

Índice para el listing query principal:

```sql
create index pets_adoption_listing_idx
  on pets (adoption_listed_at desc, id desc)
  where adoption_listed_at is not null
    and adoption_listing_paused_at is null
    and status not in ('deceased', 'lost')                -- D18
    and (adoption_eligible is null or adoption_eligible = true)  -- D19 (null tolerado en index para no excluir pets pre-eligibility-feature; el query del listing fuerza true)
    and (in_custody_dispute is null or in_custody_dispute = false)  -- D20
    and (rabies_observation_status is null or rabies_observation_status != 'active');  -- D21
```

Partial index — solo cubre filas listables tras los 4 guards cross-spec. Para el orden de paginación keyset.

**Nota sobre nullability de las columnas cross-spec**: este spec se redacta antes de que las migraciones de foster-volunteers v1.4 (`pets.adoption_eligible`), event-catalog-cleanup (`pets.in_custody_dispute`) y bite-rabies-observation (`pets.rabies_observation_status`) hayan aplicado. El partial index tolera `IS NULL` en cada columna para que el index siga funcionando si alguno de esos specs no se ha aplicado todavía. El query del listing (§5) usa la forma estricta (`= true` / `!= 'active'`) ignorando NULL, lo cual es el comportamiento correcto post-aplicación de todos los specs. Si CC corre estas migraciones en orden distinto, el index sigue válido pero hasta que las columnas existan habrá que aplicar la migración del adoption-listing al final.

### 4.3 Nada cambia en `organizations`

`organizations.verified`, `status`, `org_type`, `tier_0_show_branding`, `avatar_url`, `display_name`, `public_token` ya tienen todo lo necesario. El listing usa lo que está.

### 4.4 Nada cambia en `ownerships` ni en `pet_events`

La proyección lee `ownerships` con los filtros actuales. Los eventos del pipeline ya existen en `EVENT_TYPES`.

### 4.5 Tabla efímera de `apply_intent` — NO, va firmado

No agregamos tabla. El `apply_intent` token es un JWT firmado HMAC con el secret del server, expira en 15 minutos, carga payload `{ petToken, kind: 'adoption_apply', issuedAt }`. Cuando el visitante completa signup/login y vuelve, el server verifica firma + expiry y reabre el form. Si expiró, mensaje claro: "Tu intención de postularte expiró. Volvé a la ficha de la mascota y postulate otra vez". Cero estado server-side.

Razones para JWT en lugar de DB:
- Sin sweep job
- Sin race conditions con signup
- Sin polución de tablas con basura
- Stateless = trivialmente horizontal

## 5. La proyección — query canónica

Función helper en `lib/adoption-listing.ts`:

```ts
export type AdoptionListingFilters = {
  species?: Species;          // perro | gato | conejo | ...
  province?: string;          // codigo INDEC o nombre estandarizado
  locality?: string;
  ageBucket?: AgeBucket;
  sizeEstimate?: SizeEstimate;
  energyLevel?: EnergyLevel;
  goodWithKids?: boolean;
  goodWithDogs?: boolean;
  goodWithCats?: boolean;
  needsYard?: boolean;
  hasMicrochip?: boolean;
  organizationToken?: string; // filtra a un refugio específico
};

export type AdoptionListingCursor = {
  listedAt: string;
  id: string;
};

export async function queryAdoptionListing(
  db: Database,
  filters: AdoptionListingFilters,
  cursor: AdoptionListingCursor | null,
  pageSize = 24,
): Promise<{ items: AdoptionListingItem[]; nextCursor: AdoptionListingCursor | null }> {
  const baseConditions = [
    isNotNull(pets.adoptionListedAt),
    isNull(pets.adoptionListingPausedAt),
    // D18: excluye status terminal o no-disponible
    notInArray(pets.status, ["deceased", "lost"]),
    // D19: cross-spec con foster-volunteers v1.4 — solo aptas para adopción
    eq(pets.adoptionEligible, true),
    // D20: cross-spec con custody-disputes (event-catalog-cleanup / admin Fase 10)
    or(isNull(pets.inCustodyDispute), eq(pets.inCustodyDispute, false)),
    // D21: cross-spec con bite-rabies-observation — excluye cuarentena activa
    or(
      isNull(pets.rabiesObservationStatus),
      ne(pets.rabiesObservationStatus, "active"),
    ),
    isNull(ownerships.endedAt),
    eq(ownerships.role, "shelter_custody"),
    eq(organizations.verified, true),
    eq(organizations.status, "active"),
    inArray(organizations.orgType, ["shelter", "rescue_network"]),
  ];

  // Pet jurisdiction filters (where the pet currently is)
  if (filters.province) baseConditions.push(eq(pets.jurisdictionProvince, filters.province));
  if (filters.locality) baseConditions.push(eq(pets.jurisdictionLocality, filters.locality));

  // Identity filters
  if (filters.species) baseConditions.push(eq(pets.species, filters.species));
  if (filters.hasMicrochip === true) baseConditions.push(isNotNull(pets.microchipId));
  if (filters.hasMicrochip === false) baseConditions.push(isNull(pets.microchipId));

  // Listing-copy filters
  if (filters.ageBucket) baseConditions.push(eq(pets.adoptionAgeBucket, filters.ageBucket));
  if (filters.sizeEstimate) baseConditions.push(eq(pets.adoptionSizeEstimate, filters.sizeEstimate));
  if (filters.energyLevel) baseConditions.push(eq(pets.adoptionEnergyLevel, filters.energyLevel));
  if (filters.goodWithKids === true) baseConditions.push(eq(pets.adoptionGoodWithKids, true));
  if (filters.goodWithDogs === true) baseConditions.push(eq(pets.adoptionGoodWithDogs, true));
  if (filters.goodWithCats === true) baseConditions.push(eq(pets.adoptionGoodWithCats, true));
  if (filters.needsYard === false) baseConditions.push(or(eq(pets.adoptionNeedsYard, false), isNull(pets.adoptionNeedsYard)));

  // Organization filter
  if (filters.organizationToken) baseConditions.push(eq(organizations.publicToken, filters.organizationToken));

  // Keyset cursor: (listed_at, id) < (cursor.listedAt, cursor.id)
  if (cursor) {
    baseConditions.push(
      or(
        lt(pets.adoptionListedAt, cursor.listedAt),
        and(eq(pets.adoptionListedAt, cursor.listedAt), lt(pets.id, cursor.id)),
      ),
    );
  }

  const rows = await db
    .select({ /* pet + org + primary photo url */ })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .innerJoin(organizations, eq(organizations.id, ownerships.ownerOrganizationId))
    .where(and(...baseConditions))
    .orderBy(desc(pets.adoptionListedAt), desc(pets.id))
    .limit(pageSize + 1); // fetch one extra to know if there's more

  const hasMore = rows.length > pageSize;
  const items = rows.slice(0, pageSize);
  const last = items.at(-1);
  const nextCursor = hasMore && last
    ? { listedAt: last.adoptionListedAt!.toISOString(), id: last.id }
    : null;

  return { items, nextCursor };
}
```

**Por qué keyset y no offset.** Con offset, si entre la página 1 y la 2 alguien lista una mascota nueva (`adoption_listed_at = now`), esa mascota aparece arriba y empuja el resto un slot, y el visitante ve un duplicado o se salta uno. Con keyset por `(listed_at, id)` el cursor es absoluto: "dame todo lo listado antes de este momento exacto y con id menor en empate". Items nuevos no afectan el camino del cursor.

**Filtros que NO incluí en v1:**
- `vaccinated` / `sterilized` — requieren proyectar `pet_events` por pet (cualquier `vaccination_administered`, cualquier `sterilization_performed`). Costo de query alto sin partial indexes adicionales. Lo agregamos en v1.1 cuando el listing tenga uso real y veamos si la gente filtra por eso. Mientras tanto, la ficha individual los muestra.
- `breed` exacto — texto libre, ambiguo, distrae. Mejor cambiar a "tipo" si emerge la necesidad.

## 6. La ruta `/adoptar` — listing

### 6.1 Estructura del archivo

```
app/(public)/adoptar/
  page.tsx                          → Listing principal (server component, searchParams)
  loading.tsx                       → Skeleton
  not-found.tsx                     → "No encontramos mascotas con estos filtros"
  components/
    FiltersBar.tsx                  → Form con los toggles + selects, submit por URL
    PetListingCard.tsx              → Card individual
    ResultsHeader.tsx               → "Mostrando N resultados en {locality}"
  [petToken]/
    page.tsx                        → Ficha individual
    not-found.tsx
    postular/
      page.tsx                      → Form de postulación (auth-gated)
      actions.ts                    → submitAdoptionApplicationAction
```

### 6.2 SearchParams contract

```ts
// /adoptar?especie=perro&provincia=CABA&localidad=Belgrano&edad=adulto&talle=mediano&energia=baja&buenoConChicos=1&buenoConPerros=1&buenoConGatos=&necesitaPatio=0&conChip=&org=ORG-XK3P-9D2L&cursor=2026-05-18T14:00:00Z__pet-id-uuid

type SearchParams = {
  especie?: "perro" | "gato" | "conejo" | string;
  provincia?: string;
  localidad?: string;
  edad?: "puppy" | "junior" | "young" | "adult" | "senior";
  talle?: "small" | "medium" | "large" | "xl";
  energia?: "low" | "medium" | "high";
  buenoConChicos?: "1";   // present = filter "yes"; absent = no filter; "0" = filter "no"
  buenoConPerros?: "1" | "0";
  buenoConGatos?: "1" | "0";
  necesitaPatio?: "1" | "0";
  conChip?: "1" | "0";
  org?: string;           // organization public_token
  cursor?: string;        // "<listedAt-iso>__<petId>"
};
```

Convención: español en query params (UI-facing), inglés en el helper (`AdoptionListingFilters`). Hay un mapper `parseSearchParams` que cruza el río.

### 6.3 Copy es-AR — listing

**Hero** (siempre, sin filtro):

> # Mascotas en adopción
> Refugios y rescatistas verificados de Argentina buscan hogar para estos animales. Conocelos y postulate para adoptar.

**Cuando hay filtros activos:**

> Mostrando **42 mascotas** en CABA · Belgrano · que se llevan bien con perros
> [Limpiar filtros]

**Cuando el filtro vacía el resultado:**

> No encontramos mascotas con esos filtros.
>
> Probá aflojar algún criterio, o mirá [todas las mascotas en adopción](/adoptar).

**Card de pet (PetListingCard):**

```
[foto cuadrada]
🏠 Logo Refugio
Negrita
Perra · Adulta · Mediana · Belgrano, CABA
"Llegó después de meses en la calle..."  ← primera línea de adoption_story, max 100 chars + "…"
[Ver ficha →]
```

**Footer de cada card** (badges chiquitos cuando aplican):

- "✓ Castrada"  ← solo si hay `sterilization_performed` event (lectura barata si lo cacheamos en `pets.is_sterilized` derived; o lo dejamos para v1.1)
- "🪪 Con chip"  ← `microchip_id IS NOT NULL`
- "💚 Necesidades especiales"  ← si `adoption_story` o `adoption_requirements` lo menciona explícitamente — **no automático**, requiere bandera del refugio. **Diferido a v1.1.** En v1 no mostramos este badge.

**Cuando NO hay mascotas listadas en absoluto en el sistema** (caso día 1 post-launch):

> Todavía no hay mascotas publicadas para adopción en MiMAR.
>
> Si trabajás en un refugio o rescate, [registralo](/refugios/nuevo) para empezar a publicar.

## 7. La ficha `/adoptar/{petToken}`

### 7.1 Sections

1. **Galería** — Si hay `primary_photo` + extra `attachments` con `pet_id`, carousel. Sin extras, foto única grande.
2. **Identidad** — Nombre, especie, raza (si no es mestizo / mestiza), edad bucket + DOB estimado si está, sexo, talle, color, distinguishing_features.
3. **Refugio responsable** — Logo + nombre + jurisdicción + link a `/refugios/{orgToken}` + "Mascota en custodia desde {ownerships.startedAt}".
4. **Historia** — `adoption_story` (markdown render, sanitized).
5. **Qué necesita su nuevo hogar** — `adoption_requirements` + checklist render de `good_with_*` + `needs_yard`.
6. **Salud** — Compactado de `pet_events` filtrado: vacunación al día (sí/no/parcial), castración (sí/no/pendiente), chip (sí + número parcialmente enmascarado, o no). **No mostramos detalle del libreta sanitaria entera** — el adoptante recibe acceso completo cuando se finaliza la adopción. Lo que se muestra acá es lo necesario para decidir postularse, no la historia clínica.
7. **Fee de adopción** — Si `adoption_fee_ars` no es NULL: "Adopción solidaria: $XXX. Este aporte ayuda al refugio a cubrir vacunación, castración y atención veterinaria." Si NULL: omitir.
8. **CTA primario** — Botón grande "Postularme para adoptar a {name}". El verbo es "postularme", no "reservar" (D7).
9. **Disclaimer** — "Tu postulación inicia un proceso con el refugio. Ellos coordinan visita, evaluación y, si todo encaja, la finalización de la adopción."

### 7.2 Cuando el pet ya no está listable

- Si `adoption_listed_at IS NULL` o `adoption_listing_paused_at IS NOT NULL` o `status='deceased'` o el current ownership cambió: **404**. El URL es para mascotas listables, no permalink eterno.
- Una excepción: si `adoption_finalized` fue reciente (last 7 days) y la ruta recibe la visita, mostrar mensaje suave: "🎉 ¡{name} ya encontró su hogar! Mirá [otras mascotas en adopción](/adoptar)." En lugar del 404 frío. Mejora UX para los que clickearon en un share viejo.

### 7.3 SEO / metadata

`generateMetadata` server-side:

- Title: `Adoptá a {name} — MiMAR`
- Description: primer ~150 chars de `adoption_story` o fallback "Conocé a {name}, {species} en adopción en {locality}"
- OG image: `primary_photo` URL
- Schema.org `Animal` (sin imagen — la tag OG ya cubre)

Open Graph permite que cuando el adoptante comparte el link por WhatsApp, aparezca la foto y el nombre. Importante para el North Star — la adopción viaja por WhatsApp.

## 8. El gate de auth en "Postularme"

### 8.1 Flujo cuando el visitante NO está autenticado

```
1. Visitante anónimo clickea "Postularme para adoptar a Negrita" en /adoptar/NEGRITA-TOKEN

2. Server action `startApplyIntent(petToken)`:
   - Verifica que el pet sigue listable (early bail si no — mostrar 404-ish)
   - Genera JWT firmado con payload:
       { kind: 'adoption_apply', petToken: 'NEGRITA-TOKEN', issuedAt: <now> }
       expiresIn: 15 minutes
   - Setea cookie httpOnly `adoption_apply_intent` con el JWT
   - Redirect: /signup?returnTo=/adoptar/NEGRITA-TOKEN/postular&intent=apply

3. Visitante ve signup con banner:
   "Para postularte a adoptar a Negrita, primero creá tu cuenta de MiMAR.
    Es gratis y te toma menos de un minuto.
    ¿Ya tenés cuenta? [Iniciar sesión]"

4. Completa signup (email + password + datos del owner principal de la cuenta + skip "agregá tu primera mascota" porque viene de adopt-intent — ver §8.3).

5. Post-signup callback redirige a returnTo URL (/adoptar/NEGRITA-TOKEN/postular).

6. La página /adoptar/NEGRITA-TOKEN/postular como server component:
   - Lee la cookie adoption_apply_intent
   - Verifica firma + expiry + petToken matches el del URL
   - Si OK: renderiza el form con context "Estás postulándote para adoptar a Negrita"
   - Si expiró: muestra "Tu sesión de postulación expiró. Volvé a la ficha y postulate de nuevo." con link a /adoptar/NEGRITA-TOKEN
   - Si petToken no coincide (manipulación): mismo mensaje suave de "expiró"
```

### 8.2 Flujo cuando el visitante YA está autenticado

```
1. Click "Postularme" → directo a /adoptar/NEGRITA-TOKEN/postular (sin JWT, sin redirect)
2. Server component renderiza el form
3. Submit → submitAdoptionApplicationAction
```

### 8.3 Tweak al signup flow cuando viene de adopción

`AGENTS.md → v1 screens` dice:

> **Signup** — email/password + "Connect with Mi Argentina" placeholder; *immediately* collects first pet profile (photo, name, species, base info) in same flow

Eso es razonable para el dueño que registra su mascota. **Pero** un visitante que viene a adoptar **todavía no tiene mascota propia para registrar.** Forzarlo a inventar un perfil de pet inexistente para crear cuenta es ridículo.

**Decisión:** cuando el query param `intent=apply` está presente, el signup salta el paso "agregá tu primera mascota". Crea cuenta con `role='owner'` + 0 mascotas. Después del callback, lo manda a `/adoptar/{token}/postular`. La cuenta queda válida; cuando el adoptante eventualmente finalice una adopción, su primera mascota aparece via `adoption_finalized` (Flow 7 del org portal).

Esto **NO requiere cambio de schema** — `owner` con 0 mascotas ya es estado válido. Solo es un branch en el signup wizard.

### 8.4 Form de postulación — campos

Coherentes con la payload de `adoption_application_submitted` (Flow 6):

```ts
payload: {
  applicant_user_id,       // del session
  related_organization_id, // del current shelter_custody ownership
  housing_type,            // 'casa_con_patio' | 'casa_sin_patio' | 'departamento' | 'otro'
  other_pets,              // text libre — "tengo un gato adulto y una perra senior"
  daily_routine,           // text libre — horas afuera de casa, quién la cuida
  notes,                   // anything else the applicant wants to say
}
```

UI:

```
Estás postulándote para adoptar a Negrita.
Refugio Belgrano Animales · CABA, Belgrano

Compartinos un poco sobre tu situación para que el refugio sepa si tu hogar
encaja con lo que necesita Negrita. El refugio te contactará a tu email
({session.email}) para coordinar los próximos pasos.

[Tipo de vivienda]
( ) Casa con patio
( ) Casa sin patio
( ) Departamento
( ) Otra

[¿Tenés otras mascotas?]
[textarea] (opcional, ej: "un gato castrado adulto, sociable")

[Cómo es tu día a día]
[textarea] (¿quién está en casa durante el día? ¿hay nenes? ¿alguien la cuida si viajás?)

[Algo más que quieras contar]
[textarea] (opcional)

[Enviar postulación]
```

Click "Enviar postulación" → `submitAdoptionApplicationAction`:

1. Verificar pet sigue listable (auto-cancel lazy parecido al patrón de lost-and-found). Si ya no, mostrar mensaje claro: "{name} ya no está disponible para adopción. Mirá [otras mascotas](/adoptar)."
2. Verificar que el applicant no tiene **otra postulación pendiente sin revisar** para el mismo pet (un solo `adoption_application_submitted` por (applicant, pet) sin `_approved` ni `_rejected` posterior). Si ya hay una, mostrar "Ya postulaste a {name}. El refugio recibió tu postulación el {date} y la está revisando." y NO emitir otra.
3. Insertar `pet_events` de tipo `adoption_application_submitted` con la payload (`recorded_by_user_id` = session user, `author_role='owner'`, `author_organization_id=null` — siguiendo Flow 6).
4. Insertar `notifications` a todos los admins/coordinators del refugio con `cta_url=/org/{orgToken}/adopciones/{applicationEventId}`.
5. Mostrar confirmación: "¡Listo! Tu postulación fue enviada. Refugio Belgrano Animales recibió tu mensaje y te contactará a {session.email}. Mirá tu inbox y también [tu cuenta en MiMAR](/mis-mascotas) para novedades."

**Lo que el postulante ve en `/mis-mascotas/postulaciones`** (D17 enforced): una lista de sus propias postulaciones con estado (`pendiente_de_revisión`, `en_revisión`, `aprobada`, `rechazada`, `cerrada_porque_otra_finalizó`). Cada item linkea de vuelta a `/adoptar/{petToken}` (si la mascota sigue listable) o muestra "Esta mascota ya encontró hogar" (si no). En ningún lugar aparecen otras postulaciones, ni count, ni cola. La privacidad del proceso del refugio es total.

### 8.5 RLS y permisos del form de postulación

- **SELECT** del pet en `/adoptar/{token}/postular` — la página lee el pet via server component (bypass RLS via Drizzle, mismo patrón que `/p/{publicToken}`). La protección viene de la verificación de listability.
- **INSERT** del evento — vía server action autenticada. RLS en `pet_events` permite INSERTs donde `recorded_by_user_id = auth.uid()` y el evento es un tipo whitelist (la lista de eventos owner-emit). `adoption_application_submitted` debe estar en esa whitelist; verificar en `db/rls.sql` antes de implementar.
- **El applicant NO tiene ownership sobre el pet** mientras la application está pending — eso es importante. No aparece en `/mis-mascotas`, no puede editar el pet, no puede ver la libreta. Sólo ve "Tu postulación está siendo revisada" en una nueva pestaña `/mis-mascotas/postulaciones` (o como sección del dashboard).

## 9. Edge cases

- **Pet con dos `shelter_custody` activas** (refugio A y refugio B, raro pero schema-permitido). El JOIN devuelve dos filas. La proyección hace `DISTINCT ON (pets.id)` por la más reciente `started_at` para evitar duplicados en el listing. La ficha individual muestra al refugio principal (el del listing) — si hay disputa, es problema del admin, no del adoptante.
- **Refugio se despublica del sistema** (`organizations.status='suspended'` o `verified=false` por revisión negativa). Sus listings desaparecen del feed inmediatamente (la condición está en el WHERE). Las postulaciones pendientes a esos pets quedan en la libreta del adoptante con un disclaimer "Este refugio ya no está activo en MiMAR" y el flow de adopción se interrumpe (sin auto-cancel — el admin coordina caso por caso).
- **Pet con `adoption_listed_at` pero sin `adoption_story`**. El listing igual lo muestra; la card usa fallback "{name} busca hogar a través de {Refugio}.". La ficha muestra "El refugio todavía no completó la descripción. Postulate igual y conocelo en persona." en lugar de la historia.
- **Adoptante autenticado postula a la misma mascota dos veces rápido** (double-click). El check de §8.4#2 lo previene server-side. Si ya hay una application pendiente, retorna idempotent success.
- **Diez personas postulan para Negrita en una semana.** La mascota sigue en `/adoptar` sin pausarse (D15). El refugio ve las 10 en `/org/[orgToken]/adopciones`, revisa, decide. Avanza con 3 en paralelo (review + visita). Aprueba 1 → `adoption_application_approved`. Finaliza esa 1 → `adoption_finalized` (Flow 7 transaccional). En la **misma transacción** del finalize: las otras 9 reciben `adoption_application_rejected` automático con reason `another_application_finalized`, y una notification empática (D16). Las 9 personas reciben el aviso, ven el estado actualizado en `/mis-mascotas/postulaciones`, y el refugio queda con su lista limpia.
- **Refugio aprueba dos postulaciones a la vez** por error de UI / race. El server action de `adoption.applications.approve` ya valida "máximo una `_approved` activa por pet" (Flow 6 de event flows). El segundo intento falla con error claro al operador del refugio.
- **El postulante quiere saber "cuántos somos compitiendo"**. La UI no lo expone (D17). Si pregunta al refugio por canal offline, decisión del refugio (no es nuestra capa).
- **Adoptante con cuenta `institutional`** (govt o admin) intenta postularse. Bloqueado server-side: institutional accounts no pueden owner (constraint #3 en AGENTS.md). Mensaje: "Las cuentas institucionales no pueden postularse para adoptar. Si querés adoptar como persona, creá una cuenta personal con otro email."
- **Filtro por `provincia` que no existe.** Mostrar mensaje "No reconocemos esa provincia" + link a /adoptar limpio. (En la práctica el FiltersBar usa un `select` cerrado, así que solo pasa con URLs manipulados.)
- **Cursor inválido / manipulado.** Server intenta parsear, falla, lo trata como ausente: vuelve a la primera página. Sin error 500.
- **Postulación a un pet `deceased` por race entre listing y muerte**. El check del §8.4#1 lo detecta. Mensaje suave; sin emitir evento (insertar un application sobre un pet muerto sería pre-condition violation del Flow 7).
- **Refugio toca "Despublicar" mientras alguien está completando el form.** El submit falla con el check de listability. El form muestra mensaje claro. Sin pérdida de datos: el text typeado queda en localStorage por 24h (mejora menor, opcional v1.1).

## 10. RLS y security

| Surface | Lee | Escribe |
|---|---|---|
| `/adoptar` listing | Server component vía Drizzle → bypass RLS. Filtros aplicados en query. | — |
| `/adoptar/{token}` ficha | Server component vía Drizzle. Verificación de listability hardcoded en el page handler. | — |
| `/adoptar/{token}/postular` | Server component verifica session + apply_intent JWT (si vino de signup) | Server action `submitAdoptionApplicationAction`. Verifica `auth.uid()`, valida pet listable, inserta `pet_events`. RLS sobre `pet_events` para INSERT debe permitir `adoption_application_submitted` con `recorded_by_user_id = auth.uid()`. |
| `/refugios/{orgToken}` | Server component público | — |
| `/mis-mascotas/postulaciones` (lista de mis postulaciones) | Authenticated client. RLS de `pet_events` para SELECT donde `recorded_by_user_id = auth.uid() AND event_type = 'adoption_application_submitted'` ya cubre. | — |
| `/org/{orgToken}/adopciones/{applicationEventId}` (vista del refugio) | Cubierto por org portal existente | Idem |

**PII en la ficha pública.** Nunca exponer email/teléfono del refugio en `/adoptar/{token}`. El contacto se materializa con la postulación (refugio recibe notif con datos del adoptante: email del applicant). El refugio decide cómo y cuándo contactar.

**PII del adoptante.** Email del applicant aparece en la notif al refugio. Phone del applicant **no se manda** automáticamente — el refugio lo pregunta en su contacto inicial o el adoptante lo escribe en `notes` voluntariamente. Default conservador: no compartimos teléfono sin consentimiento explícito.

**Apply intent JWT.** Firmado con `process.env.APPLY_INTENT_SECRET` (nuevo env var, agregar a `.env.example`). Si el secret rota, los intents viejos invalidan — comportamiento aceptable.

**Rate-limit del form de postulación.** 5 postulaciones por hora por user, 1 postulación por hora por (user, pet). Soft-limit en el server action; mensaje user-facing claro al alcanzarlo. Implementación: Redis-less via tabla `rate_limit_buckets` (existe ya en `db/schema.ts`? Si no, deferir a Fase 5 polish).

## 11. End-to-end happy path

```
T+0  Refugio "Belgrano Animales" hace intake de Negrita (Flow 1 del org portal).
     pets.adoption_listed_at = NULL  ← no listada todavía.

T+3d Coordinator del refugio entra a /org/[orgToken]/mascotas/{negritaToken},
     completa adoption_story + requirements + age_bucket='adult' + size='medium'
     + good_with_dogs=true + good_with_kids=true + fee=15000,
     toca "Publicar en /adoptar".
     pets.adoption_listed_at = now()

T+5d Pilar, vecina de Belgrano, abre /adoptar?provincia=CABA&localidad=Belgrano.
     Ve la card de Negrita. Click → /adoptar/{negritaToken}.

T+5d Pilar lee la historia, mira fotos, clickea "Postularme para adoptar a Negrita".
     Server detecta no-auth → JWT apply_intent + redirect a /signup?intent=apply&returnTo=...

T+5d Pilar completa signup (email, password). Signup branch detecta intent=apply,
     skip el "primera mascota". Cuenta creada con role=owner, 0 mascotas.

T+5d Callback redirige a /adoptar/{negritaToken}/postular. Server lee JWT,
     verifica firma + expiry + petToken match. Renderiza el form con context.

T+5d Pilar completa form (departamento, sin otras mascotas, trabajo desde casa),
     submit → submitAdoptionApplicationAction:
       · check pet listable ✓
       · check no application pendiente de Pilar para Negrita ✓
       · INSERT pet_events adoption_application_submitted
       · INSERT notifications al refugio
     Confirmación "Postulación enviada".

T+5d Refugio recibe notif. Coordinator entra a /org/{orgToken}/adopciones/{appId},
     revisa → adoption_application_reviewed.
     Decide aprobar → adoption_application_approved.
     Notif a Pilar "Tu postulación fue aprobada".

T+6d Refugio coordina visita offline. Todo OK. Coordinator
     adoption_finalized (Flow 7): ownership flip, reminders, Pilar
     primera mascota visible en /mis-mascotas.

T+6d Negrita YA NO aparece en /adoptar (la projection vuelve a evaluar:
     current ownership es 'owner' de Pilar, no 'shelter_custody' del refugio).
     pets.adoption_listed_at sigue seteado (audit) pero la WHERE clause
     filtra. Equivalentemente, podemos setear adoption_listed_at = NULL
     en el commit del Flow 7 — pero no es necesario; la projection es
     defensiva.

T+1M Reminder de check-in mes 1 dispara, Pilar emite post_adoption_checkin.
```

## 12. Phasing

**Fase 1 — Schema + listing query helper (1 PR).**
- Migración `pets`: 11 columnas adoption_* + 4 CHECK constraints + 1 partial index
- `lib/adoption-listing.ts`: `queryAdoptionListing`, types, `parseSearchParams`, `buildSearchParams`
- Unit tests del helper (filtros, cursor, edge cases de paginación)
- Sin UI todavía

**Fase 2 — Org-side: form de listing copy + toggle publicar/pausar (1 PR).**
- En `/org/[orgToken]/mascotas/{petToken}` agregar sección "Listing en /adoptar"
- Toggle "Publicar / Despublicar / Pausar" → server action `setAdoptionListingStatusAction`
- Form con textarea para story + requirements + selects para buckets + tri-state checkboxes para good_with_*
- **Nueva capability `adoption.listing.manage`** — agregarla al `Capability` union de `lib/org-permissions.ts` y a la matriz de `docs/org-portal-permissions.md`. Propuesta: `admin: yes`, `coordinator: yes`, `member: no`, `volunteer: no`, `foster: no`, `vet_individual: no` (mismas filas que `adoption.applications.*`).
- No emite `pet_events` (es contenido de listing, no fact del pet)
- **Server-side validations en `setAdoptionListingStatusAction` cuando action='publish' (D19, D20, D21)**:
  - `pets.adoption_eligible = true` → si false/null, error claro con CTA a marcar apta (D19)
  - `pets.in_custody_dispute = false` o null → si true, error "Esta mascota está en disputa de custodia. Resolvé la dispute antes de publicar." (D20)
  - `pets.rabies_observation_status != 'active'` → si active, error "Esta mascota está en período de observación sanitaria. Esperá al cierre del período antes de publicar." (D21)
  - `pets.status not in ('deceased', 'lost')` → si lost, error "Esta mascota está reportada como perdida. Marcala recuperada antes de publicar." Si deceased, error final (D18)
- Mismas validations corren como pre-check al cargar el form de listing copy: si alguno de los 4 guards falla, el form muestra el motivo + CTA y el botón "Publicar" queda disabled. El refugio puede igual editar la story/requirements para tenerla lista cuando el pet califique

**Fase 3 — Listing público + ficha individual (1 PR).**
- `app/(public)/adoptar/page.tsx` con FiltersBar, ResultsHeader, listado de PetListingCard, "Mostrar más"
- `app/(public)/adoptar/[petToken]/page.tsx` con la ficha completa
- generateMetadata para SEO + OG tags
- Skeleton + empty states + no-listings-yet message
- E2E mínimo: cargar /adoptar con filters via URL, verificar mascotas correctas

**Fase 4 — Gate de auth + apply intent + signup branch (1 PR).**
- Server action `startApplyIntent`
- JWT helper con `APPLY_INTENT_SECRET`
- Branch en signup wizard para `intent=apply`
- Cookie + redirect dance probado

**Fase 5 — Form de postulación + server action + notifs al refugio (1 PR).**
- `app/(public)/adoptar/[petToken]/postular/page.tsx`
- `submitAdoptionApplicationAction` con todos los checks
- `/mis-mascotas/postulaciones` mínimo (lista las pending del user, sólo las propias — D17)
- Rate-limit (deferir si no hay infra todavía)
- Confirmación post-submit

**Fase 5.5 — Cross-cutting: auto-rejection de pending al `adoption_finalized` (1 PR pequeño, en el org portal).**
- **Vive en código del org portal, no de `/adoptar`** — extiende el `finalizeAdoptionAction` que implementa Flow 7 (`docs/org-portal-event-flows.md`)
- Dentro de la misma `db.transaction` del finalize: `SELECT` todas las `adoption_application_submitted` para este pet que no tengan `_approved` / `_rejected` posterior, e insertar un `adoption_application_rejected` por cada una con payload `{ application_event_id, reviewer_user_id: <finalizer>, reason: 'another_application_finalized', auto_generated: true }`
- Insertar `notifications` empática a cada postulante: "{Pet.name} encontró hogar con otra postulación. Sabemos que es decepcionante. {Refugio} tiene otras mascotas en adopción → /adoptar?org={orgToken}"
- Tests: 0, 1, 5, 50 postulaciones pending → cascada correcta, idempotency si finalize se reintenta (poco probable post-tx pero defensivo)
- Actualizar `docs/org-portal-event-flows.md` Flow 7 con el nuevo paso (debería ser el paso 4.5 o equivalente, antes de las notifs)
- **Si esta Fase no se hace, las postulaciones zombies quedan visibles en `/mis-mascotas/postulaciones` de cada postulante sin estado actualizado.** Aceptable temporalmente pero feo

**Fase 6 — Polish (opcional).**
- Badges "Castrada" / "Con chip" en cards (proyección rápida de events)
- Página del refugio `/refugios/{orgToken}` con sus pets en adopción
- localStorage backup del form de postulación
- Filtro por `vaccinated` cuando tengamos un campo derivado en `pets`
- Recently-adopted celebration page en lugar del 404 cuando aplica

Total: ~6-7 PRs chicos, ~1.5 semanas. Cada fase entregable de forma independiente — desde la 1 ya hay valor (helper testeado y schema lista), desde la 2 el refugio puede preparar contenido, desde la 3 el listing es navegable, desde la 5 cierra el loop, desde la 5.5 las cascadas son limpias.

## 12.5 Addendum v1.4 — Consent + history sharing

Materializa D22. Self-contained: schema delta + form field + RLS extension + nueva view org-side, todo en un solo lugar.

### 12.5.1 Schema delta

Cuando se cree la tabla `adoption_applications` (Fase 1 del plan de listing-public), incluir:

```ts
// db/schema.ts → adoptionApplications
profileSharingConsentAt: timestamp('profile_sharing_consent_at', { withTimezone: true }).notNull(),
// CHECK: required at INSERT time. No nullable; el server action lo setea con now()
// si la checkbox del form viene marcada. Sin marcar → server action rechaza
// con error "Consent obligatorio".
```

Migration SQL agrega CHECK defensive:

```sql
alter table adoption_applications
  add constraint adoption_applications_consent_required
  check (profile_sharing_consent_at is not null);
```

### 12.5.2 Form field — `/adoptar/{petToken}/postular`

Agregar como último campo del form de §8.4, ANTES del botón "Enviar postulación":

```
[ ] Acepto compartir con Refugio Belgrano Animales mi historial de adopciones,
    fosters y mascotas registradas en MiMAR para esta postulación. El refugio
    solo accederá mientras mi postulación esté abierta y dejará de verlo en
    cuanto la postulación cierre (sea aprobada, rechazada o cancelada).
    [Más info sobre tu privacidad — Ley 25.326]

[Enviar postulación]   ← deshabilitado hasta tildar el checkbox
```

El link "Más info sobre tu privacidad" abre modal con copy:

> Bajo la Ley 25.326 (Protección de Datos Personales), tus datos solo pueden compartirse con consentimiento informado y para un propósito específico.
>
> **Qué compartirías:** la lista de tus adopciones previas en MiMAR (con outcome — exitosa, revertida, etc.), tus fosters previos, tus mascotas registradas actualmente (species, sex, año aproximado de nacimiento, no nombre completo del veterinario ni medical detail). NO compartirías: tus notificaciones, otras postulaciones a OTRAS mascotas, denuncias de bienestar que hayas hecho, dirección exacta.
>
> **Por cuánto tiempo:** solo mientras tu postulación a [Negrita] esté abierta. Al cerrarse, el refugio pierde acceso inmediatamente.
>
> **Por qué te pedimos esto:** el refugio toma mejor decisión con contexto. Una persona con buena trayectoria de adopciones previas (checkins regulares, sin reversiones) tiene más probabilidad de ser elegida. Sin el consent, el refugio decide solo con lo que escribís acá.

UI behaviour:
- Checkbox unchecked por default — el usuario lo tilda activamente.
- Submit button disabled hasta tildar.
- Mensaje del checkbox y modal en es-AR.
- Idempotente al re-render del form (recordá el state via `useState`).

### 12.5.3 Server action — `submitAdoptionApplicationAction`

Extender el flow de §8.4#3:

3. Validar `payload.profile_sharing_consent === true`. Si no, error 400 con copy "Consent obligatorio".
4. Insertar `adoption_applications` con `profile_sharing_consent_at = new Date()`.
5. (Resto del flow igual: emitir event, notificar al refugio, etc.)

### 12.5.4 Vista nueva org-side — "Historial del postulante en MiMAR"

Ubicación: dentro del detail de la application en `/org/{orgToken}/adopciones/{applicationId}`. Card colapsado que se expande on click ("Ver historial del postulante en MiMAR →").

Mock:

```
┌──────────────────────────────────────────────────────────────┐
│ Historial de Juan Pérez (juan@ejemplo.com) en MiMAR          │
│                                                              │
│ ╶─ Mascotas actuales ─╴                                      │
│   🐕 Negrita (perro, hembra, ~2018) — actual desde 2024-03   │
│   🐈 Luna (gato, hembra, ~2020) — actual desde 2022-08       │
│                                                              │
│ ╶─ Adopciones previas ─╴                                     │
│   2024-03  Refugio Patitas Vagabundas  → Negrita             │
│            ✓ Adopción completada · 12 checkins en seguimiento│
│   2022-08  Refugio Otro                → Luna                │
│            ✓ Adopción completada                             │
│                                                              │
│ ╶─ Fosters previos ─╴                                        │
│   2023-06 → 2023-09  Refugio Tres Patas  · 3 pets            │
│            ✓ Todos terminados a adopción/return ok           │
│                                                              │
│ ╶─ Postulaciones previas (a esta organización) ─╴            │
│   2024-01  → Manchas  · rechazada (motivo: housing_size)     │
│                                                              │
│ ⓘ Tu acceso a este historial cierra cuando esta postulación  │
│   se cierre. Hoy: visible.                                   │
└──────────────────────────────────────────────────────────────┘
```

**Lo que NO se muestra**:
- Notificaciones del applicant
- Postulaciones a otras orgs (sí postulaciones previas a ESTA org como contexto)
- Denuncias welfare en las que el applicant figure como reporter
- Medical detail de las mascotas (nombre del vet, medicamentos específicos)
- Dirección exacta, DNI, teléfono salvo email (que viene del form)

### 12.5.5 RLS extensions

Sobre `pets`, `ownerships`, `pet_events`:

```sql
-- pets: org receptora de adoption_application open con consent active read
-- los pets del applicant
create policy pets_select_visible_to_active_applicant_review on pets for select
  using (
    exists (
      select 1
      from ownerships o
      inner join adoption_applications app
        on app.applicant_user_id = o.owner_user_id
       and app.profile_sharing_consent_at is not null
      inner join cases c
        on c.adoption_application_id = app.id
       and c.status in ('open', 'escalated')
      inner join organization_memberships m
        on m.organization_id = c.opened_by_organization_id
       and m.user_id = auth.uid()
       and m.left_at is null
      where o.pet_id = pets.id
        and o.role = 'owner'
        and o.ended_at is null
    )
  );

-- ownerships: idem chain
create policy ownerships_select_visible_to_active_applicant_review on ownerships for select
  using (
    exists (
      select 1
      from adoption_applications app
      inner join cases c on c.adoption_application_id = app.id
      inner join organization_memberships m on m.organization_id = c.opened_by_organization_id
      where app.applicant_user_id = ownerships.owner_user_id
        and app.profile_sharing_consent_at is not null
        and c.status in ('open', 'escalated')
        and m.user_id = auth.uid()
        and m.left_at is null
    )
  );

-- pet_events: limitado a tipos non-sensitive (libreta sanitaria + ownership audit, NO welfare denuncias bridge events)
create policy pet_events_select_visible_to_active_applicant_review on pet_events for select
  using (
    pet_events.event_type in (
      'pet_registered', 'pet_profile_updated',
      'vaccination_administered', 'deworming_administered', 'sterilization_performed',
      'vet_visit_logged', 'weight_recorded',
      'post_adoption_checkin',
      -- adoption_application_* del applicant a la MISMA org (contexto histórico interno)
      'adoption_application_submitted', 'adoption_application_resolved',
      'adoption_finalized', 'adoption_reversed',
      'foster_assigned', 'foster_ended'
      -- NOT: maltreatment_reported, abandonment_reported, symptom_observed, custody_dispute_*
    )
    and exists (
      select 1
      from ownerships o
      inner join adoption_applications app on app.applicant_user_id = o.owner_user_id
      inner join cases c on c.adoption_application_id = app.id
      inner join organization_memberships m on m.organization_id = c.opened_by_organization_id
      where o.pet_id = pet_events.pet_id
        and o.role = 'owner'
        and o.ended_at is null
        and app.profile_sharing_consent_at is not null
        and c.status in ('open', 'escalated')
        and m.user_id = auth.uid()
        and m.left_at is null
    )
  );
```

**Reverse**: cuando `cases.status` se flippea a `closed`/`merged` (resolved, cancelled, cascade rejected), la sub-query interna devuelve false → acceso revoca automáticamente sin necesidad de cleanup explícito. Mismo patrón scope-bound que welfare denuncias.

### 12.5.6 Tests (extender la batería del plan de listing-public)

```ts
// __tests__/adoption-application-consent.test.ts
it('form sin consent → submit rechazado con error claro');
it('form con consent → INSERT exitoso, profile_sharing_consent_at populated');

// __tests__/adoption-application-history-rls.test.ts
it('org members ven historial del applicant mientras app open');
it('org members PIERDEN visibilidad cuando app cierra (resolved)');
it('org members PIERDEN visibilidad cuando app cierra (cascade rejected)');
it('org members NO ven welfare denuncias del applicant ni en app abierta');
it('user que NO es org member NO ve historial');
it('applicant NO ve "el refugio te está mirando" — no signal del access');
```

### 12.5.7 Dependencias

Esta v1.4 requiere el **sistema de casos implementado** (`plans/2026-05-19-cases-system.md`) porque las RLS extensions del §12.5.5 chainean por `cases.adoption_application_id` y `cases.status`. Orden:

1. Implementar listing-public Fase 1-2 (schema base).
2. Implementar sistema de casos (Fases A-F).
3. Implementar listing-public Fase 3+ + agregar el v1.4 addendum (form field + RLS + view org-side).

Si urge shipear listing-public ANTES del sistema de casos, el v1.4 addendum se pospone — listing-public v1.3 sigue siendo functional sin consent + history (decisión del Producto: hay valor en shipear v1.3 sin v1.4).

## 13. Lo que NO está en este diseño

- **Recommendations / matching algorítmico.** Listing es plano + filtros. Sin "mascotas para vos basadas en tu perfil". El refugio es el que matchea, no el sistema.
- **Favoritos del visitante / wishlist.** Diferido a v1.1.
- **Notificaciones al adoptante anónimo "esta semana se publicaron 12 nuevas mascotas en Belgrano".** Implica capturar email pre-signup — fuera de scope.
- **Donaciones / aportes al refugio integradas.** El refugio lo maneja por canales propios; DIM no procesa pagos en v1.
- **Compartir el pet por WhatsApp con botón nativo.** El share-intent es feature genérica del browser; agregamos un botón explícito en v1.1 si hay demanda.
- **Mapa geográfico del listing.** Lista + filtros lineales. Mapa es proyección welfare-officer-style, fuera de scope para usuario consumer.
- **Adopciones internacionales / transporte.** Lista por jurisdicción argentina; el refugio puede vetar postulaciones de otras provincias en su review.
- **Multi-pet adoption** ("adoptar dos hermanitos juntos"). Cada pet su listing, cada postulación su evento. El refugio coordina si los quiere mantener juntos via copy en el story.
- **Auto-finalización si el refugio no responde X días.** Manual via admin.
- **API pública del listing** (para que sitios externos lo embeban). Diferido — primero validamos el caso de uso directo.
- **Animales BA federation** — diplomatic, deferred (igual que en lost-and-found spec).
- **Métricas / analytics del listing** (postulaciones por refugio, conversión por pet, etc.) — primer feature welfare-officer dashboard cuando esa surface arranque.
- **Cron de auto-pause** para listings inactivos meses sin update. Manual hasta que el volumen lo justifique.

---

## Próximo paso

Cuando este diseño tenga OK final, partimos en planes de implementación. Las Fases 1, 3 y 5 son las críticas (foundation + listing visible + cierre del loop). Fases 2 y 4 son habilitadores. Fase 6 es polish opcional.

Si querés ajustar algo antes de los planes — copy específico, los 11 campos adoption_*, el flujo del JWT, el tamaño de página (24 vs 12) — **mejor decirlo ahora** que después.

Decisiones cerradas en la review:

- ✅ **Sin "reserva".** El botón es "Postularme para adoptar a {name}". La palabra "reservar" no aparece en copy de UI, label de botón, ni en notifications. Múltiples postulaciones simultáneas son normales — el refugio elige (D7 v1.1).
- ✅ **Cinco buckets de edad granulares** (`puppy | junior | young | adult | senior`). Mapping a labels es-AR en §4.2.

Open questions cerradas en v1.3:

- ✅ **Pausa preserva listing copy** (D3 confirmado). Menos fricción para el refugio: pausa = hide del listing, conserva story/requirements/buckets intactos. Unpause = poner `adoption_listing_paused_at = NULL` y el contenido sigue.
- ✅ **JWT del apply intent expira a 15 min** (D6 confirmado). Razonable para signup flow rápido. Si emerge demanda de timeout más largo (verificar email, recuperar password, etc.) se sube en una iteración futura sin breaking change.
