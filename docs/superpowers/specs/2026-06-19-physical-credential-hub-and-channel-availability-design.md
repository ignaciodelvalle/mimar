# Hub de credencial física + disponibilidad de canales por jurisdicción — design spec

> El punto de entrada owner-facing para llevar la credencial al mundo físico. Un solo botón en el perfil de la mascota abre un hub con **tres canales** — QR imprimible casero, chapa grabada y tag NFC — y **grisea** los que no están disponibles en la jurisdicción de la mascota. El admin controla esa disponibilidad por jurisdicción, reusando la maquinaria de `govt_business_rules`. Este spec es la **capa de orquestación**: no reimplementa la chapa física (eso es la spec `physical-tag`), no inventa un framework de config (eso es `govt-business-rules`), no tira el placeholder de interés (lo recicla). Teje las tres piezas en una sola experiencia.
>
> **Fecha:** 2026-06-19
> **Owner:** Ignacio Del Valle
> **Estado:** 🟢 Ready for CC — plan ejecutable a escribir post-OK de este spec
> **Versión:** 1.0

---

## 1. El gap que cierra

Hoy el dueño no tiene una forma unificada de "obtener una credencial física" para su mascota. Lo que existe está fragmentado y a medio terminar:

1. **`§4.20 physical-tag-interest`** (`components/pet-profile/PhysicalTagInterestCard.tsx` + tabla `physical_tag_interest` + `app/actions/physical-tag-interest.ts`) — una card que solo **mide interés** en "una chapa futura". No ofrece canales concretos ni produce nada. Es un placeholder honesto ("estamos midiendo interés — no se cobra todavía").
2. **`physical-tag` spec** (`specs/2026-05-18-physical-tag-design.md`, Item 5) — define la chapa durable con cadena `/t/[serial]` → `/p/[publicToken]`, activación, revocación, `/cuenta/chapas`, `/admin/chapas`. Es la **infraestructura** del artefacto, pero su entry point es `/cuenta/chapas` (gestión), no el perfil, y su **open question #2 (DIY QR)** quedó sin resolver.
3. **`qrcode` lib + `/cartel` + `/asistencia/presentar`** — ya generan QR server-side a `/p/[publicToken]`, pero solo en contextos puntuales (mascota perdida, presentación de perro de servicio). No hay un "descargá el QR de tu mascota para imprimir".

El resultado: un dueño que quiere poner el QR de su mascota en el collar **hoy mismo** no tiene camino. Y cuando exista la chapa grabada o el tag NFC vía proveedor, no hay forma de decir "esto está disponible en CABA pero todavía no en Formosa".

Este spec define **un único punto de entrada en el perfil** que orquesta los tres canales y su disponibilidad por zona, apoyándose en lo que ya existe.

## 2. Relación con specs existentes (qué reusa, qué NO duplica)

| Pieza existente | Qué aporta | Cómo la usa este spec |
|---|---|---|
| `specs/2026-05-18-physical-tag-design.md` (Item 5) | `pet_tags`, `/t/[serial]`, activación/revocación, `/cuenta/chapas`, `/admin/chapas`, eventos `tag_activated`/`tag_revoked` | Los canales **chapa grabada** y **NFC** entregan un artefacto que, post-fulfillment, se activa por la cadena `/t/[serial]` de esa spec. Este hub es el **descubrimiento/pedido**; la activación sigue siendo de physical-tag. **Resuelve su open question #2 (DIY QR)** = el canal QR imprimible. |
| `specs/2026-05-19-govt-business-rules-poc-design.md` (Item 16) — tabla `govt_business_rules`, `lib/business-rules-resolver.ts` (cascada localidad→provincia→país→default), `lib/business-rules-defaults.ts`, CRUD admin en `/admin/jurisdicciones/.../reglas`, audit obligatorio | Framework de config scoped por jurisdicción con resolver + auditoría + UI | Agrega un `ruleType` nuevo `physical_credential_channels`. **Cero infraestructura nueva de config**: reusa resolver, defaults, validators, form-por-ruleType, audit. |
| `§4.20 physical-tag-interest` (tabla + action + card) | Mecanismo de "lista de espera" por `(pet, user)` con soft-cancel | Se **recicla**: el botón "Avisame cuando esté disponible" de un canal **gris** escribe en `physical_tag_interest`. La card placeholder se **reemplaza** por el hub. |
| `qrcode` lib + patrón de `/cartel` (`QRCode.toString(url, {type:'svg'})`) | Generación server-side de QR/PDF a `/p/[publicToken]` | Base del canal **QR imprimible**. |
| Perfil v2.1 (`specs/2026-06-18-pet-profile-v21-reorder-...-design.md`, Item 6) — sección "03 Credenciales" dentro de la tab Resumen | Ubicación canónica de cards de credencial (PPP, perro de servicio, y hoy la card §4.20) | El hub vive ahí, respetando el orden cerrado (hero → alert strip → quick actions → tabs). |
| `LnSheetPage`, `LnButton`, tokens `--color-ln-*`, `disabled:opacity-50` | Chrome y design system | El sheet y los estados de canal se construyen con esto. Sin chrome nuevo. |

## 3. Decisiones cerradas (confirmadas con Nacho 2026-06-19)

| # | Decisión | Razón |
|---|---|---|
| **D1** | **Tres canales, todos configurables por jurisdicción.** `printable_qr` con default **ON pero apagable** por el admin; `engraved_plate` y `nfc_tag` default **OFF** hasta que haya proveedor en esa zona. | El QR casero es gratis y sin proveedor → cobertura zero-cost por default, pero el admin conserva la palanca de apagarlo en una zona si hiciera falta (p. ej. conflicto con un canal oficial). Chapa/NFC dependen de fulfillment real → off hasta que exista. |
| **D2** | **Reusar `govt_business_rules`** con un `ruleType` nuevo `physical_credential_channels`. No tabla dedicada. | Hereda gratis cascada localidad→provincia→país→default, resolver, validators, audit y la pantalla admin `/admin/jurisdicciones`. Es exactamente "el sistema de organización y criterios del proyecto": admin = scope universal, config scoped por jurisdicción. |
| **D3** | **Sin eventos nuevos en el MVP.** El QR imprimible es un *generate* stateless (igual que `/cartel` hoy, que no emite evento). El pedido de chapa/NFC deriva al fulfillment de la spec physical-tag, cuya activación ya emite `tag_activated`. "Avisame" reusa `physical_tag_interest` (no es evento del pet timeline). | Mantiene el MVP liviano y honesto: no se inventan eventos para acciones que todavía no tienen fulfillment real dentro de DIM. Cuando exista pedido/checkout, se evalúa `physical_credential_ordered`. |
| **D4** | **El hub reemplaza la card `§4.20`**, no convive con ella. El mecanismo de interés se preserva como el CTA "Avisame" de canales grises (con `channel` opcional). | Una sola superficie en el perfil. El placeholder cumplió su función (medir interés); ahora se gradúa a feature real sin perder los datos de interés ya capturados. |
| **D5** | **El QR imprimible resuelve la open question #2 de physical-tag (DIY QR) → SÍ.** El QR casero apunta **directo** a `/p/[publicToken]`, NO pasa por `/t/[serial]`. | El DIY no es una chapa de inventario; es una impresión casera. No tiene serial, no se revoca, no entra a `pet_tags`. Es la cobertura inmediata zero-cost mientras llega el canal físico. |
| **D6** | **Disponibilidad se resuelve contra la jurisdicción de la mascota** (`pet.jurisdictionCountry/Province/Locality`), no la del usuario. | La credencial es de la mascota; su jurisdicción ya es canónica desde el registro (catálogo INDEC). Coherente con cómo se resuelven las reglas PPP. |

## 4. El diseño

### 4.1 Entry point en el perfil

En la sección **"03 Credenciales"** de la tab Resumen (donde hoy renderiza `PhysicalTagInterestCard` y las cards PPP / perro de servicio), una card nueva **`PhysicalCredentialCard`** reemplaza a la del §4.20:

```
┌─────────────────────────────────────────────┐
│ 🏷️  Credencial física para {nombre}          │
│ Una credencial que cuelga del collar. Si      │
│ alguien encuentra a {nombre}, escanea y llega │
│ a su perfil.                                   │
│                          [ Obtener credencial ]│  ← LnButton primary
└─────────────────────────────────────────────┘
```

El botón **"Obtener credencial física"** abre el sheet vía deep-link `?sheet=credencial-fisica` (mismo patrón que `?sheet=marcar-perdida`, registrado en `SheetMounter`).

> **Por qué card+sheet y no un ítem en `PetActionsMenu`:** el v2.1 separó *logging* (EventCatcher/`/anotar`) de *gestión* (PetActionsMenu) y ubicó las **credenciales** como cards dentro de Resumen (D4 del Item 6). "Credencial física" es credencial, no logging ni lifecycle → va como card en la sección 03, no como verbo de acción.

### 4.2 El sheet de canales — `GetPhysicalCredentialSheet`

`LnSheetPage tone="azul"`, título **"Credencial física para {nombre}"**, subtítulo corto. Cuerpo = tres filas-canal renderizadas desde un array, cada una con su estado resuelto:

| Canal | `channel_key` | Ícono | Default | Acción si **disponible** |
|---|---|---|---|---|
| QR imprimible | `printable_qr` | 📄 | ON (apagable) | Genera PDF imprimible (chapita troquelable + tarjeta tamaño billetera) reusando la infra de `/cartel`. QR → `/p/[publicToken]` directo (D5). |
| Chapa grabada | `engraved_plate` | 🏷️ | OFF | Deriva al hand-off del proveedor (`providerName` + `providerUrl` del payload de la regla). La activación posterior es de physical-tag (`/t/[serial]`). |
| Tag NFC | `nfc_tag` | 📡 | OFF | Igual que chapa, hand-off al proveedor NFC. |

### 4.3 Estados del canal (el corazón del pedido)

Cada fila-canal es un `role="group"` con uno de estos estados:

| Estado | Cuándo | Visual | Comportamiento | A11y |
|---|---|---|---|---|
| **Disponible** | resolver = `true` para la jurisdicción de la mascota | fila activa, botón primario (`printable_qr`) o ghost (`engraved_plate`/`nfc_tag`) | ejecuta el canal | botón habilitado, label descriptivo |
| **No disponible (gris)** | resolver = `false` | `opacity-50`, fila no interactiva, leyenda "No disponible en tu zona todavía" | muestra CTA secundario **"Avisame"** → `togglePhysicalTagInterestAction(token, channel)` | `aria-disabled="true"` + `disabled` real (no solo color) + leyenda asociada vía `aria-describedby` |
| **Interés registrado** | el user ya tocó "Avisame" para ese canal | fila gris + "Te avisamos cuando esté disponible. Solicitado el {fecha}." + "Cancelar" | toggle (soft-cancel, ya implementado) | botón "Cancelar interés" |
| **Cargando** | generando PDF / enviando | spinner inline, botón `disabled` | — | `aria-busy="true"` |

> **Greying = función pura del resolver.** No hay lógica nueva de feature-flags. La fila se construye con `{ channel, available: boolean, interest: PhysicalTagInterestState }` y el componente decide el estado. Esto es testeable sin DB (snapshot de los 4 estados).

### 4.4 Resolución de disponibilidad

Server component del perfil llama un helper nuevo:

```ts
// lib/physical-credential-channels.ts
export interface ChannelAvailability {
  printable_qr: boolean;
  engraved_plate: { enabled: boolean; providerName?: string; providerUrl?: string };
  nfc_tag:       { enabled: boolean; providerName?: string; providerUrl?: string };
}

export async function resolvePhysicalCredentialChannels(
  jurisdiction: { country: string; province: string | null; locality: string | null },
): Promise<ChannelAvailability>;
```

Implementado **sobre `lib/business-rules-resolver.ts`** (Item 16): resuelve el `ruleType='physical_credential_channels'` con la cascada localidad→provincia→país→default. El default vive en `lib/business-rules-defaults.ts`:

```ts
physical_credential_channels: {
  printable_qr: true,                         // D1: ON por default, apagable
  engraved_plate: { enabled: false },         // D1: off hasta proveedor
  nfc_tag:        { enabled: false },
}
```

El resultado se pasa a `PhysicalCredentialCard` → `GetPhysicalCredentialSheet`. Greying derivado.

### 4.5 Tokens, props y variantes (design-system)

**`PhysicalCredentialCard`** (server-rendered, presentational)

| Prop | Tipo | Default | Descripción |
|---|---|---|---|
| `petPublicToken` | `string` | — | Token del pet para deep-link + QR target |
| `petName` | `string` | — | Para copy |
| `availability` | `ChannelAvailability` | — | Resuelto server-side |
| `interestByChannel` | `Record<ChannelKey, PhysicalTagInterestState>` | — | Estado de interés por canal |

**Tokens usados:** card `rounded-2xl border-ln-line bg-ln-card p-4`; heading `text-base font-semibold text-ln-ink`; CTA primaria `bg-ln-azul hover:bg-ln-azul-700 text-white`; estado gris `disabled:opacity-50`; sheet `LnSheetPage tone="azul"`. Sin tokens nuevos.

**A11y:** cada fila-canal `role="group"` con `aria-labelledby`; canales grises `aria-disabled` + `disabled` real + leyenda `aria-describedby`; el sheet hereda focus-trap y `Escape` de `LnSheetPage`.

### 4.6 Control admin — pantalla

**No hay pantalla admin nueva.** Se enchufa al CRUD existente `/admin/jurisdicciones/[country]/[province]/[locality]/reglas`:

- Nuevo `ruleType` `physical_credential_channels` aparece en el catálogo de reglas de la jurisdicción.
- **Form específico** (NO JSON editor, coherente con el patrón de los forms PPP) `PhysicalCredentialChannelsForm.tsx`:
  - Checkbox "QR imprimible disponible" (default checked).
  - Checkbox "Chapa grabada disponible" → al activarse, revela inputs `providerName` + `providerUrl`.
  - Checkbox "Tag NFC disponible" → idem.
- Reusa `createBusinessRuleAction` / `updateBusinessRuleAction` (boundary + writer + audit ya existentes), `validateRulePayload` (nuevo validador Zod para este ruleType), y la detección de no-op/duplicado.
- **Audit** automático (`govt_business_rule_created/updated/deleted`) — sin trabajo extra.
- `/gob/reglas` (read-only, scoped por jurisdicción del operador) muestra la regla resuelta — el operador govt **ve** qué canales están habilitados en su zona pero **no** los edita (solo admin, scope universal).

### 4.7 Payload de la regla (validado por Zod)

```ts
// rulePayload para physical_credential_channels
{
  printable_qr: boolean,
  engraved_plate: { enabled: boolean, providerName?: string, providerUrl?: string },
  nfc_tag:        { enabled: boolean, providerName?: string, providerUrl?: string },
}
```

Validador: si `enabled=true` para chapa/NFC, `providerName` requerido y `providerUrl` debe ser URL válida (para el hand-off). Si `enabled=false`, se ignoran los campos de proveedor.

## 5. Implementation (file-level)

- **`lib/business-rules-defaults.ts`** — agregar `physical_credential_channels` al objeto de defaults (D1).
- **`lib/business-rules-validators.ts`** — agregar el validador Zod del nuevo payload.
- **`lib/physical-credential-channels.ts`** (nuevo) — `resolvePhysicalCredentialChannels()` sobre el resolver existente; tipo `ChannelAvailability` + `ChannelKey`.
- **`lib/physical-tag-interest.ts`** — extender `getPhysicalTagInterest` para devolver estado por `(pet, user, channel?)`; mantener back-compat con el toggle global.
- **`app/actions/physical-tag-interest.ts`** — `togglePhysicalTagInterestAction(token, channel?)` acepta `channel` opcional (columna nueva nullable; ver §6).
- **`components/pet-profile/PhysicalCredentialCard.tsx`** (nuevo) — reemplaza el render de `PhysicalTagInterestCard` en el perfil.
- **`components/pet-profile/GetPhysicalCredentialSheet.tsx`** (nuevo) — las tres filas-canal con sus estados.
- **`app/(app)/mis-mascotas/[publicToken]/page.tsx`** — en la sección "03 Credenciales", resolver `availability` + `interestByChannel` y renderizar `PhysicalCredentialCard` en lugar de `PhysicalTagInterestCard`.
- **`SheetMounter`** — registrar `?sheet=credencial-fisica` → `GetPhysicalCredentialSheet`.
- **Canal QR imprimible** — ruta/print view nueva (p. ej. `app/(app)/mis-mascotas/[publicToken]/credencial/`) que genera el PDF (chapita troquelable + tarjeta billetera) reusando el patrón de `cartel/page.tsx` + `cartel-print.css`. QR → `/p/[publicToken]` directo (D5). **A diferencia de `/cartel`, no exige `status='lost'`** — es permanente, Tier 0.
- **`app/admin/jurisdicciones/[country]/[province]/[locality]/reglas/nueva/PhysicalCredentialChannelsForm.tsx`** (nuevo) — form específico del ruleType.
- **Router de form por `?ruleType=`** en `nueva/page.tsx` y `editar/[ruleId]` — agregar el case del nuevo ruleType.
- **`components/pet-profile/PhysicalTagInterestCard.tsx`** — deprecar/eliminar tras migrar su uso (su lógica de toggle se absorbe en el sheet).

## 6. Cambios de datos

Mínimos, alineados con D2/D3:

- **`physical_tag_interest`** — agregar columna `channel text` nullable (`'printable_qr' | 'engraved_plate' | 'nfc_tag' | null`). `null` = interés legacy (global, pre-canales). La unicidad pasa de `(pet, user)` a `(pet, user, channel)` para permitir interés por canal. Migración nueva + backfill trivial (filas viejas quedan `channel=null`).
- **`govt_business_rules`** — **sin cambios de schema**: `ruleType` es `text` y `rulePayload` es `jsonb`. Solo se agrega un valor al enum lógico de `ruleType` (validado en código, no en DB) y su default/validator.
- **Sin event types nuevos** (D3).

## 7. Test plan (test-first)

- **Resolver** (`lib/physical-credential-channels.test.ts`): default → `printable_qr:true`, plate/NFC `false`; regla a nivel localidad override a provincia/país (cascada); payload con proveedor se propaga (`providerName/Url`).
- **Estados de canal** (componente, sin DB): para cada canal, los 4 estados (disponible / gris / interés-registrado / cargando) renderizan el control correcto; gris usa `disabled` real + `aria-disabled`, no solo opacidad.
- **Greying por jurisdicción**: mascota en jurisdicción con `nfc_tag.enabled=false` → fila NFC gris con CTA "Avisame"; misma mascota tras habilitar NFC en su localidad → fila activa.
- **Interés por canal**: `togglePhysicalTagInterestAction(token, 'nfc_tag')` crea/cancela solo ese canal; el interés legacy (`channel=null`) no se pisa.
- **QR imprimible**: la print view genera QR a `/p/[publicToken]` (no `/t/`); funciona con `status != 'lost'` (a diferencia de `/cartel`).
- **Admin form**: crear regla `physical_credential_channels` con NFC enabled exige `providerName`/`providerUrl`; no-op detection si el payload == default; audit escrito.
- **Perfil**: la sección "03 Credenciales" renderiza `PhysicalCredentialCard` y ya no `PhysicalTagInterestCard`; orden v2.1 intacto (hero primero).

## 8. Out of scope (explícito)

- **Fulfillment / checkout / pago** de chapa y NFC dentro de DIM — sigue siendo el dominio de la spec physical-tag (§14 de ese doc) y futuro v2. Acá el canal disponible solo hace **hand-off** al proveedor.
- **La cadena `/t/[serial]`, `pet_tags`, activación/revocación, `/cuenta/chapas`, `/admin/chapas`** — son de la spec physical-tag (Item 5). Este spec no los toca; solo los referencia como destino post-pedido.
- **Evento `physical_credential_ordered`** — diferido hasta que exista pedido real (D3).
- **Override org-level** (un refugio/clínica específico que ofrezca chapas independiente de la jurisdicción) — posible extensión futura vía boolean en `organizations` (patrón `tier0ShowBranding`), fuera del MVP.
- **NFC tap nativo** (Web NFC API) — out of scope core, igual que en physical-tag §14.

## 9. Decisiones (cerradas 2026-06-19)

Las 4 preguntas abiertas se resolvieron con el dueño del producto:

1. **Granularidad del proveedor por canal** → **uno por canal por jurisdicción** (`providerName` + `providerUrl` únicos por canal). Lista multi-proveedor queda diferida hasta que emerja.
2. **QR imprimible — formato del PDF** → **una sola hoja A4** con chapita troquelable + tarjeta tamaño billetera, sin opciones de usuario en v1.
3. **Copy del estado gris** → **"No disponible en tu zona todavía"** (no promete fechas; se descarta "Próximamente en {localidad}").
4. **Todos los canales apagados en una jurisdicción** → **se permite** (coherente con D1: `printable_qr` es apagable); el hub renderiza un **empty state** claro con copy + "Avisame" global. No se fuerza el QR siempre-ON.

## 10. Próximo paso

Con OK de este spec, escribir `plans/2026-06-19-physical-credential-hub.md`. Fases sugeridas:

| Fase | Resumen | Dependencias |
|---|---|---|
| **A** | `ruleType` `physical_credential_channels`: default + validador Zod + resolver `lib/physical-credential-channels.ts` + tests | Item 16 (govt-business-rules) en código |
| **B** | Admin form `PhysicalCredentialChannelsForm` + wiring en `nueva`/`editar` + read-only en `/gob/reglas` | A |
| **C** | Migración `physical_tag_interest.channel` + extensión del action/helper de interés | — |
| **D** | `PhysicalCredentialCard` + `GetPhysicalCredentialSheet` + registro `?sheet=credencial-fisica` + swap en el perfil (deprecar `PhysicalTagInterestCard`) | A, C |
| **E** | Canal QR imprimible: print view `/credencial` reusando `cartel` infra (resuelve DIY-QR / open question #2 de physical-tag) | D |
| **F** | Tests integración + smoke del flujo completo + docs | A–E |

**Decisiones pendientes antes del plan**: las 4 open questions de §9 (todas con propuesta por default; confirmables en el OK).

## 11. Docs to update (mismo PR del plan)

- `AGENTS.md` → Privacy tiers: nota de que la credencial física (cualquier canal) resuelve a Tier 0 estable de por vida; no expone más que el `/p/[publicToken]`.
- `specs/2026-05-18-physical-tag-design.md` → marcar **open question #2 (DIY QR) resuelta** por este spec (canal `printable_qr`), y referenciar este hub como su entry point owner-facing.
- `specs/2026-05-19-govt-business-rules-poc-design.md` → agregar `physical_credential_channels` a la lista de ruleTypes consumidores del framework.
- `docs/superpowers/README.md` → fila ✅/🟢 + SHA cuando se implemente.
