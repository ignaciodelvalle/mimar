# Guías de onboarding externas — inventario de honestidad

> **Actualización 2026-09-10** (HEAD `0b0d18767`). Las cinco guías se repasaron
> contra el código después de una tanda grande de trabajo en la app del celular
> y en el portal de gobierno. Lo nuevo está en la sección
> [Repaso 2026-09-10](#repaso-2026-09-10), al final. El cuerpo de abajo es el
> inventario original del 2026-08-12 y sigue siendo válido salvo donde el repaso
> lo corrige.

> Generado el 2026-08-12 contra el HEAD de `integration/all-20260703`. Las cinco guías de esta carpeta son guías de uso para cada tipo de usuario (funcionario, veterinario, refugio, dueño, vecino), escritas con la regla "si no puedo citar dónde vive, no va". Este README documenta los dos subproductos de ese proceso: **qué capacidades se sacaron de cada guía por no existir todavía** (leído al revés, es un backlog de producto visto desde el usuario) y **qué contradicciones aparecieron** entre las páginas públicas y el código.

## Qué se sacó de cada guía por no existir todavía

### Guía del funcionario (`guia-funcionario.md`)

- **Federación / ingreso con Mi Argentina.** Es la premisa arquitectónica del proyecto, pero hoy solo existe el scaffold OIDC apagado (`lib/infra/miarg-oidc.ts`, gated por env vars ausentes). Sacado de todo lo operativo; degradado a "no hace todavía". Un funcionario que espere credenciales federadas se va a decepcionar — es el hueco más sensible para quien usa el portal de gobierno.
- **Envío automático de notificaciones ENO a la autoridad.** El sistema encola y **mide** su propia bandeja de salida (métrica A7, `fetchEnoSla`), pero el disparo automático hacia el organismo externo es follow-up (AGENTS.md §SENASA, línea ~1093). La guía no promete que "la autoridad recibe" nada fuera del portal.
- **Derivación de denuncias a canales estatales externos.** El propio sitio lo aclara (`app/(public)/denuncias/page.tsx:109`). La guía presenta la bandeja interna como lo que es.
- **Export provincial del registro PPP.** Flag + declaración jurada existen; el archivo de intercambio con la provincia está pendiente (feature inventory, "Identity & legal", 🟡). Degradado a "no hace".
- **Reglas de cumplimiento legal jurisdiccionales (rules-engine v2).** Obligation types con nivel de exigencia, baseline legal versionado: spec + plan listos, sin ejecutar (🟢, SDD `jurisdiction-compliance`). La guía solo promete las reglas operativas que ya están en `/gob/reglas`.
- **Verificación de identidad contra RENAPER.** Proveedor sin decidir (⚪). La guía dice explícitamente que el DNI es declarado, no validado contra registros estatales.
- **Importación de padrones municipales preexistentes.** No existe ningún importador; la guía avisa que los datos del territorio arrancan de cero.
- **Capa de calor geográfica por defunción individual** en Mortalidad: diferida (el payload de `death_recorded` no lleva punto geográfico — AGENTS.md §dashboards). No se mencionó ningún "mapa de mortalidad" por caso.

### Guía del veterinario (`guia-veterinario.md`)

- **Acceso de lectura del profesional "por portal" (Tier 4).** Figura como futuro en la tabla de tiers (AGENTS.md §Privacy tiers). Se sacó cualquier versión de "escaneás y ves el historial" y se explicó el mecanismo real: el dueño comparte (enlace temporal revocable o nivel médico público opt-in).
- **Receta electrónica veterinaria (Res. SENASA 80/2025).** El `tipo_evento_code` existe; la carga con principio activo y posología es un sprint dedicado pendiente (AGENTS.md §Legal framework). Mencionado solo en "no hace".
- **Validación automática de matrícula contra el colegio profesional.** No existe: la aprobación es revisión humana de la autoridad local (`/gob/cola`, tipo `role_upgrade_vet`). La guía lo dice de frente.
- **Facturación, cobros, aranceles.** No hay nada de pagos en el sistema. Dicho explícitamente porque una clínica lo va a preguntar.

### Guía del refugio (`guia-refugio.md`)

- **Chequeo de postulantes contra el registro de infractores (Ley Huellas CABA 6839).** La base de conocimiento legal lo marca como integración futura (`lib/reference/legal-knowledge-base.ts`, entrada `ley-caba-6839`). La guía aclara que la evaluación del adoptante es del refugio.
- **Donaciones / pagos.** No existe.
- **Push al celular por defecto.** Web push v1 existe pero con flag `NEXT_PUBLIC_PUSH_ENABLED` default OFF y solo para severidad urgente (feature inventory, "Infra"). La guía promete la campanita in-app, no push.

### Guía del dueño (`guia-dueno.md`)

- **Aviso automático de vacuna por vencer.** Es ⚪ en el inventario ("Vaccination-due warning al owner"). Lo que existe es el recordatorio programado a mano (`/mis-mascotas/[token]/vacunas/programar`); la guía distingue exactamente eso.
- **Estado sanitario / nudges por mascota.** El motor se eliminó como dead code el 2026-07-21 y no hay superficie owner-facing hoy (feature inventory, fila "Estado sanitario"). No se mencionó ningún "semáforo de salud".
- **Semáforo de requisitos de viaje (movilidad jurisdiccional).** Honest facade: la ruta `/viaje` muestra "Próximamente" y el ítem de menú está deshabilitado (feature inventory 🟡). Solo se mencionó en "no hace"; la mudanza (`/mudanza`) sí existe y no se confundió con esto.
- **Equivalencia legal de la libreta digital.** Depende de homologación por jurisdicción (página `/funcionalidades`, tier "Cuando tu localidad se suma"). La guía recomienda conservar el papel.
- **Chapa grabada oficial.** El canal `engraved_plate` arranca OFF por defecto y se habilita por regla jurisdiccional (`lib/infra/physical-credential-channels.ts:17`); solo la chapita QR autoimpresa (`printable_qr`, ON por defecto) se presenta como universal.
- **Mi Argentina** como método de ingreso: placeholder. Ingreso real: correo + contraseña.

### Guía del vecino (`guia-vecino.md`)

- **Mapa general de mascotas perdidas.** `/perdidas` es un listado con filtros, sin mapa (ver Contradicciones, abajo). La guía dice "listado".
- **"Mordedura" como tipo de denuncia.** El formulario público tiene 9 tipos y ninguno es mordedura (`src/modules/welfare/domain/types.ts:12`); el circuito de mordedura es otro (evento clínico / módulo de organización). La guía enumera los 9 tipos reales.
- **Novedades al denunciante anónimo.** Imposible por diseño (no hay canal de vuelta); la guía convierte esto en instrucción: guardá el código `DEN`.
- **Derivación automática a organismos externos.** En desarrollo (aviso de `/denuncias`); la guía suma la advertencia de emergencias (911) para no posicionar a miMAR como canal de urgencias.

### Hallazgo lateral: dos filas del Feature inventory quedaron desactualizadas

No es parte del alcance de las guías, pero salió de la verificación adversarial y conviene registrarlo: dos limitaciones que el Feature inventory de `AGENTS.md` todavía documenta **ya no existen** — el emisor SÍ puede cancelar una transferencia org→org pendiente (`app/org/[orgToken]/transferencias/CancelTransferAction.tsx`, cableado en `page.tsx:156`) y SÍ existe el formulario para revertir una adopción (`app/org/[orgToken]/mascotas/[publicToken]/ReverseAdoptionAction.tsx`, cableado en `page.tsx:118`), aparentemente desde el facades-harvest del 2026-07-21. Las filas de AGENTS.md:1146-1147 quedaron stale; las guías siguen a las rutas (jerarquía de verdad #1) y presentan ambas capacidades como existentes. Pendiente: actualizar esas dos filas del inventario.

## Contradicciones encontradas (páginas públicas vs. código)

> **ESTADO 2026-08-12: las CINCO están corregidas en el commit `6265bc37`.** Se
> dejan documentadas porque el hallazgo sigue siendo útil —muestran cómo se
> despega una página pública del código— pero **no salgas a buscarlas: ya no
> existen**. En todos los casos se corrigió la página, no se construyó lo
> prometido.
>
> La #3 era la única con consecuencia física y por eso se atacó primero: alguien
> que ve un animal en peligro podía no llamar al 911 creyendo que ya había
> avisado a la autoridad. Además de corregir el texto, ahora `/ayuda` recomienda
> el 911 explícitamente.

1. **`/ayuda` promete un "mapa" de mascotas perdidas.** El texto dice "Consultá el mapa de mascotas perdidas" y enlaza `/perdidas` (`app/(public)/ayuda/page.tsx:88-95`), pero `/perdidas` es un listado en tarjetas con filtros por provincia — no renderiza ningún mapa (`app/(public)/perdidas/page.tsx`; el único "mapa" ahí es el texto de una tarjeta que refiere al punto marcado dentro de la credencial individual, línea 450).
2. **`/ayuda` lista "mordedura" como tipo de denuncia.** "Podés indicar el tipo de situación (maltrato, abandono, mordedura, entre otros)" (`app/(public)/ayuda/page.tsx:113-115`), pero los tipos reales del formulario son 9 y no incluyen mordedura (`src/modules/welfare/domain/types.ts:12-22`, renderizados 1:1 en `app/(public)/denuncias/nueva/_components/Step1Kind.tsx:63`). La mordedura viaja por el circuito clínico/organizacional (`/org/[orgToken]/mordedura/nuevo`, evento `bite_reported`), no por denuncias.
3. **`/ayuda` y `/denuncias` cuentan historias distintas sobre la derivación.** `/ayuda` afirma sin matiz que "Las denuncias son recibidas por las autoridades sanitarias pertinentes" (`app/(public)/ayuda/page.tsx:115`); `/denuncias` — la página del propio flujo — aclara "La integración con canales gubernamentales está en desarrollo — tu reporte queda guardado y será enviado cuando esté disponible" (`app/(public)/denuncias/page.tsx:107-111`). El código respalda a `/denuncias`: la gestión es interna (cola `/gob` por jurisdicción, fallback admin), sin integración externa.
4. **`/acerca` sugiere que escanear el QR muestra el historial.** "El objetivo es que cualquier veterinario, refugio o autoridad pueda ver el historial de un animal escaneando su QR" (`app/(public)/acerca/page.tsx:66-68`). Está redactado como objetivo, no como hecho — pero es exactamente la expectativa que el modelo de tiers desmiente hoy (escanear = Nivel 0, identidad sin historial; el historial requiere que el dueño comparta: `app/(public)/p/[publicToken]/page.tsx:681`, AGENTS.md §Privacy tiers). Riesgo de lectura más que falsedad literal; las guías explican el mecanismo real.
5. **Menor / cosmético: `/ayuda` muestra la URL vieja de login.** El enlace apunta correctamente a `/iniciar-sesion` pero el texto visible dice "/login" (`app/(public)/ayuda/page.tsx:28-33`), la ruta inglesa que hoy es solo un redirect permanente (`app/(auth)/login/page.tsx`). Además, el paso "Creá tu cuenta" enlaza a la pantalla de ingreso en lugar de `/registro`.

---

*Método: cada guía se escribió recorriendo primero las rutas reales de su audiencia (`app/`), chequeando cada capacidad contra el Feature inventory de `AGENTS.md`, y pasando el texto final por una relectura de promesas ("¿puedo citar la ruta o la línea?"). La jerarquía de verdad usada: rutas reales > Feature inventory > User roles > Legal framework > Privacidad > páginas públicas.*

## Verificación independiente (2026-08-12)

Muestreo de afirmaciones contra el código, hecho por quien NO escribió las guías.
Todas las chequeadas se sostienen:

| Afirmación | Dónde vive | ✓ |
|---|---|---|
| El consultorio de un vet con matrícula verificada queda habilitado sin segunda revisión | `create-organization.ts:135` (`isSoloVetClinic`) | ✓ |
| Una cuenta personal administra una sola organización | `create-organization.ts:137-139` | ✓ |
| Hasta 5 adjuntos de 25 MB en una denuncia | `welfare-uploads.ts:22-23` | ✓ |
| Los 9 tipos de denuncia enumerados (sin "mordedura") | `welfare/domain/types.ts:12` | ✓ |
| Nivel médico público por 24 h / 7 d / 30 d / permanente | `enable-tier2-public.ts:12-16` | ✓ |
| Importación masiva por CSV para refugios | `app/org/[orgToken]/intake/importar` | ✓ |
| La razón social es obligatoria al crear organización | `organizations.legal_name` NOT NULL | ✓ |

**Lo que esta verificación NO cubre:** es un muestreo, no una auditoría línea por
línea de las cinco guías. Antes de mandarle cualquiera de éstas a una persona de
afuera —sobre todo la del funcionario, que es la de outreach institucional—
conviene una lectura completa por alguien que conozca el estado del producto.

---

## Repaso 2026-09-10

Contra `0b0d18767`. Motivo: entre el 2026-08-12 y hoy entró una tanda grande de
trabajo en la app del celular (selector de fotos, asiento de tatuaje, pantalla de
acompañamiento de adopción, código de expediente) y en el portal de gobierno (rol
nacional de sólo lectura, Cola ENO, "Acciones que vencen"). Las guías describían
un producto anterior a todo eso.

### Capacidades nuevas que SÍ entraron a las guías (rastreadas)

| Capacidad | Dónde vive | Guía |
|---|---|---|
| Foto de la mascota desde el celular, **después** del alta (Más → Foto de la mascota) | `apps/mobile/src/pets/PetPhotoScreen.tsx`; adaptador instalado en `apps/mobile/app/_layout.tsx` | dueño |
| Asiento de **tatuaje** en el teléfono, con foto obligatoria | `RECORD_KINDS` en `apps/mobile/src/pets/record-event-view-model.ts`; formulario en `RecordEventScreen.tsx` | dueño |
| **Acompañamiento de adopción** desde el teléfono (sólo el titular) | `apps/mobile/src/pets/RehomeScreen.tsx`, fila en `OwnerFace.tsx` | dueño, refugio |
| **Solicitud de nuevo hogar** como caso que le llega a la organización | `src/modules/cases/domain/case-kinds.ts` (`rehome_request`), cola en `app/gob`/`app/org/[orgToken]/casos` | refugio |
| **Código de expediente `CAS-XXXX-XXXX`** visible en la ficha, sección "Trámites" | `apps/mobile/src/pets/OwnerFace.tsx` (`Section title="Trámites"`), `owner-face-view-model.ts` (`caseLine`) | dueño, funcionario |
| La mordedura se asienta **donde ocurrió**, no donde vive el animal | selector de localidad propio en `RecordEventScreen.tsx` | dueño, funcionario |
| **Corregir un asiento** desde el teléfono (corrección encima, nunca edición) | `apps/mobile/src/pets/EventDetailScreen.tsx` | dueño |
| Rol institucional **`national`**, sólo lectura, alcance país | `db/migrations/0214_user_role_national.sql`; `requireGobReadAccessOrRedirect` en `lib/infra/auth-guards.ts`; `hasNationalReadScope` en `lib/domain/jurisdiction-canonical.ts` | funcionario |
| **Cola ENO**, ordenada por vencimiento y filtrable por provincia y SLA | `app/gob/outbox/page.tsx` (`preset=eno`), `lib/ui/outbox-filter-axes.ts`, `lib/infra/outbox-query.ts` | funcionario |
| **"Acciones que vencen"**, la lista única de plazos | `app/gob/acciones/page.tsx` | funcionario |
| **"Observaciones"** ya tiene entrada de menú | `components/layout/nav-presets.ts` | funcionario |

### Afirmaciones que se SACARON o se degradaron en este repaso

Esta es la parte que conviene leer aunque no leas las guías.

1. **"La app puede asentar los 19 asientos del dueño."** No se escribió, y la
   distinción importa. La API v1 y el contrato admiten los 19, y la fence de
   paridad (`scripts/check-owner-surface-parity.ts`) da verde porque **mide
   alcance de API, no alcance de dedo**. Desde la pantalla se llegan a **16**:
   los 12 fijos del selector, los 3 condicionales (preñez inicio/fin y check-in
   post-adopción) y `medication_end` desde el asiento que abre el tratamiento.
   **Tres tienen formulario completo y ninguna pantalla los enlaza**:
   `death` (fallecimiento), `microchip_replace` (reemplazo de microchip) y
   `dangerous_breed_attestation` (declaración jurada de raza). Los docblocks de
   `record-event-view-model.ts` dicen desde dónde se los alcanza — "desde la
   ficha", "desde la tarjeta de cumplimiento" — y esas llamadas no existen en el
   árbol: `recordEventRoute` tiene exactamente tres sitios de llamada
   (`OwnerFace.tsx`, `LibretaScreen.tsx`, y `EventDetailScreen.tsx` con
   `medication_end`). La guía del dueño los lista como "hoy se cargan desde la
   web". **Es el hallazgo más accionable de este repaso.**
2. **"No manda notificaciones push al celular *por defecto*."** Se sacó "por
   defecto" de la guía del dueño y de la del refugio: sugería un interruptor que
   se puede prender. En la app no hay push de ningún tipo — `expo-notifications`
   ni siquiera está instalado, y la propia pantalla de la bandeja documenta que
   "que un push abra la bandeja" es trabajo futuro. Lo que hay es la bandeja
   in-app. (En la **web** sí existe web push con flag apagado; son dos cosas
   distintas y la guía ya no las mezcla.)
3. **"La web hace todo lo mismo que la app — no es una versión reducida."**
   Invertido: hoy la asimetría corre para el otro lado y hay que decir cuál.
   La guía enumera lo que sólo hace la web (cartel, chapa física, los tres
   asientos de arriba, buscar hogar si sos tránsito, listas largas).
4. **"La cuenta nacional la crea el equipo administrador."** Sacado. **No hay
   ninguna pantalla de alta para el rol `national`**: `app/admin/cuentas` sólo
   tiene los registros de gobierno y administradores. Hoy la única vía de
   provisión es `scripts/seed-test-users.ts`, es decir el equipo técnico a mano.
   La guía lo dice así, porque prometerle a un organismo nacional un alta que no
   existe es exactamente el riesgo #1 de este trabajo.
5. **"Corregir un evento es sólo por web."** Era la creencia de partida y es
   falsa: la app tiene **"Corregir registro"** y escribe una corrección encima
   del asiento, sin pisar nada. Manda a la web sólo cuando el asiento tiene
   campos que la app todavía no sabe dibujar, y lo dice con su propia frase.
6. **"No hay paginado en las listas de la app."** Cierto salvo una excepción que
   hay que nombrar: el **catálogo de adopciones sí pagina**, con "Mostrar más".
   El resto muestra una tanda y avisa cuántas faltan.
7. **La Cola ENO no se presenta como un canal de envío.** El drenador
   (`lib/infra/outbox-drainer.ts`) es un no-op declarado que escribe una fila de
   auditoría con `would_send: true`, y la propia tabla rotula
   *"Registrada y auditada — transmisión a la autoridad pendiente de endpoint
   receptor"*. La guía del funcionario lleva una advertencia explícita para que
   nadie lea "entregado" como "la autoridad lo recibió".
8. **El alcance del rol nacional no se presentó como "ve todo".** Lo rebotan las
   pantallas que siguen bajo el guard de escritura: Reglas, ficha de una mascota,
   detalle de una solicitud de la cola, detalle de un servicio, Observaciones,
   alta de investigación, y las descargas CSV. Y no tiene el buscador general,
   que está excluido a propósito en `app/gob/layout.tsx` porque busca personas y
   mascotas por dato individual.

### Huecos de producto que salieron del repaso y no están en ninguna guía

- **Tres asientos sin puerta** en la app (punto 1 de arriba).
- **La app no abre la cámara en ningún flujo.** La foto de la mascota y la del
  tatuaje salen de la galería; el lector de código de barras del microchip tiene
  su costura (`apps/mobile/src/native/chip-scanner-port.ts`) y nadie la enchufó,
  así que los 15 dígitos se escriben a mano.
- **No hay pantalla de expediente en la app.** El código `CAS-XXXX-XXXX` es una
  línea de texto que se copia manteniendo el dedo apretado; la fila no navega a
  ningún lado a propósito, para no simular un enlace que no existe.
- **`cuidado/[grantToken]`** (la vista del cuidador temporal sobre su propio
  permiso) no está enlazada desde ninguna pantalla: se llega sólo por el link de
  la invitación.
- **El rol `national` no tiene vía de alta en producto** (punto 4).

### Marcado, no resuelto

- **El camino real de la foto nunca corrió en un teléfono.** El commit que
  enchufa el selector (`f756b20c9`) lo dice de frente: se verificó el contrato,
  el mapeo y la suite, y queda sin verificar en hardware que el selector abra,
  que el EXIF/GPS se vaya de verdad, y que el tope de tamaño alcance en un sensor
  de 48-50 MP. **Eso toca dos cosas que las guías ahora prometen** — la foto de
  la mascota y el asiento de tatuaje, que sin foto no se puede guardar. No se
  degradó el texto porque el código está completo y enchufado, pero si la primera
  build en un teléfono falla ahí, estos dos párrafos son los que hay que corregir
  primero.
- **`dim-interno:docs/agents/prompt-cowork-onboarding-externos.md` escribe "MiMAR"** con M
  mayúscula en cuatro lugares (líneas 10, 25, 89 y 102 — la 102 es justamente la
  regla que dice cómo se escribe la marca). La marca es **miMAR**. Hay una fence
  (`scripts/check-brand-casing.ts`) pero su alcance es `.ts`/`.tsx` de
  `app,components,lib,packages,src,apps/mobile/{app,src}`: **la prosa en Markdown
  no la mira nadie**, así que este error no lo va a levantar `pnpm verify`. Las
  cinco guías y este README están bien; el prompt permanente no, y como es el
  documento que genera este material conviene corregirlo en su propia tanda.
