# MiMAR rebrand + portal restructure — implementation plan

> Plan ejecutable para Claude Code. Cambia el brand user-facing a MiMAR (Mi Mascota Argentina), reestructura portales con cuatro surfaces claras (`/pro`, `/org/[token]`, `/gob`, `/admin`), extiende `service_offerings` a polymorphic provider (org o vet independiente), y lockea Mi Argentina integration como premisa core. Actualiza AGENTS.md + todos los specs/plans in-flight + README + brand copy mínimo en código.
>
> Este plan es **doc-first**. El rename físico de carpetas (`app/refugio/` → `app/org/`) y el code refactor para soportar `/pro` y polymorphic offerings son **pieces separadas** que vienen después; este plan deja los docs alineados para que esos PRs cuando lleguen tengan referencia clara.
>
> **Fecha:** 2026-05-17
> **Owner:** Ignacio Del Valle
> **Tamaño:** ~13 archivos tocados (1 AGENTS.md + 5 specs + 7 plans + 1 README) + 3-5 archivos de código con brand copy
> **Estimación:** ~3-4 horas de trabajo (sin programar features, solo docs y copy)

---

## 0. Antes de tocar nada

Lectura obligatoria en este orden:

1. **`AGENTS.md`** completo — vas a reescribir varias secciones (Naming, User roles & account types). Entender el doc actual end-to-end es prerequisito porque el cambio toca conceptual model
2. **`docs/superpowers/README.md`** — el índice. Cambia su tabla de "what to attack next" porque los planes que están listos van a tocar paths nuevos
3. **`docs/superpowers/specs/2026-05-16-health-campaigns-and-scheduling-design.md`** — el spec v2.0. Su D1 ("Provider = organization, no polimorfismo") **se revierte parcialmente** en este plan porque agregamos `/pro` para vets independientes
4. **`docs/superpowers/specs/2026-05-17-admin-page-design.md`** (v2.1) — tiene rutas compartidas govt/admin en `/admin/*`. Se dividen
5. **`docs/superpowers/specs/2026-05-17-lost-and-found-complete-design.md`** y **`docs/superpowers/specs/2026-05-17-symptom-disease-surveillance-design.md`** — referencias a `/refugio` y a routing de notifications
6. **Los planes correspondientes** en `docs/superpowers/plans/` para cada spec — mismas referencias
7. **`app/p/[publicToken]/page.tsx`** y **`app/layout.tsx`** — la única superficie de código que tocás en este plan (brand copy)

**Antes de empezar**: corré `pnpm typecheck && pnpm lint && pnpm test` para baseline. Cualquier failure pre-existente decímelo antes de avanzar, no lo arrastres.

## 1. Qué construye este plan

Cuatro cambios conceptuales con efecto en muchos docs:

**1.1 Brand identity dual: MiMAR ↔ DIM.** "Mi Mascota Argentina" como brand user-facing. DIM como codename interno + identificador estable (public_token format, code, schema, audit). Mi Argentina alignment se declara como premisa core (no nice-to-have).

**1.2 Portal restructure:**
- `/mis-mascotas` (owner) — sin cambios
- `/pro` (vet personal con `professional.provider` capability) — **nuevo**, para vets independientes que ofrecen servicios sin clínica afiliada
- `/org/[orgToken]` (members de cualquier org) — **rename de `/refugio/[orgToken]`**, generalizado a todos los `org_type`
- `/gob` (govt institutional accounts) — **nuevo**, para approvals scoped a localidad + dashboards regionales + business rules en su scope
- `/admin` (admin institutional accounts) — **refinado**, para meta-admin (crear cuentas institucionales, dashboards del aplicativo, audit cross-govt, business rules universales)
- `/p/[publicToken]` (credencial pública) — sin cambios
- `/libreta/compartir/[shareToken]` (libreta Tier-2) — sin cambios

**1.3 `service_offerings` polymorphic.** El offering pertenece a una org (clínica, autoridad sanitaria, etc.) O a un usuario vet independiente. XOR en columnas, mismo patrón que `Ownership.owner_user_id | owner_organization_id` ya validado. D1 del spec de scheduling v2.0 se ajusta.

**1.4 Business rules ownership con cascada.** Govt configura business rules en su scope (jurisdicción asignada). Admin configura también, pero universal o en cualquier jurisdicción (override). Más específica gana. Se documenta como concepto futuro en AGENTS.md; tabla `business_rules` se diseña cuando llegue.

## 2. Decisiones cerradas (acordadas con Nacho)

| # | Decisión | Notas |
|---|---|---|
| D1 | **DIM se mantiene como codename interno + identificador estable**. `public_token` format `DIM-XXXX-XXXX` no cambia. Schema, server actions, audit logs, internal docs siguen siendo "DIM" | Identificadores en producción no se rompen |
| D2 | **MiMAR es el brand user-facing**. Aparece en metadata, header de credencial, signup/login copy, notifications títulos, marketing. "Mi Mascota Argentina" es el spelling-out cuando se necesita | Si el contexto es legal/oficial, el footer institucional dice "Documento de Identificación para Mascotas" para preservar legitimidad |
| D3 | **Mi Argentina integration es premisa core, no opcional**. Sin esa conexión, el producto no tiene sentido. Documentado en AGENTS.md → Naming + North Star (extender ligeramente) | No bloquea v1 (integration real es deferred) pero el alignment guía todas las decisiones |
| D4 | **`/refugio` se renombra a `/org`** (singular, corto) en todos los docs. Plus middleware redirect cuando se haga el code rename (PR separado, no este plan) | En docs, todas las refs a `/refugio/*` pasan a `/org/[orgToken]/*` |
| D5 | **`/pro`** es portal nuevo para vets independientes. Diferencia funcional vs `/org/[token]`: el vet personal ofrece servicios solos, sin las features de org (intake stray, foster, adoption, transfer custody, member management, coverage zones). El vet con clínica usa `/org/[token]` de su clínica | El vet con DOS hats (independiente + miembro de clínica) ve ambos portales con identidades distintas |
| D6 | **`/gob` y `/admin` son surfaces separadas**. Govt: scoped a sus localidades, configuración regional, dashboards regionales. Admin: cuentas institucionales, dashboards del aplicativo, audit global, business rules universales | `/gob` reemplaza el uso compartido de `/admin` que estaba en admin page spec v2.1 |
| D7 | **`service_offerings` polymorphic**: `organization_id` OR `provider_user_id`, XOR enforced. Misma jurisdicción denormalizada en el offering (`jurisdiction_province` + `jurisdiction_locality`) para que govt routee approvals por scope independiente de quién es el provider | Schema change requiere migración (en plan separado de implementación, no acá) |
| D8 | **Capability access dicta portal access**. Si tenés la capability aprobada, tenés acceso al portal donde se usa | `professional.provider` para `/pro`, org membership para `/org/[token]`, `govt_assignments` activas para `/gob`, `role='admin'` para `/admin` |
| D9 | **Business rules: govt scoped, admin universal con override**. Cascada: más específica gana. Locality > province > country > default hardcoded. Schema futuro, hoy solo documentado | No bloquea v1 |
| D10 | **Este plan es doc-first**. Code refactor (rename de carpetas, polymorphic offering en schema, `/pro` route implementation) son PRs separados que vienen después. Single excepción: brand copy mínimo en credencial pública + layout + auth pages | Reduce riesgo, permite reviewar el conceptual antes del implementation |

## 3. Scope

**Dentro de este plan (todo en docs y brand copy):**
- Reescritura de AGENTS.md → Naming section (dual identity DIM/MiMAR, Mi Argentina premise)
- Reescritura de AGENTS.md → User roles & account types (cuatro portales con capability access)
- Update mínima de AGENTS.md → North Star (Mi Argentina alignment explícito)
- Nueva nota corta en AGENTS.md sobre business rules ownership
- Update de `docs/superpowers/README.md` (paths, status, recomendaciones)
- Update de 5 specs (paths, conceptual changes en scheduling y admin)
- Update de 7 plans (paths, copy donde aplique)
- Update mínima de brand copy en código: `app/layout.tsx`, `app/p/[publicToken]/page.tsx`, `app/(auth)/signup/page.tsx`, `app/(auth)/login/page.tsx`

**Fuera de este plan (van en otros PRs después de que este mergee):**
- Rename físico de carpeta `app/refugio/` → `app/org/` (mover archivos + actualizar imports + middleware redirect)
- Implementación de `/pro` route group con sus pages, components, server actions
- Migración del schema para polymorphic `service_offerings` (organization_id nullable + provider_user_id + XOR constraint + jurisdiction columns)
- Implementación de `/gob` route group con sus pages
- Refactor de `/admin` para reflejar el split de capabilities
- Tablas / business rules implementation
- Code-level capability extension para `professional.provider`, `role='govt'` capabilities, `role='admin'` capabilities

**Dependencias de plans que NO se ejecutan acá pero quedan habilitados después:**
- `2026-05-16-health-campaigns-and-scheduling.md` — cuando se ejecute, debería usar `/org/[token]` y `/pro` correctos. Si querés ejecutarlo ANTES del code rename, las URLs viejas funcionan via redirect; pero idealmente se hace después del code rename
- `2026-05-17-lost-and-found-complete.md` — mismo razonamiento
- `2026-05-17-symptom-disease-surveillance.md` — notification routing logic actualizada

## 4. Plan paso a paso

### Paso 1 — AGENTS.md (foundational, hacelo primero)

**1.1 — Naming section: reescritura completa.**

Reemplazar la sección actual "Naming" con esto:

```markdown
## Naming

DIM has a dual identity by design.

**User-facing brand: MiMAR (Mi Mascota Argentina).** This is what appears in app metadata, signup/login copy, the public credential header, notification titles, future marketing, and the domain (when assigned). The "Mi-" prefix is a deliberate alignment with the Argentine government services pattern (Mi Argentina, Mi AFIP, Mi ANSES) — communicating "your personal portal." The Spanish word "mascota" is what every Argentine pet owner uses; "Mi Mascota Argentina" is warm, familiar, and emotionally legible.

**Code identifier: DIM.** The original backronym ("Documento de Identificación para Mascotas") remains in code, schema, server actions, audit logs, internal docs, and the `public_token` format (`DIM-XXXX-XXXX`). DIM is a stable identifier we never rename — every issued token, every audit entry, every database row references it. The institutional descriptor "Documento de Identificación para Mascotas" also appears in the footer of the public credential page when an animal-health professional or government clerk views the document — it reinforces legitimacy in those contexts without changing the user-facing brand for everyday owners.

**Why the duality.** "DIM" alone sounds institutional/legal — good for credibility with vets and govt, cold for an owner adding their dog's first photo. "MiMAR" alone loses the document-credential framing that makes the credencial pública meaningful as official identification. Both names serve different audiences and contexts; keeping both serves the product.

**Mi Argentina alignment is the core premise, not a nice-to-have.** This project's reason to exist is to be the missing data layer that government animal-health programs (Mascotas CABA, SENASA zoonosis surveillance, eventually Mi Argentina itself) lack today. The product makes no sense as a standalone PWA forever — its trajectory points at official adoption. Every design decision is filtered through this premise:
- The credential is real enough that Mi Argentina could eventually issue it
- The data model is privacy-preserving enough that govt actors can use it under existing legal frameworks
- The brand alignment signals the direction
- The architecture supports federation when the integration becomes feasible

If you find yourself making a decision that breaks Mi Argentina alignment for short-term convenience, reconsider.
```

**1.2 — User roles & account types: actualizar la tabla de portales y agregar bloque sobre access.**

Buscar la tabla "The four roles" en la sección actual de "User roles & account types". Reemplazar la columna "Primary portal" con los valores nuevos:

| Role | Account type | ... | Primary portal | Notes |
|---|---|---|---|---|
| `owner` | personal | ... | `/mis-mascotas` | (no change) |
| `vet` | personal | ... | `/pro` (when approved as service provider) **OR** via `/org/[orgToken]` membership | New: independent vets get `/pro` after admin approval; clinic-affiliated vets work via the clinic's `/org/[token]` |
| `govt` | institutional | ... | `/gob` | Multi-locality via `govt_assignments` |
| `admin` | institutional | ... | `/admin` | Universal scope. Creates other institutional accounts. |

Y agregar un bloque nuevo (después de "The four roles" subsection, antes de "Lifecycle and downgrade paths"):

```markdown
### Portal access: capability-driven

A user's access to a portal is determined by whether they have at least one capability that's exercised in that portal:

- **`/mis-mascotas`** — every authenticated personal account (owner or vet). No additional capability needed; the portal lists the user's own pets.
- **`/pro`** — vets with the `professional.provider` capability (granted by admin or govt approval of a `role_upgrade_vet_provider` request). A vet without this capability can still be a vet (their matrícula is verified, they can author events) but cannot offer services in DIM until approved as a service provider.
- **`/org/[orgToken]`** — users with an active `organization_memberships` row for that specific org and at least one org-level capability (e.g., `intake.create`, `appointment.manage`, `service_offering.create`).
- **`/gob`** — `role='govt'` users with at least one active `govt_assignments` row.
- **`/admin`** — `role='admin'` users with `account_type='institutional'` and `deactivated_at IS NULL`.

Capabilities are layered: org-level (per-membership), professional-level (per-vet, e.g., `professional.provider`), and role-level (per-role, e.g., govt's `approve.org_verification`, admin's `account.create_institutional`). The portal layout asserts the right layer for entry; specific actions inside the portal assert finer-grained capabilities.

### Portal único /pro (modelo unificado)

`/pro` es el portal personal de TODO vet — uno solo, no dos.

- **Patient care** (mis pacientes, tratamientos recientes, agenda de mis pacientes, mis orgs): disponible para todo vet con `profiles.role='vet'`. No requiere capability extra. Es el contenido actual de `/pro` ya implementado.
- **Service provider** (offerings, agenda de turnos públicos, cobros): viven como sub-rutas del mismo portal — `/pro/servicios`, `/pro/agenda`, `/pro/agenda/turnos/[token]`. Gated por capability `professional.provider` (otorgada vía aprobación de `role_upgrade_vet_provider`). Cuando un vet NO tiene esa capability, las sub-rutas son 404 / hidden; cuando la tiene, aparecen como secciones adicionales del mismo portal.

Esto reemplaza el modelo previo donde se planteaban DOS portales separados para service-provider y patient-care. Decisión: un vet tiene un único surface personal (`/pro`); sus features dependen de sus capabilities.

**Implicancias:**
- `service_offerings` polimórfico sigue vivo (provider_user_id para vet personal), no cambia.
- La capability `professional.provider` sigue existiendo conceptualmente; gate las sub-rutas `/pro/servicios*` + `/pro/agenda*`.
- Approval type `role_upgrade_vet_provider` sigue vivo — sigue siendo la petición que el vet hace para destrabar las sub-rutas de provider.
- El portal `/pro` ya existe en código (Fase actual); las sub-rutas de service-provider se implementan cuando se ejecute el health-campaigns plan.

### Functional difference between `/pro` and `/org/[orgToken]`

Both surfaces support **service offerings + scheduling**: define services, set recurring availability, accept bookings, mark attendance, emit pet_events.

`/pro` provides **only that**. The independent vet operates as a service provider; no intake of strays, no foster pipeline, no adoption workflow, no member management, no coverage zones, no cross-org transfers. Authorship attribution: `pet_events` emitted from `/pro` set `recorded_by_user_id=vet`, `author_role='vet'`, `author_organization_id=null`.

`/org/[orgToken]` provides scheduling **plus** the full org capabilities matching the `org_type`: shelter/rescue_network gets intake + foster + adoption pipelines; clinic gets primarily scheduling; sanitary_authority gets official campaigns + jurisdictional dashboards. Authorship attribution: `author_organization_id` is set to the org.

A vet with **both** an independent practice AND a clinic affiliation has both portals available and chooses contextually which identity to act under. The data model captures this naturally — the offering, the appointment, and the emitted event all carry the right `author_*` fields per case.
```

**1.3 — Business rules: agregar nota corta al final de la sección "User roles & account types".**

Agregar este bloque:

```markdown
### Business rules ownership (future)

When the system grows to support configurable business rules (minimum age to register a pet, mandatory vaccinations by jurisdiction, eligibility criteria for service offerings, etc.), the configuration follows a layered ownership:

- **Govt** configures rules within their assigned jurisdictions. A govt of CABA can set rules that apply in CABA. A govt of Mendoza Capital can set rules for Mendoza Capital.
- **Admin** configures rules universally (Argentina-wide defaults) or in any specific jurisdiction (override). Admin acts as both the universal-scope setter and the escalation path for jurisdictional rules when no govt is in scope.

When multiple rules conflict, **more specific wins**: locality > province > country > hardcoded default. A Belgrano rule overrides a CABA rule overrides an Argentina rule overrides the code default.

Schema for `business_rules` is deferred until the feature lands. The concept is locked here so future designs respect the hierarchy.
```

**1.4 — North Star: aclaración chica.**

En la sección "North Star" actual, buscar el párrafo que menciona Mi Argentina. Si dice algo genérico tipo "eventual integration with Mi Argentina", reemplazar con:

```markdown
The ultimate trajectory is **integration with Mi Argentina**. This is not a nice-to-have — it is the premise. A standalone pet-credential PWA has limited reach; a federated layer that Mi Argentina can issue and verify is what changes the system at population scale. Every architectural decision in this codebase is filtered through whether it preserves or harms that path. See AGENTS.md → Naming for more.
```

(El reemplazo exacto depende del wording actual; lo importante es subir la prioridad de Mi Argentina de "future open question" a "core premise that shapes everything".)

**1.5 — Verificar:**

Después de editar AGENTS.md, releer la sección Privacy tiers para asegurar que no hay nada que contradiga lo nuevo. Si la tabla menciona "(future) Verified vet via portal" como Tier 4, mantenerlo — eso ahora aplica al vet via `/org/[token]` o `/pro`.

### Paso 2 — `docs/superpowers/README.md`

**2.1 — Update tabla "What to attack next".**

Las prioridades 1-6 actuales son válidas. Solo cambiar:
- Donde dice "Cuando admin page Fase 0 lands" — agregar nota *"el rename de portales (este plan) debería ir antes de admin page Fase 0 para que la spec esté alineada cuando se implemente"*
- Agregar prioridad 0 nueva al tope de la tabla, apuntando a este plan:

```markdown
| 0 | **MiMAR rebrand + portal restructure** (this plan) | `plans/2026-05-17-mimar-rebrand-and-portal-restructure.md` | Doc-first: AGENTS.md + specs/plans alignment con brand MiMAR, paths /org, /gob, /admin, /pro. Pre-requisito de los demás planes para que las URLs no diverjan. ~3-4 horas. |
```

**2.2 — Update tabla "All specs & plans" — solo las celdas que tocan paths.**

Para cada fila de spec/plan donde el "Notas" mencione paths viejos (`/refugio`, `/admin/cola` shared, etc.), reescribir las notas para reflejar la nomenclatura nueva.

**2.3 — Update sección "Cross-cutting dependencies".**

El primer bullet dice "Admin page Fase 0 destraba...". Mantener pero clarificar que el destrabe ahora pasa por dos surfaces (`/gob` y `/admin`), no una sola.

Agregar un bullet nuevo:

```markdown
- **Portal rename (este plan)** destraba:
  - Coherencia entre todos los specs/plans (todos referencian `/org`, `/gob`, `/admin`, `/pro` consistentemente)
  - Reducción de fricción cuando llegue el code rename físico de `app/refugio/` → `app/org/`
  - Habilita la implementación de `/pro` para vets independientes
```

**2.4 — Update sección "Convenciones" → Naming.**

Agregar al final:

```markdown
**Brand y rutas:**
- Producto user-facing: **MiMAR** (Mi Mascota Argentina). Aparece en title, copy, notifications.
- Codename interno: **DIM**. Schema, code, tokens, audit. Nunca cambia.
- Paths user-facing: `/mis-mascotas`, `/pro`, `/org/[orgToken]`, `/gob`, `/admin`, `/p/[publicToken]`, `/libreta/compartir/[shareToken]`.
- Spanish naming convention para paths (`/gob`, no `/government`; `/organizaciones` se acortó a `/org` por brevidad consistente con `/admin`, `/p`).
```

### Paso 3 — `docs/superpowers/specs/2026-05-16-health-campaigns-and-scheduling-design.md`

Este spec tiene la rewrite más significativa por D7 (polymorphic offerings) y la adición de `/pro`.

**3.1 — Header: bump versión a v2.1.**

Cambiar:
```
**Versión:** 2.0 — rewrite simplificado...
```

A:
```
**Versión:** 2.1 — polymorphic provider (org o vet independiente), paths actualizados (`/org/[orgToken]`, `/pro`, `/gob`, `/admin`), routing de approvals via govt. Reemplaza v2.0.
```

**3.2 — D1: revertir parcialmente.**

Buscar la tabla "Decisiones cerradas" del spec. La fila D1 actual dice:

> | D1 | **Provider = `organization` verified**. NO polimorfismo con vet individual. Un vet que quiera ofrecer turnos lo hace via la clínica donde está como membership | Modelo argentino: vets independientes son raros en este contexto; cuando aparezcan, modelamos. Hoy: org es la unidad de approval |

Reemplazar por:

> | D1 | **Provider polymorphic: `organization` verified OR vet personal con `professional.provider` capability**. La org es la unidad de approval para clínicas / autoridades sanitarias / refugios. El vet independiente (sin clínica, e.g., vet de campo) es la unidad de approval para casos personales. Mismo XOR pattern que `Ownership.owner_user_id | owner_organization_id` | Captura los dos casos legítimos del mercado argentino: clínicas con scheduling, y vets independientes con consultorio móvil o atención a domicilio. Schema-level XOR mantiene integridad |

**3.3 — D8: update routing de approvals.**

La fila D8 actual habla de approval state en `service_offerings.status`. Mantener, pero agregar nota sobre el routing:

> | D8 | **Approval state en columna `service_offerings.status`** (pending_approval, approved, rejected, paused, archived). El routing del request va a govt cuya scope cubre la `jurisdiction_locality` declarada en el offering (sea de org o de vet independiente); fallback a admin si no hay govt covering | Refleja la separación `/gob` (locality-scoped) vs `/admin` (universal). El offering declara su jurisdicción independiente de quién sea el provider |

**3.4 — §4.1 schema de `service_offerings`: hacer polymorphic.**

Buscar el bloque SQL de `service_offerings`. Cambios:

- `organization_id uuid not null` → `organization_id uuid` (nullable)
- Agregar columna: `provider_user_id uuid references profiles(id) on delete cascade`
- Agregar columnas: `jurisdiction_country text not null default 'AR'`, `jurisdiction_province text`, `jurisdiction_locality text`
- Agregar CHECK: `constraint provider_xor check ((organization_id is not null and provider_user_id is null) or (organization_id is null and provider_user_id is not null))`
- Agregar comentario inline explicando el polymorphism + cómo la jurisdicción se denormaliza desde el provider

**3.5 — §4.2 a §4.5: aclaraciones mínimas.**

- `service_schedule_rules` no cambia
- `time_slots` no cambia
- `appointments`: la columna `organization_id` se vuelve nullable (un appointment de vet independiente no tiene org). Agregar `provider_user_id` nullable también. Mismo XOR.
- `reminders` extensión: sin cambios

**3.6 — §5 approval workflow: actualizar para reflejar govt routing.**

El paso 5.2 actual dice "Admin abre `/admin/servicios`". Reemplazar con:

- Govt cuya scope cubre la `jurisdiction_locality` del offering recibe la notification + ve el request en `/gob/servicios`
- Admin recibe el request en `/admin/servicios` SOLO si no hay govt covering esa locality (fallback)

El UI flow y los buttons (aprobar / rechazar) son los mismos; cambia quién los ve.

**3.7 — §6 org-side flow: paths `/refugio/` → `/org/[orgToken]/`.**

Buscar todas las refs a `/refugio/servicios`, `/refugio/agenda`, etc. Cambiar el patrón a `/org/[orgToken]/servicios`, `/org/[orgToken]/agenda`.

**3.8 — §6.5 (nueva subsección): `/pro` flow.**

Agregar subsección después de §6.4:

```markdown
### 6.5 Vet independiente: `/pro`

Un vet personal con `professional.provider` capability aprobada usa `/pro` como surface. Funcionalmente equivalente a `/org/[orgToken]/servicios` + `/org/[orgToken]/agenda` colapsado a una sola ruta (no hay otra org context para distinguir):

- `/pro` — dashboard del vet: sus offerings, su agenda del día
- `/pro/servicios` — sus offerings
- `/pro/servicios/nuevo` — crear offering nuevo (submit → status='pending_approval')
- `/pro/servicios/{token}` — detalle / editar
- `/pro/servicios/{token}/agenda` — schedule rules
- `/pro/agenda` — dashboard del día
- `/pro/agenda/turnos/{token}` — appointment detalle, marca attended/no_show/cancel

Mecánica idéntica a la del org-side. La diferencia es solo el ownership del offering (`provider_user_id` set en lugar de `organization_id`) y la authorship de los `pet_events` emitidos (`author_organization_id=null`).

**Approval del vet como service provider:** prerequisito a usar `/pro`. Es un approval_request nuevo de tipo `role_upgrade_vet_provider` (extensión natural del catálogo del admin page). El vet ya verified (matriculaVerified=true) pide upgrade a service provider; admin o govt scope-matching aprueba; capability `professional.provider` se le otorga.
```

**3.9 — §7 owner-side flow: aclaraciones.**

§7.2 (búsqueda): la search query ya filtra por `service_kind` y locality. Update implícito — ahora las rows pueden venir de orgs O de vets independientes. El render de cada row distingue:
- Si `organization_id` set: muestra org name + logo
- Si `provider_user_id` set: muestra "Dr/a. {first name}" + matrícula

**3.10 — §9 UI surfaces resumen: rewrite de la tabla.**

Reemplazar las tablas org-side / admin-side con tres tablas:

```markdown
### Org-side (route group `/org/[orgToken]`)

| Ruta | Quién | Función |
|---|---|---|
| `/org/[orgToken]/servicios` | Org member con `service_offering.create` | Lista de offerings de la org |
| `/org/[orgToken]/servicios/nuevo` | Idem | Form para crear nuevo offering |
| ... | ... | ... |

### Professional-side (route group `/pro`)

| Ruta | Quién | Función |
|---|---|---|
| `/pro` | Vet con `professional.provider` capability | Dashboard del vet |
| `/pro/servicios` | Idem | Lista de sus offerings |
| ... | ... | ... |

### Owner-side (route group `/(app)`)

(sin cambios respecto a v2.0, solo formato)

### Govt-side (route group `/gob`, mínimo viable hasta admin page Fase 0)

| Ruta | Quién | Función |
|---|---|---|
| `/gob/servicios` | `role='govt'` users con scope covering | Lista de pending offerings en su scope |
| ... | ... | ... |

### Admin-side (route group `/admin`, mínimo viable)

| Ruta | Quién | Función |
|---|---|---|
| `/admin/servicios` | `role='admin'` users | Fallback queue de offerings sin govt covering |
| ... | ... | ... |
```

**3.11 — §13 lo que NO está: update.**

Sacar "Polimorfismo provider (org o vet individual): solo orgs." de la lista de "fuera" — ahora SÍ está.

Agregar a "fuera":
- `/pro` para vets independientes: schema-ready, implementación de las pages es PR separado
- Capability `professional.provider` y su approval flow: schema-ready, implementación con el admin page

### Paso 4 — `docs/superpowers/specs/2026-05-17-admin-page-design.md`

Este spec necesita un split de capabilities entre `/gob` y `/admin`.

**4.1 — Header: bump a v2.2.**

Nota de versión: *"v2.2 — split de surfaces `/gob` (govt scope-bound) vs `/admin` (universal meta-admin). Reemplaza v2.1."*

**4.2 — Capability matrix (§5): reorganizar por surface.**

El § actual tiene una sola tabla con columnas "govt en scope" y "admin". Mantener la matrix de quién-puede-qué, pero agregar arriba una tabla nueva:

```markdown
### Surface ownership

| Action category | Surface | Visible to | Notes |
|---|---|---|---|
| Approvals scoped a locality | `/gob/cola` | Govt con assignment covering | Org verification, vet upgrade, service offering, scheduling |
| Approvals fallback (no govt covering) | `/admin/cola` | Admin | Same actions as `/gob/cola` but for localities sin govt |
| Approvals meta (role upgrade to govt/admin) | `/admin/cola` | Admin only | role_upgrade_govt, role_upgrade_admin |
| Crear cuentas institucionales | `/admin/cuentas` | Admin only | Create govt, create admin |
| Dashboards regionales | `/gob/dashboards` | Govt en su scope | Vaccination coverage, mortality clusters, etc., filtered to assigned localities |
| Dashboards del aplicativo | `/admin/sistema` | Admin only | DAU, signups, retention, perf, costs |
| Audit log propio | `/gob/historial` o `/admin/historial` | Cada user el suyo | |
| Audit log global cross-govt | `/admin/auditoria` | Admin only | |
| Business rules en mi scope | `/gob/reglas` | Govt en su scope | Locality / province scoped rules |
| Business rules universales | `/admin/reglas` | Admin | Country-wide defaults, override capability per any jurisdiction |
```

La matrix de quién-puede-qué (debajo) se queda casi igual, solo aclarando que algunas filas son visibles en `/gob` y otras en `/admin` según la column nueva.

**4.3 — §7 flows: split en sub-secciones.**

Mantener los flows actuales (approval, revocation, etc.) pero etiquetar cada flow con su surface:

- `request_review_flow` → tanto en `/gob/cola` (govt scope) como en `/admin/cola` (admin fallback). Mismo componente, distinto data scope
- `create_institutional_govt_flow` → solo `/admin/cuentas`
- etc.

**4.4 — §8 UI surfaces: rewrite con cuatro tablas separadas**

(Owner-side, Govt-side, Admin-side, Cuenta-self-service-side). Es un refactor visual de la tabla existente, sin cambiar la lista de capabilities.

**4.5 — §13 / §15 / §16: pequeños ajustes.**

Donde se mencione "admin page" como surface única, aclarar que ahora son dos. La fase de implementación (que estaba con todo en `/admin`) se split en dos PRs paralelos: uno para `/gob/*`, uno para `/admin/*`. La schema foundation queda la misma (govt_assignments, approval_requests, audit_log).

### Paso 5 — `docs/superpowers/specs/2026-05-17-lost-and-found-complete-design.md`

Más liviano. Solo paths.

**5.1 — Find/replace `/refugio` → `/org/[orgToken]`.**

Buscar todas las occurrences de `/refugio/` en el doc. Reemplazar con `/org/[orgToken]/`. La ruta exacta del CTA (e.g., `/refugio/mascotas/{token}`) pasa a `/org/[orgToken]/mascotas/{petToken}`. Mantener el sentido — los placeholders del path tienen que estar claros.

**5.2 — §8 flows: misma find/replace.**

**5.3 — §13 phasing: misma find/replace.**

**5.4 — No cambia ninguna decisión. Es solo paths.**

### Paso 6 — `docs/superpowers/specs/2026-05-17-symptom-disease-surveillance-design.md`

Igualmente liviano.

**6.1 — Notification routing logic update.**

Buscar la sección donde el `outbreak_signal` enrutaba "a govt en jurisdicción del pet con fallback admin". Mantener el concepto. Aclarar que ahora govt notifica via su `/gob/cola` y admin via su `/admin/cola` fallback (era ambiguo en el spec original cuando ambos compartían `/admin`).

**6.2 — Sin cambios estructurales.** Es solo aclaración de path.

### Paso 7 — Plans

Para cada plan en `docs/superpowers/plans/`:

**7.1 — `2026-05-16-health-campaigns-and-scheduling.md`:**
- Find/replace `/refugio/` → `/org/[orgToken]/`
- Aclarar que la Fase 0 schema ahora incluye `service_offerings.provider_user_id` + XOR constraint + jurisdiction columns
- Agregar Fase 1.5 (entre 1 y 2): "Approval routing: govt + admin fallback" — el `notify all admins` de v2.0 ahora es "lookup govts cuya scope cubre `jurisdiction_locality` del offering; fallback a admins si vacío"
- Agregar nueva Fase 2.5 (después de 2): "`/pro` route group para vet independientes (mirror reducido de `/org/[token]`)"
- Actualizar números de fase / total: ahora son 10 fases (8 + 2 nuevas), no 8

**7.2 — `2026-05-17-lost-and-found-complete.md`:**
- Find/replace `/refugio/` → `/org/[orgToken]/`
- Sin más cambios

**7.3 — `2026-05-17-symptom-disease-surveillance.md`:**
- Update Fase 4 (notification routing) para reflejar govt-first / admin-fallback explícitamente. El "today routes only to admins" del plan original se mantiene como interim hasta que admin page Fase 0 + this rebrand mergeen

**7.4 — `2026-05-16-libreta-sanitaria-parte-a.md`, `parte-b.md`, `parte-c.md`:**
- Find/replace cualquier "DIM" user-facing → "MiMAR" donde sea copy del usuario. Code references y schema (DIM en token format) NO se tocan
- Sin más cambios

**7.5 — `2026-05-16-vecino-mascota-en-transito.md`:**
- Same: user-facing "DIM" → "MiMAR"
- Path refs si hay

**7.6 — `2026-05-16-event-agent-foundations.md`:**
- Path refs si hay (debería tener pocas — ese plan es mostly lib code)

**7.7 — `2026-05-15-timeline-type-filter.md`:**
- Probablemente no tiene refs. Verificar y skip si no.

### Paso 8 — Brand copy en código (mínimo viable)

Tres archivos. Cambios chicos. Sin tocar lógica.

**8.1 — `app/layout.tsx`:**

Buscar el metadata block. Cambiar:

```ts
export const metadata: Metadata = {
  title: "DIM — Documento de Identificación para Mascotas",
  // ...
};
```

A:

```ts
export const metadata: Metadata = {
  title: "MiMAR — Mi Mascota Argentina",
  description: "Tu mascota, su credencial digital, su libreta sanitaria.",
};
```

(Adaptar al wording exacto que el file tenga ahora.)

**8.2 — `app/p/[publicToken]/page.tsx`:**

Buscar el header del credential. Hoy dice algo como:

```tsx
<p className="text-[10px] uppercase tracking-[0.3em] text-neutral-500 dark:text-neutral-500">
  DIM · Credencial digital
</p>
```

Cambiar a:

```tsx
<p className="text-[10px] uppercase tracking-[0.3em] text-neutral-500 dark:text-neutral-500">
  MiMAR · Credencial digital
</p>
```

Buscar el footer del credential. Hoy dice algo como:

```tsx
<p className="text-center text-[10px] uppercase tracking-[0.3em] text-neutral-400 dark:text-neutral-600">
  Documento de Identificación para Mascotas
</p>
```

Mantenerlo así — es el descriptor institucional que refuerza legitimidad. Verificar que sigue ahí; si fue removido en algún update previo, reagregarlo.

**8.3 — `app/(auth)/signup/page.tsx` y `app/(auth)/login/page.tsx`:**

Buscar cualquier mención user-facing a "DIM" en el copy de signup/login. Reemplazar con "MiMAR" o reescribir las frases para que fluyan mejor. Ejemplo:

```
Antes: "Bienvenido a DIM"
Después: "Bienvenido a MiMAR"

Antes: "DIM es el documento de identificación para tu mascota"
Después: "MiMAR es la libreta sanitaria digital de tu mascota"
```

Mantener el espíritu del copy actual. No reescribir todo — solo lo que dice "DIM" como brand.

## 5. Verificación final

Después de Paso 1 al 8:

1. **Typecheck.** `pnpm typecheck` cero errores.
2. **Lint.** `pnpm lint` cero errores nuevos.
3. **Tests.** `pnpm test` todos verdes (los tests no deberían testear strings de brand específicos; si alguno lo hace, actualizalo).
4. **Build.** `pnpm build` compila.
5. **Smoke manual visual:**
   - Abrir `/` (landing) y ver brand "MiMAR" en el title del browser
   - Crear cuenta nueva o login: copy menciona MiMAR donde antes decía DIM
   - Abrir un pet del owner: el card del pet profile sigue igual (lo del brand está en layout / p)
   - Abrir `/p/{some-pet-token}` (en otra pestaña incógnito): header dice "MiMAR · Credencial digital", footer dice "Documento de Identificación para Mascotas"
6. **Docs grep check:**
   - `grep -r "/refugio" docs/superpowers/` debería retornar cero matches (excepto si hay un comentario explicando el rename histórico, que está bien)
   - `grep -r "DIM " docs/superpowers/` puede dar muchos matches — eso ESTÁ BIEN porque DIM sigue siendo codename. Lo que **no** debería aparecer en `docs/superpowers/specs/` user-facing copy es "DIM" como brand. Internamente sí.
7. **Consistency check:**
   - Releer AGENTS.md → Naming sección y validar que dice lo que se acordó
   - Releer AGENTS.md → User roles & account types y validar la tabla de portales
   - Releer el README del superpowers y validar que las prioridades están bien
8. **No-regression check:**
   - Listar los pet_events emitidos antes del rebrand seguir leyéndose igual (todo el codename DIM intacto en data)
   - Schema unchanged: `select count(*) from pets where public_token like 'DIM-%'` debería retornar todas las filas (sin cambios)

## 6. Casos borde y trampas

- **Rename físico de carpeta NO va en este plan.** Si Claude Code se siente tentado a hacer `mv app/refugio app/org`, **STOP**. Eso es PR separado y rompe cosas (imports, routes, tests). Este plan es solo docs y brand copy.
- **`/pro` route implementation NO va en este plan.** Solo se documenta como diseño. La implementación (pages, components, server actions) es otro PR.
- **Brand en `pet_events` ya emitidos.** Si en algún payload de evento existente dice "DIM" como brand user-facing, **NO retroactivar**. Los eventos son immutable. Solo el copy que se renderiza en surface user-facing puede cambiar; los payloads no.
- **Token format.** El público_token `DIM-XXXX-XXXX` **NO cambia**. No hay rename de tokens existentes ni del format para nuevos.
- **Tests que assertan strings.** Si algún test dice `expect(page).toContain("DIM")` en un context user-facing, actualizar a "MiMAR". Si lo hace en context técnico (e.g., chequeando token format), dejar como está.
- **Notifications históricas.** Las notifications ya emitidas con título "DIM ..." quedan así. Los nuevos templates usan "MiMAR".
- **Si un plan referenciado por este (e.g. scheduling plan v2) NO existe físicamente todavía** porque el plan original aún no se commiteó, skip y dejar nota. No crear archivos nuevos en este paso.

## 7. Cuando termines

1. Marcá los chequeos de §5 como hechos
2. Reportá a Nacho:
   - Cuántos archivos tocados (esperado ~13 docs + 3-5 code files)
   - Output del grep checks de §5
   - Cualquier desalineamiento que hayas encontrado entre specs / plans / AGENTS.md durante el pase y cómo lo resolviste
   - Cualquier decisión de borde sobre copy donde tuviste que improvisar (e.g., un paragraph de signup que necesitó rewrite total porque mencionaba DIM múltiples veces)
3. Commit message sugerido:
   ```
   docs(rebrand): MiMAR brand + portal restructure across all specs and plans

   Updates AGENTS.md, README, all 5 in-flight specs, all 7 in-flight plans
   to reflect:

   - User-facing brand: MiMAR (Mi Mascota Argentina). DIM remains as
     internal codename and stable identifier (token format, schema, code).
   - Mi Argentina alignment elevated from "future open question" to
     "core premise that shapes everything" in Naming and North Star.
   - Portal rename: /refugio → /org/[orgToken] (all org_types, not just
     shelters). New /pro for independent vet providers. /gob
     for govt (locality-scoped actions). /admin refined to meta-admin only.
   - service_offerings becomes polymorphic (organization_id OR
     provider_user_id, XOR) to support vet-independent providers.
   - Capability access dictates portal access. Business rules ownership
     layered: govt scoped, admin universal with override.

   Minimal code touches (brand copy in layout, public credential, auth
   pages). Physical folder rename (app/refugio → app/org), /pro
   implementation, polymorphic schema migration, and /gob route
   implementation are all separate PRs that this plan enables.
   ```

4. **Próximo paso natural** después de este plan en main:
   - Code rename de `app/refugio/` → `app/org/` con middleware redirect (1 PR, ~half day)
   - Schema migration de `service_offerings` polymorphic (1 PR, ~half day)
   - Implementación de `/pro` route group (1 PR, ~1-2 días)
   - Implementación de `/gob` route group (parte de admin page Fase 0+)

Hacé estos en el orden que tenga sentido para tu workflow. Ninguno está bloqueado por los otros una vez que este doc rebrand mergea.
