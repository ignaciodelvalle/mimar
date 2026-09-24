# ENO pipeline — Enfermedades de Notificación Obligatoria

> **Estado (2026-06-04):** ✅ IMPLEMENTADO — v1 PR #124 + v2 cola horaria PR #302; correcciones legales PR #385. La superficie /gob/eno dedicada queda diferida a v2 (out-of-scope del spec).

> **Fecha:** 2026-05-21
> **Owner:** Ignacio Del Valle
> **Status:** ✅ Owner decisions locked. Ready for implementation.
> **Origen:** TODO(eno) en `lib/vaccine-reminder-state.ts` + roadmap item #11 en `docs/superpowers/README.md`

---

## Resumen

Cuando un **vet** marca a una mascota con una enfermedad incluida en el catálogo ENO, el sistema **debe** notificar automáticamente a la autoridad sanitaria correspondiente (province + locality) dentro de las ventanas legales. Marco: SENASA + ministerios provinciales bajo Ley 15.465/1960 (Decreto 3640/64) + Res. MS 2827/2022 + Res. SENASA 422/2003.
> **Corrección 2026-06-04:** Ley 27.305 eliminada — esa ley regula la cobertura de leche medicamentosa (PMO), no tiene relación con zoonosis. Decreto 1228/2018 eliminado — no verificado como ancla ENO.

ENO ≠ vacunas obligatorias del carnet sanitario. El TODO(eno) histórico en C1 (`vaccine-reminder-state.ts`) confunde ambos conceptos. Este spec **separa** los dos catálogos y crea la infraestructura para el reporting automático.

---

## Decisiones cerradas (2026-05-21)

| ID | Pregunta | Decisión |
|---|---|---|
| **ENO-D1** | Catálogo v1 | **A — Lista corta core.** 5 enfermedades zoonóticas core + severity tiers critical/high |
| **ENO-D2** | Qué emite el notify | **A — Solo vet.** `clinical_info_logged.sub_kind='disease_diagnosis'` con `disease_code` ∈ catálogo ENO |
| **ENO-D3** | Jurisdiction routing | **A — Province + Locality.** Notify a ambos govts scope-matching |
| **ENO-D4** | Owner alert | **B — Stigma filter.** Owner notified salvo diseases con `stigmaSensitive=true` |
| **ENO-D5** | Privacy del notify a govt | **A — Full PII.** Pet completo + owner displayName/phone/jurisdiction (modelo `welfare_reports`) |

---

## Catálogo (ENO-D1 = A)

`lib/eno-catalog.ts`:

```ts
export type EnoDisease = {
  code: string;           // stable key for indexing
  label: string;          // display name (Spanish)
  severity: "critical" | "high";
  notifyHours: number;    // SLA al govt
  stigmaSensitive: boolean; // ENO-D4 filter
  legalAnchor: string;    // ley citada
};

export const ENO_DISEASES_AR: readonly EnoDisease[] = [
  {
    code: "rabies",
    label: "Rabia",
    severity: "critical",
    notifyHours: 24,
    stigmaSensitive: false,
    legalAnchor: "Ley 22.953 (control rabia)",
  },
  {
    code: "leptospirosis",
    label: "Leptospirosis",
    severity: "high",
    notifyHours: 48,
    stigmaSensitive: false,
    // Ley 27.305 removed — leche medicamentosa/PMO, NOT zoonosis.
    legalAnchor: "Ley 15.465 (ENO nacional) + Decreto 1088/2011 (ProTenencia)",
  },
  {
    code: "hidatidosis",
    label: "Hidatidosis / Equinococosis",
    severity: "high",
    notifyHours: 48,
    stigmaSensitive: false,
    // Ley 27.305 removed — misattributed (see leptospirosis comment above).
    legalAnchor: "Res. SENASA 422/2003 (Anexo II) + Decreto 1088/2011 (ProTenencia)",
  },
  {
    code: "brucelosis_canina",
    label: "Brucelosis canina",
    severity: "high",
    notifyHours: 72,
    stigmaSensitive: true,   // dueño puede sentir estigma social
    // TODO(verify): resolución específica de brucelosis canina (B. canis) no confirmada en
    // digesto SENASA; se usa el marco general 422/2003 (Anexo II) hasta confirmar.
    legalAnchor: "Res. SENASA 422/2003 (Anexo II)",
  },
  {
    code: "leishmaniasis",
    label: "Leishmaniasis visceral canina",
    severity: "critical",
    notifyHours: 48,
    stigmaSensitive: true,   // estigma por riesgo humano + impacto en pet
    // TODO(verify): posible Res. SENASA 315/2017; confirmar en digesto.senasa.gob.ar.
    // Res. SENASA 405/2017 not verified in official SENASA digest — replaced by general 422/2003.
    legalAnchor: "Res. SENASA 422/2003 (Anexo II)",
  },
];
```

---

## Trigger (ENO-D2 = A — solo vet)

Vet con capability `vet.clinical_write` puede emitir:

```ts
pet_events.event_type = "clinical_info_logged"
pet_events.author_role = "vet"
pet_events.payload = {
  sub_kind: "disease_diagnosis",
  disease_code: "rabies",      // debe estar en ENO_DISEASES_AR
  diagnosis_date: "2026-05-21",
  notes: "...",
  // ...
}
```

Cuando ese evento se insertea, el flow de **`processEnoEventTrigger(petEvent)`** (helper invocado desde el server action de creación del clinical_info_logged):

1. Validate: `payload.sub_kind === 'disease_diagnosis'`, `payload.disease_code` ∈ catálogo
2. Resolve disease + jurisdictions
3. Insert notifications al govt scope (ENO-D3)
4. Insert notification al owner si `!disease.stigmaSensitive` (ENO-D4=B)
5. Audit log

Owner-emitted `symptom_observed` con `payload.suspected_disease=X` **no** gatilla el flow v1 — sólo el vet diagnosis es la fuente confiable. v2 podría agregar trigger con flag de confirmación owner.

---

## Jurisdiction routing (ENO-D3 = A — province + locality)

Para cada `disease_diagnosis` event:

```ts
const pet = await getPet(event.petId);
const targets = await db.select()
  .from(govtAssignments)
  .where(
    or(
      // Province-scope authority (autoridad sanitaria provincial)
      and(
        eq(govtAssignments.jurisdictionProvince, pet.jurisdictionProvince),
        // localityScope='any-locality-in-province' o el assignment es province-wide
      ),
      // Locality-scope (DPZ operativo)
      and(
        eq(govtAssignments.jurisdictionProvince, pet.jurisdictionProvince),
        eq(govtAssignments.jurisdictionLocality, pet.jurisdictionLocality),
      ),
    ),
  );
```

Para cada `target.userId`, insert una notification con:
- `kind = "eno_disease_diagnosis"`
- `severity = disease.severity`
- `payload = { disease_code, disease_label, pet_public_token, pet_name, owner_display_name, owner_phone, owner_jurisdiction, vet_user_id, vet_org_id, diagnosis_date }`

(ENO-D5=A → full PII per modelo welfare_reports actual.)

---

## Owner alert (ENO-D4 = B — stigma filter)

Si `!disease.stigmaSensitive`:

```ts
INSERT notification (
  user_id: pet.ownerId,
  kind: "eno_pet_disease_diagnosis",
  severity: disease.severity,
  payload: { disease_label, pet_name, vet_name, next_steps_url }
);
```

Si `disease.stigmaSensitive` (brucelosis, leishmaniasis): **no** se crea owner notification. El vet tiene la responsabilidad clínica de comunicar al owner directamente (el system no lo notifica de forma automática para preservar el contexto sensible de la conversación cara a cara).

Audit_log siempre incluye `owner_was_notified: boolean` para trazabilidad.

---

## Surfaces v1

| Surface | Quién | Qué muestra |
|---|---|---|
| `/notificaciones` owner | owner | Inbox normal — ENO notifications aparecen cuando `!stigmaSensitive` |
| `/notificaciones` govt | govt | Inbox normal — ENO notifications con kind filter |
| **TODO v2:** `/gob/eno` queue dedicada | govt | Queue filtrada por kind=eno_disease_diagnosis + filter province/disease/severity |

v1 reusa el sistema de notifications existente. v2 puede agregar un queue dedicado.

---

## Audit (siempre)

Cada notification trigger crea audit_log entry:

```ts
INSERT audit_log (
  actor_user_id: vet.id,
  actor_organization_id: vet.orgId,
  action: "eno_notification_emitted",
  payload: {
    disease_code,
    disease_severity,
    pet_id,
    targets_count,       // cuántos govt users notified
    owner_was_notified,  // boolean (stigma filter aplicado)
    legal_anchor,        // ley citada del catálogo
  }
);
```

---

## Archivos a crear / modificar

### Create

| Path | Propósito |
|---|---|
| `lib/eno-catalog.ts` | Catálogo ENO_DISEASES_AR readonly + helpers `getEnoDisease(code)`, `isEnoCode(code)` |
| `lib/eno-trigger.ts` | `processEnoEventTrigger(petEvent)` — el flow completo |
| `__tests__/eno-trigger.test.ts` | Integration tests con DB real |

### Modify

| Path | Cambio |
|---|---|
| `db/schema.ts` | Añadir `"eno_notification_emitted"` a `AUDIT_LOG_ACTIONS`. Añadir `"eno_disease_diagnosis"` y `"eno_pet_disease_diagnosis"` a `notificationTypeEnum` si existe; si no, son free-text en `notifications.kind` column |
| `app/actions/events.ts` (o donde se crea clinical_info_logged) | Después del insert del evento, llamar `processEnoEventTrigger(petEvent)` |

### Out of scope (v2)

- `/gob/eno` queue dedicada
- Owner-emitted `symptom_observed` como trigger
- Disease tracking longitudinal (recovery events)
- Brote investigation linkage (`outbreak_investigation` case_kind)

---

## Definition of Done

- [x] `lib/eno-catalog.ts` exportando 5 diseases
- [x] `lib/eno-trigger.ts` con `processEnoEventTrigger` integration-tested
- [x] AUDIT_LOG_ACTIONS contains `eno_notification_emitted`
- [x] Wired desde `app/actions/events.ts` (o equivalente) en el path de `clinical_info_logged`
- [x] `__tests__/eno-trigger.test.ts`: 
  - rabies → notifies all province + locality govts + owner
  - leishmaniasis (stigmaSensitive) → notifies govts but NOT owner
  - non-ENO disease_code → no-op
  - missing govt scope → no-op (no targets to notify)
- [x] `pnpm typecheck` + `pnpm biome check` + `pnpm test` all clean
