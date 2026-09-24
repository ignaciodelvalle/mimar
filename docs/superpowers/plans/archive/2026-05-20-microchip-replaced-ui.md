# Microchip replaced — UI owner + remediation case activation

> Plan ejecutable para completar `microchip_replaced`: hoy schema-ready (Zod + libreta groupBy + case-attachment branching) pero sin UI owner-facing y con el case kind `microchip_remediation` deferido. Este plan agrega el form en `/mis-mascotas/[publicToken]/eventos/nuevo/microchip-reemplazo`, server action, lifecycle declaration del case kind, y wire-up de notifications + audit.
>
> **Fecha:** 2026-05-20
> **Owner:** Ignacio Del Valle
> **Tamaño:** ~3 PRs, ~12 archivos nuevos, ~8 archivos tocados, 0 migraciones SQL (todo el schema ya existe)
> **Estimación:** ~2 días de Claude Code

---

## 0. Por qué este plan existe

El catalog cleanup 2026-05-19 mergeó `microchip_revoked` dentro de `microchip_replaced` con `new_chip_number=null` como discriminador de revocación pura. El schema, Zod, libreta groupBy y case-attachment branching ya están en código:

- `db/schema.ts:255` — `"microchip_replaced"` en `EVENT_TYPES`
- `lib/event-schemas.ts:517` — `microchipReplaced` schema con reasons enum unificado (damaged / unreadable / duplicate_detected / fraud_detected / owner_request / device_failure / other) y `actor_role` discriminator
- `lib/libreta-sanitaria.ts:181` — grouping en `microchip`
- `lib/case-attachment.ts:119` — branching: solo `fraud_detected` + `duplicate_detected` abren `microchip_remediation`
- `__tests__/event-schemas.test.ts:248` — coverage tests OK
- `scripts/seed-storylines-*.ts` — seed data presente

Lo que **falta**:

🔴 **UI owner-facing.** No hay form en `/eventos/nuevo/*` para que el owner registre el cambio cuando le reemplazaron el chip en la veterinaria. Hoy la única vía es seed o emisión institucional via server (sin route).

🔴 **`microchip_remediation` case lifecycle.** En `lib/case-kinds.ts` figura pero NO está en `V1_CASE_KINDS`, no tiene archivo `lib/case-lifecycles/microchip-remediation.ts`, no aparece en `LIFECYCLES` registry. El branching de `case-attachment` apunta a un kind que el sistema rechaza al insertar.

🔴 **Server action.** No existe `app/actions/microchip.ts` con `replaceMicrochipAction`. La emisión institucional tampoco tiene wrapper.

🔴 **Cross-pet duplicate detection.** Cuando un owner registra "duplicate_detected", el sistema debería buscar el chip antiguo en otras pets activas y alertar. Hoy no hace nada.

🟡 **Notification matrix.** Nadie recibe nada cuando un chip se reemplaza. Necesario para el caso fraude (notif a admin) y para el case `microchip_remediation` (notif a govt si applies).

## 1. Decisiones cerradas (no relitigar)

| # | Decisión | Razón |
|---|---|---|
| D1 | **Owner puede registrar cualquier `reason` salvo `fraud_detected` y `duplicate_detected`** | Owner sabe damaged/unreadable/owner_request/device_failure de su propio chip. Fraude y duplicado son detecciones de sistema o institucionales — abrir esos kinds desde owner sin verificación introduce abuso |
| D2 | **`fraud_detected` y `duplicate_detected` solo pueden venir de admin o vet con `events.write.identification`** | Reflejan determinaciones técnicas (lectura cruzada de DB, hallazgo en consulta). Admin path: directo. Vet path: durante una atención, marcar el chip como fraudulento abre el case automáticamente |
| D3 | **El form owner muestra 4 reasons** | `damaged`, `unreadable`, `owner_request`, `device_failure`, `other`. Los 2 restantes hidden — si el owner sospecha fraude, deriva al admin via "Reportar irregularidad" |
| D4 | **`new_chip_number=null` (revocación pura) requiere reason terminante** | Si el chip se retiró sin reemplazo, el reason DEBE ser `fraud_detected`, `device_failure` u `owner_request`. Para reasons como `damaged` se asume que hay reemplazo (el vet le pone uno nuevo en el mismo acto) |
| D5 | **`microchip_remediation` case se abre solo con `fraud_detected` y `duplicate_detected`** | Confirmado en `case-attachment.ts:119`. No tocar — está bien razonado: damaged/unreadable son operación normal, no requieren tracking de caso |
| D6 | **Cross-pet duplicate scan al emitir `duplicate_detected`** | El server action consulta `pets` para encontrar el `previous_chip_number` activo en otra mascota. Si lo encuentra, abre el case con `secondaryPetId` apuntando a esa segunda pet. Si NO lo encuentra, abre el case igual pero solo con `primaryPetId` (la dup pudo ser histórica) |
| D7 | **Actor_role del event lo computa el server, no se trustea del cliente** | Owner UI → `actor_role='owner'`. Vet en `/org/[orgToken]` → `actor_role='vet'` + `author_organization_id` set. Admin en `/admin` → `actor_role='admin'` |
| D8 | **El case lifecycle de `microchip_remediation` tiene status open/escalated/closed + reopen disabled** | Mismo shape que `custody_dispute`. No tiene cron auto-close — humanos (admin/govt) lo cierran cuando resuelven el fraude o confirman el duplicado |
| D9 | **Pet.microchipNumber se actualiza dentro del mismo tx que el event** | Append-only del event + UPDATE de la columna desnormalizada. Mantiene la coherencia que ya existe para `microchip_implanted` (que también escribe `pets.microchip_*`) |

---

## 2. Qué construye este plan

Tres fases secuenciales. Cada una es 1 PR.

**Fase A — Lifecycle del case `microchip_remediation`.** Promover el kind a V1, crear `lib/case-lifecycles/microchip-remediation.ts`, registrar en `LIFECYCLES`, agregar `case-normatives` y coverage tests. Sin UI todavía.

**Fase B — Server action + cross-pet duplicate scan.** `app/actions/microchip.ts` con `replaceMicrochipAction`. Casos cubiertos: owner-initiated (4 reasons), vet-in-org-initiated (todos los reasons), admin-initiated (todos los reasons). Tx que: valida payload, busca duplicate cross-pet si aplica, emite `microchip_replaced` event con `case_id` cuando branching activa, actualiza `pets.microchip_number`, emite notifications según matriz, audit_log row.

**Fase C — UI owner-facing.** Form `/mis-mascotas/[publicToken]/eventos/nuevo/microchip-reemplazo` con 4 reasons + opcional new_chip_number. Vinculo desde la sección "Microchip" del pet detail. Sub-form vet en `/org/[orgToken]/mascotas/[publicToken]/microchip/reemplazar` para uso clínico. Sub-form admin en `/admin/observaciones/[publicToken]/microchip` (path provisional, ver §3.4).

---

## 3. Por fase, paso a paso

### 3.1 Fase A — Lifecycle `microchip_remediation`

**Archivos nuevos:**

- `lib/case-lifecycles/microchip-remediation.ts`:

  ```ts
  // microchip_remediation lifecycle.
  //
  // Opens: microchip_replaced with reason='fraud_detected' OR 'duplicate_detected'.
  // Branching enforced in lib/case-attachment.ts:119.
  // Terminal: explicit close by admin/govt (no event opener for close — admin marks
  // the case resolved with closed_reason='resolved' | 'cancelled' | 'merged').
  // No auto-close cron.
  // No reopen — once resolved, a new microchip_replaced opens a fresh case.

  import type { CaseLifecycle } from "./types";

  export const microchipRemediationLifecycle: CaseLifecycle = {
    kind: "microchip_remediation",
    statusValues: ["open", "escalated", "closed"],
    phases: ["investigation", "evidence_collected", "resolved", "dismissed"],
    opensEvents: [
      {
        eventType: "microchip_replaced",
        guard: (p) =>
          p.reason === "fraud_detected" || p.reason === "duplicate_detected",
      },
    ],
    terminalEvents: [], // closed manually via case action, not via event
    cronCloseRoute: null,
    cronCloseScheduleHours: 24,
    manualOpenAllowed: true,
    reopenAllowed: false,
  };
  ```

- `__tests__/case-lifecycles.test.ts`: extender coverage para que reconozca `microchip_remediation` como V1.

**Archivos modificados:**

- `lib/case-kinds.ts`:
  - Mover `microchip_remediation` desde "Deferred" hacia el bloque V1 dentro de `CASE_KINDS`.
  - Agregarlo a `V1_CASE_KINDS` array.

- `lib/case-lifecycles/index.ts`:
  - `import { microchipRemediationLifecycle } from "./microchip-remediation";`
  - Agregar en el `LIFECYCLES` record.

- `lib/case-normatives.ts`:
  - Agregar entry para `microchip_remediation` con referencias a la Resolución SENASA / Ley de Registro Nacional de Identificación de Mascotas (cuando se aplique en CABA/PBA — investigar referencia exacta antes de hardcodear; placeholder "Reglamentación local de identificación animal" mientras tanto).

- `lib/case-attachment.ts`: nada — el branching ya está.

**Validaciones:**

- Coverage test V1: el kind tiene lifecycle file declarado.
- Test del branching: insertar `microchip_replaced` con `reason='damaged'` NO abre case; con `reason='fraud_detected'` sí; con `reason='duplicate_detected'` sí.

**Shippeable**: la activación del case lifecycle sin UI no rompe nada porque seed scripts ya emiten eventos sin `case_id` y siguen funcionando — la branching guard solo activa cuando reason es fraud/dup.

---

### 3.2 Fase B — Server action

**Archivos nuevos:**

- `app/actions/microchip.ts`:

  ```ts
  "use server";

  import { z } from "zod";
  import { db, pets, petEvents, notifications, auditLog, cases } from "@/db";
  import { and, eq, isNull } from "drizzle-orm";

  import { requireUserOrThrow } from "@/lib/auth-guards";
  import { resolveAuthorship } from "@/lib/event-authorship";
  import { validateEventPayload } from "@/lib/event-schemas";
  import { openCase } from "@/lib/case-queries";
  import { getLifecycle } from "@/lib/case-lifecycles";

  const OWNER_REASONS = ["damaged", "unreadable", "owner_request", "device_failure", "other"] as const;
  const VET_REASONS = [...OWNER_REASONS, "duplicate_detected"] as const;
  const ADMIN_REASONS = [...OWNER_REASONS, "duplicate_detected", "fraud_detected"] as const;

  const schema = z.object({
    petId: z.string().uuid(),
    previousChipNumber: z.string(),
    newChipNumber: z.string().nullable(),
    reason: z.enum([
      "damaged", "unreadable", "duplicate_detected",
      "fraud_detected", "owner_request", "device_failure", "other",
    ]),
    replacedBy: z.string().nullable().optional(),
    replacedAt: z.string(), // ISO
    notes: z.string().nullable().optional(),
    actorContext: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("owner") }),
      z.object({ kind: z.literal("vet_in_org"), organizationId: z.string().uuid() }),
      z.object({ kind: z.literal("admin") }),
    ]),
  });

  export async function replaceMicrochipAction(input: z.infer<typeof schema>) {
    const parsed = schema.parse(input);
    const user = await requireUserOrThrow();

    // Gate reasons by actor.
    const allowedReasons =
      parsed.actorContext.kind === "owner" ? OWNER_REASONS :
      parsed.actorContext.kind === "vet_in_org" ? VET_REASONS :
      ADMIN_REASONS;
    if (!allowedReasons.includes(parsed.reason as any)) {
      throw new Error(`Reason '${parsed.reason}' no permitido para actor '${parsed.actorContext.kind}'`);
    }

    // Validate new_chip_number=null requires terminal reason.
    if (parsed.newChipNumber === null) {
      const allowedNullReasons = ["fraud_detected", "device_failure", "owner_request"];
      if (!allowedNullReasons.includes(parsed.reason)) {
        throw new Error("Revocación sin reemplazo requiere reason fraud_detected, device_failure u owner_request");
      }
    }

    return db.transaction(async (tx) => {
      // 1. Load pet, verify ownership/membership match actor.
      const [pet] = await tx.select().from(pets).where(eq(pets.id, parsed.petId)).limit(1);
      if (!pet) throw new Error("Pet no encontrada");
      // ... actor-pet gate per actorContext.kind (owner = current ownership, vet_in_org = org has custody, admin = always allowed)

      // 2. Cross-pet duplicate scan if reason='duplicate_detected'.
      let secondaryPetId: string | null = null;
      if (parsed.reason === "duplicate_detected") {
        const dupes = await tx
          .select({ id: pets.id })
          .from(pets)
          .where(and(
            eq(pets.microchipNumber, parsed.previousChipNumber),
            isNull(pets.deletedAt),
          ));
        secondaryPetId = dupes.find(d => d.id !== pet.id)?.id ?? null;
      }

      // 3. Open case if branching applies.
      const lifecycle = getLifecycle("microchip_remediation");
      const shouldOpen = lifecycle?.opensEvents?.[0]?.guard?.({ reason: parsed.reason }) ?? false;
      let caseId: string | null = null;
      if (shouldOpen) {
        const opened = await openCase(tx, {
          kind: "microchip_remediation",
          primaryPetId: pet.id,
          secondaryPetId,
          openedByUserId: user.id,
          jurisdictionProvince: pet.jurisdictionProvince,
          jurisdictionLocality: pet.jurisdictionLocality,
        });
        caseId = opened.id;
      }

      // 4. Resolve authorship.
      const authorship = resolveAuthorship(parsed.actorContext, user);

      // 5. Validate payload via Zod.
      const payload = {
        previous_chip_number: parsed.previousChipNumber,
        new_chip_number: parsed.newChipNumber,
        reason: parsed.reason,
        replaced_by: parsed.replacedBy ?? null,
        replaced_at: parsed.replacedAt,
        actor_role: authorship.authorRole,
        actor_user_id: user.id,
        notes: parsed.notes ?? null,
      };
      validateEventPayload("microchip_replaced", payload);

      // 6. Insert event.
      const [event] = await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "microchip_replaced",
        payload,
        caseId,
        recordedByUserId: user.id,
        authorRole: authorship.authorRole,
        authorOrganizationId: authorship.authorOrganizationId,
        authorVerified: authorship.authorVerified,
      }).returning();

      // 7. Update pets.microchipNumber.
      await tx.update(pets).set({
        microchipNumber: parsed.newChipNumber,
        microchipUpdatedAt: new Date(),
      }).where(eq(pets.id, pet.id));

      // 8. Notifications matrix.
      if (parsed.reason === "fraud_detected") {
        // Notif urgente a admin platform.
        await tx.insert(notifications).values({
          userId: /* admin user ids */ ...,
          severity: "urgent",
          category: "admin",
          title: `Fraude de microchip detectado en ${pet.name}`,
          body: `Caso ${caseId}. Investigar.`,
          relatedPetId: pet.id,
          relatedCaseId: caseId,
        });
      }
      if (parsed.reason === "duplicate_detected" && secondaryPetId) {
        // Notif a govt jurisdicción + a admin.
        // ...
      }
      // Always notif al owner cuando vet/admin emite (heads-up).
      if (parsed.actorContext.kind !== "owner" && pet.ownerUserId) {
        await tx.insert(notifications).values({
          userId: pet.ownerUserId,
          severity: parsed.reason === "fraud_detected" ? "urgent" : "info",
          category: "health",
          title: `Microchip de ${pet.name} actualizado`,
          body: `Motivo: ${parsed.reason}. Si no reconocés el cambio, contactá soporte.`,
          relatedPetId: pet.id,
          relatedEventId: event.id,
        });
      }

      // 9. Audit log.
      await tx.insert(auditLog).values({
        action: "microchip.replace",
        actorUserId: user.id,
        subjectPetId: pet.id,
        relatedEventId: event.id,
        metadata: { reason: parsed.reason, actorContext: parsed.actorContext.kind },
      });

      return { ok: true, eventId: event.id, caseId };
    });
  }
  ```

  (El código de arriba es el outline — los `// ...` se completan en implementación. Notificaciones reales necesitan resolver admin user_ids vía query existente.)

**Archivos modificados:**

- `lib/event-authorship.ts`: extender `resolveAuthorship` para aceptar `actorContext` con discriminator (owner | vet_in_org | admin).
- `db/AUDIT_LOG_ACTIONS` (en `db/schema.ts`): agregar `"microchip.replace"`.

**Tests:**

- `__tests__/microchip-replaced.test.ts`:
  - Owner emite damaged → event emitido, sin case, pets.microchipNumber actualizado.
  - Owner intenta fraud_detected → error.
  - Vet en org emite duplicate_detected → case `microchip_remediation` abierto.
  - Cross-pet dup scan encuentra otra pet → secondaryPetId set en el case.
  - Cross-pet dup scan sin matches → case abierto solo con primary.
  - Revocación pura (new_chip_number=null) con reason damaged → error.
  - Revocación pura con reason owner_request → OK.
  - Notif al owner cuando emite vet → existe.
  - Audit log row escrita.

---

### 3.3 Fase C — UI owner-facing

**Archivo nuevo:** `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/microchip-reemplazo/page.tsx`

```tsx
import { ReplaceMicrochipForm } from "./ReplaceMicrochipForm";
import { loadPetForOwner, requireUserOrRedirect } from "@/lib/auth-guards";
import { notFound } from "next/navigation";

export default async function NuevoReemplazoMicrochipPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const { user } = await requireUserOrRedirect();
  const pet = await loadPetForOwner(publicToken, user.id);
  if (!pet) notFound();
  if (!pet.microchipNumber) {
    // Tactically redirect a registrar chip si todavía no tiene
    return <NoChipYetView pet={pet} />;
  }

  return (
    <main className="max-w-2xl mx-auto p-6">
      <Breadcrumb items={[
        { label: "Mis mascotas", href: "/mis-mascotas" },
        { label: pet.name, href: `/mis-mascotas/${publicToken}` },
        { label: "Reemplazar microchip" },
      ]} />
      <h1>Reemplazar microchip de {pet.name}</h1>
      <p className="lead">
        Si te cambiaron el chip en la veterinaria o el chip dejó de funcionar, registralo acá.
      </p>
      <ReplaceMicrochipForm petId={pet.id} publicToken={publicToken} currentChip={pet.microchipNumber} />
    </main>
  );
}
```

**Archivo nuevo:** `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/microchip-reemplazo/ReplaceMicrochipForm.tsx` (client)

```tsx
"use client";

import { useFormState } from "react-dom";
import { replaceMicrochipFormAction } from "./action";

const OWNER_REASONS = [
  { value: "damaged", label: "Roto físicamente" },
  { value: "unreadable", label: "No se puede leer" },
  { value: "owner_request", label: "Decisión propia (revoco sin reemplazo)" },
  { value: "device_failure", label: "Dejó de funcionar (sin daño visible)" },
  { value: "other", label: "Otro motivo" },
] as const;

export function ReplaceMicrochipForm({ petId, publicToken, currentChip }: Props) {
  const [state, formAction] = useFormState(replaceMicrochipFormAction, { errors: {}, values: {} });

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="petId" value={petId} />
      <input type="hidden" name="previousChipNumber" value={currentChip} />

      <FormSection title="Motivo del reemplazo">
        <Field label="¿Qué pasó con el chip actual?" required error={state.errors.reason?.[0]}>
          <RadioGroup name="reason" required>
            {OWNER_REASONS.map((r) => (
              <Radio key={r.value} value={r.value} label={r.label} />
            ))}
          </RadioGroup>
        </Field>
      </FormSection>

      <FormSection title="Chip nuevo">
        <Field
          label="Número del chip nuevo"
          helper="Dejá vacío si fue revocación sin reemplazo (solo con owner_request o device_failure)"
          error={state.errors.newChipNumber?.[0]}
        >
          <Input name="newChipNumber" maxLength={20} pattern="[0-9]*" inputMode="numeric" />
        </Field>
        <Field label="Implantado por (opcional)">
          <Input name="replacedBy" placeholder="Ej: Vet. García, Clínica del Sol" maxLength={120} />
        </Field>
        <Field label="Fecha" required error={state.errors.replacedAt?.[0]}>
          <DateInput name="replacedAt" max={today} required />
        </Field>
      </FormSection>

      <FormSection title="Notas">
        <Field label="Comentarios (opcional)">
          <Textarea name="notes" rows={3} maxLength={300} />
        </Field>
      </FormSection>

      <Alert variant="info">
        <strong>¿Sospechás fraude o duplicado del chip?</strong> Eso requiere intervención del
        admin o tu veterinaria. Marcalo desde la <Link href="/reportar-irregularidad">página de reporte</Link>
        en lugar de este formulario.
      </Alert>

      <div className="flex gap-3 justify-end">
        <Button variant="link" href={`/mis-mascotas/${publicToken}`}>Cancelar</Button>
        <Button variant="primary" type="submit">Registrar reemplazo</Button>
      </div>
    </form>
  );
}
```

**Archivo nuevo:** `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/microchip-reemplazo/action.ts`

Server action wrapper que mapea FormData a `replaceMicrochipAction({ ..., actorContext: { kind: "owner" } })`.

**Archivos modificados:**

- `app/(app)/mis-mascotas/[publicToken]/page.tsx`: en la sección "Microchip" del pet detail, agregar botón "Reemplazar chip" condicional a tener chip activo.

- `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/page.tsx` (event-type picker): agregar entry "microchip-reemplazo" entre los eventos disponibles, con label "Reemplazar microchip".

### 3.4 Fase C bis — UI vet (en org)

**Archivo nuevo:** `app/org/[orgToken]/mascotas/[publicToken]/microchip/reemplazar/page.tsx` + `ReplaceMicrochipForm.tsx`

Misma estructura que owner pero con:

- Reasons disponibles: 4 owner + `duplicate_detected`.
- Pre-check: vet con `events.write.identification` capability + org tiene `shelter_custody` o `foster` activo sobre el pet.
- `actorContext.kind = "vet_in_org"` en la llamada.

### 3.5 Fase C ter — UI admin

**Archivo nuevo:** `app/admin/observaciones/[publicToken]/microchip/reemplazar/page.tsx`

Path provisional bajo `/observaciones` porque ahí ya viven las acciones admin sobre un pet específico. Si emerge demanda de un hub admin de microchips, se mueve a `/admin/microchips/...` en otro plan.

Reasons disponibles: todos los 6.
`actorContext.kind = "admin"`.

---

## 4. Resumen ejecutivo

| Fase | Duración | PRs | Archivos nuevos | Archivos tocados |
|---|---|---|---|---|
| A — Lifecycle case | 0.25d | 1 | 1 | 3 |
| B — Server action + scan | 1d | 1 | 2 | 3 |
| C — UI (owner + vet + admin) | 0.75d | 1 | 6 | 2 |
| **Total** | **~2d** | **3** | **9** | **8** |

---

## 5. Riesgos

| Riesgo | Mitigación |
|---|---|
| Cross-pet duplicate scan falso positivo (chip antiguo que no fue dup real, sino reciclado intencionalmente) | El case abre como "open" — admin investiga antes de cualquier acción. Lifecycle permite cerrarlo con `closed_reason='dismissed'` |
| Owner registra un reason equivocado | Edit no permitido (append-only). Owner emite otro `microchip_replaced` con reason corregido si hace falta. Auditoría preservada |
| Vet emite duplicate_detected sin scope (pet de otra org) | Gate por capability + ownership match. Server rechaza |
| Admin emite fraud_detected sin evidencia | Audit log + case visible en `/admin/casos`. La decisión queda registrada con motivo + notes obligatorias |

---

## 6. Out of scope

- Hub admin completo de microchips (lista de remediations, dashboard de fraude). Si hay demanda, plan aparte.
- Integration con RENAMA (Registro Nacional de Mascotas) — Mi Argentina dependiente.
- Bulk import de microchip replacements (clínicas que migran datos legacy).
- Read-only del histórico de chips en la credencial Tier 0 — actualmente solo se muestra el chip actual; mostrar el historial completo está en otro plan.
