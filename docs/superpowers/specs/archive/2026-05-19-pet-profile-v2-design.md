# Pet profile v2 + Achievements — design spec

> Rediseño del perfil de mascota en `/mis-mascotas/[publicToken]`. Hoy la página acumula timeline de eventos + libreta + recordatorios + acciones — terminó siendo un dump cronológico. v2: el profile pasa a ser un **resumen vivo** del estado actual de la mascota (info dinámica derivada de los datos), saca la lista de eventos cruda (que vive en `/libreta`, `/historial` y `/anotar`), e introduce **achievements** como gamification suave que enseña al dueño qué hitos le agregan valor al record de su mascota.
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Estado:** 🟢 Shipped 2026-05-22 (PR #127 (repositorio anterior, privado) open vs develop)
> **Versión:** 1.2 — SDD aplicado completamente. Slice A (foundational refactor + perf win + tattoo R5 gap) + Slice B (pet_achievement_views + actions + T7-B1/B2 row). Slice C (PPP on /p/, Modo presentación) deferred to follow-up SDD change.
>
> **Versiones previas:** 1.0 — diseño inicial con achievements POC.
>
> **Depende de:** los specs cases-system (`2026-05-19-cases-event-attachment-design.md` + `2026-05-19-cases-lifecycles-design.md`) si se quiere mostrar "Casos abiertos" en el profile. Independiente del resto.
>
> **Cierre v2.1 (2026-06-18, Item 6 — `2026-06-18-pet-profile-v21-reorder-and-action-consolidation-design.md`):** dos puntos del v2 quedaron resueltos. (1) **Timeline = tab (cerrado).** El v2 spec proponía "sacar el timeline del perfil → vive en `/libreta` y `/historial`"; la implementación lo trajo de vuelta como pestaña y v2.1 lo ratifica: el timeline vive como tabs dentro del perfil (Resumen · Libreta · Vacunas · Historial), y `/libreta`, `/historial`, `/vacunas` son redirects permanentes a `?tab=…`. (2) **PPP + perro de servicio son credential cards dentro de Resumen** (sección 03), no banners full-width arriba del hero. El orden final del perfil es identidad (hero) → avisos (`PetAlertStrip` priorizado) → acciones → tabs; credenciales y logros dentro de Resumen.

---

## 1. Por qué este documento existe

El profile actual (`app/(app)/mis-mascotas/[publicToken]/page.tsx`) hace tres cosas a la vez:

- **Identidad**: foto, nombre, especie/sexo/edad, microchip — info clave de la mascota.
- **Resumen operativo**: próximas vacunas, dosis de medicación pendientes, recordatorios.
- **Timeline cronológico**: lista completa de pet_events, con su `<EventTimeline>` y filtros de libreta.

Problemas:

1. El **timeline mete ruido**. El dueño que entra al profile quiere saber "¿qué pasa con mi mascota HOY?" — no leer 200 events crudos del último año.
2. La libreta sanitaria ya tiene su propia ruta dedicada (`/libreta`) desde el spec de libreta-sanitaria. Duplicar el timeline en el profile fragmenta la atención.
3. La captura rápida (`/anotar`) y los formularios `/eventos/*` ya son el camino de entrada para crear events. No tiene sentido también mostrarlos como timeline en el profile.
4. **No hay storytelling**. El dueño no ve "tu mascota tiene 3 años con vos", "vivió 1 episodio de pérdida y volvió a casa", "fue adoptada", "está registrada como animal de servicio". Datos importantes y emocionalmente significativos quedan enterrados en payloads de events.

v2 reorganiza:

- **El profile = identidad + estado vivo + achievements + acciones primarias**. Sin lista de events.
- **`/libreta`** sigue siendo el archivo médico estructurado (sin cambios — ya está implementado).
- **`/historial`** (ya existe) sigue siendo la timeline completa cronológica para quien la necesita (vet, audit, dueño curioso).
- **`/anotar`** (ya existe) sigue siendo el entry point para registrar events nuevos.
- **Achievements** — sección nueva con badges automáticos derivados del state + event log. Empezamos con 5 POC.

---

## 2. Decisiones cerradas

| # | Decisión | Razón |
|---|---|---|
| PP1 | **Sacar el `<EventTimeline>` del profile**. La sección "Eventos" desaparece. El profile no muestra ninguna lista de events crudos | Reduce ruido, deja la timeline donde pertenece (`/historial`) |
| PP2 | **Profile = "snapshot vivo"**. Cada sección muestra **info derivada del estado actual**, no events crudos. Ejemplos: "Próxima vacuna antirrábica vence en abril 2026", "Última vez pesada hace 2 meses: 12.4 kg", "Esterilizada", "Microchip implantado el 2024-03". | El dueño quiere saber estado, no historia. Si quiere historia, va a `/libreta` o `/historial` |
| PP3 | **Las secciones "vivas" se computan en server component** vía query sobre el último event relevante por kind, NO requieren materialización. Patrón existente para `pets.estimated_weight_kg` (denormalized cache) se mantiene; otras se computan on-read | KISS. Si hay performance issue real (no especulativo), materializar después con un campo nuevo en `pets` |
| PP4 | **5 achievements POC en v1**: animal de servicio, fui adoptado, me perdí pero volví, tuve crías, trotamundos. Cada uno con: icono, copy curado, condición de cómputo declarativa, y opcional "earn at" timestamp para mostrar cuándo | Empezar chico, validar UX antes de inflar el catálogo |
| PP5 | **Achievements son computados on-read** (sin tabla `pet_achievements` en v1). Función pura `getEarnedAchievements(pet, events, serviceDog, cases) → Achievement[]`. Si la performance lo requiere después, materializar | Mismo principio que PP3. Sin schema migration al introducir achievements; agregar achievement = agregar entry al catálogo |
| PP6 | **Algunos achievements requieren event_types nuevos** ("tuve crías" → no existe), otros requieren payload additions ("trotamundos" → no existe `pet_traveled_abroad`). Para v1, los achievements que NO se puedan computar con el catálogo actual se declaran como `not_yet_computable` y se muestran en UI con copy "Próximamente — requiere registrar [X tipo de evento]". Los event_types nuevos se agregan en specs follow-up si Producto los prioriza | Permite shipear el system de achievements sin bloquear en el catálogo de events |
| PP7 | **Achievements se muestran como chips horizontales** debajo del nombre/foto, antes de las secciones de info viva. Tap/click en un chip abre tooltip con copy + fecha de earn. Sin sección colapsable separada — están a la vista de entrada | Visibilidad. Esconder achievements en sección colapsable los vuelve invisibles. Chips son escaneables y celebran al dueño cuando entra |
| PP8 | **Achievements son owner-visible solamente** en v1. NO aparecen en credencial pública Tier 0 / Tier 1, NO los ve el refugio en `/org/[orgToken]`, NO los ve govt. El consent de §12.5 v1.4 de adoption-listing podría exponerlos al refugio durante review futuro pero NO en v1 | Privacy first. Compartir externamente requiere consent explícito por surface — diferido |
| PP9 | **Empty state cuando hay 0 achievements**: mostrar 1 chip vacío "Tu mascota recién empieza su historia en MiMAR" con icono 🌱. Sin lista vacía o "Sin logros". Tono cálido | UX. La primera vez que el dueño entra (recién registró), no debe sentir que está atrás de nadie |
| PP10 | **El profile mantiene las acciones primarias visibles** que ya están: registrar evento (link a `/anotar`), libreta completa, historial completo, perdida, devolución, asistencia, microchip, editar perfil. Las saca del medio del page (donde están hoy intercaladas con events) y las agrupa en un **menu de acciones** consistente arriba o abajo del profile | Las acciones tienen que seguir siendo accesibles — solo cambia la jerarquía visual |
| PP11 | **"Casos abiertos" se muestra como una sección dedicada arriba** del profile cuando hay ≥1 caso abierto sobre la mascota. Cada caso es chip clickable a `/casos/[publicCode]`. Sección oculta cuando no hay casos. Requiere el sistema de casos implementado. | Coherencia con la prioridad asignada al sistema de casos: si una pet tiene un bite_incident abierto, esa info es lo primero que debe ver el dueño |

---

## 3. Estructura del profile v2

Layout vertical, mobile-first. Width max `max-w-2xl`, consistente con el resto del owner portal.

```
┌──────────────────────────────────────────────────────────────┐
│  [← Volver a mis mascotas]                                   │
│                                                              │
│  ╶─ [Casos abiertos: 2] ───────────────────────────╴ (cond.) │
│   📋 CAS-XK3P · Observación antirrábica (día 4/10)           │
│   🐾 CAS-9DLM · Adopción en seguimiento (mes 2/12)           │
│                                                              │
│  ┌──────────┐                                                │
│  │  [foto]  │   Negrita                                      │
│  │  120px   │   Perra · hembra · ~6 años                     │
│  │          │   En tránsito desde 2024-03 (vecina Patricia)  │
│  └──────────┘                                                │
│                                                              │
│  Logros · 🏆 ──────────────────────────────────              │
│  [⚓ Fui adoptada] [🦮 De servicio] [🌍 Trotamundos]         │
│  [🏠 Me perdí y volví ×2]                                    │
│                                                              │
│  ╶─ Estado actual ─────────────────────────────────╴         │
│   Peso: 12.4 kg (hace 2 meses)                               │
│   Salud: vigente · Próxima vacuna antirrábica: abril 2026    │
│   Esterilización: ✓ realizada                                │
│   Microchip: 941-000xxxxxxxx · implantado 2024-03            │
│   Alergias: pollo                                            │
│   Entrenamiento: básico                                      │
│                                                              │
│  ╶─ Cuidados próximos ────────────────────────────╴          │
│   💊 Dosis de Tramadol en 4h (HOY 18:00)                     │
│   📅 Turno con vet Pérez mañana 10:00                        │
│   💉 Vacuna antirrábica vence en 2 meses                     │
│                                                              │
│  ╶─ Acciones ──────────────────────────────────────╴         │
│   ↗ Registrar algo nuevo (/anotar)                           │
│   📔 Ver libreta sanitaria completa                          │
│   📜 Ver historial completo                                  │
│   ✏ Editar perfil                                            │
│   🆔 Datos legales / Ley 26.858                              │
│   🆘 Marcar como perdida                                     │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Secciones detalladas

### 4.1 Header de identidad

Lo que YA tiene + ajustes:

- Foto grande (siempre), 120×120px circular.
- Nombre, especie + sexo + edad (calculada en runtime).
- Custody role badge si NO es owner permanente: "En tránsito desde [date]" para `shelter_custody`, "Foster desde [date]" para `foster`, "Co-dueña" para `co_owner`. NO mostrar nada extra para `owner` (es el default esperado).
- Si la pet es `deceased` → cambia el layout entero al "in memoriam" view (ya existe y se mantiene).

### 4.2 Sección "Casos abiertos" (condicional)

Solo se renderiza si la mascota tiene ≥1 caso con `status IN ('open', 'escalated')`.

Lookup: `SELECT * FROM cases WHERE primary_pet_id = pet.id AND status IN ('open', 'escalated') ORDER BY opened_at DESC LIMIT 5`.

Cada caso es un row con:
- Ícono por kind
- `public_code` (CAS-XXXX-XXXX) corto
- Label del kind + phase actual computada
- Link al detail `/casos/[publicCode]`

Si hay >5 casos abiertos (raro), mostrar "Ver todos los casos (N) →".

Dependencia: requiere sistema de casos implementado. Si no está implementado al momento de shipear v2 del profile, esta sección queda como TODO comentado y se activa en el PR del sistema de casos.

### 4.3 Sección "Logros" (achievements chips)

Computado on-read. Función `getEarnedAchievements(pet, events, serviceDog, cases): EarnedAchievement[]`.

Si `EarnedAchievement[].length === 0` → render del empty state PP9.

Si ≥1 → chips horizontales scrollables (overflow-x-auto). Cada chip:

```
┌──────────────────────────┐
│ [icon] [label] [×count]? │  ← className: rounded-full px-3 py-1
└──────────────────────────┘    border, hover, tap-target 44×44
```

Click en chip → tooltip / modal compacto con copy expandido + fecha de earn.

### 4.4 Sección "Estado actual"

Información derivada. Cada línea es un computed field:

| Línea | Fuente |
|---|---|
| Peso | `pet.estimated_weight_kg` (ya denormalized) + último `weight_recorded.occurred_at` para el "hace X" |
| Salud / próxima vacuna | Lookup del último `vaccination_administered` por `vaccine_name` ∈ vacunas core (antirrábica especialmente). Compute `next_due_at` y formatear |
| Esterilización | EXISTS de `sterilization_performed` |
| Microchip | `pet.microchip_id` (ya en la table) + `pet.microchip_implanted_at` |
| Alergias | `pet.known_allergies` (denormalized) |
| Entrenamiento | `pet.training_level` |
| Foods | `pet.favourite_foods` (renderizar como lista corta si hay) |

Cada línea **sin línea = sin renderizar** (no mostrar "Peso: —"). Si la pet no tiene nada cargado, la sección entera muestra "Cargá información para ver el resumen aquí" + link a `/editar`.

### 4.5 Sección "Cuidados próximos"

Reuso de la lógica actual del profile (próximas vacunas + medication doses + appointments). Sin cambios funcionales — solo se mueve abajo de "Estado actual" como sección dedicada.

Items ordenados por `due_at` ascending. Top 5 mostrados; si hay más → "Ver todos →" link.

### 4.6 Sección "Acciones"

Menu vertical de acciones, agrupado y consistente. Lo que hoy aparece esparcido se concentra acá:

```
↗ Registrar algo nuevo                    → /mis-mascotas/[token]/anotar
📔 Ver libreta sanitaria                  → /mis-mascotas/[token]/libreta
📜 Ver historial completo                 → /mis-mascotas/[token]/historial
✏ Editar perfil                           → /mis-mascotas/[token]/editar
🆔 Datos legales / Ley 26.858             → /mis-mascotas/[token]/asistencia (si dog Y role=owner)
🆘 Marcar como perdida                    → /mis-mascotas/[token]/perdida (si status=active)
🔍 Confirmar devolución                   → /mis-mascotas/[token]/devolucion (si status=lost Y hay proposal pendiente)
🪙 Confirmar microchip                    → /mis-mascotas/[token]/eventos/nuevo/microchip (si pet sin chip)
```

Cada acción es un row con icon + label + arrow → consistente con design system.

Los conditional rendering rules (Ley 26.858 solo dog+owner, perdida solo status=active, etc.) los hereda del fix de service dog (`fix-service-dog-404.md`) y del lost-and-found spec.

---

### 4.7 Sección "PPP — Animal Potencialmente Peligroso" (condicional, v1.1)

**Condición de render**: `pets.potentially_dangerous_breed === true`.

Aparece **arriba** del profile (similar a Casos abiertos), entre el Header de identidad y la sección de Achievements. Visual: card amber/naranja, prominent pero no alarmante (es status legal, no peligro inminente).

```
┌──────────────────────────────────────────────────────────────┐
│ ⚠ Raza considerada Potencialmente Peligrosa (PPP)            │
│                                                              │
│ Por la raza de {pet.name} ({breed_label}), está sujeta al    │
│ régimen de la Ley CABA 4078 / Ley Prov 14.107.               │
│                                                              │
│ ╶─ Atestación ─╴                                             │
│   {if dangerous_breed_attested exists:}                      │
│   ✓ Atestada en {registry_label} el {attested_at}            │
│      Nº de registro provincial: {registry_id}                │
│   {else:}                                                    │
│   ⚠ Atestación pendiente.                                    │
│      → Registrar atestación                                  │
│                                                              │
│ ╶─ Requisitos generales (informativos) ─╴                    │
│   • Bozal y correa corta en vía pública                      │
│   • Seguro de responsabilidad civil recomendado              │
│   • Identificación visible permanente                         │
└──────────────────────────────────────────────────────────────┘
```

**Componentes:**

- **Display obligatorio**: status PPP es público (Ley 4078 lo requiere). Por eso aparece TAMBIÉN en el credencial público Tier 0 (`/p/[publicToken]`) con badge "PPP" + breve disclaimer. Esto es decisión del propio Ley 4078 — el público tiene derecho a saber. NO es opcional como el banner de service dog (Ley 25.326 protege ese otro caso).
- **Atestación**: cuando NO existe `dangerous_breed_attested` event en el pet, se muestra el CTA "Registrar atestación". Click → `/mis-mascotas/[token]/ppp/atestar` (ruta nueva si no existe; verificar). Form captura `registry` (caba_4078 | prov_14107 | other) + `registry_id` + `attested_at`. Emite `dangerous_breed_attested` event. Después de eso, la sección muestra el ✓ con detalle.
- **Requisitos informativos**: copy estática derivada de `lib/case-normatives.ts` o lookup similar (cuando esté el sistema de business rules del item #9 implementado, esto vendrá del lookup `(country='AR', province=X, locality=Y, rule_type='ppp_requirements')`).
- **Sin export real en v1**: el registro provincial real (export to ANIMALES BA / Registro Nacional de PPP) es **placeholder**. El sistema captura la atestación localmente y la muestra. Cuando exista integración real con el registro provincial, se agregará un botón "Sincronizar con registro provincial" + audit log. Por ahora la atestación es declarativa del dueño, no verificada por el registro.

**Achievement implications**: NO hay achievement positivo por ser PPP — es un status legal, no un logro. Sí hay implicación negativa para `i_was_adopted` cascade: las orgs que listan PPPs en `/adoptar` deben marcar visiblemente esta condición (decisión del adoption-listing spec D1).

### 4.8 Sección "Credencial de perro de asistencia" (condicional, v1.1)

**Condición de render**: existe `pet_service_dog` row para el pet Y `credential_status='vigente'` Y `in_service=true`.

Aparece **arriba** del profile (después de PPP si ambos existen, antes de Achievements). Visual: card emerald/verde tipo tarjeta de identificación, dignified.

```
┌──────────────────────────────────────────────────────────────┐
│  ┌───────────────────────┐  CREDENCIAL DE PERRO DE ASISTENCIA│
│  │  [foto pet circular]  │  Ley 26.858                       │
│  │  80px                 │                                   │
│  │                       │  {pet.name}                       │
│  └───────────────────────┘  {service_type_label}             │
│                              Microchip: {microchip_id}        │
│                              RUPGA: {rupga_credential}        │
│                              Centro de entrenamiento:         │
│                                {training_center}              │
│                              Emitida: {credential_issue_date} │
│                              Vence: {credential_expiry_date}  │
│                                                              │
│  Esta credencial habilita el acceso, deambulación y          │
│  permanencia de la mascota en todos los espacios públicos    │
│  y privados de uso público, conforme a la Ley 26.858.        │
│                                                              │
│  → Presentar credencial (pantalla completa, modo offline)    │
└──────────────────────────────────────────────────────────────┘
```

**Comportamientos clave:**

- **Modo presentación**: el botón "Presentar credencial" abre la vista en pantalla completa optimizada para mostrar a un guardia/recepcionista. Sin chrome, fondo neutro, QR opcional (linkea a `/p/[publicToken]` para verificación externa). Funciona offline (carga server-side todo lo necesario al primer render).
- **Visibility public**: respeta `pet_service_dog.publicVisibility`. Si `'full_banner'` → el credencial aparece TAMBIÉN en `/p/[publicToken]` como banner. Si `'private_only'` → solo aparece en el profile del owner. El default es `'private_only'` por Ley 25.326 (la info de discapacidad es sensible y la presencia del banner público revela esa info indirectamente).
- **Expiry warning**: si `credential_expiry_date` está en los próximos 30 días → badge warning "Renovar pronto" + CTA "Actualizar credencial".
- **Status not vigente**: si `credential_status IN ('pendiente_verificacion', 'vencida', 'revocada')` → la card NO se muestra como credencial; en su lugar aparece un row en la sección "Acciones" del profile ("🆔 Credencial Ley 26.858 — status: {label} →") que linkea a `/asistencia` para resolver.
- **Disability information**: por Ley 25.326 (Art. 7) **NUNCA se muestra qué discapacidad tiene el dueño**. La credencial es del PERRO + su training + su compliance, no del dueño. El service_type (e.g., "Perro guía") es atributo del perro, no etiqueta del dueño.

**Diferencia con la card PPP del §4.7**: PPP es status REGULATORIO PÚBLICO del animal (todos pueden saber, por Ley 4078). Service Dog es CREDENCIAL DEL ANIMAL que habilita derechos del dueño (solo el dueño elige cuándo y a quién mostrarla, por Ley 25.326). Visual y semánticamente distintas.

### 4.9 Orden vertical de secciones en el profile v2 (resumen actualizado v1.1)

```
1. BackLink
2. [cond] Casos abiertos (§4.2)
3. [cond] PPP card (§4.7)
4. [cond] Service dog credential card (§4.8)
5. Header de identidad (§4.1)
6. Achievements chips (§4.3)
7. Estado actual (§4.4)
8. Cuidados próximos (§4.5)
9. Acciones (§4.6)
```

Las dos cards nuevas (PPP, Service Dog) tienen precedencia visual SOBRE Header + Achievements porque son status legales destacados que el dueño y cualquier tercero (en el caso PPP) necesitan ver de entrada.

---

## 5. Catálogo POC de Achievements

### 5.1 Estructura

```ts
// lib/achievements/types.ts
export interface AchievementDef {
  id: string;                  // slug estable, e.g. 'i_was_adopted'
  label: string;               // texto del chip "Fui adoptada"
  icon: string;                // emoji o nombre de icono
  description: string;         // copy del tooltip
  computeStatus: (input: AchievementInput) => AchievementStatus;
}

export type AchievementStatus =
  | { kind: 'earned'; earnedAt: Date; count?: number; detail?: string }
  | { kind: 'not_yet'; reason?: string }                  // sin condiciones cumplidas
  | { kind: 'not_yet_computable'; missing: string };      // requiere event_type todavía no implementado

export interface AchievementInput {
  pet: Pet;
  events: PetEvent[];        // ordenados por occurred_at
  serviceDog: PetServiceDog | null;
  cases: Case[];             // todos los casos del pet, abiertos y cerrados
}
```

### 5.2 Los 5 POC

#### A1 — Animal de servicio

```ts
{
  id: 'service_dog',
  label: 'De servicio',
  icon: '🦮',
  description: 'Estoy registrada como perro de asistencia bajo la Ley 26.858.',
  computeStatus: ({ serviceDog }) => {
    if (!serviceDog) return { kind: 'not_yet' };
    if (serviceDog.credentialStatus === 'vigente') {
      return { kind: 'earned', earnedAt: serviceDog.credentialIssuedAt };
    }
    return { kind: 'not_yet', reason: `Credencial en estado ${serviceDog.credentialStatus}` };
  },
}
```

Condición: existe row en `pet_service_dog` con `credential_status='vigente'`. Hoy ya implementable.

#### A2 — Fui adoptado

```ts
{
  id: 'i_was_adopted',
  label: 'Fui adoptada',
  icon: '🏠',
  description: 'Pasé por un proceso de adopción formal y ahora tengo familia.',
  computeStatus: ({ events }) => {
    const finalized = events.filter(e => e.event_type === 'adoption_finalized');
    if (finalized.length === 0) return { kind: 'not_yet' };
    return {
      kind: 'earned',
      earnedAt: new Date(finalized[finalized.length - 1].occurred_at),
      count: finalized.length > 1 ? finalized.length : undefined,
    };
  },
}
```

Condición: existe ≥1 `adoption_finalized` event sobre la pet. Hoy implementable (event existe).

#### A3 — Me perdí pero volví

```ts
{
  id: 'lost_and_found',
  label: 'Me perdí y volví',
  icon: '🧭',
  description: 'Me perdí pero volví a casa. Completé un episodio de lost-and-found.',
  computeStatus: ({ events }) => {
    // Pares status_changed lost→active completos
    let pairs = 0;
    let lastEarnedAt: Date | null = null;
    let lastLost: Date | null = null;
    for (const e of events.filter(e => e.event_type === 'status_changed')) {
      const p = e.payload as { from_status?: string; to_status?: string };
      if (p.to_status === 'lost') lastLost = new Date(e.occurred_at);
      else if (p.from_status === 'lost' && p.to_status === 'active' && lastLost) {
        pairs++;
        lastEarnedAt = new Date(e.occurred_at);
        lastLost = null;
      }
    }
    if (pairs === 0) return { kind: 'not_yet' };
    return { kind: 'earned', earnedAt: lastEarnedAt!, count: pairs > 1 ? pairs : undefined };
  },
}
```

Condición: ≥1 par `status_changed: lost → active` completo. Hoy implementable.

#### A4 — Tuve crías

```ts
{
  id: 'i_had_litter',
  label: 'Tuve crías',
  icon: '🐣',
  description: 'Soy mamá. Quedó registrado mi embarazo en mi libreta sanitaria.',
  computeStatus: () => ({
    kind: 'not_yet_computable',
    missing: 'Requiere un event_type "litter_recorded" o un sub_kind en clinical_info_logged que el catálogo todavía no tiene',
  }),
}
```

Condición: NO computable en v1. Se muestra como "Próximamente — registrá un embarazo / parto en la libreta para desbloquearlo" con tooltip explicativo. Cuando se agregue (event_type nuevo `litter_recorded` o `clinical_info_logged.sub_kind='pregnancy'`), se actualiza el `computeStatus` y se activa retroactivamente.

#### A5 — Trotamundos

```ts
{
  id: 'globetrotter',
  label: 'Trotamundos',
  icon: '🌍',
  description: 'Viajé al exterior al menos una vez (con todos los papeles en regla).',
  computeStatus: () => ({
    kind: 'not_yet_computable',
    missing: 'Requiere un event_type "international_travel" o "vet_certificate_export" que el catálogo todavía no tiene',
  }),
}
```

Condición: NO computable en v1. Mismo tratamiento que A4.

### 5.3 Catálogo extensible

```ts
// lib/achievements/catalog.ts
export const ACHIEVEMENTS_CATALOG: AchievementDef[] = [
  serviceDogAchievement,
  iWasAdoptedAchievement,
  lostAndFoundAchievement,
  iHadLitterAchievement,
  globetrotterAchievement,
];

export function getEarnedAchievements(input: AchievementInput): EarnedAchievement[] {
  return ACHIEVEMENTS_CATALOG
    .map(def => ({ def, status: def.computeStatus(input) }))
    .filter(item => item.status.kind === 'earned')
    .map(item => ({ ...item.def, ...item.status as { kind: 'earned'; earnedAt: Date; count?: number } }));
}

export function getNotYetAchievements(input: AchievementInput): NotYetAchievement[] {
  return ACHIEVEMENTS_CATALOG
    .map(def => ({ def, status: def.computeStatus(input) }))
    .filter(item => item.status.kind === 'not_yet_computable')
    .map(item => ({ ...item.def, missing: (item.status as any).missing }));
}
```

UI muestra:
- `getEarnedAchievements()` → chips coloridos visibles.
- `getNotYetAchievements()` → opcional, mostrarlo como sección expandible "Logros por desbloquear" con tooltip explicativo de cada uno. **Decisión PP**: en v1 NO mostrarlos en la sección principal — solo cuando el usuario expande "Ver todos los logros disponibles". Razón: no queremos que el empty state sea "te faltan 5 logros" — eso es lo opuesto al tono cálido de PP9.

### 5.4 Achievements adicionales — backlog para futuras iteraciones

(Solo lista. Diseño concreto en specs follow-up si Producto lo prioriza.)

- 🎂 **Cumpleaños** — pet tiene `date_of_birth` cumplido este mes
- 💉 **Al día con vacunas** — todas las core vaccines tienen `next_due_at` futuro
- ✂ **Esterilización completada** — existe `sterilization_performed`
- 🩹 **Sobreviviente** — sobrevivió a una `clinical_info_logged.sub_kind='surgery'` mayor
- 🦮 **Voluntario** — está actualmente foster bajo una org (caso edge — no es la pet la voluntaria, sino su dueño)
- 🌱 **Más de N años con vos** — cumple N años desde el `pet_registered` o desde el último `custody_transferred` a owner
- 🆔 **Identidad completa** — tiene foto + microchip + vacunas core completas + esterilización
- 🐕 **Perro de servicio aprobado por govt** — variant de A1 con verificación adicional

---

## 6. Endpoints técnicos

### 6.1 Server component que renderiza el profile

`app/(app)/mis-mascotas/[publicToken]/page.tsx` se simplifica significativamente:

```tsx
export default async function MisMascotaPage({ params }) {
  const { publicToken } = await params;
  const access = await requirePetAccess(publicToken);
  if (!access.ok) notFound();

  const pet = access.pet;
  const events = await fetchPetEventsForProfileV2(pet.id);  // solo lo necesario, ver §6.2
  const serviceDog = await fetchPetServiceDog(pet.id);
  const cases = await fetchOpenCasesForPet(pet.id);
  const reminders = await fetchActiveReminders(pet.id, access.user.id);
  const appointments = await fetchUpcomingAppointments(pet.id);

  const earned = getEarnedAchievements({ pet, events, serviceDog, cases });
  const dynamicInfo = computeDynamicInfo({ pet, events });  // peso, vacunas, etc.

  return (
    <main className="...">
      <BackLink />
      {cases.length > 0 && <OpenCasesSection cases={cases} />}
      <IdentityHeader pet={pet} ownershipRole={access.ownershipRole} />
      <AchievementsSection earned={earned} />
      <DynamicInfoSection info={dynamicInfo} pet={pet} />
      <UpcomingCareSection reminders={reminders} appointments={appointments} />
      <ActionsMenu pet={pet} ownershipRole={access.ownershipRole} />
    </main>
  );
}
```

### 6.2 Query optimization

Se elimina la carga full de `pet_events` (que el profile actual hace con joins a attachments). En v2 solo necesitamos:

- Última `weight_recorded` (peso + fecha)
- Última `vaccination_administered` por `vaccine_name='rabia'` (vence)
- EXISTS de `sterilization_performed`
- Para achievements: lista de `adoption_finalized`, lista de `status_changed`, etc. (cheap queries por event_type indexed).

Helper `fetchPetEventsForProfileV2(petId)` devuelve un objeto con SOLO los campos requeridos por las secciones del profile. NO la lista cruda completa. Reduce payload significativamente para mascotas con cientos de events.

### 6.3 Componentes nuevos

- `components/profile-v2/IdentityHeader.tsx`
- `components/profile-v2/OpenCasesSection.tsx` (depende de sistema de casos)
- `components/profile-v2/AchievementsSection.tsx`
- `components/profile-v2/AchievementChip.tsx`
- `components/profile-v2/AchievementTooltip.tsx`
- `components/profile-v2/DynamicInfoSection.tsx`
- `components/profile-v2/UpcomingCareSection.tsx` (refactor del actual UpcomingVaccinesSection + MedicationDosesSection consolidado)
- `components/profile-v2/ActionsMenu.tsx`

---

## 7. Tests

### 7.1 Achievements unit tests

`__tests__/achievements.test.ts`:

```ts
describe('serviceDogAchievement', () => {
  it('not_yet sin service dog row');
  it('not_yet con credentialStatus="pendiente_verificacion"');
  it('earned con credentialStatus="vigente"');
});

describe('iWasAdoptedAchievement', () => {
  it('not_yet sin adoption_finalized events');
  it('earned con 1 adoption_finalized');
  it('earned con count=2 con 2 adoption_finalized');
});

describe('lostAndFoundAchievement', () => {
  it('not_yet sin pares lost→active');
  it('not_yet con solo lost sin active');
  it('earned con 1 par completo');
  it('earned con count=3 con 3 pares completos');
});

describe('iHadLitterAchievement / globetrotterAchievement', () => {
  it('not_yet_computable con missing message');
});
```

### 7.2 Profile rendering tests

`__tests__/profile-v2-rendering.test.ts`:

```ts
it('renders identity header con foto + nombre + age');
it('no renderiza OpenCasesSection si no hay casos abiertos');
it('renderiza OpenCasesSection con chips clickables si hay casos');
it('renderiza AchievementsSection con chips de earned achievements');
it('renderiza empty state si no hay achievements earned');
it('NO renderiza EventTimeline en ningún lado del profile');
it('renderiza ActionsMenu con acciones condicionales correctas (asistencia solo para dog+owner)');
```

### 7.3 Performance smoke

`__tests__/profile-v2-perf.test.ts` (opcional):

- Pet con 500+ events → render del profile en <200ms server-side (consulta las cheap queries del §6.2, no el dump full).

---

## 8. Migration / compatibility

- Sin schema migration (PP3, PP5).
- El profile actual se reemplaza completo. NO breaking change para URLs — la ruta es la misma, solo cambia el render.
- La libreta y el historial siguen funcionando idénticos.
- Captura rápida (/anotar) sigue idéntica.
- Achievements son aditivos — no rompen nada existente.

---

## 9. Implementation order — sugerencia

1. **Fase 1 — Achievements library** (lib + tests). Sin tocar la UI. ~1-2 días.
2. **Fase 2 — Componentes nuevos** (los 8 de §6.3). Stand-alone, con Storybook si existe. ~2-3 días.
3. **Fase 3 — Refactor del page.tsx** del profile reemplazando layout completo. ~1 día.
4. **Fase 4 — Tests E2E** + ajustes de UX post-feedback inicial. ~1 día.

Total ~1 semana. Plan ejecutable separado (`plans/2026-05-19-pet-profile-v2.md` cuando se priorice).

---

## 10. Open questions

- **Achievements share fuera del owner?** PP8 dice owner-only en v1. En el futuro, si Producto quiere que aparezcan en credencial pública o en perfil del refugio durante adoption review, el spec debe ampliarse con un campo `pets.achievements_visibility = 'private' | 'public' | 'review_only'`.
- **"Streak" de checkins post-adopción** — sería un achievement extra (🔥 "3 meses de checkins regulares"). Decisión: agregar a backlog §5.4, NO en POC v1.
- **Gamification negativa** — ¿mostrar "Logros por desbloquear" con candado puede ser desmotivante? Decisión PP en §5.3: NO mostrar en empty state; solo bajo expansión "Ver todos los disponibles".
- **Internacionalización** — el catálogo de achievements está hardcoded en es-AR. Si en el futuro se interpreta, mover a estructura per-locale. Fuera de scope v1.
- **Materialización si performance** — PP3 + PP5 dicen "compute on-read". Si en algún punto la consulta de events para A2/A3 (lookups por event_type sobre N events del pet) se vuelve lento (raro — `pet_events_type_idx` ya existe), considerar columna `pets.achievements_cache` JSONB invalidada al INSERT de eventos relevantes. **NO especular**: medir primero.

---

## 11. Out of scope

- Achievements multi-pet (e.g., "tu familia tiene 3 mascotas adoptadas" — agregación por owner, no por pet)
- Notificaciones de achievement earned ("¡Negrita desbloqueó Trotamundos!") — UX nice-to-have pero defer
- Compartir achievement individual a redes sociales (image gen + OG tags) — fuera de scope
- Versionado de achievement defs ("este achievement existía en 2024 con condición distinta") — no relevante en v1
- Custom achievements creados por usuarios o refugios — fuera de scope, defer indefinido

---

## Closed Delta — SDD applied 2026-05-22

### Decisions closed during SDD cycle

**R2 (inline timeline)**: Collapsed by default inside `<details>` showing last 5 events; attachments sign lazily on expand. Pragmatic compromise vs strict PP1 "no event list".

**OD9 (fetchPetEventsForProfileV2)**: Two parallel queries — Query A typed events for state computation, Query B last 5 metadata-only rows. Single exported constant `PROFILE_V2_TYPED_EVENT_TYPES` as source of truth.

**OD6 (pulse_until storage)**: New table `pet_achievement_views(user_id, pet_id, achievement_id, first_seen_at, pulse_until)` with composite uniqueness and owner-only RLS. Server action `markAchievementSeenAction` upserts rows; pulse_until defaults to now() + 7 days on insert.

**R5 (tattoo gap)**: Folded into Slice A. `tattooCode` + `tattooLocation` displayed in "Estado actual" section alongside microchip.

**Scope**: Slice A (foundation refactor + perf win + tattoo) + Slice B (achievements UX with credentials+achievements single row, pulse_until badge). Slice C (PPP on /p/, ServiceDogCredentialCard presentación mode) deferred to follow-up SDD change.

### Deferred follow-ups (documented in PR #127)

- **Tattoo field tightening**: Once PR #125 (tattoo-identifier) lands on develop, tighten `CurrentStatePet.tattooCode` from optional to required (`string | null`).
- **Slice C**: Separate SDD for PPP card on `/p/[publicToken]` and ServiceDogCredentialCard "modo presentación" full-screen button (OD7, OD8, OD10).

### Slice deliverables (v1.2)

- **Slice A**: `fetchPetEventsForProfileV2` helper (Query A typed + Query B last-5), `PetCurrentStateSection` (Estado actual with tattoo R5), `PetUpcomingCareSection` (consolidated care), `PetActionsMenu` (vertical actions), `PetHealthTimeline` (collapsed with lazy signing), page.tsx section reorder to §4.9 spec.
- **Slice B**: `pet_achievement_views` migration + RLS, `markAchievementSeenAction` server action, `pulse_until` field on `EarnedAchievement`, `AchievementsSection` single-row credentials+achievements redesign, page.tsx wiring for views load + action dispatch.

### Results

- 18 commits on `feat/pet-profile-v2` branch (10 original + 8 fix-batch after first verify)
- ~585 prod LOC + ~420 test LOC
- Test impact: +20 tests (1493 → 1513)
- Verify status: 0 CRITICAL, 2 WARNING (both deferred tattoo-merge follow-ups), 2 SUGGESTION (non-blocking)
- PR #127 open vs develop with `size:exception` label (owner-authorized per obs #347)

### Key discoveries

- **Strict TDD held throughout**: 17 work units in dependency order, tests-in-same-commit on every unit. First verify caught integration-level wiring gap (WARNING-1 / NFR-5); fix batch of 8 commits + bonus annotation closed all findings.
- **drizzle-kit drift hazard**: When two parallel feature branches (tattoo-identifier #125, pet-profile-v2 this change) both add migrations against the same parent commit on develop, `pnpm db:bootstrap --no-seeds` detects data-loss risk and prompts. Safe workaround: apply migration SQL directly via postgres.js.
- **RLS harness limitation**: Tables with no seed data (like `pet_achievement_views`) need a fixture row inserted in beforeAll for the RLS probe to infer `allow` from row count.
- **Component-with-injection pattern**: If a component receives a server action or signer function prop (like `PetHealthTimeline` with `signAttachments`), add integration-level wiring tests at the page level — unit tests mocking the prop may pass while page wiring breaks.
