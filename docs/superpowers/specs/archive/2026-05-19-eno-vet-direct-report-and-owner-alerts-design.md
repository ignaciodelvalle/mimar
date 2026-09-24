> **IMPLEMENTED / shipped** — This spec has been fully implemented. `clinical_info_logged(sub_kind='disease_diagnosis')` is live in `lib/event-schemas.ts`; ENO fanout via `event_notification_outbox` is wired in `src/modules/welfare/` and measured by `fetchEnoSla`. Archived for historical reference only.

# ENO — vet direct report + owner alerts + legal coverage — design spec

> Hoy las ENO (Enfermedades de Notificación Obligatoria) entran a MiMAR vía `symptom_observed` (matcher fuzzy) → `outbreak_signal` (system-emitted al govt). El owner NO ve diagnósticos (D1 del symptom-surveillance spec, privacy-first). Este spec abre dos huecos:
>
> 1. **Vet direct report**: un veterinario con diagnóstico ya confirmado en lab no debería pasar por el matcher. Introducimos `clinical_info_logged(sub_kind='disease_diagnosis')` que bypasea matcher, emite `outbreak_signal` directo con `confirmed_by_lab=true` y severity `critical`.
>
> 2. **Owner-facing alerts para zoonoses peligrosas**: override explícito y limitado del D1 del surveillance spec. Cuando un `symptom_observed` matchea una enfermedad **zoonótica con riesgo público inmediato** (rabia, leptospirosis, etc.), el owner SÍ recibe un warning explicando el riesgo y el siguiente paso clínico. La lista cerrada de qué diseases califican vive en un catálogo nuevo `lib/disease-public-alert-catalog.ts` anclado en la cobertura legal argentina.
>
> Incluye revisión legal completa de las ENO argentinas y mapping a la lista de diseases ya curada en `lib/diseases.ts`.
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Estado:** ready for review, no code yet
> **Versión:** 1.0
> **Depende de:** `2026-05-17-symptom-disease-surveillance-design.md` (implementado) — extiende y refina, no reemplaza. `2026-05-18-bite-rabies-observation-design.md` D5 — precedente del owner-facing override por public health risk.

---

## 1. Por qué este documento existe

Tres problemas concretos del flow actual:

### Hueco 1 — Vet con diagnóstico confirmado

Un veterinario que ya tiene confirmación de lab (e.g., test rápido de leptospirosis positivo, PCR de rabia positivo) **no debería tener que escribir síntomas en texto libre para que el matcher levante el flag**. Es redundante e introduce delay + ruido (matcher es fuzzy, puede mismatch). El profesional debería tener un path directo: "Diagnostiqué X, vino confirmado por lab, acá va el report a la autoridad sanitaria."

Hoy el vet con `professional.provider` granted puede emitir `symptom_observed` con `reporter_role='vet'` y meterle texto libre, pero el flag de "confirmado" no existe — el sistema lo trata como cualquier reporte. Hay info que se pierde.

### Hueco 2 — Owner no se entera de zoonosis críticas

Por el D1 del spec de surveillance ("el dueño no ve diagnósticos"), el sistema es 100% silent con el owner cuando emite `outbreak_signal`. Razón válida para diseases con bajo riesgo público inmediato. Pero para:

- **Rabia** (mortalidad 100% sin profilaxis post-exposición): el owner DEBE consultar APR ya
- **Leptospirosis** (zoonosis bacteriana, contagia humanos por contacto con orina): el owner debe lavarse manos, evitar contacto con orina, ir al médico si presenta síntomas
- **Hidatidosis** (parásito que infecta humanos): protocolos de manejo de heces

…**no avisar al owner es negligencia.** El owner es la persona que comparte casa con el animal, debería saber. El bite-rabies spec D5 ya hizo este override: durante observación rábica activa con symptom escalado, el owner SÍ recibe alerta urgent. Generalicemos.

### Hueco 3 — Catálogo legal no anclado por disease

`lib/diseases.ts` tiene flag `reportable: bool` pero NO referencia a qué norma específica obliga a reportar cada disease. AGENTS.md y `docs/legal-framework-full.md` tienen el material; falta el bridge accessible desde código.

---

## 2. Decisiones cerradas

| # | Decisión | Razón |
|---|---|---|
| EN1 | **Vet direct report vive como `clinical_info_logged(sub_kind='disease_diagnosis')`**. NO event_type nuevo. Mismo patrón que pregnancy del spec hermano | Coherencia con catalog cleanup. Mantiene el umbrella `clinical_info_logged` como concentrador de events clínicos no-rutina (lab/imaging/surgery/allergy/pregnancy/disease) |
| EN2 | **Direct report requiere capability `vet.clinical_write`** ya existente en el sistema, otorgada por `professional.provider` granted. Owner no puede emitir `disease_diagnosis` — sigue limitado al `symptom_observed` path actual | Diagnóstico es acto profesional. El owner sigue describiendo síntomas; el sistema o el vet diagnostican |
| EN3 | **Direct report bypassa matcher** y emite `outbreak_signal` directo. Severity: si `confirmed_by_lab=true` → `'critical'`, sino → `'high'`. (El severity normal del matcher era `'low'`/`'medium'`/`'high'` según match_strength.) | Confirmación profesional > inferencia algorítmica. El severity max comunica "esto no es una posibilidad, es un hecho confirmado" |
| EN4 | **Owner-facing alert se dispara cuando se cumplen TODAS estas condiciones**: (a) el event es `outbreak_signal`, (b) el `disease_code` tiene `public_health_alert: true` en el catálogo nuevo `disease-public-alert-catalog.ts`, (c) el severity del signal es `'high'` o `'critical'`. La alerta es notification al owner con copy curada por disease (no genérica) | Subset estrecho del override D1. Solo zoonoses con riesgo público inmediato. Curado por SME (lista cerrada, no automática) |
| EN5 | **Catálogo legal** vive en `lib/disease-legal-anchors.ts` (lookup `disease_code → LegalReference[]`). Renderizable en el UI del case detail / del outbreak signal detail | Documentation as code. Permite que cada notificación al govt incluya "Por qué te llega esto: Ley X, Res. Y" |
| EN6 | **Catálogo public alert** vive en archivo separado `lib/disease-public-alert-catalog.ts`. Subset cerrado de DISEASES que tienen `public_health_alert: true`. NO se mezcla con `diseases.ts` para mantener la separación: `diseases.ts` es referencia clínica (qué existe), `public-alert-catalog.ts` es decisión de producto (a quién avisamos cuando aparece) | Separación clean — facilita audit + revisión por SME |
| EN7 | **Copy del owner-facing alert es específica por disease**, NO genérica. Cada entry del `disease-public-alert-catalog.ts` declara: title, body curado, severity (en términos owner-facing: 'info' / 'warning' / 'urgent'), CTA label, CTA URL (link a info pública del Ministerio de Salud cuando aplica) | "Tu mascota tiene rabia confirmada" requiere copy distinta de "Tu mascota podría tener leptospirosis". No es one-size-fits-all |
| EN8 | **Cualquier reporte de síntoma peligroso (owner o vet) levanta alertas** (reqto del usuario). Esto significa: el matcher actual (que ya corre sobre `symptom_observed` del owner) chequea `disease-public-alert-catalog.ts` y, si match high-severity, emite notification al owner — incluso si vino de owner. La existing privacy D1 se relaja específicamente para esta lista cerrada | Riesgo público > privacy del diagnóstico. La lista cerrada limita el blast radius |
| EN9 | **NO se almacena PII del lab que confirmó** ni resultados raw del análisis. Solo `confirmed_by_lab: bool` + `lab_name: string opcional` + `lab_report_reference: string opcional` (número de orden / código). El detalle clínico vive en archivos del vet, no en MiMAR | Mismo principio que disposition_method.facility — capturar el suficiente, no más |
| EN10 | **El `outbreak_signal` emitido por direct report del vet tiene un payload field nuevo `triggered_by: 'matcher' \| 'direct_diagnosis'`** para distinguir trazabilidad. Audit del govt puede filtrar "todos los direct_diagnosis del último mes en mi jurisdicción" | Trazabilidad. El govt necesita saber el grado de certeza del signal |

---

## 3. Glosario

| Término | Qué es |
|---|---|
| **ENO** | Enfermedad de Notificación Obligatoria. Cualquier disease con `reportable=true` en `lib/diseases.ts` |
| **Public-alert disease** | Subset de ENO con `public_health_alert=true` en `lib/disease-public-alert-catalog.ts`. Solo estas disparan owner-facing notification |
| **Direct report** | `clinical_info_logged(sub_kind='disease_diagnosis')` emitido por vet con capability `vet.clinical_write` |
| **Matcher** | El symptom-disease matcher fuzzy ya implementado en `lib/symptom-matcher.ts`. Sigue funcionando idéntico — solo el `outbreak_signal` que emite ahora puede gatillar owner alert si la disease califica |
| **Direct → outbreak** | Emisión inmediata de `outbreak_signal` desde un `disease_diagnosis` sin pasar por matcher. `triggered_by='direct_diagnosis'` |
| **Owner alert** | Notification con severity escalado, copy específica por disease, CTA a info pública. Inserta una row en `notifications` con `related_pet_id`, `related_event_id`, y `severity` mapeado |

---

## 4. Catálogo legal — `lib/disease-legal-anchors.ts`

Nuevo archivo. Mapping `disease_code → LegalReference[]`. Cobertura inicial de las disease entries actuales de `lib/diseases.ts` que tienen `reportable=true`:

```ts
// lib/disease-legal-anchors.ts
export interface LegalReference {
  id: string;            // slug estable
  label: string;         // display "Ley 15.465 / 1960"
  scope: string;         // qué obliga
  jurisdiction: 'national' | 'province' | 'locality';
  appliesTo?: { country?: string; province?: string; locality?: string };
  fullTextUrl?: string;
}

export const DISEASE_LEGAL_ANCHORS: Record<string, LegalReference[]> = {
  rabies_confirmed: [
    {
      id: 'ley_15465_60',
      label: 'Ley 15.465 / 1960',
      scope: 'Régimen legal de ENO; rabia incluida',
      jurisdiction: 'national',
      fullTextUrl: 'https://www.argentina.gob.ar/normativa/nacional/ley-15465-195093/texto',
    },
    {
      id: 'res_ms_1144_2018',
      label: 'Res. MS 1144 / 2018',
      scope: 'Guía de Prevención, Vigilancia y Control de la Rabia',
      jurisdiction: 'national',
      fullTextUrl: 'https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-1144-2018-311546/texto',
    },
    {
      id: 'dl_8056_73_pba',
      label: 'DL 8056 / 1973 (PBA)',
      scope: 'Profilaxis rabia en PBA — notificación obligatoria',
      jurisdiction: 'province',
      appliesTo: { province: 'Buenos Aires' },
    },
    {
      id: 'ord_caba_41831_87',
      label: 'Ord. CABA 41.831 / 1987',
      scope: 'Análogo CABA para profilaxis rabia',
      jurisdiction: 'province',
      appliesTo: { province: 'Ciudad Autónoma de Buenos Aires' },
    },
  ],
  rabies_suspected: [/* mismo set que rabies_confirmed */],
  leptospirosis: [
    { id: 'ley_15465_60', /* ... */ },
    { id: 'res_ms_1715_2007', label: 'Res. MS 1715 / 2007', scope: 'Vigilancia ENO — leptospirosis incluida', jurisdiction: 'national' },
    { id: 'res_cvpba_05_2020', label: 'Res. CVPBA 05/2020', scope: 'ENO pequeños animales PBA — leptospirosis', jurisdiction: 'province', appliesTo: { province: 'Buenos Aires' } },
    { id: 'ley_5325_48_pba', label: 'Ley 5325 / 1948 (PBA)', scope: 'Denuncia enfermedades transmisibles <24hs', jurisdiction: 'province', appliesTo: { province: 'Buenos Aires' } },
  ],
  canine_brucellosis: [
    { id: 'res_cvpba_05_2020', /* ... */ },
    { id: 'ley_6115_59_pba', label: 'Ley 6115 / 1959 (PBA)', scope: 'Profilaxis obligatoria brucelosis', jurisdiction: 'province', appliesTo: { province: 'Buenos Aires' } },
  ],
  visceral_leishmaniasis: [
    { id: 'res_ms_1811_2011', label: 'Res. MS 1811 / 2011', scope: 'Programa Nacional de Control de Enfermedades Zoonóticas', jurisdiction: 'national' },
    { id: 'res_cvpba_05_2020', /* ... */ },
  ],
  hydatidosis: [
    { id: 'res_ms_1811_2011', /* ... */ },
    { id: 'res_ms_546_85', label: 'Res. MS 546 / 1985', scope: 'Manual de procedimientos de control de hidatidosis', jurisdiction: 'national' },
    { id: 'ley_6115_59_pba', /* ... */ },
  ],
  tuberculosis: [
    { id: 'ley_15465_60', /* ... */ },
    { id: 'ley_6115_59_pba', /* ... */ },
  ],
  anthrax: [
    { id: 'ley_15465_60', /* ... */ },
  ],
  toxoplasmosis: [
    { id: 'ley_15465_60', /* ... */ },
  ],
  // ... continuar con cualquier nueva disease que se agregue a diseases.ts
};

export function getLegalAnchorsForDisease(
  diseaseCode: string,
  jurisdiction: { country?: string; province?: string; locality?: string }
): LegalReference[] {
  const all = DISEASE_LEGAL_ANCHORS[diseaseCode] ?? [];
  // Filtrar por jurisdiction (national siempre aplica; province solo si match)
  return all.filter(ref => {
    if (ref.jurisdiction === 'national') return true;
    if (!ref.appliesTo) return false;
    if (ref.appliesTo.province && ref.appliesTo.province !== jurisdiction.province) return false;
    if (ref.appliesTo.locality && ref.appliesTo.locality !== jurisdiction.locality) return false;
    return true;
  });
}
```

**Test de cobertura** (`__tests__/disease-legal-anchors.test.ts`):

```ts
it('every reportable disease has at least one legal anchor', () => {
  for (const disease of DISEASES.filter(d => d.reportable)) {
    expect(DISEASE_LEGAL_ANCHORS[disease.code]).toBeDefined();
    expect(DISEASE_LEGAL_ANCHORS[disease.code].length).toBeGreaterThan(0);
  }
});
```

---

## 5. Catálogo public alert — `lib/disease-public-alert-catalog.ts`

Subset cerrado de las ENO con `public_health_alert: true`. Lista inicial (basada en evaluación de riesgo público inmediato — el SME / vet asesor debe firmar antes de implementación):

```ts
// lib/disease-public-alert-catalog.ts
export interface PublicHealthAlert {
  diseaseCode: string;       // FK al DISEASES.code
  ownerNotificationTitle: string;
  ownerNotificationBody: string;
  ownerNotificationSeverity: 'info' | 'warning' | 'urgent';
  ctaLabel: string;
  ctaUrl: string;            // link a info pública (MinSal, OMS, etc.)
  rationale: string;         // por qué amerita owner alert (para audit interno)
}

export const PUBLIC_ALERT_DISEASES: PublicHealthAlert[] = [
  {
    diseaseCode: 'rabies_confirmed',
    ownerNotificationTitle: 'URGENTE — Caso confirmado de rabia en tu mascota',
    ownerNotificationBody: 'Se confirmó un caso de rabia en {pet_name}. La rabia es 100% mortal sin profilaxis post-exposición humana (APR). Si tuviste contacto con saliva del animal, mordedura, o exposición de mucosas, consultá INMEDIATAMENTE al centro APR más cercano (Instituto Pasteur CABA: 011-4953-2826). No esperes síntomas.',
    ownerNotificationSeverity: 'urgent',
    ctaLabel: 'Información oficial Min. Salud',
    ctaUrl: 'https://www.argentina.gob.ar/salud/glosario/rabia',
    rationale: 'Rabia: mortalidad 100% sin APR. Owner es la primera persona en riesgo. Silence sería negligencia.',
  },
  {
    diseaseCode: 'rabies_suspected',
    ownerNotificationTitle: 'Atención — Sospecha de rabia en tu mascota',
    ownerNotificationBody: 'Síntomas compatibles con rabia detectados en {pet_name}. La rabia es 100% mortal sin profilaxis post-exposición. Mientras se confirma el diagnóstico, mantené distancia, evitá contacto con saliva, y consultá a tu veterinario y al centro APR si hubo exposición.',
    ownerNotificationSeverity: 'urgent',
    ctaLabel: 'Información oficial Min. Salud',
    ctaUrl: 'https://www.argentina.gob.ar/salud/glosario/rabia',
    rationale: 'Sospecha de rabia: mismo riesgo público que confirmación mientras la confirmación llega. APR pre-emptive es protocolo standard.',
  },
  {
    diseaseCode: 'leptospirosis',
    ownerNotificationTitle: 'Posible leptospirosis en tu mascota — precauciones',
    ownerNotificationBody: 'Síntomas / diagnóstico compatible con leptospirosis en {pet_name}. Es una bacteria que infecta humanos por contacto con orina infectada. Lavate las manos siempre después de tocar a tu mascota, usá guantes si limpiás su orina/heces, y consultá a tu médico si presentás fiebre, dolor muscular, o ictericia.',
    ownerNotificationSeverity: 'warning',
    ctaLabel: 'Sobre leptospirosis',
    ctaUrl: 'https://www.argentina.gob.ar/salud/glosario/leptospirosis',
    rationale: 'Zoonosis bacteriana con riesgo de transmisión directa por contacto con orina. Protocolo de manejo es preventible si owner sabe.',
  },
  {
    diseaseCode: 'hydatidosis',
    ownerNotificationTitle: 'Hidatidosis detectada en tu mascota',
    ownerNotificationBody: 'Tu mascota podría estar infectada con hidatidosis (parásito Echinococcus). Es una zoonosis grave en humanos. Manejá las heces con cuidado (bolsa cerrada), lavate las manos con jabón después de tocarla, y consultá a tu médico para evaluación. El tratamiento del animal es indicado por tu veterinario.',
    ownerNotificationSeverity: 'warning',
    ctaLabel: 'Sobre hidatidosis',
    ctaUrl: 'https://www.argentina.gob.ar/salud/glosario/hidatidosis',
    rationale: 'Echinococcosis transmite huevos por heces. Riesgo de contagio doméstico es real si owner no sabe.',
  },
  {
    diseaseCode: 'visceral_leishmaniasis',
    ownerNotificationTitle: 'Leishmaniasis visceral detectada en tu mascota',
    ownerNotificationBody: '{pet_name} fue diagnosticado con leishmaniasis visceral. Es una zoonosis transmitida por mosquito flebótomo (vector). Reducí poblaciones de mosquitos en tu domicilio (eliminar agua estancada), protegé a tu mascota con repelentes recomendados por el vet, y consultá a tu médico ante síntomas como fiebre prolongada, pérdida de peso, esplenomegalia.',
    ownerNotificationSeverity: 'warning',
    ctaLabel: 'Sobre leishmaniasis',
    ctaUrl: 'https://www.argentina.gob.ar/salud/glosario/leishmaniasis',
    rationale: 'Vector-borne pero el manejo doméstico reduce riesgo. Owner es crítico en este caso.',
  },
  {
    diseaseCode: 'anthrax',
    ownerNotificationTitle: 'URGENTE — Caso de carbunclo (ántrax)',
    ownerNotificationBody: 'Se detectó carbunclo en {pet_name}. Es una zoonosis bacteriana grave. NO toques al animal sin EPP, mantené distancia, llamá a tu veterinario y al servicio de zoonosis local INMEDIATAMENTE. Las esporas pueden contaminar el entorno.',
    ownerNotificationSeverity: 'urgent',
    ctaLabel: 'Información oficial',
    ctaUrl: 'https://www.argentina.gob.ar/salud/glosario/carbunclo',
    rationale: 'Carbunclo: riesgo crítico para humanos, requiere manejo profesional inmediato.',
  },
  {
    diseaseCode: 'tuberculosis',
    ownerNotificationTitle: 'Posible tuberculosis en tu mascota',
    ownerNotificationBody: 'Síntomas / diagnóstico compatible con tuberculosis en {pet_name}. Es una zoonosis transmitida por contacto cercano y vía respiratoria. Consultá a tu médico para evaluación, especialmente si convivís con personas inmunocomprometidas o niños pequeños.',
    ownerNotificationSeverity: 'warning',
    ctaLabel: 'Sobre tuberculosis zoonótica',
    ctaUrl: 'https://www.argentina.gob.ar/salud/glosario/tuberculosis',
    rationale: 'Cross-species TB cases ocurren. Owner debe saber para evaluación clínica humana.',
  },
];

export function getPublicAlertForDisease(diseaseCode: string): PublicHealthAlert | null {
  return PUBLIC_ALERT_DISEASES.find(a => a.diseaseCode === diseaseCode) ?? null;
}
```

**Diseases que NO disparan owner alert (intencional)**:

- `canine_brucellosis` — reportable a govt (Res. CVPBA 05/2020) pero transmisión a humanos baja en condiciones de tenencia normales. Notificar al owner crearía pánico innecesario. (SME puede sobrescribir.)
- `toxoplasmosis` — reportable pero transmisión humana ya es de conocimiento general (lineamientos a mujeres embarazadas, etc.). Notificación específica al owner agrega poco.
- `parvovirus`, `distemper`, `feline_leukemia`, etc. — NO zoonosis, solo riesgo animal-a-animal. Mantenemos D1 — owner ve el tratamiento prescrito por el vet, no el diagnóstico cargado.

**Curation**: la lista debe ser **revisada por SME veterinario + epidemiólogo** antes de release. Acá hay un proxy razonable; no es la decisión final.

---

## 6. Domain model

### 6.1 Sin cambios al `EVENT_TYPES`

`clinical_info_logged` ya existe. `outbreak_signal` ya existe.

### 6.2 Extensión al Zod schema de `clinical_info_logged`

```ts
// lib/event-schemas.ts
sub_kind: z.enum([
  'lab_work', 'imaging', 'surgery', 'allergy_detection',
  'pregnancy',           // pregnancy spec
  'disease_diagnosis',   // ← nuevo (este spec)
  'other',
]),

// Pregnancy fields (del pregnancy spec) +
// Nuevos fields para disease_diagnosis:
disease_code: z.string().nullable().optional(),            // FK lógico a DISEASES.code
confirmed_by_lab: z.boolean().nullable().optional(),
lab_name: z.string().nullable().optional(),
lab_report_reference: z.string().nullable().optional(),
diagnosis_date: z.string().datetime().nullable().optional(),
```

Refinement:

```ts
.superRefine((payload, ctx) => {
  if (payload.sub_kind !== 'disease_diagnosis') return;

  if (!payload.disease_code) {
    ctx.addIssue({ code: 'custom', message: 'disease_code required for disease_diagnosis' });
  }

  // disease_code debe existir en lib/diseases.ts catalog
  const diseaseExists = DISEASES.some(d => d.code === payload.disease_code);
  if (!diseaseExists) {
    ctx.addIssue({ code: 'custom', message: `disease_code "${payload.disease_code}" not in catalog` });
  }
});
```

### 6.3 Extensión al Zod schema de `outbreak_signal`

```ts
// Agregar al payload de outbreak_signal:
triggered_by: z.enum(['matcher', 'direct_diagnosis']),
confirmed_by_lab: z.boolean().default(false),
source_disease_diagnosis_event_id: z.string().uuid().nullable().optional(),  // FK al evento que lo originó (cuando triggered_by='direct_diagnosis')
```

### 6.4 Capability gate — `vet.clinical_write`

Verificar en `lib/capabilities.ts` si ya existe — si no, crearla. Granted automáticamente al vet con `professional.provider` granted (mismo patrón que `bite.report` del bite-rabies spec). Owner NO puede emitir `disease_diagnosis`.

---

## 7. Server actions

### 7.1 `recordDiseaseDiagnosisAction` (nueva)

```ts
// app/actions/events.ts (extender)
export async function recordDiseaseDiagnosisAction(
  publicToken: string,
  formData: FormData,
): Promise<EventFormState> {
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return { error: access.error };

  const caps = await getGrantedCapabilities(access.user.id);
  if (!caps.includes('vet.clinical_write')) {
    return { error: 'Solo veterinarios con habilitación profesional pueden registrar diagnósticos.' };
  }

  const diseaseCode = String(formData.get('disease_code') ?? '').trim();
  const confirmedByLab = formData.get('confirmed_by_lab') === 'true';
  // ... extraer fields

  // Validar disease existe en catalog
  if (!DISEASES.some(d => d.code === diseaseCode)) return { error: 'Disease no reconocida.' };

  await db.transaction(async (tx) => {
    // 1. INSERT clinical_info_logged
    const [diagnosisEvent] = await tx.insert(petEvents).values({
      petId: access.pet.id,
      eventType: 'clinical_info_logged',
      payload: {
        sub_kind: 'disease_diagnosis',
        disease_code: diseaseCode,
        confirmed_by_lab: confirmedByLab,
        lab_name: labName,
        lab_report_reference: labRef,
        diagnosis_date: diagnosisDate,
        title: `Diagnóstico: ${DISEASES.find(d => d.code === diseaseCode)?.label ?? diseaseCode}`,
        performed_by: access.user.id,  // o el FK pattern del performed_by autocomplete spec
      },
      occurredAt: diagnosisDate,
      recordedByUserId: access.user.id,
      ...access.eventAuthorship,
    }).returning();

    // 2. Si la disease es reportable, emit outbreak_signal directo
    const disease = DISEASES.find(d => d.code === diseaseCode);
    if (disease?.reportable) {
      const [signalEvent] = await tx.insert(petEvents).values({
        petId: access.pet.id,
        eventType: 'outbreak_signal',
        payload: {
          source_symptom_event_id: null,  // no viene de symptom_observed
          source_disease_diagnosis_event_id: diagnosisEvent.id,
          disease_code: diseaseCode,
          disease_label: disease.label,
          triggered_by: 'direct_diagnosis',
          confirmed_by_lab: confirmedByLab,
          severity: confirmedByLab ? 'critical' : 'high',
          pet_jurisdiction_country: access.pet.jurisdictionCountry,
          pet_jurisdiction_province: access.pet.jurisdictionProvince,
          pet_jurisdiction_locality: access.pet.jurisdictionLocality,
          pet_species: access.pet.species,
          match_strength: null,  // no aplica para direct
        },
        ...access.eventAuthorship,
      }).returning();

      // 3. Notify govt + admin scope-matching (reusa lib actual)
      await routeOutbreakSignalNotification(signalEvent.id, /* jurisdiction */);

      // 4. Si la disease está en public-alert-catalog, notif al owner
      await maybeNotifyOwnerOfPublicAlert(tx, diseaseCode, access.pet, signalEvent.id);
    }
  });

  redirect(`/mis-mascotas/${publicToken}`);
}
```

### 7.2 `maybeNotifyOwnerOfPublicAlert` (nuevo helper)

```ts
// lib/owner-disease-alerts.ts (nuevo)
import { getPublicAlertForDisease } from './disease-public-alert-catalog';

export async function maybeNotifyOwnerOfPublicAlert(
  tx: DBTx,
  diseaseCode: string,
  pet: Pet,
  triggerEventId: string,
) {
  const alert = getPublicAlertForDisease(diseaseCode);
  if (!alert) return;

  // Resolver owners actuales (incluye co_owners)
  const owners = await tx
    .select({ userId: ownerships.ownerUserId })
    .from(ownerships)
    .where(and(
      eq(ownerships.petId, pet.id),
      inArray(ownerships.role, ['owner', 'co_owner']),
      isNull(ownerships.endedAt),
    ));

  for (const o of owners) {
    if (!o.userId) continue;  // org-held owners skip — no human user para notificar directo
    await tx.insert(notifications).values({
      userId: o.userId,
      notificationType: 'disease_public_alert',
      title: alert.ownerNotificationTitle.replace('{pet_name}', pet.name),
      body: alert.ownerNotificationBody.replace(/{pet_name}/g, pet.name),
      severity: alert.ownerNotificationSeverity,
      ctaLabel: alert.ctaLabel,
      ctaUrl: alert.ctaUrl,
      relatedPetId: pet.id,
      relatedEventId: triggerEventId,
    });
  }
}
```

### 7.3 Extender `createSymptomObservedAction` (existente)

El flow actual ya emite `outbreak_signal` cuando matcher hace match. Ahora, después de emitir el signal, llamar a `maybeNotifyOwnerOfPublicAlert` para cada matched disease en `alerted_disease_codes` que califique. (Antes de este spec, esa llamada no existía — el owner nunca veía nada.)

```ts
// app/actions/events.ts createSymptomObservedAction (post outbreak_signal emission)
for (const diseaseCode of alertedDiseaseCodes) {
  // Solo enviar owner alert si la severity del signal califica
  if (['high', 'critical'].includes(signalSeverity)) {
    await maybeNotifyOwnerOfPublicAlert(tx, diseaseCode, pet, signalEvent.id);
  }
}
```

---

## 8. UX — vet direct report form

### 8.1 Entry points

- **`/anotar`**: capture rápida con patterns como "diagnosticé X", "confirmado en lab", "le dio positivo a [disease]" → matchea entry nuevo del registry y redirige a form pre-filled.
- **`/eventos/nuevo/clinico`**: form genérico ya existente; sub_kind picker ahora incluye "Diagnóstico clínico" cuando el user tiene `vet.clinical_write`. Selecciona → form expande con disease picker + confirmed_by_lab toggle.
- **`/org/[orgToken]/mascotas/[petToken]`**: action "Registrar diagnóstico" disponible para org members con la capability.

### 8.2 Form fields

```
Registrar diagnóstico clínico · {pet.name}

[Enfermedad diagnosticada]
  combobox sobre DISEASES (filtrado por pet.species)
  resultados muestran ENO badge cuando reportable=true
  + entry "Otra (texto libre)" → opens free text field, no emite outbreak_signal

[Fecha del diagnóstico] datepicker (default: today)

[Confirmado por lab?] toggle
  Si sí → mostrar:
    [Nombre del laboratorio] text opcional
    [Referencia / nº de orden] text opcional

[Notas clínicas] textarea opcional

⚠ Esta acción notifica automáticamente a la autoridad sanitaria scope.
   {if disease en public-alert-catalog:}
   ⚠ ESTE diagnóstico también notificará al dueño con copy específica
     sobre el riesgo público asociado a {disease.label}.

[Registrar diagnóstico]
```

### 8.3 UX para el owner que recibe alert

Notification aparece en `/notificaciones` con copy específica + CTA. El detail del notification puede llevar al pet profile, NO al case detail interno (el owner sigue sin ver el outbreak_signal raw en la libreta — eso es govt-scope). Lo que SÍ ve el owner: una sección nueva en su pet profile v2 (cuando esté implementado) "⚠ Alertas de salud pública activas" — chip warning con info del disease + CTA al disease info pública.

---

## 9. Tests

```ts
// __tests__/disease-diagnosis-flow.test.ts
it('owner sin capability NO puede emitir disease_diagnosis');
it('vet con capability emite disease_diagnosis sin matcher');
it('disease_diagnosis con reportable=true emite outbreak_signal con triggered_by=direct_diagnosis');
it('disease_diagnosis con confirmed_by_lab=true → outbreak_signal severity=critical');
it('disease_diagnosis sin confirmed_by_lab → outbreak_signal severity=high');
it('disease_diagnosis NO reportable (e.g., otitis externa) → NO outbreak_signal');

// __tests__/owner-public-alerts.test.ts
it('symptom_observed que matchea rabia high-spec → owner recibe notification urgent');
it('symptom_observed que matchea canine_brucellosis → owner NO recibe notification (no en public-alert catalog)');
it('disease_diagnosis confirmado de leptospirosis → owner recibe notification warning con copy específica');
it('disease_diagnosis confirmado de toxoplasmosis → owner NO recibe notification');
it('disease_diagnosis sobre pet held by org-only → no owner notification (no hay user)');

// __tests__/disease-legal-anchors.test.ts
it('every reportable disease has at least one legal anchor');
it('rabies_confirmed in CABA returns Ord. 41.831');
it('leptospirosis in Mendoza returns only national-jurisdiction anchors');
```

---

## 10. Open questions

- **SME sign-off del public-alert catalog**: la lista del §5 es proxy razonable, **NO definitiva**. Antes de release, validar con un vet + epidemiólogo argentino. Sumar/quitar diseases según consenso técnico.
- **Multi-language alert copy**: el catálogo asume es-AR. Cuando MiMAR i18n, mover a estructura per-locale. Defer.
- **Owner pet org-held**: si la pet está custodia de una org (sin owner user), el alert va a... ¿coordinadores de la org? Tendencia: SÍ — notification a todos los `organization_memberships` con role coordinator/admin de la org. Defer al spec org-side cuando se priorice.
- **Re-trigger de alert**: si el mismo disease se diagnostica 2 veces seguidas (e.g., follow-up tests), ¿el owner recibe la alert 2 veces? Tendencia: throttle — 1 alert per disease per pet per 30 días.
- **Owner sees signal in pet profile**: el owner ve la alert en notifications, pero ¿debería ver el `outbreak_signal` en la libreta? D1 del surveillance spec dice no. Mantener — el outbreak_signal sigue siendo govt-scope. Lo que el owner ve es la **notification + sección destacada del profile v2**, no el evento crudo.
- **CTAs externas linkadas**: las URLs a Min. Salud / OMS pueden cambiar. ¿Periodic check? Defer — los links están en el código, fáciles de actualizar en PR.
- **Performance del owner-alert hook**: agregar lookups por cada `outbreak_signal` añade latencia. La lista cerrada del catalog hace que el lookup sea O(N small) — aceptable. Si crece, mover a Map indexed.

---

## 11. Out of scope

- **SNVS integration real** (push del signal a Sistema Nacional de Vigilancia Salud) — fuera de scope. El signal queda en MiMAR; el govt puede exportar manualmente cuando integration externa exista.
- **Auto-reporting a SENASA por species ganaderas** — MiMAR es pet-focused; no maneja ganadería.
- **Quarantine workflow para enfermedades muy contagiosas** — defer. Hoy el sistema solo loguea + alerta; no implementa flujos de cuarentena obligatoria (que serían case_kind `quarantine_episode` futuro).
- **Owner-side disease history visible** — sigue silent (no diagnóstico cargado en la libreta del owner). Solo las public-alerts disparan owner-facing copy específica. La libreta del owner sigue mostrando `symptom_observed` (texto libre que el owner escribió) y `vaccination_administered`, sin diagnósticos cargados.

---

## 12. Implementation outline (para plan ejecutable post-OK)

1. **Fase 1** — Catálogos: `lib/disease-legal-anchors.ts` + `lib/disease-public-alert-catalog.ts` + tests cobertura. ~1 día.
2. **Fase 2** — Schema extension a `clinical_info_logged` y `outbreak_signal` schemas. Capability `vet.clinical_write` si no existe. ~½ día.
3. **Fase 3** — `recordDiseaseDiagnosisAction` + helper `maybeNotifyOwnerOfPublicAlert`. ~1 día.
4. **Fase 4** — Hook en `createSymptomObservedAction` para dispatch owner alert post-signal. ~½ día.
5. **Fase 5** — Form UI `/eventos/nuevo/clinico` con sub_kind picker + disease combobox + confirmed_by_lab toggle. Capture rápida entries. ~1 día.
6. **Fase 6** — Pet profile v2 sección "Alertas de salud pública activas" (addendum). ~½ día.
7. **Fase 7** — Tests. ~1 día.

Total ~5 días. Plan ejecutable separado cuando se priorice.
