# Deprecación de `/pro` — vets profesionales operan vía organization tipo `clinic`

> Plan ejecutable para eliminar el portal `/pro` y migrar el modelo "vet independiente que ofrece servicios" hacia el modelo de organización tipo `clinic` existente. Vet solo = clinic de 1 miembro (el propio vet como `admin`). El portal `/org/[orgToken]` ya cubre 100% de lo que `/pro` ofrecía: services + scheduling + libreta-sanitaria con `author_role='vet'`. El refactor ahorra duplicación de código y unifica la doctrina "el actor profesional opera dentro de una org".
>
> **Fecha:** 2026-05-20
> **Owner:** Ignacio Del Valle
> **Tamaño:** ~3 PRs, ~12 archivos eliminados, ~18 archivos tocados, 1 migración data-only (backfill), 0 schema changes
> **Estimación:** ~3 días de Claude Code

---

## 0. Decisión y rationale

El portal `/pro` se construyó como atajo: un vet con `professional.provider` capability quería ofrecer turnos sin tener que crear una organización. La realidad operativa post-implementación muestra que `/pro` y `/org/[orgToken]` de tipo `clinic` hacen lo mismo en distinta envoltura:

| Capability | `/pro` | `/org/[orgToken]` clinic |
|---|---|---|
| Crear services | ✅ `VetServiceOfferingForm` | ✅ `OfferingForm` |
| Definir schedule rules | ✅ `VetAgendaRuleForm` | ✅ idem |
| Materialize slots | ✅ via cron | ✅ idem |
| Recibir reservas owner | ✅ via `/turnos/buscar` | ✅ idem |
| Atender turno y emitir eventos clínicos | ✅ con `author_role='vet'`, `author_organization_id=null` | ✅ con `author_role='vet'`, `author_organization_id=org.id` |
| Membership management | N/A (solo el vet) | ✅ (sobra para clinic de 1 pero no estorba) |
| Coverage zones | N/A | ✅ (útil) |
| Intake / foster / adopción | N/A | ✅ (no obligatorio pero accesible si más adelante el vet quiere recibir strays) |
| Branding público en credencial | N/A | ✅ via `tier_0_show_branding` |

El único delta semántico: `author_organization_id` queda en `null` para emisiones `/pro` y poblada para emisiones de clinic. Operativamente, los dueños no distinguen — ven al Dr/a en la libreta igual. **Y la org tipo clinic puede tener un solo miembro (el vet, role=admin) sin problema** — no hay constraint en `organizations` ni en `organization_memberships` que exija múltiples miembros.

Mantener dos paths multiplica:
- 1 auth guard exclusivo (`requireVetProviderOrRedirect`)
- 1 page tree en `app/pro/*` (11 archivos)
- 1 enum semántico (`professional.provider` capability) duplicando lo que `vet_individual` membership ya cubre
- 1 fork en revalidations (`/pro/agenda` vs `/org/[orgToken]/agenda`)
- 1 ramificación en `lib/event-authorship.ts` para resolver authorship

Deprecar `/pro` y unificar todo bajo `clinic` org reduce superficie de testing, copy a mantener, y casos edge a documentar.

## 1. Decisiones cerradas

| # | Decisión | Razón |
|---|---|---|
| D1 | **`/pro` y subrutas se eliminan completamente del repo** | No es una redirect — es una eliminación. Los vets activos hoy se migran a una org clinic vía backfill. Después de ese backfill, `/pro` ya no debe responder. |
| D2 | **Vets existentes con `matriculaVerified=true` y al menos 1 service offering activo en `/pro` reciben una org clinic auto-creada** | La org se llama `Consultorio {displayName}`, queda `org_type='clinic'`, `status='verified'` (heredamos verification del vet), el vet queda como `admin` de esa org con `can_write_pet_events=true`. Sus offerings se re-anclan a `org_id` de la nueva org. |
| D3 | **Vets sin offerings (matrícula verificada pero no ofrecieron servicios)** se quedan como `role='vet'` sin clinic asociada. Su flujo de signup ahora muestra una step extra "¿Querés ofrecer servicios?" que ofrece crear la clinic. | No vamos a auto-crear orgs vacías que después generan ruido en `/admin/cola`. |
| D4 | **El default landing redirect de `vet` con matrícula verificada deja de ser `/pro`**. Pasa a `/cuenta/memberships` si tiene 1+ memberships, o a `/cuenta` si no tiene ninguna (con CTA "Creá tu consultorio para ofrecer servicios"). | Sin `/pro`, el "home" del vet es donde estén sus operaciones. |
| D5 | **La capability `professional.provider` queda retirada definitivamente** | Nunca llegó a aterrizar como columna real. Solo vivía como swap-point comments en código. La verificación de matrícula (`profiles.matriculaVerified`) se mantiene — sigue siendo info útil sobre el vet aunque no esté asociada a una clinic todavía. |
| D6 | **Authorship resolution se simplifica**. Cuando un vet emite un evento, **siempre** está dentro de un org context (clinic donde es member). `author_role='vet'`, `author_organization_id=org.id`. La rama "vet sin org" desaparece. | Cero excepciones. La libreta ya muestra correctamente "Dr/a X · Clínica Y" — no se pierde nada. |
| D7 | **`/turnos/buscar` sigue funcionando exactamente igual** — los offerings de clinic-de-1-vet salen indistinguibles de offerings de clinic grande. | Los owners no necesitan saber si su vet es solo o tiene staff. |
| D8 | **Backfill data migration se ejecuta en una sola transacción** + verifica idempotencia. Si se ejecuta dos veces, no duplica orgs. | Safety. La query de detección usa `displayName + matriculaNumber` como clave compuesta. |
| D9 | **Período de gracia de 0 días** — al deploy del PR final, `/pro` 404s. Backfill corre en el deploy. Los vets recibirán email "Tu portal cambió de lugar. Ahora trabajás desde {nueva-org-token}" en el mismo deploy. | El producto está pre-release; no hay riesgo de tráfico orgánico a `/pro`. Si emerge demanda de período transition, agregamos un middleware redirect en un follow-up. |

---

## 2. Por fases

### Fase A — Backfill data migration (vets activos → orgs clinic) — ~0.5d

**Objetivo:** crear orgs clinic para todo vet con offerings activos, re-anclar offerings, sin tocar UI.

**Archivos nuevos:**

- `scripts/migrate-vets-to-clinics.ts` — script idempotente que:
  1. Query: `SELECT * FROM profiles WHERE role='vet' AND matriculaVerified=true`.
  2. Para cada vet, query: `SELECT * FROM serviceOfferings WHERE providerUserId = vet.id AND providerOrganizationId IS NULL`.
  3. Si tiene 1+ offerings:
     - Verificar idempotencia: ¿existe ya una org con `displayName = 'Consultorio ${vet.displayName}'` y `created_by_user_id = vet.id`? Si sí, saltar (ya migrado).
     - Sino: insertar `organizations` row con `displayName`, `org_type='clinic'`, `status='verified'`, `verified=true`, `verified_at=now()`, `created_by_user_id=vet.id`, `jurisdiction_*` heredado de `vet.jurisdiction_*`, `public_token` generado.
     - Insertar `organization_memberships` row: `user_id=vet.id`, `org_id=new.id`, `role='admin'`, `can_write_pet_events=true`, `accepted_at=now()`.
     - Si vet declaró matrícula tipo `vet_individual`, también agregar el flag pero el role principal es `admin`.
     - UPDATE de cada offering del vet: `providerOrganizationId = new.id`, `providerUserId = vet.id` (preserva attribution).
  4. Si tiene 0 offerings: no crear org. Logear el vet como "candidato sin servicios".
  5. Log final: count creadas, count saltadas (ya migradas), count skipped (sin offerings).

**Archivos modificados:**

- `db/schema.ts` — verificar que `serviceOfferings.providerOrganizationId` exista y soporte FK (debe ya existir; si no, agregar como migración 0040).

**Tests:**

- `__tests__/migrate-vets-to-clinics.test.ts`:
  - Run inicial: vet con 2 offerings → 1 org creada, 2 offerings re-anchored.
  - Run duplicado (idempotencia): nada cambia.
  - Vet sin offerings: nada creado.
  - Vet con offerings parciales ya re-anchored a otra org: salta para evitar conflictos (loguea warning).

**Shippeable**: la migración no rompe `/pro` ni `/org`. Los offerings ahora viven en orgs (lo que ya soporta el sistema) pero `/pro` sigue leyéndolos via `providerUserId`. Ningún cambio visible para usuarios todavía.

---

### Fase B — Eliminar `/pro` del codebase + redirigir referencias — ~1.5d

**Archivos eliminados (11):**

- `app/pro/page.tsx`
- `app/pro/agenda/page.tsx`
- `app/pro/agenda/turnos/[appointmentToken]/page.tsx`
- `app/pro/agenda/turnos/[appointmentToken]/AttendanceFormDispatcher.tsx`
- `app/pro/servicios/page.tsx`
- `app/pro/servicios/nuevo/page.tsx`
- `app/pro/servicios/nuevo/VetServiceOfferingForm.tsx`
- `app/pro/servicios/[offeringToken]/page.tsx`
- `app/pro/servicios/[offeringToken]/agenda/page.tsx`
- `app/pro/servicios/[offeringToken]/agenda/VetAgendaRuleForm.tsx`
- `app/pro/servicios/[offeringToken]/agenda/MaterializeNowButton.tsx`

Y todo `app/pro/` queda vacío (lo borra el script de delete).

**Archivos modificados:**

- `lib/auth-guards.ts`:
  - Eliminar `requireVetProviderOrRedirect` y `VetProviderSession` type.
  - El comment "SWAP POINT" se va con el código.

- `lib/role-landing.ts`:
  - `pathForRole('vet')` deja de devolver `/pro`. Nueva lógica:
    1. Si vet tiene `organization_memberships` activas como `admin` o `coordinator` → redirigir a `/org/[firstOrgToken]`.
    2. Si vet tiene memberships activas pero solo `vet_individual` → `/cuenta/memberships` (vista de sus orgs).
    3. Si vet no tiene memberships → `/cuenta` con banner CTA "Crea tu consultorio".

- `app/(app)/mis-mascotas/page.tsx`:
  - Reemplazar `if (profile.role === "vet") redirect("/pro")` por `redirect(pathForRole('vet', profile))`.

- `app/actions/attendance.ts`:
  - Las 3 `revalidatePath("/pro/agenda")` → `revalidatePath` del `/org/[orgToken]/agenda` correspondiente (resolver via offering → providerOrganizationId).

- `app/actions/booking.ts:305`:
  - `ctaUrl: "/pro/agenda"` → `ctaUrl: /org/${orgToken}/agenda` (resolver org).

- `app/actions/events.ts:2399`:
  - `revalidatePath("/pro")` → no es necesario; el path se inválida por revalidate del org page.

- `app/actions/schedule-rules.ts`:
  - 3 `revalidatePath` → `/org/${orgToken}/servicios/${offeringToken}/agenda`.

- `app/actions/service-offerings.ts`:
  - `revalidatePath("/pro/servicios")` y `redirect("/pro/servicios")` → resolver org y usar `/org/${orgToken}/servicios`.
  - L173: la branch que decide entre `/org` y `/pro` colapsa a solo `/org`.

- `app/actions/slot-materialization.ts:190`:
  - `revalidatePath` → `/org/${orgToken}/servicios/${offeringToken}/agenda`.

- `app/org/[orgToken]/page.tsx:154`:
  - El link a `/pro` que sirve para "switch portal" se elimina. Los vets ahora navegan entre orgs via `/cuenta/memberships`.

- `middleware.ts`:
  - Agregar regla: cualquier request a `/pro/*` retorna `NextResponse.redirect("/cuenta/memberships", 308)` por 30 días (graceful — aunque D9 dice 0 días, los caches de browser y bookmarks justifican un redirect mientras).

**Server actions a actualizar (las viven en `app/actions/*.ts`):**

Aquellas que aceptaban `actorContext.kind = "vet_independent"` pasan a aceptar solo `actorContext.kind = "vet_in_org"`. El switch que diferenciaba se elimina.

- `lib/event-authorship.ts`:
  - Eliminar la rama `vet_independent` que setea `author_organization_id = null`. Ahora siempre `author_organization_id = orgContext.organizationId`.

**Tests modificados:**

- Eliminar `__tests__/vet-provider-auth-guard.test.ts` (si existe).
- Update tests que asumen `/pro` paths.
- Test nuevo: vet sin orgs entra a `/mis-mascotas` → no redirige a `/pro` (404) → redirige a `/cuenta` con banner.

**Shippeable**: post-PR, los vets sin org no pueden ofrecer servicios, los vets con org migrada van directo a `/org`. Si la migración Fase A se ejecutó correctamente, no hay pérdida de funcionalidad.

---

### Fase C — UX onboarding vets nuevos + cleanup conceptual — ~0.75d

**Objetivo:** que el vet nuevo entienda que su path para ofrecer servicios es crear una clinic.

**Archivos nuevos:**

- `app/(app)/cuenta/crear-consultorio/page.tsx` — wizard 3 pasos para que un vet cree su clinic:

  ```
  Step 1 — Datos del consultorio
    Nombre (default: "Consultorio {displayName}")
    Descripción
    Foto / logo
  Step 2 — Ubicación
    Domicilio (geocoded)
    ¿Atendés a domicilio?
    Radio de cobertura
  Step 3 — Primer servicio
    Crear opcionalmente 1 servicio inicial (vacunación / control)
    Skip permitido
  ```

  Submit: crea `organizations` (org_type=clinic, status=verified), `organization_memberships` (role=admin), opcionalmente 1 `serviceOfferings`.

- `app/(app)/cuenta/crear-consultorio/CrearConsultorioForm.tsx` (client).

**Archivos modificados:**

- `app/(app)/cuenta/page.tsx`:
  - Si role=vet con matriculaVerified=true y sin memberships con role admin → mostrar banner "¿Vas a ofrecer servicios? Creá tu consultorio →" linkeando a `/cuenta/crear-consultorio`.

- `app/(app)/signup/*` (flow signup):
  - Después de signup como vet con matrícula, sumar un step opcional "¿Querés ofrecer servicios?" → al confirmar, abre el wizard de Fase C.
  - Si skip, vet queda como `role='vet'` sin clinic, en su mascotas-only landing.

- `AGENTS.md` y `docs/superpowers/specs/2026-05-16-health-campaigns-and-scheduling-design.md`:
  - Update copia donde menciona `/pro` para refleje el nuevo modelo. (Esto en realidad se hace en el AGENTS.md cleanup separado.)

**Tests:**

- `__tests__/create-clinic-wizard.test.ts`: vet completa wizard → org creada, membership creada, vet redirected al `/org/[token]`.

---

## 3. Verificación end-to-end

Post-merge de las 3 fases, validar:

1. ✅ Vet existente con offerings: redirige automáticamente a su org clinic. Sus offerings siguen visibles y aceptan reservas.
2. ✅ Owner busca turno en `/turnos/buscar` y ve los offerings del vet (sin diferencia visible vs antes).
3. ✅ Owner reserva slot → notification al vet via su org → vet atiende desde `/org/[orgToken]/agenda/turnos/[appointmentToken]`.
4. ✅ Vet emite vacuna en la libreta del pet → event tiene `author_role='vet'`, `author_organization_id=org.id`.
5. ✅ Vet nuevo signup: ve banner "Creá tu consultorio" en `/cuenta`. Wizard funciona.
6. ✅ Visit a `/pro/*`: 308 redirect a `/cuenta/memberships`.
7. ✅ Backfill idempotente: re-run no duplica orgs.
8. ✅ Coverage tests verdes (no hay referencias colgadas a `/pro`).

---

## 4. Out of scope

- Cambio del modelo de `matriculaVerified` en sí — sigue siendo flag en `profiles`. Si se promueve a tabla aparte con expiración, plan separado.
- Mover credentials profesional/colegio a una entidad jerárquica (Colegio de Veterinarios). Por ahora un vet pertenece a una clinic y listo.
- Permitir que un vet pertenezca a múltiples clinics (ya soportado por `organization_memberships`, pero el wizard de Fase C solo crea una). Multi-clinic operativo viene cuando emerja demanda.

---

## 5. Riesgos

| Riesgo | Mitigación |
|---|---|
| Vet activo no recibe la org en el backfill (edge case data) | Script logea cada decisión; admin revisa logs post-deploy. Vet afectado lo crea manualmente via Fase C wizard. |
| Owners con bookmarks a `/pro/agenda` se quedan sin acceso | Middleware redirect 308 durante 30 días (D9 dice 0 días para deploy, pero el redirect en middleware compensa). |
| Authorship resolution rompe en libretas históricas | Eventos viejos con `author_organization_id=null` siguen valid — el reader solo agrega "(Clínica X)" cuando hay org id. Sin org id, muestra solo "Dr/a X" como ya hace. No backfill de eventos. |
| Vet existing con membership en otra org (no la auto-creada) | El backfill chequea idempotencia por `displayName + creator`. No toca orgs existentes. Si el vet ya tiene una clinic propia, no se duplica. |

---

## 6. Resumen ejecutivo

| Fase | Duración | PRs | Cambios |
|---|---|---|---|
| A — Backfill | 0.5d | 1 | 1 script nuevo + tests |
| B — Eliminar `/pro` | 1.5d | 1 | -11 archivos, ~16 archivos tocados, middleware redirect |
| C — Onboarding nuevo + cleanup | 0.75d | 1 | Wizard create-clinic + banner en /cuenta + signup step |
| **Total** | **~3d** | **3** | **~12 archivos eliminados, ~18 tocados, 1 script de migración** |

Net result: -1 portal, -1 capability, -1 auth guard, -1 ramificación de authorship, +1 wizard reutilizable, +N orgs clinic auto-creadas. El modelo conceptual de DIM queda: "los actores profesionales operan dentro de organizaciones". Cero excepciones.
