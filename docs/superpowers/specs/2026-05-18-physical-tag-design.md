# Chapa identificadora física — design spec

> La chapa física que cuelga del collar del pet con el QR que apunta al credencial público. Cierra el gap entre el software de DIM y el mundo real: sin un objeto que el finder casual pueda escanear, todo el flujo lost-and-found queda dependiente de que el finder sepa que DIM existe y busque manualmente. Este spec define el lado nuestro del problema — schema, eventos, flujos, URL — y deja como placeholders explícitos la decisión de fabricante, material concreto y modelo de distribución comercial, alineado con la estrategia Estonia-style de empezar institucional-digital y dejar el componente físico abierto hasta que llegue volumen o integración govt.
>
> **Fecha:** 2026-05-18
> **Owner:** Ignacio Del Valle
> **Estado:** 🟢 Ready for CC — plan ejecutable en `plans/2026-05-18-physical-tag.md` (a escribir después del OK de este spec)
> **Versión:** 1.0

---

## 1. El gap que cierra

DIM hoy renderiza `/p/[publicToken]` correctamente con foto, nombre, status, microchip y canal de contacto. El `publicToken` (`DIM-XXXX-XXXX`) es unguessable y URL-safe. **Lo que falta es el artefacto físico**: el QR que cuelga del collar y un vecino escanea cuando encuentra al perro en la calle.

Sin chapa, el lost-and-found completo que specceamos depende de que el finder (a) sepa que DIM existe, (b) busque "DIM" o "MiMAR" o "mascota perdida AR", (c) llegue al sitio, (d) tipee el número del microchip si lo conoce. Nada de esto pasa en la realidad. El finder casual *escanea lo que está en el collar*. Si no hay QR ahí, el flujo se rompe en el último mile.

Este spec define qué construye DIM para que ese QR exista, sin comprometernos todavía con un proveedor de fulfillment ni con un material específico. La filosofía es **Estonia-style**: la identidad canónica vive en el software (publicToken + microchip ISO), la chapa es UX layer encima. Cualquier fabricante que produzca un objeto con un QR que apunte a la URL canónica resuelve el problema.

## 2. Decisiones cerradas (confirmadas con Nacho 2026-05-18)

| # | Decisión | Razón |
|---|---|---|
| D1 | **El QR contiene la URL completa al credencial público en el dominio principal**: `https://mimar.gob.ar/p/DIM-XXXX-XXXX` (o el dominio activo del momento). No dominio corto separado, no short-code intermedio | Simplicidad operacional. Sin dominio extra para registrar y mantener. El `publicToken` ya es la identidad canónica del pet — la chapa es 1:1 con esa URL. Si el QR se vuelve denso de leer, la mejora viene por mejor material/grabado, no por acortar URL |
| D2 | **Múltiples chapas activas simultáneas por pet permitidas**. Owner puede tener tag en collar + arnés + transportadora + carrier de transporte. Todas apuntan a la misma URL del credencial | Refleja realidad: los owners ponen tags en varios lugares. Implementación elegante: las chapas son artefactos de inventario (con su propio serial físico), no entidades de URL distintas. Misma URL para todas — el finder ve siempre el mismo perfil del pet |
| D3 | **Material y tecnología abiertos en v1**. El spec NO se compromete con silicona vs metal vs plástico, ni con QR-only vs QR+NFC. La chapa es definida por sus propiedades funcionales (durable, legible, soporta el QR de la URL canónica), no por sus propiedades materiales | Evita lock-in con un proveedor antes de tener volumen. El research benchmark muestra trade-offs reales (silicona más durable, NFC reduce fricción, metal más percibido como oficial); la elección final depende de qué fabricante AR salga adelante y a qué precio. La arquitectura DIM no cambia con la elección de material |
| D4 | **Fabricante: placeholder explícito**. El spec lista opciones AR conocidas + opciones import-friendly + criterios para elegir, pero no compromete a ninguna. La decisión es de operación, no de arquitectura | Permite escribir todo el código del lado DIM (schema, flows, surfaces) antes de tener un fabricante listo. Cuando el fabricante esté, el spec describe los datos mínimos que tiene que devolverle a DIM (serial + lote + activation status) y no más |
| D5 | **Modelo de distribución: Estonia-style en intención, abierto en mecánica**. La chapa no se vende self-service en v1 (no hay e-commerce / fulfillment dentro de DIM). Se asume distribución vía canal institucional cuando esté disponible: refugios, veterinarios, futura integración Mascotas CABA / Mi Argentina. Mientras tanto, el sistema soporta self-activation: el owner que compre una chapa DIM-compatible en cualquier canal puede activarla escaneándola | Coherente con el North Star de DIM como infra digital del estado AR. No nos metemos en logística antes de tiempo. Cuando el canal aparezca (govt o partnership), DIM ya tiene el flow de activación listo |
| D6 | **La chapa es un artefacto físico identificado por `tag_serial`, separado del `publicToken` del pet**. El serial es interno (rastreo de lotes, anti-counterfeit, revocación granular); la URL pública del QR siempre es la del publicToken | Permite emitir lotes de chapas pre-impresas con serial conocido pero sin pet asociado, distribuirlas vía cualquier canal, y que el activador (owner) las ligue a su pet cuando las recibe. También permite revocar una chapa físicamente perdida sin afectar las otras del mismo pet |
| D7 | **Activación es self-serve y atómica**. Owner escanea su chapa nueva, la app detecta que es un serial sin asociar, le ofrece "Asociar a una mascota" (lista sus pets) o "Registrar nueva mascota". Confirma → la chapa queda ligada y operativa | UX simple, sin papeleos, sin pre-asociación en fábrica. Si la chapa se pierde antes de activarse, el serial nunca llegó a apuntar a nadie — sin impacto privacy/security |
| D8 | **Revocación NO cambia la URL del pet**. Cuando se revoca una chapa (perdida, dañada, robada), el `tag_serial` queda marcado revocado en inventario. La URL del credencial sigue funcionando porque está atada al `publicToken` del pet, no a la chapa. Las otras chapas activas del mismo pet siguen funcionando | Edge case que el modelo resuelve gratis: si una chapa cae en manos hostiles, el dueño revoca esa chapa específica y emite/activa otra. El finder casual escaneando la chapa revocada llega al mismo credencial — porque la URL es del pet, no de la chapa. La diferencia operativa es solo de inventario interno |
| D9 | **`pet_events` registra `tag_activated` y `tag_revoked`** como eventos del pet timeline, además de quedar en la tabla `pet_tags` directamente | Coherente con el patrón de event-sourcing del proyecto. El timeline del pet muestra "Chapa M-3F9A activada en marzo 2026" — utilidad para el owner ver el historial completo de su pet |

## 3. Glosario

| Término | Qué es | Vive en |
|---|---|---|
| **Tag / Chapa** | El artefacto físico con el QR. Un objeto que cuelga del collar, arnés, transportadora | `pet_tags` (tabla nueva) |
| **`tag_serial`** | Identificador interno único de la chapa física. Formato `M-XXXX` (4 chars alfanuméricos sin ambigüedad, ~1.6M combinaciones). Se imprime visible en el dorso de la chapa para referencia oral. NO es URL — es un código interno | `pet_tags.serial` |
| **`tag_lote_id`** | Lote de producción al que pertenece la chapa. Trazabilidad: si un lote sale defectuoso o se reporta falsificado, se revoca todo el lote | `pet_tags.lote_id`, opcional |
| **Activación** | Acto del owner de ligar una chapa pre-emitida a un pet suyo. Cambia `pet_tags.status` de `issued` a `activated` | Server action |
| **Revocación** | Marca una chapa como ya-no-vigente. Mantiene la row para audit, pero `status='revoked'` | Server action |
| **Credencial pública** | El surface `/p/[publicToken]` ya existente. Es lo que el finder ve cuando escanea | `app/p/[publicToken]/page.tsx` (existe) |
| **Disclosure prefs** | Las preferencias de privacidad del owner que controlan qué muestra el credencial. Ya specceadas en lost-and-found v1.1 | `pets.disclosure_*` columns (existen) |

## 4. Domain model

### 4.1 Tabla `pet_tags`

```sql
create table pet_tags (
  id                  uuid primary key default gen_random_uuid(),
  serial              text not null unique,                  -- "M-3F9A", "M-7K2X", etc.
  lote_id             text,                                  -- "L-2026-01" — optional batch trace
  pet_id              uuid references pets(id) on delete set null,  -- null = unactivated

  status              text not null default 'issued',        -- 'issued' | 'activated' | 'revoked'
  activated_at        timestamptz,
  activated_by_user_id uuid references profiles(id),

  revoked_at          timestamptz,
  revoked_by_user_id  uuid references profiles(id),
  revoked_reason      text,                                  -- 'lost' | 'damaged' | 'stolen' | 'replaced' | 'transfer' | 'other'

  -- Optional placeholder fields for future use; nullable in v1
  material            text,                                  -- 'silicone' | 'metal' | 'plastic' | null (unknown)
  has_nfc             boolean not null default false,
  manufacturer        text,                                  -- free text, e.g. "Luna Accesorios", "K9 Dog Trainers"

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint pet_tags_status_valid check (status in ('issued','activated','revoked')),
  constraint pet_tags_activation_consistent check (
    (status = 'issued'    and pet_id is null     and activated_at is null and revoked_at is null)
    or
    (status = 'activated' and pet_id is not null and activated_at is not null and revoked_at is null)
    or
    (status = 'revoked'   and activated_at is not null and revoked_at is not null)
  ),
  constraint pet_tags_revoked_reason_valid check (
    revoked_reason is null
    or revoked_reason in ('lost','damaged','stolen','replaced','transfer','other')
  ),
  constraint pet_tags_material_valid check (
    material is null or material in ('silicone','metal','plastic')
  )
);

create index pet_tags_pet_idx     on pet_tags (pet_id) where status = 'activated';
create index pet_tags_serial_idx  on pet_tags (serial);
create index pet_tags_status_idx  on pet_tags (status);
create index pet_tags_lote_idx    on pet_tags (lote_id) where lote_id is not null;
```

**Sobre el serial**: 4 chars alfanuméricos excluyendo caracteres ambiguos (I, O, 0, 1, l) → ~31^4 = ~923K combinaciones. Suficiente para v1; expandible a 5-6 chars cuando el volumen lo demande (migración sin breaking change). El formato `M-XXXX` empieza con `M-` para "MiMAR" como prefix legible.

**Sobre la URL del QR**: NO se almacena en la chapa el `tag_serial`. El QR contiene `https://mimar.gob.ar/p/DIM-XXXX-XXXX` donde el `DIM-XXXX-XXXX` es el `publicToken` del pet **post-activación**. La chapa pre-emitida (status='issued') no tiene QR ligado todavía — se imprime el QR *después* de la activación. Esto requiere que el fulfillment soporte print-on-demand o que la chapa lleve QR genérico que redirija a "activá tu chapa" hasta activación.

**Alternativa más simple**: el QR de cada chapa contiene `https://mimar.gob.ar/t/M-XXXX` (donde `M-XXXX` es el serial). El server resuelve:
- Si `status='activated'`: 302 redirect a `/p/[publicToken]`
- Si `status='issued'`: 200 page "Esta chapa todavía no está activada. ¿Sos el dueño? Activala acá."
- Si `status='revoked'`: 200 page "Esta chapa fue revocada. Si la encontraste suelta, gracias por intentar. Si crees que pertenece a alguien, contactá info@..."

**Decisión**: usar `/t/M-XXXX` con redirect server-side. Mantiene D1 (URL pública del credencial siempre `/p/[publicToken]`) más la flexibilidad de pre-imprimir QR antes de saber a qué pet va. **El finder NUNCA ve `/t/`** — el redirect es transparente. El owner ve `mimar.gob.ar/p/...` siempre que comparta el link manualmente.

### 4.2 Estados y transiciones

```
                  ┌──────────────────────────────────────────┐
                  │                                          │
   [fabricación]──▶ issued ──[activate]──▶ activated ──[revoke]──▶ revoked
                                              │
                                              └──[transfer flow]──▶ activated (con nuevo pet_id, mismo serial)
```

- **`issued`**: row creada por el script de import del lote del fabricante. `pet_id=null`. QR físico ya impreso con URL `mimar.gob.ar/t/M-XXXX`.
- **`activated`**: owner asoció la chapa a su pet. `pet_id` apunta al pet. Redirect `/t/...` → `/p/[publicToken]` activo.
- **`revoked`**: marcada terminal. La row sobrevive para audit; el redirect muestra la página de revocada. Re-activación de la misma chapa **no permitida** (emit nueva chapa, no reciclar).

**Transferencia de pet con chapa**: cuando el pet cambia de dueño (adopción, custody transfer), la chapa va con el pet por default — no hay que re-emitir nada porque la URL del QR sigue apuntando al mismo `publicToken`. Si el nuevo owner quiere chapa propia (estética, marketing), revoca la vieja y activa una nueva. Convención: `revoked_reason='transfer'` documenta este caso.

### 4.3 Event types nuevos en `pet_events`

Agregar al catálogo (con su Zod schema correspondiente, siguiendo el patrón del event-catalog-cleanup plan):

| Event type | Cuándo | Payload |
|---|---|---|
| `tag_activated` | Owner liga chapa a pet | `{ tag_serial: "M-3F9A", lote_id?, material?, has_nfc, source?: 'self' | 'authority' }` |
| `tag_revoked` | Owner o authority revoca chapa | `{ tag_serial, reason: 'lost'|'damaged'|'stolen'|'replaced'|'transfer'|'other', replacement_tag_serial? }` |

**`tag_issued` no es event** del pet timeline — la chapa todavía no está ligada a un pet cuando se emite. Vive solo en la tabla `pet_tags`. Si emerge necesidad de tracear emisión, agregar después como event del lote (out of scope v1).

### 4.4 Soporte de múltiples chapas activas por pet

Schema lo soporta nativo: `pet_tags.pet_id` es FK + index, no UNIQUE. Múltiples rows con mismo `pet_id` y `status='activated'` son válidas. Query típica del owner:

```sql
select * from pet_tags
where pet_id = $1 and status = 'activated'
order by activated_at desc;
```

Caso real: collar tag M-3F9A + arnés tag M-8K2L + transportadora tag M-4R7Z. Tres rows, mismo pet, todas activas. Cualquier finder escanea cualquiera → mismo credencial.

## 5. URL canónica del QR — confirmación de D1

Lo que se imprime físicamente en cada chapa:

```
https://mimar.gob.ar/t/M-XXXX
```

**Server behavior** en `/t/[serial]`:

| Status del serial | Response |
|---|---|
| `activated` | HTTP 302 redirect a `/p/[publicToken]` del pet asociado |
| `issued` (no activada) | HTTP 200 página "Activá esta chapa" con form que requiere login del owner |
| `revoked` | HTTP 200 página "Chapa revocada — contactá info@..." con disclaimer |
| Serial no existe | HTTP 404 |

El finder casual ve siempre la URL final `mimar.gob.ar/p/DIM-XXXX-XXXX` en su browser después del redirect. Esa URL es la canónica para compartir manualmente.

**Por qué no imprimir directo `mimar.gob.ar/p/DIM-XXXX-XXXX` en la chapa**: porque las chapas se imprimen ANTES de saber a qué pet van. Pre-imprimirlas con URL del pet sería print-on-demand 1:1, lo cual sube costo unitario y elimina la posibilidad de fabricar lotes para distribución vía refugios/vets. El indirect `/t/...` es lo que habilita el modelo Estonia-style.

## 6. UX flows

### 6.1 Activación

```
Owner recibe la chapa (por canal X: refugio, vet, regalo, e-commerce futuro)
  → Escanea el QR con el teléfono
  → Browser abre mimar.gob.ar/t/M-3F9A
  → Server detecta status='issued', renderiza página de activación
  → Página invita a login (si no logueado, redirect a /login con returnTo=/t/M-3F9A)
  → Logged-in: "Esta chapa está lista para asociar a una mascota."
       [Lista de las mascotas del owner con radio button]
       [Opción "Registrar nueva mascota" abajo]
  → Owner elige pet o crea nueva
  → Submit → activateTagAction({ serial: "M-3F9A", petId })
    Transacción:
      1. Lock advisory sobre el serial (anti-double-activation race)
      2. SELECT pet_tags WHERE serial=$1 FOR UPDATE
      3. Validar status='issued' (si no → error claro)
      4. Validar ownership del pet por session user
      5. UPDATE pet_tags SET status='activated', pet_id=$2, activated_at=now(),
                                activated_by_user_id=session.user.id
      6. INSERT pet_events type='tag_activated' con payload
      7. INSERT notification al owner confirmando
    Commit
  → Redirect a /mis-mascotas/[publicToken] del pet, banner "Chapa activada ✓"
```

### 6.2 Revocación

```
Owner va a /cuenta/chapas → ve sus chapas activas + revocadas
  → Click "Revocar" sobre M-3F9A
  → Form:
       - Razón (dropdown obligatorio): perdida / dañada / robada / reemplazada / transferencia / otro
       - Tag de reemplazo (opcional): serial de otra chapa que estás activando ahora mismo
       - Confirm checkbox: "Entiendo que esta chapa dejará de funcionar y la URL mostrará página de revocada"
  → Submit → revokeTagAction({ serial, reason, replacementSerial? })
    Transacción:
      1. Lock advisory sobre el serial
      2. Validar status='activated' y ownership
      3. UPDATE pet_tags SET status='revoked', revoked_at=now(), revoked_by_user_id, revoked_reason
      4. INSERT pet_events type='tag_revoked' con payload (incluye replacement_tag_serial si aplica)
      5. Si replacementSerial provisto: cascadear a activateTagAction internamente
    Commit
  → Refresh /cuenta/chapas
```

### 6.3 Owner panel `/cuenta/chapas`

```
Tabla con todas las chapas que el owner activó alguna vez:

| Serial   | Pet           | Estado     | Activada       | Acciones      |
|----------|---------------|------------|----------------|---------------|
| M-3F9A   | Pepe (perro)  | Activa     | 15 mar 2026    | Revocar       |
| M-8K2L   | Pepe (perro)  | Activa     | 16 mar 2026    | Revocar       |
| M-7R2X   | Luna (gato)   | Activa     | 02 abr 2026    | Revocar       |
| M-4Q1B   | Pepe (perro)  | Revocada   | -- · 12 ene    | (audit only)  |

[+ Activar nueva chapa]
  → Form: "Tipeá o escaneá el serial de la chapa nueva"
       Si tiene cámara: botón "Escanear con cámara" que abre QR reader
       Si no: input texto manual ("M-XXXX")
  → onSubmit: si el serial es válido y status='issued', muestra activation flow §6.1
```

### 6.4 Surface del finder — no hay form ni login

El finder no se logueea. Solo escanea, ve `/p/[publicToken]`, lee el contacto, llama al owner. **No tocamos ese surface en este spec** — ya existe. La chapa solo es el delivery mechanism del QR.

### 6.5 Surface admin/govt — gestión de inventario

`/admin/chapas` (admin only en v1):

- Búsqueda por serial, lote, estado, owner
- Vista de lote: cuántas chapas emitidas, activadas, revocadas
- Acción "Cargar lote nuevo": form que recibe `lote_id` + cantidad + (opcional) material, manufacturer, has_nfc → genera N serials únicos en `status='issued'`, devuelve CSV con los serials para mandarle al fabricante a imprimir
- Acción "Revocar lote": en caso de falsificación o defecto detectado, revoca todo un lote. Owners afectados reciben notification automática

`/gob/chapas` no existe en v1 — los govts no operan inventario.

## 7. Material y tecnología — placeholder explícito

D3 desacopla material de arquitectura. Para que CC pueda implementar todo el lado DIM sin esperar la decisión, el schema lleva los tres campos opcionales (`material`, `has_nfc`, `manufacturer`) y la app los renderiza si están presentes pero no los exige.

**Cuando llegue el momento de elegir**, las tres categorías a evaluar:

### Tier A — Aluminio grabado láser (lo que se hace hoy en AR)

- **Material**: `metal` (aluminio anodizado)
- **NFC**: `has_nfc=false`
- **Pro**: barato, cualquier laser engraver argentino lo hace mañana, estéticamente percibido como oficial/PPP
- **Contra**: se raya el grabado con el tiempo (PetHub reportó 4-12 meses), se oxida si la calidad del anodizado es baja, no soporta NFC

### Tier B — Silicona laser grabada

- **Material**: `silicone`
- **NFC**: `has_nfc=false` (versión básica) o `true` (versión con chip embebido)
- **Pro**: aguanta agua, no se raya, soporta NFC embebido sin sumar grosor visible, silente (no tintinea), comfortable para el pet
- **Contra**: producción local AR limitada — Mercado Libre tiene resellers pero no fabricantes claros. Hay que importar el silicone blank y laser-engrave localmente, o full-import desde Shenzhen

### Tier C — Tag inteligente full custom (silicona + NFC + grabado láser + QR estampado)

- **Material**: `silicone`
- **NFC**: `has_nfc=true`
- **Pro**: best UX para el finder (tap o scan), durabilidad máxima
- **Contra**: requiere import + MOQ alto (típicamente 500-1000 unidades mínimo desde Shenzhen). Costo unitario más bajo en escala pero capital inicial alto

### Criterios para elegir cuando llegue el momento

1. **Volumen comprometido** — si tenemos refugio/vet partner que compra 500+, Tier C es viable. Si arrancamos con 50 chapas piloto, Tier A.
2. **Timeline al primer scan real** — Tier A se produce mañana, Tier C tarda 4-6 semanas.
3. **Posicionamiento de marca** — DIM como "oficial estado" sugiere metal/aluminio (visualmente afín a DNI físico). DIM como "smart pet tech" sugiere silicona moderna.
4. **Sostenibilidad económica** — el margen por chapa financia el hosting. Tier C tiene mejor margen en escala pero peor unit economics chico.

## 8. Fabricantes — placeholder con opciones AR investigadas

Listados como referencia para cuando llegue el momento. **NO comprometerse** con ninguno hasta que haya volumen / partnership / decisión de Nacho.

### Argentina — opciones Tier A (aluminio grabado)

| Proveedor | Sitio | Pros | Notas |
|---|---|---|---|
| **Luna Accesorios** | lunaccesorios.com.ar | Fábrica mayorista de accesorios pet en AR. Aluminio + grabado láser/CNC. Pricing especial para volumen | El más establecido del search |
| **K9 Dog Trainers** | k9dogtrainerstienda.com.ar | Marca AR, grabado láser de precisión | Más retail que mayorista |
| **Laser Eleven** | lasereleven.com.ar | Tags 2.5 y 3 cm de diámetro, alta durabilidad | Tamaño chico — bueno para gatos |
| **Grabados Piroso** | grabadospiroso.com.ar | Maquinaria láser + CNC, custom cutting | Versátil, formas no-redondas posibles |

Cualquiera puede producir Tier A si DIM le manda el SVG del QR + serial. El fabricante NO necesita saber nada del backend de DIM — solo imprime lo que recibe en archivo.

### Argentina — opciones Tier B (silicona con láser)

Mercado AR poco desarrollado para fabricación local de silicone tags. Aproximaciones:

1. **Combo híbrido**: silicone blank importado (Alibaba / Aliexpress) + laser-engraving local con Luna Accesorios o Grabados Piroso. Logística más compleja.
2. **Mercado Libre resellers**: hay vendedores que ofrecen tags silicone custom; investigar quién es el fabricante real detrás (probablemente import directo).

### Internacional — opciones Tier C (full custom)

| Proveedor | URL | Notas |
|---|---|---|
| **Chuangxinjia / nfctagfactory.com** | nfctagfactory.com | Shenzhen, MOQ típicamente 500-1000. Hace QR + NFC + silicone + custom logo |
| **Alibaba aggregators** | alibaba.com | Múltiples sellers, due diligence requerida |
| **RFIDsilicone.com** | rfidsilicone.com | Especializado en pet tags silicone+NFC |

Considerar: import a AR tiene impuestos altos (IVA 21% + impuestos a la importación), pero en escala el unit cost compensa. Modelo Brasil/Chile: ellos importan a regional hub y redistribuyen.

### Criterio de elección de proveedor (cuando se decida)

- Volumen mínimo viable que ese proveedor acepta vs. nuestra demanda
- Lead time (Argentina local: 1-2 semanas; import Shenzhen: 4-8 semanas)
- Calidad de grabado del QR (debe leerse aún tras desgaste; pedir samples antes de comprometer)
- Capacidad de print-on-demand con serial único por unidad (varía por proveedor)
- Disposición a firmar acuerdo de no-resale (anti-counterfeit): el proveedor solo le vende a DIM, no a terceros que armen su propia base

## 9. Cadena de distribución — placeholder Estonia-style

**Filosofía**: en v1, DIM **no hace fulfillment directo**. La chapa llega al owner por canales que existen fuera de DIM. La app soporta activación de cualquier chapa pre-emitida sin importar cómo el owner la consiguió.

Canales posibles, ordenados por probabilidad de aparición:

1. **Refugios partners** — DIM da chapas en lote al refugio (subsidiadas o gratis), refugio las entrega con la adopción. Owner las activa al llegar a casa.
2. **Veterinarios partners** — vet vende la chapa junto con el chip implant o el checkup anual. Modelo Barcelona COVB.
3. **Govt subsidiado** (futuro) — Mascotas CABA / Mi Argentina distribuye gratis junto con el chip mandatorio.
4. **E-commerce DIM** (futuro v2) — usuario pide al sitio, llega a casa. Requiere fulfillment + payment infra.
5. **Mercado Libre / pet shops** (futuro v2) — SKU oficial DIM en marketplaces.

Para v1, **basta con que existan chapas físicas DIM-compatibles** y que algún canal piloto distribuya. El piloto inicial probable: un lote inicial de 50-100 chapas Tier A distribuido a refugios del piloto. Esos refugios prueban activación con cada nueva adopción.

## 10. Ciclo de vida y edge cases

### Caso normal
1. Lote impreso → 100 chapas `status='issued'`.
2. Refugio recibe 50 chapas.
3. Refugio adopta perro a familia X, le da chapa M-3F9A.
4. Familia X activa → `status='activated'`, pet ligado.
5. Familia X usa la chapa por años. Funciona.

### Pet adoptado de nuevo (transfer ownership)
- La chapa se queda con el pet. Owner nuevo no necesita activar nada — la chapa ya está activa.
- Si owner nuevo quiere chapa suya, **revoca la vieja** (reason='transfer') y **activa una nueva**.

### Chapa perdida
- Owner reporta en `/cuenta/chapas`: revoca la perdida (reason='lost'), activa una nueva del lote que tenga.
- Finder que escanee la chapa perdida ve "Chapa revocada — info@..." con disclaimer. No llega al perfil del pet.

### Chapa robada con intención de fraude
- Owner revoca con reason='stolen'. Misma UX que perdida.
- Si la chapa robada se ve circular (lote falso, etc.), el admin revoca el lote completo (acción admin §6.5).

### Chapa dañada (QR ilegible)
- Owner revoca con reason='damaged', activa nueva.

### Pet con múltiples chapas (collar + arnés + transportadora)
- Owner activa cada una con diferente serial pero mismo pet. Vista en `/cuenta/chapas` muestra las 3 activas.
- Si una se pierde, revoca solo esa. Las otras dos siguen funcionando.

### Pet muere
- Cuando se emite `death_recorded` event, considerar emitir `tag_revoked` automático para todas las chapas activas del pet con reason='other' y `replacement=null`. **Decisión pendiente**: ¿auto-revoke o dejar al owner? Probablemente dejar — el owner puede querer conservar la chapa como memento.

### Lote falsificado detectado
- Admin revoca el lote completo. Todos los seriales del lote pasan a `status='revoked'`.
- Owners de chapas afectadas reciben notification + invitación a recibir chapa de reemplazo gratis.

### Chapa sin activar circulando
- `status='issued'`. Si alguien la encuentra antes de que se active, escanea y ve "Esta chapa todavía no fue activada. Si la encontraste suelta, por favor avisá a info@... — alguien la está esperando."
- Mensaje no expone ninguna info ni permite "claim" abierto. Activación requiere login del legítimo owner.

## 11. Privacy on scan

Sin cambios sobre lost-and-found spec v1.1. La chapa es solo delivery mechanism. El surface `/p/[publicToken]` ya respeta:
- `pets.disclosure_show_phone`
- `pets.disclosure_show_email`
- `pets.disclosure_show_vet_contact`
- `pets.disclosure_show_health_summary`

El owner controla qué muestra el credencial; la chapa hereda esas prefs sin lógica adicional.

## 12. RLS y security

`pet_tags`:
- **SELECT**:
  - Owner del pet ve sus chapas activadas (`pet_id IN (mis pets)`)
  - Cualquiera puede SELECT por `serial` (lookup público del estado para el redirect) — pero la lookup en `/t/[serial]` se hace server-side con service role, no via RLS
  - Admin ve todo
- **INSERT**:
  - Lote de issued: solo admin (via server action)
  - Activation: owner via server action (transacción que valida ownership)
- **UPDATE**:
  - Solo via server action (activate, revoke)
- **DELETE**: nunca

Server action `activateTagAction` valida que el `pet_id` que el owner pasa pertenezca al `session.user.id`. Anti-race con advisory lock sobre el serial.

## 13. Notificaciones

`notification_type` agrega (TEXT, sin migration):

- `tag_activated_confirmation` → al owner confirmando activación exitosa
- `tag_revoked_confirmation` → al owner confirmando revocación
- `tag_lote_revoked_global` → cuando se revoca un lote entero, notification a todos los owners afectados con CTA "Solicitá reemplazo"

## 14. Out-of-scope explícito

Lo que este spec **NO cubre** y queda para iteraciones futuras:

- **Fulfillment / e-commerce dentro de DIM**: pedido del owner → fábrica → envío a domicilio. v2 cuando haya volumen para justificar la infra.
- **Pricing al usuario final**: depende del canal y del fabricante. El spec no comercia.
- **Payment processing**: idem.
- **Print-on-demand QR personalizado con foto del pet**: la chapa lleva QR genérico al serial; "chapas con foto" son producto comercial que se monta encima si emerge demanda.
- **Anti-counterfeit con firma digital**: el publicToken + serial son unguessable, pero no hay firma criptográfica del fabricante por chapa. Cuando llegue Mi Argentina integration, se evalúa.
- **Geofencing / smart tracking activo (Tractive, AirTag)**: otra liga de producto, otro pricing. Out of scope DIM core.
- **Multi-pet share** (una chapa que rote entre pets, ej. en refugios con muchos animales): no, la chapa es 1:1 con pet activo. Refugio que recibe 50 perros activa 50 chapas.
- **Recovery flow del propio QR** si el grabado del QR se borra: el owner ve el serial impreso en texto en la chapa (separado del QR), puede tipearlo en `/cuenta/chapas` o tipear directo la URL `mimar.gob.ar/t/M-XXXX`. La chapa duplica info (QR + texto del serial visible) — anti-frustración.
- **Mobile app native** con NFC tap directo a perfil sin browser: out of scope core. La PWA actual con `navigator.nfc` (web NFC API) puede soportarlo cuando madure el standard.
- **Integration con SENASA pet passport físico**: cuando llegue.
- **Stickers descartables para gatos indoor** (versión más barata, no para uso outdoor): no en v1; la chapa es premium-positioned como documento.

## 15. Open questions

1. **Auto-revoke al `death_recorded`**: ¿se revocan automáticamente las chapas del pet cuando se registra defunción? Pros: limpieza de inventario, evita confusión si alguien escanea más tarde. Contras: owner puede querer conservar la chapa. **Mi propuesta**: NO auto-revocar. Mostrar en `/cuenta/chapas` filtro "chapas de pets fallecidos" con CTA opcional a revocar.

2. **Owner que quiere imprimir su propio QR DIY**: ¿bloqueamos o permitimos? Hoy nadie nos impide que un owner genere su propio QR apuntando a `mimar.gob.ar/p/DIM-XXXX-XXXX` e imprima un sticker casero. **Mi propuesta**: permitirlo explícitamente como "modo DIY" — el owner puede generar el QR de su pet desde `/cuenta/chapas → "Generar QR para imprimir tu propio sticker"`. Ese QR NO va por `/t/[serial]`, va directo a `/p/[publicToken]`. Permite cobertura zero-cost mientras llega el canal físico.

3. **Compatibility con sistemas existentes**: ¿soporta DIM que un owner registre una chapa NATid (de natcan.ar) o de cualquier otro provider AR? **Mi propuesta**: NO. Solo chapas con serial DIM canónico. Quien quiera usar DIM compra/recibe chapa DIM. Permitir alias a otros sistemas abre puerta a complejidad sin valor claro.

4. **Serial format extension**: ¿4 chars son suficientes? 923K combinaciones. Si DIM escala a 1M+ chapas (10% del parque AR), no alcanza. **Mi propuesta**: empezar con 4. Migrar a 5 cuando se llegue a 500K chapas emitidas (umbral arbitrario pero conservador). Migración no-breaking porque los seriales viejos siguen siendo válidos; solo los nuevos llevan 5 chars.

5. **`/t/[serial]` rate limiting**: el endpoint es público y se escanea por finders casuales. ¿Necesitamos rate limit? **Mi propuesta**: rate limit suave (100 req/min por IP) solo para prevenir scraping malintencionado del catálogo. Un finder real escanea 1-2 veces; un scraper hace miles. Cualquier IP que pegue al endpoint a esa velocidad va contra el límite y recibe 429.

6. **Visualización del serial en el credencial**: ¿el `/p/[publicToken]` muestra "Chapa activa: M-3F9A"? Decisión: **no**. El finder no necesita verlo (ya escaneó). El owner lo ve en `/cuenta/chapas`. Mostrar el serial públicamente solo expone metadata sin valor.

---

## 16. Próximo paso

Si este spec tiene OK final, escribimos el plan ejecutable en `plans/2026-05-18-physical-tag.md`. Cubre las fases:

| Fase | Resumen |
|---|---|
| **A** | Schema (`pet_tags` table + Drizzle model + migración 0020) |
| **B** | Event catalog: `tag_activated`, `tag_revoked` con Zod schemas (subido al catálogo, CI test) |
| **C** | Server actions: `issueTagsLoteAction` (admin), `activateTagAction`, `revokeTagAction`, `revokeLoteAction` |
| **D** | Surface `/t/[serial]` con server-side redirect según status |
| **E** | Surface owner `/cuenta/chapas` con tabla + activar nueva + revocar + DIY QR generator |
| **F** | Surface admin `/admin/chapas` con búsqueda + lote management + revocación masiva |
| **G** | Tests + smoke manual del flow completo emisión → activación → revocación → re-activación |

Cinco fases A-E son 1 PR cada una. F+G son 1 PR. Total ~3 días de CC.

**Decisiones pendientes antes del plan** (sin estas el plan se queda incompleto):

- Open question #1 (auto-revoke en death): decidir
- Open question #2 (DIY QR): decidir
- Open question #3 (interop con NATid/otros): decidir
- Open question #4 (4 vs 5 chars en serial): decidir (probablemente 4)
- Open question #5 (rate limit): decidir (probablemente suave)
- Open question #6 (mostrar serial en credencial): decidir (probablemente no)

Si querés ajustar algo del modelo (URL pattern, multi-tag, etc.) — decímelo antes del plan. Después del plan, cambiar la base cuesta más.
