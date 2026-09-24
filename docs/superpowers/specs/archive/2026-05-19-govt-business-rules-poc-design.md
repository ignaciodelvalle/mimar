# Govt business rules — POC — design spec

> POC: framework para que distintas jurisdicciones (govts) configuren sus propias **reglas de negocio locales**. Caso inicial: las reglas PPP (Animal Potencialmente Peligroso, Ley CABA 4078 / Prov 14.107) — cada jurisdicción puede divergir en lista de razas, threshold de peso, registros que requieren atestación. Hoy las reglas viven hardcoded en `lib/breeds.ts` con un único set "AR". El POC introduce: tabla `govt_business_rules`, defaults en código, resolver con cascada (locality > province > country > defaults), forms específicos por rule_type, y dashboards: uno para admin (gestiona todas las reglas) y otro para govt (read-only de las que aplican a su scope).
>
> POC = demonstrates capability. Implementación inicial cubre solo rule types PPP. Generalización a otros rule types (e.g., vaccination requirements, sterilization mandates) llega cuando se priorice — el framework lo permite sin schema changes.
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Estado:** ready for review, no code yet
> **Versión:** 1.0
> **Depende de:** admin page (govt_assignments + admin/govt routing ya implementado), `pets.potentially_dangerous_breed` flag existente.

---

## 1. Por qué este documento existe

`AGENTS.md → User roles → Business rules ownership (future)` declara explícitamente este hueco:

> Cada jurisdicción puede tener reglas de negocio propias que diverjan de las defaults nacionales. Hoy todo está hardcoded; necesitamos infrastructure que permita configurabilidad scoped por govt + admin oversight.

Casos concretos de divergencia hoy ignorada en código:

- **Razas PPP**: Ley CABA 4078 lista (entre otras) Rottweiler, Pit bull, Doberman, Akita, Bullmastiff, etc. Ley Prov 14.107 (PBA) tiene una lista similar pero **no idéntica**. Otras provincias podrían tener subsets distintos o agregar razas locales relevantes. Hoy `lib/breeds.ts` tiene una sola lista global "AR".
- **Threshold de peso para considerar PPP**: algunas jurisdicciones aplican >25kg, otras lo definen por raza solamente, otras combinan. Hoy no hay threshold modelado.
- **Registros que requieren atestación**: CABA pide atestación al Registro 4078 + opcional ANIMALES BA. PBA pide al Registro Provincial 14.107. Otras pueden tener su propio registro municipal. Hoy `dangerous_breed_attested` event acepta cualquier string en `registry` — sin validación.

Sin framework configurable, cualquier divergencia provincial requiere PR + deploy. POC abre la puerta a govts configurando localmente.

---

## 2. Decisiones cerradas

| # | Decisión | Razón |
|---|---|---|
| BR1 | **POC limitado a 3 rule types**: `ppp_breed_list`, `ppp_weight_threshold`, `ppp_attestation_required_registries`. Generalización a otros types (vaccination requirements, sterilization mandates, etc.) defer. El framework lo permite — solo los rule_types y sus forms / resolvers son los que crecen con cada feature | Demuestra el patrón sin scope creep |
| BR2 | **Tabla `govt_business_rules`** con `(jurisdiction_country, jurisdiction_province nullable, jurisdiction_locality nullable, rule_type, rule_payload jsonb)`. UNIQUE composite — un set de (jurisdiction + rule_type) tiene a lo sumo 1 row activa | Schema flexible que crece sin migrations |
| BR3 | **Defaults en código** (`lib/business-rules-defaults.ts`). Cuando un govt NO ha creado override para `(jurisdiction, rule_type)`, el resolver devuelve el default. Esto permite migración blanda: pre-POC los defaults capturan el comportamiento hardcoded actual | Backward compat sin breaks |
| BR4 | **Resolver con cascada**: `locality > province > country > defaults`. Lookup para un pet en CABA Palermo busca primero `(country=AR, province=CABA, locality=Palermo)`, después `(country=AR, province=CABA, locality=null)`, después `(country=AR, province=null, locality=null)`, finalmente defaults. La primera coincidencia gana | Permite override granular sin perder fallbacks |
| BR5 | **Form ESPECÍFICO por rule_type**, NO JSON editor genérico. Cada rule_type tiene una UI Curada: `ppp_breed_list` muestra checklist de razas conocidas + add custom; `ppp_weight_threshold` muestra slider; `ppp_attestation_required_registries` muestra multi-select de registros conocidos. JSON crudo solo accesible en modo "advanced edit" como escape | UX over JSON soup. JSON editor genérico es para developers, no para govt admin que quiere "agregar Boxer a la lista" |
| BR6 | **Solo `role='admin'`** puede CREAR / UPDATE / DELETE rules (cualquier jurisdicción). Govt con `role='govt'` solo READ las que aplican a su scope. Razón: este es un framework "meta" — el admin nacional administra el sistema, los govts locales informan / consumen pero no alteran | Limita risk de configuración inconsistente local. Centraliza control |
| BR7 | **Audit log obligatorio** para cada create/update/delete de rule. Track `actor_user_id`, `action`, `target_rule_id`, `previous_payload`, `new_payload`, `timestamp` | Govt business rules son legalmente sensibles. Audit es no-negotiable |
| BR8 | **Dashboards en dos surfaces**: `/admin/jurisdicciones` (lista de jurisdicciones con counts de reglas activas) + `/admin/jurisdicciones/[code]/reglas` (CRUD de reglas para esa jurisdicción) + `/gob/reglas` (read-only de reglas que aplican al govt logged in con explanation de la cascada) | Separación clean por surface. Admin gestiona, govt informa |
| BR9 | **Cuando una rule se crea / cambia**, todos los pets en jurisdicción se RE-EVALUATE en background (cron / queue). Por ejemplo: si CABA agrega Boxer a su PPP list, todos los pets registrados en CABA con breed=Boxer reciben UPDATE de `potentially_dangerous_breed=true` + emit `dangerous_breed_attested` reminder a sus dueños | Sin re-eval, las reglas serían letra muerta para pets pre-existentes. Esto es el value del framework |
| BR10 | **No-op si govt crea rule duplicada del default**: si admin crea rule `ppp_breed_list` para AR con la misma lista que está en defaults, el resolver lo detecta y NO inserta (con feedback "Esta config es idéntica al default — sin override necesario"). Reduce noise | Mantiene la base de override limpia |
| BR11 | **Validation Zod por rule_type**: `lib/business-rules-validators.ts` declara schemas por rule_type. INSERT/UPDATE valida el payload contra el schema correcto antes de persistir. Garbage in → 400 | Type safety. Sin esto, un admin con typo guarda `{ breedz: [...] }` y el resolver no encuentra `breeds` después |

---

## 3. Glosario

| Término | Qué es |
|---|---|
| **Business rule** | Decisión configurable que afecta comportamiento del sistema (e.g., "qué razas son PPP en CABA") |
| **Rule type** | Discriminator del tipo de rule. POC: `ppp_breed_list`, `ppp_weight_threshold`, `ppp_attestation_required_registries`. Extensible |
| **Default** | Valor de fallback hardcoded en `lib/business-rules-defaults.ts`. Aplica cuando ningún govt ha overrideado |
| **Override** | Row en `govt_business_rules` que sobrescribe el default para una jurisdicción específica |
| **Cascada de resolución** | locality > province > country > defaults. Primera coincidencia gana |
| **Re-evaluation** | Cron/queue que actualiza pets afectados cuando una rule cambia |
| **Audit row** | Registro en `audit_log` para cada operación CRUD sobre rules |

---

## 4. Domain model

### 4.1 Tabla `govt_business_rules`

```ts
// db/schema.ts
export const GOVT_BUSINESS_RULE_TYPES = [
  'ppp_breed_list',
  'ppp_weight_threshold',
  'ppp_attestation_required_registries',
  // Future: 'vaccination_requirements_core', 'sterilization_mandate', etc.
] as const;
export type GovtBusinessRuleType = (typeof GOVT_BUSINESS_RULE_TYPES)[number];

export const govtBusinessRules = pgTable(
  'govt_business_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jurisdictionCountry: text('jurisdiction_country').notNull().default('AR'),
    jurisdictionProvince: text('jurisdiction_province'),  // null = country-wide
    jurisdictionLocality: text('jurisdiction_locality'),  // null = province-wide
    ruleType: text('rule_type').notNull().$type<GovtBusinessRuleType>(),
    rulePayload: jsonb('rule_payload').notNull(),
    notes: text('notes'),
    legalAnchorIds: text('legal_anchor_ids').array(),  // refs to lib/case-normatives.ts or similar
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id')
      .references(() => profiles.id, { onDelete: 'restrict' }),
  },
  (table) => ({
    uniqueJurisdictionRuleType: uniqueIndex('govt_business_rules_jurisdiction_rule_type_unique')
      .on(table.jurisdictionCountry, table.jurisdictionProvince, table.jurisdictionLocality, table.ruleType),
    ruleTypeIdx: index('govt_business_rules_rule_type_idx').on(table.ruleType),
  }),
);

export type GovtBusinessRule = typeof govtBusinessRules.$inferSelect;
```

### 4.2 Defaults en código

```ts
// lib/business-rules-defaults.ts
import { DANGEROUS_BREEDS_AR } from './breeds';  // existente

export interface PPP_BreedList { breeds: string[]; }  // canonical breed slugs
export interface PPP_WeightThreshold { kg: number | null; appliesIfBreedNotPPP: boolean; }
export interface PPP_AttestationRegistries { registries: { id: string; label: string; required: boolean }[]; }

export const BUSINESS_RULES_DEFAULTS = {
  ppp_breed_list: { breeds: DANGEROUS_BREEDS_AR } satisfies PPP_BreedList,
  ppp_weight_threshold: { kg: null, appliesIfBreedNotPPP: false } satisfies PPP_WeightThreshold,
  ppp_attestation_required_registries: { registries: [] } satisfies PPP_AttestationRegistries,
} as const;

// Country-AR defaults that diverge from "base" defaults
export const BUSINESS_RULES_AR_OVERRIDES = {
  // Currently identical to base — placeholder for future federal-level divergence
};
```

### 4.3 Resolver con cascada

```ts
// lib/business-rules-resolver.ts
import { db, govtBusinessRules } from '@/db';
import { BUSINESS_RULES_DEFAULTS } from './business-rules-defaults';
import { and, eq, isNull, sql } from 'drizzle-orm';

export async function resolveBusinessRule<T extends GovtBusinessRuleType>(
  ruleType: T,
  jurisdiction: { country?: string; province?: string; locality?: string }
): Promise<BusinessRulePayload<T>> {
  const country = jurisdiction.country ?? 'AR';
  const province = jurisdiction.province ?? null;
  const locality = jurisdiction.locality ?? null;

  // Cascada: locality > province > country > defaults
  const candidates = [
    { country, province, locality },
    { country, province, locality: null },
    { country, province: null, locality: null },
  ];

  for (const c of candidates) {
    const [row] = await db
      .select()
      .from(govtBusinessRules)
      .where(and(
        eq(govtBusinessRules.ruleType, ruleType),
        eq(govtBusinessRules.jurisdictionCountry, c.country),
        c.province === null
          ? isNull(govtBusinessRules.jurisdictionProvince)
          : eq(govtBusinessRules.jurisdictionProvince, c.province),
        c.locality === null
          ? isNull(govtBusinessRules.jurisdictionLocality)
          : eq(govtBusinessRules.jurisdictionLocality, c.locality),
      ))
      .limit(1);
    if (row) return row.rulePayload as BusinessRulePayload<T>;
  }

  return BUSINESS_RULES_DEFAULTS[ruleType] as BusinessRulePayload<T>;
}
```

### 4.4 Validators per rule_type

```ts
// lib/business-rules-validators.ts
import { z } from 'zod';

export const BUSINESS_RULE_VALIDATORS = {
  ppp_breed_list: z.object({
    breeds: z.array(z.string()).min(0).max(100),
  }).strict(),

  ppp_weight_threshold: z.object({
    kg: z.number().min(0).max(200).nullable(),
    appliesIfBreedNotPPP: z.boolean(),
  }).strict(),

  ppp_attestation_required_registries: z.object({
    registries: z.array(z.object({
      id: z.string().min(2),
      label: z.string().min(2),
      required: z.boolean(),
    })).max(20),
  }).strict(),
} satisfies Record<GovtBusinessRuleType, z.ZodSchema>;
```

### 4.5 Helper de re-evaluation

```ts
// lib/business-rules-reeval.ts
export async function reEvaluatePppBreedListChange(jurisdiction: { country: string; province?: string; locality?: string }) {
  // Query pets in jurisdiction
  const petsInJurisdiction = await db.select().from(pets).where(/* jurisdiction match */);

  for (const pet of petsInJurisdiction) {
    const newRule = await resolveBusinessRule('ppp_breed_list', pet);
    const isNowPPP = newRule.breeds.includes(pet.breed ?? '');
    if (isNowPPP !== pet.potentiallyDangerousBreed) {
      await db.update(pets)
        .set({ potentiallyDangerousBreed: isNowPPP })
        .where(eq(pets.id, pet.id));
      // Notif al owner si flippeó a true
      if (isNowPPP) {
        await createNotification({
          userId: ownerOfPet(pet),
          notificationType: 'ppp_breed_list_updated_now_applies',
          title: 'Cambio en la regulación PPP de tu jurisdicción',
          body: `La raza de ${pet.name} (${pet.breed}) ahora figura en la lista de Animales Potencialmente Peligrosos de tu localidad. Conocé los requisitos legales y, si corresponde, registrá la atestación.`,
          severity: 'warning',
          ctaLabel: 'Ver requisitos PPP',
          ctaUrl: `/mis-mascotas/${pet.publicToken}#ppp`,
        });
      }
    }
  }
}
```

Cron schedule + queue para batch processing. Idempotente. Llamado tras cada UPDATE de rule_type relevante.

### 4.6 Audit log actions

Agregar a `AUDIT_LOG_ACTIONS`:

```ts
'govt_business_rule_created',
'govt_business_rule_updated',
'govt_business_rule_deleted',
```

---

## 5. Server actions

### 5.1 `createBusinessRuleAction`

```ts
// app/actions/business-rules.ts (nuevo)
'use server';
export async function createBusinessRuleAction(formData: FormData): Promise<BusinessRuleFormState> {
  const { user } = await requireUserOrRedirect();
  const profile = await getProfile(user.id);
  if (profile?.role !== 'admin') return { error: 'Solo admin puede crear business rules' };

  const ruleType = String(formData.get('ruleType') ?? '') as GovtBusinessRuleType;
  if (!GOVT_BUSINESS_RULE_TYPES.includes(ruleType)) return { error: 'Rule type inválido' };

  const country = String(formData.get('jurisdictionCountry') ?? 'AR');
  const province = formData.get('jurisdictionProvince') ? String(formData.get('jurisdictionProvince')) : null;
  const locality = formData.get('jurisdictionLocality') ? String(formData.get('jurisdictionLocality')) : null;
  const notes = formData.get('notes') ? String(formData.get('notes')) : null;
  const legalAnchorIds = (formData.getAll('legalAnchorIds') as string[]) ?? [];

  // Parse rule_payload (form-specific per rule_type)
  const rulePayload = parseRulePayloadFromForm(ruleType, formData);

  // Validate
  const validator = BUSINESS_RULE_VALIDATORS[ruleType];
  const parsed = validator.safeParse(rulePayload);
  if (!parsed.success) return { error: `Payload inválido: ${parsed.error.message}` };

  // Check if equivalent to default → no-op (BR10)
  const defaultPayload = BUSINESS_RULES_DEFAULTS[ruleType];
  if (deepEqual(parsed.data, defaultPayload)) {
    return { warning: 'Esta configuración es idéntica al default — no se requiere override.' };
  }

  await db.transaction(async (tx) => {
    const [created] = await tx.insert(govtBusinessRules).values({
      jurisdictionCountry: country,
      jurisdictionProvince: province,
      jurisdictionLocality: locality,
      ruleType,
      rulePayload: parsed.data,
      notes,
      legalAnchorIds,
      createdByUserId: user.id,
      updatedByUserId: user.id,
    }).returning();

    // Audit
    await tx.insert(auditLog).values({
      actorUserId: user.id,
      action: 'govt_business_rule_created',
      payload: {
        ruleId: created.id,
        ruleType,
        jurisdiction: { country, province, locality },
        newPayload: parsed.data,
      },
    });

    // Trigger re-evaluation if relevant
    if (ruleType === 'ppp_breed_list') {
      await reEvaluatePppBreedListChange({ country, province, locality });
    }
  });

  redirect(`/admin/jurisdicciones/${country}/${province ?? '_'}/${locality ?? '_'}/reglas`);
}
```

### 5.2 `updateBusinessRuleAction` y `deleteBusinessRuleAction`

Análogos. Audit log para each.

Deletion triggers re-evaluation con resolver fallback al next-level-up de cascada (ya que la rule overrideante se removió).

---

## 6. UX

### 6.1 Dashboard admin `/admin/jurisdicciones`

```
Jurisdicciones

[Search: ___________ ]

┌────────────────────────────────────────────────────┐
│ AR / Ciudad Autónoma de Buenos Aires               │
│   2 reglas activas · 48 barrios                    │
│   → Ver reglas                                     │
├────────────────────────────────────────────────────┤
│ AR / Buenos Aires                                  │
│   3 reglas activas · 135 partidos                  │
│   → Ver reglas                                     │
├────────────────────────────────────────────────────┤
│ AR / Mendoza                                       │
│   0 reglas activas (usando defaults)               │
│   → Crear primera regla                            │
└────────────────────────────────────────────────────┘
```

Cada row click → `/admin/jurisdicciones/[country]/[province]/[locality]/reglas`.

### 6.2 Detail `/admin/jurisdicciones/[country]/[province]/[locality]/reglas`

```
Reglas para AR / Buenos Aires / La Plata

[+ Crear nueva regla]

Reglas activas en esta jurisdicción:
┌─────────────────────────────────────────────────────┐
│ ppp_breed_list                                       │
│   8 razas configuradas (vs 7 default AR)             │
│   Última actualización: Ana Pérez · 2024-04-12       │
│   [Ver detalle] [Editar] [Eliminar]                  │
├─────────────────────────────────────────────────────┤
│ ppp_weight_threshold                                 │
│   25 kg + applies to non-PPP breeds                  │
│   Última actualización: Ana Pérez · 2024-04-12       │
│   [Ver detalle] [Editar] [Eliminar]                  │
└─────────────────────────────────────────────────────┘

Reglas posibles (no configuradas — usando default):
┌─────────────────────────────────────────────────────┐
│ ppp_attestation_required_registries                  │
│   Default: ningún registro requerido                 │
│   [Configurar]                                       │
└─────────────────────────────────────────────────────┘
```

### 6.3 Form específico por rule_type

**Form `ppp_breed_list`**:

```
Configurar lista PPP para AR / Buenos Aires / La Plata

Razas consideradas Potencialmente Peligrosas:

  Razas conocidas (toggle on/off):
  [x] Akita Inu              (default AR ✓)
  [x] American Pit Bull      (default AR ✓)
  [x] Bullmastiff             (default AR ✓)
  [ ] Boxer                   (default: NO)        ← agregar
  [x] Dóberman                (default AR ✓)
  ...lista completa de razas reconocidas en lib/breeds.ts...

  Razas adicionales (no estándar — texto libre):
  [+ Agregar raza local]

Anclaje legal:
  [x] Ley Prov 14.107
  [ ] Resolución municipal La Plata XXX (texto libre)

Notas internas (visible solo a admin/govt):
[textarea]

[Cancelar] [Guardar regla]

⚠ Si guardás, todas las mascotas registradas en La Plata con
   raza en esta lista serán automáticamente marcadas como PPP
   y sus dueños notificados.
```

**Form `ppp_weight_threshold`**:

```
Configurar threshold de peso PPP para AR / Buenos Aires / La Plata

[ ] Aplicar threshold de peso

Peso mínimo (kg) para considerar PPP por peso solo:
slider 0 ────●──────── 100

[ ] Aplicar threshold incluso a razas NO listadas en ppp_breed_list

(Si checkbox desactivada, threshold solo aplica si la raza YA
 es PPP por la lista — agrega una segunda condición a las razas)

[Cancelar] [Guardar regla]
```

**Form `ppp_attestation_required_registries`**:

```
Registros donde se debe atestar mascota PPP en AR / Buenos Aires / La Plata

[+ Agregar registro]

Registros conocidos (toggle on/off + required):
  [x] Registro Provincial 14.107 — required
  [ ] ANIMALES BA — opcional
  [+ Registro municipal La Plata (texto libre)] — required

(Owner debe registrar atestación en cada registro marcado como
 "required" para que el sistema considere su atestación completa.)

[Cancelar] [Guardar regla]
```

### 6.4 Govt read-only `/gob/reglas`

```
Reglas que aplican a vos · {govt_user.jurisdiction}

ppp_breed_list
  Origen de la regla: AR / Buenos Aires (province-level override)
  8 razas: Akita Inu, American Pit Bull, Bullmastiff, ...

  ℹ La cascada de tu jurisdicción es:
    1. AR / Buenos Aires / La Plata → ninguna regla local
    2. AR / Buenos Aires → 8 razas (esta es la regla activa)
    3. AR (país) → 7 razas (no aplica porque province override existe)

ppp_weight_threshold
  Origen: AR / Buenos Aires (province-level override)
  25 kg + applies to non-PPP breeds

ppp_attestation_required_registries
  Origen: Default (ninguna jurisdicción ha overridado)
  Registries: (none)
```

Sin botones de edit — solo lectura.

### 6.5 Display al owner

Cuando un owner registra una pet (`PetForm`) y la raza matchea la `ppp_breed_list` de su jurisdicción, hoy el sistema setea `potentially_dangerous_breed=true` automáticamente. **Sin cambios** al owner-facing flow — solo el resolver del business rule cambia.

El pet profile v2 §4.7 (PPP card) muestra la atestación pendiente con link al form de atestar. Cuando hay `ppp_attestation_required_registries` configurado, el form de atestación pre-llena los registries requeridos y el ✓ del PPP card pide ALL required filled antes de mostrar atestado completo.

---

## 7. Tests

```ts
// __tests__/business-rules-resolver.test.ts
it('returns default when no override exists');
it('returns locality override when present');
it('returns province override when locality null');
it('returns country override when province null');
it('cascade order: locality > province > country > defaults');

// __tests__/business-rules-validators.test.ts
it('ppp_breed_list valid: breeds array of strings');
it('ppp_breed_list invalid: breeds not array');
it('ppp_weight_threshold valid');
it('ppp_attestation_required_registries valid');

// __tests__/business-rules-actions.test.ts
it('admin can create rule');
it('govt CANNOT create rule (403)');
it('owner CANNOT create rule');
it('duplicate rule (same jurisdiction + rule_type) updates instead of insert');
it('no-op when payload equals default');
it('audit log row created');

// __tests__/ppp-reeval.test.ts
it('changing ppp_breed_list for CABA flips pets.potentially_dangerous_breed for all CABA pets');
it('notification disparada a owners affected');
```

---

## 8. Open questions

- **Backfill** — cuando se introduce este framework, los pets existentes ya están marcados PPP según `lib/breeds.ts`. ¿Hace falta re-eval inicial? Tendencia: NO — DANGEROUS_BREEDS_AR del breeds.ts ES el default actual; los pets ya están bien con esa lista. Solo cuando admin override, re-eval.
- **Effective date** — un govt admin agrega Boxer a PPP "desde mañana". ¿La rule tiene `effective_at`? Defer — v1 es immediate. Si necesidad, agregar campo después.
- **History de rules** — cuando una rule se update, ¿guardamos versions? Audit log captura el cambio, pero query "qué rule estaba activa en fecha X" no es trivial. Defer — audit log cubre 99%.
- **Federation con SENASA / Ministerios provinciales** — futuro: import automático de rules desde fuentes oficiales. Defer.
- **Rule conflicts** — si admin crea override de CABA para `ppp_breed_list` y después agrega override de Palermo, ¿el de Palermo gana (más específico)? Sí — BR4 cascada lo dice. Pero el dashboard debería **visualmente** mostrar que el Palermo override existe, no enterrarlo.
- **JSON editor modo "advanced"** — BR5 lo menciona como escape. ¿Vale la pena en POC? Defer — formas estructurados cubren 95%, JSON editor genera bugs.

---

## 9. Out of scope

- **Rule types fuera de PPP** (vaccination requirements, sterilization mandate, mascot-density-limits-per-residence, etc.) — el framework lo soporta, los rule_types se agregan en specs por cada feature.
- **Public-facing display** de las reglas que aplican a una jurisdicción ("¿qué reglas PPP rigen en tu barrio?") — defer; útil pero no POC-priority.
- **Versioning / rollback** de rules — audit log es suficiente para v1.
- **Notificaciones masivas** a owners cuando una rule cambia con impacto material — BR9 ya cubre el caso individual (notif por pet). Bulk "se actualizó la regulación en tu provincia" notification general → defer.

---

## 10. Implementation outline (para plan ejecutable post-OK)

1. **Fase 1** — Schema (tabla `govt_business_rules` + audit_log actions) + defaults + validators + resolver. ~1-2 días.
2. **Fase 2** — Server actions create/update/delete con audit log. ~1 día.
3. **Fase 3** — Re-evaluation helper para PPP + cron / queue. ~1 día.
4. **Fase 4** — Dashboard admin `/admin/jurisdicciones` + `/admin/jurisdicciones/[country]/[province]/[locality]/reglas`. ~1-2 días.
5. **Fase 5** — Forms específicos por rule_type (3 forms). ~1-2 días.
6. **Fase 6** — Dashboard govt `/gob/reglas` read-only. ~½ día.
7. **Fase 7** — Integration: `lib/breeds.ts isDangerousBreed()` usa el resolver. ~½ día.
8. **Fase 8** — Tests. ~1 día.

Total ~7-9 días. Independiente del sistema de casos.
