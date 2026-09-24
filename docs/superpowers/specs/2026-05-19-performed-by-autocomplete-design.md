# Performed_by autocomplete — vets/clinics linkeados + texto libre — design spec

> Hoy los campos "realizado por" en eventos clínicos (`vet_name`, `clinic`, `administered_by`, `performed_by`) son **texto plano** sin link a entidades reales. El user tipea cualquier cosa y queda como string. Este spec introduce un autocomplete dual: cuando el user empieza a tipear, el system sugiere vets/clínicas verified de su localidad — si elige uno, se guarda **link estructurado** (FK a organization_id / profile_id) + el texto snapshot. Si tipea libre, se guarda solo el texto (igual que hoy). Es el patrón "magnético cuando se puede, manual cuando no" — análogo al pattern de `apply_intent` y de localidades INDEC.
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Estado:** ready for review, no code yet
> **Versión:** 1.0
> **Depende de:** schema existente de organizations + organization_memberships. NO depende del sistema de casos.

---

## 1. Por qué este documento existe

Hoy un evento `vaccination_administered` con payload `{ administered_by: "Dr. Juan Pérez, Veterinaria del Sol" }` guarda info útil para el dueño que pone el nombre, pero el sistema NO sabe que el Dr. Pérez es el mismo Dr. Pérez del evento de la pet vecina, ni que "Veterinaria del Sol" es una org verificada con perfil en MiMAR.

Implicancias:

- **Imposible cross-referencing** — analytics tipo "cuántas vacunas administra el Dr. Pérez por mes" o "qué clínica tiene la mejor cobertura antirrábica en Belgrano" requieren joins que el texto libre no permite.
- **Imposible verification** — un dueño podría escribir "Dr. Inventado, Clínica Fantasma" y el sistema no detecta nada.
- **Pérdida de UX** — el dueño tiene que tipear el mismo nombre 50 veces para 50 visitas; un autocomplete sería más rápido y consistente.
- **Reputation orgs no se construye** — las clínicas verified no acumulan "historial visible" de su actividad. Sin link, su perfil queda vacío.

Pero NO podemos forzar el linking — la realidad operativa es que:

- Vets independientes sin perfil MiMAR existen y registran eventos válidos.
- Un evento histórico ("vacuna del 2018, ya no recuerdo qué vet") debe poder cargarse sin elegir nadie.
- Clinics que cierran o cambian de nombre no deben romper events viejos.

La solución dual (linked OR free text, mismo schema) cubre los dos casos.

---

## 2. Decisiones cerradas

| # | Decisión | Razón |
|---|---|---|
| PB1 | **Schema dual**: cada event con campo "performed by" gana 2 columnas opcionales: `performed_by_organization_id` (FK opcional a `organizations`) + `performed_by_user_id` (FK opcional a `profiles`). El campo **texto existente se mantiene** como snapshot (read on-write, never edited). Permite que cambios de display_name de la org o profile no muten history | Append-only del event log + UX que mantiene el "como te lo dijeron" texto literal en libreta |
| PB2 | **Autocomplete combobox con doble fuente**: (a) `organizations` verified con `org_type IN ('clinic', 'sanitary_authority', 'rescue_network', 'shelter')` y jurisdiction match, (b) `profiles` con `role='vet'` Y `matriculaVerified=true`. Resultados ordenados por relevancia (start-match > contains) Y boosted por jurisdiction match Y por verified-ness | Combina las dos entities que un user podría querer linkar (clínica vs vet individual) en un solo input |
| PB3 | **Si el user elige un option del autocomplete**: persiste `performed_by_organization_id` y/o `performed_by_user_id` populated + el texto snapshot del display_name al momento. Si tipea libre y submite sin elegir: solo texto (los FKs quedan NULL). El form acepta ambos paths transparentemente | Magnetic when possible, free when not |
| PB4 | **NO backfill retroactivo**. Events históricos quedan con texto libre + FKs NULL. Los nuevos eventos pueden ser linkados | Backfill requeriría matching fuzzy de texto histórico → org real, lo cual es error-prone. El cost no justifica el valor |
| PB5 | **6 event types afectados** (los que tienen "by" fields): `vaccination_administered`, `deworming_administered`, `sterilization_performed`, `vet_visit_logged`, `clinical_info_logged`, `microchip_implanted`. Future events que tengan "by" siguen el patrón | Lista cerrada explícita |
| PB6 | **Helper `searchVetsAndClinics(query, jurisdiction)` único**, devuelve resultados unified de orgs + profiles con discriminator. Cliente decide cómo presentar visualmente | Una sola query path = consistencia. Caching futuro centralizado |
| PB7 | **Jurisdiction matching: priority but no filtering**. Vet de tu jurisdicción aparece primero pero vet de otra provincia TAMBIÉN aparece (puede ser real — viajaste a otra provincia por turno). Sin filter rígido | Realismo. Filter rígido por jurisdicción rompería casos legítimos cross-jurisdicción |
| PB8 | **Rate limit del autocomplete** mismo patrón que ya existe (60 req/min en `lib/ar-localidades.ts`) — endpoint server action protegido | Anti-spam, anti-scrape |
| PB9 | **Privacy del vet individual**: solo `display_name` y opcional `matriculaProvincial` (si verified) se exponen al user buscando. NO email, NO phone, NO DNI. Mismo principio que el perfil público de un vet | Privacy del profesional. El user no necesita más para identificarlo en el record |
| PB10 | **Display en la libreta**: si linked → render del display_name + badge "Linkeado a {org_name}" (clickable a profile org) + matriculaVerified check si aplica. Si texto libre → render del texto plano + tooltip "Registrado por dueño, sin verificación profesional" | Visual distinction crystal-clear entre linked vs texto |
| PB11 | **Form UX**: combobox tiene 3 estados visibles: (a) typing — muestra suggestions, (b) selected — chip con display_name + check verde + opción "X" para limpiar, (c) free text mode — input plano sin suggestions, label "Sin sugerencia, guardando como texto libre". User decide en cualquier momento qué path tomar | Claridad sobre qué se está guardando |

---

## 3. Glosario

| Término | Qué es |
|---|---|
| **Linked entry** | Performed_by que se persistió con FK a organization o profile real |
| **Free-text entry** | Performed_by que se persistió solo como string sin FK |
| **Display snapshot** | El texto display_name resuelto al momento del INSERT. Persiste siempre, incluso cuando hay link. Inmutable |
| **Autocomplete suggestions** | Output del helper `searchVetsAndClinics`. Mezcla orgs verified + vets verified con discriminator |
| **Magnetic field** | Pattern UX: el form sugiere matches pero permite escape a manual. Inspirado en apply_intent y LocalityCombobox |

---

## 4. Domain model

### 4.1 Schema delta — agregar 2 columnas opcionales a 6 event types

Estas columnas viven en `pet_events.payload` (jsonb), no en columnas SQL — coherente con el rest of payload structure. Lo que cambia es el **Zod schema** que valida.

```ts
// lib/event-schemas.ts — para CADA uno de los 6 schemas:

// Antes (e.g., vaccinationAdministered):
const vaccinationAdministered = z.object(withVersion({
  vaccine_name: z.string(),
  brand: z.string().nullable(),
  batch: z.string().nullable(),
  administered_by: z.string().nullable(),  // texto libre
  next_due_at: z.string().datetime().nullable(),
})).strict();

// Después:
const vaccinationAdministered = z.object(withVersion({
  vaccine_name: z.string(),
  brand: z.string().nullable(),
  batch: z.string().nullable(),
  administered_by: z.string().nullable(),  // texto snapshot — siempre populated cuando hay valor
  administered_by_organization_id: z.string().uuid().nullable().optional(),
  administered_by_user_id: z.string().uuid().nullable().optional(),
  next_due_at: z.string().datetime().nullable(),
})).strict()
.superRefine((p, ctx) => {
  // Si hay FK populated, el texto snapshot debe estar populated también
  if ((p.administered_by_organization_id || p.administered_by_user_id) && !p.administered_by) {
    ctx.addIssue({ code: 'custom', message: 'administered_by text snapshot required when FK populated' });
  }
});
```

Mismo patrón para los otros 5 event types:

| Event | Existing "by" field | New FK fields |
|---|---|---|
| `vaccination_administered` | `administered_by` | `administered_by_organization_id` + `administered_by_user_id` |
| `deworming_administered` | (no field hoy — agregar `administered_by` opcional al schema) | mismo |
| `sterilization_performed` | `performed_by` + `clinic` | `performed_by_organization_id` (cubre ambos casos vet o clínica) + `performed_by_user_id` |
| `vet_visit_logged` | `vet_name` + `clinic` | `attended_by_organization_id` + `attended_by_user_id` |
| `clinical_info_logged` | `performed_by` | `performed_by_organization_id` + `performed_by_user_id` |
| `microchip_implanted` | `implanted_by` | `implanted_by_organization_id` + `implanted_by_user_id` |

**NO se agregan columnas SQL** — todo vive en payload. La búsqueda inverse "qué events linkearon a esta org/vet" usa Postgres jsonb operators con índices GIN:

```sql
-- Índice para queries "all events done by this org/vet"
create index pet_events_performed_by_org_idx
  on pet_events using gin ((payload -> 'administered_by_organization_id'));
-- etc por field, o un solo GIN sobre payload con expression específica
```

(Decisión de indexing fina al implementar — depende del query workload real.)

### 4.2 Helper `searchVetsAndClinics`

```ts
// lib/performed-by-search.ts (nuevo)

export type PerformedBySuggestion =
  | { kind: 'organization'; id: string; displayName: string; orgType: string; jurisdictionLocality: string | null; verified: boolean }
  | { kind: 'profile'; id: string; displayName: string; matriculaVerified: boolean; matriculaProvincial: string | null };

export async function searchVetsAndClinics(
  query: string,
  jurisdiction?: { province?: string; locality?: string },
  limit = 10,
): Promise<PerformedBySuggestion[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  // Two parallel queries: organizations + profiles
  const [orgs, profilesRes] = await Promise.all([
    db
      .select({
        id: organizations.id,
        displayName: organizations.displayName,
        orgType: organizations.orgType,
        jurisdictionLocality: organizations.jurisdictionLocality,
        jurisdictionProvince: organizations.jurisdictionProvince,
        verified: organizations.verified,
      })
      .from(organizations)
      .where(and(
        eq(organizations.verified, true),
        inArray(organizations.orgType, ['clinic', 'sanitary_authority', 'rescue_network', 'shelter']),
        eq(organizations.status, 'active'),
        ilike(organizations.displayName, `%${q}%`),
      ))
      .limit(limit),
    db
      .select({
        id: profiles.id,
        displayName: profiles.displayName,
        matriculaVerified: profiles.matriculaVerified,
        matriculaProvincial: profiles.matriculaProvincial,
      })
      .from(profiles)
      .where(and(
        eq(profiles.role, 'vet'),
        eq(profiles.matriculaVerified, true),
        ilike(profiles.displayName, `%${q}%`),
      ))
      .limit(limit),
  ]);

  // Merge + rank
  const suggestions: PerformedBySuggestion[] = [
    ...orgs.map((o) => ({
      kind: 'organization' as const,
      id: o.id,
      displayName: o.displayName,
      orgType: o.orgType,
      jurisdictionLocality: o.jurisdictionLocality,
      verified: o.verified,
      _rank: rankScore(o.displayName, q, o.jurisdictionLocality, o.jurisdictionProvince, jurisdiction),
    })),
    ...profilesRes.map((p) => ({
      kind: 'profile' as const,
      id: p.id,
      displayName: p.displayName,
      matriculaVerified: p.matriculaVerified,
      matriculaProvincial: p.matriculaProvincial,
      _rank: rankScore(p.displayName, q, null, null, jurisdiction),  // profiles no tienen jurisdiction direct
    })),
  ]
  .sort((a, b) => b._rank - a._rank)
  .slice(0, limit)
  .map(({ _rank, ...s }) => s);

  return suggestions;
}

function rankScore(displayName: string, q: string, locality: string | null, province: string | null, context?: { province?: string; locality?: string }): number {
  let score = 0;
  // Start match boost
  if (displayName.toLowerCase().startsWith(q.toLowerCase())) score += 100;
  // Jurisdiction match boosts
  if (context?.locality && locality === context.locality) score += 50;
  else if (context?.province && province === context.province) score += 25;
  return score;
}
```

### 4.3 Server action wrapper

```ts
// app/actions/performed-by.ts (nuevo)
'use server';
import { searchVetsAndClinics } from '@/lib/performed-by-search';
import { enforceRateLimit } from '@/lib/rate-limit';

export async function searchVetsAndClinicsAction(query: string, jurisdiction?: { province?: string; locality?: string }): Promise<PerformedBySuggestion[]> {
  const { user } = await requireUserOrRedirect();
  await enforceRateLimit({ key: `performed_by_search:${user.id}`, perMinute: 60 });
  return searchVetsAndClinics(query, jurisdiction);
}
```

---

## 5. UX — Combobox component

### 5.1 `PerformedByCombobox` (nuevo)

Reusable component que reemplaza los inputs de texto plano en los 6 forms.

```tsx
// components/PerformedByCombobox.tsx (nuevo)

interface Props {
  /** Pet jurisdiction (heredada del pet) — para boost de relevancia */
  contextJurisdiction?: { province?: string; locality?: string };
  /** Label del field */
  label: string;
  /** Form field names */
  inputNames: {
    text: string;       // e.g., "administered_by"
    organizationId: string;  // e.g., "administered_by_organization_id"
    userId: string;     // e.g., "administered_by_user_id"
  };
  /** Initial value (cuando editing pre-existing event) */
  initial?: {
    text?: string;
    organizationId?: string | null;
    userId?: string | null;
  };
  /** Filter restrictivo opcional — algunos forms quieren solo vets, otros solo clinics */
  allowedKinds?: ('organization' | 'profile')[];
}

export function PerformedByCombobox({ contextJurisdiction, label, inputNames, initial, allowedKinds }: Props) {
  const [state, setState] = useState<{
    text: string;
    selected: PerformedBySuggestion | null;
    suggestions: PerformedBySuggestion[];
    typing: boolean;
    showFreeTextMode: boolean;
  }>({
    text: initial?.text ?? '',
    selected: null,  // re-resolve from initial.organizationId / userId on mount
    suggestions: [],
    typing: false,
    showFreeTextMode: false,
  });

  // Debounced search
  useDebouncedEffect(() => {
    if (!state.typing || state.text.length < 2) return;
    searchVetsAndClinicsAction(state.text, contextJurisdiction)
      .then((suggestions) => {
        const filtered = allowedKinds ? suggestions.filter((s) => allowedKinds.includes(s.kind)) : suggestions;
        setState((s) => ({ ...s, suggestions: filtered }));
      });
  }, [state.text, state.typing], 250);

  return (
    <div className="space-y-2">
      <label>{label}</label>

      {/* Hidden form fields */}
      <input type="hidden" name={inputNames.text} value={state.selected?.displayName ?? state.text} />
      {state.selected?.kind === 'organization' && (
        <input type="hidden" name={inputNames.organizationId} value={state.selected.id} />
      )}
      {state.selected?.kind === 'profile' && (
        <input type="hidden" name={inputNames.userId} value={state.selected.id} />
      )}

      {state.selected ? (
        // Selected chip
        <div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2">
          <span className="text-sm font-medium">{state.selected.displayName}</span>
          {state.selected.kind === 'organization' && (
            <span className="text-xs text-emerald-700">✓ {orgTypeLabel(state.selected.orgType)} verificado</span>
          )}
          {state.selected.kind === 'profile' && (
            <span className="text-xs text-emerald-700">✓ Vet matriculado</span>
          )}
          <button type="button" onClick={() => setState((s) => ({ ...s, selected: null, text: '', typing: false }))} className="ml-auto text-emerald-700 hover:text-emerald-900">
            ✕ Limpiar
          </button>
        </div>
      ) : (
        // Typing input
        <input
          type="text"
          value={state.text}
          onChange={(e) => setState((s) => ({ ...s, text: e.target.value, typing: true, showFreeTextMode: false }))}
          placeholder="Buscar veterinario o clínica…"
          className="..."
        />
      )}

      {/* Suggestions dropdown */}
      {state.typing && state.suggestions.length > 0 && (
        <ul className="rounded-lg border border-neutral-300 divide-y">
          {state.suggestions.map((s) => (
            <li key={`${s.kind}-${s.id}`}>
              <button
                type="button"
                onClick={() => setState((st) => ({ ...st, selected: s, typing: false }))}
                className="w-full text-left px-3 py-2 hover:bg-neutral-50"
              >
                <div className="font-medium">{s.displayName}</div>
                {s.kind === 'organization' && (
                  <div className="text-xs text-neutral-600">{orgTypeLabel(s.orgType)} · {s.jurisdictionLocality ?? '—'}</div>
                )}
                {s.kind === 'profile' && (
                  <div className="text-xs text-neutral-600">Matrícula {s.matriculaProvincial ?? '—'}</div>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Free text mode toggle */}
      {state.typing && state.text.length >= 2 && state.suggestions.length === 0 && (
        <div className="text-xs text-neutral-600">
          Sin coincidencias. Tu texto se guardará tal cual como referencia libre.
          <button type="button" onClick={() => setState((s) => ({ ...s, showFreeTextMode: true, typing: false }))} className="ml-2 text-blue-600 underline">
            Continuar con texto libre →
          </button>
        </div>
      )}
    </div>
  );
}
```

### 5.2 Integration en cada form

Reemplazar los inputs text plain existentes:

```tsx
// Antes (e.g., en VaccinationForm):
<input name="administered_by" type="text" />

// Después:
<PerformedByCombobox
  contextJurisdiction={{ province: pet.jurisdictionProvince, locality: pet.jurisdictionLocality }}
  label="¿Quién la aplicó?"
  inputNames={{
    text: 'administered_by',
    organizationId: 'administered_by_organization_id',
    userId: 'administered_by_user_id',
  }}
  initial={initial && {
    text: initial.payload?.administered_by,
    organizationId: initial.payload?.administered_by_organization_id,
    userId: initial.payload?.administered_by_user_id,
  }}
/>
```

(6 forms updated — la lista del PB5.)

---

## 6. Display en la libreta

`<EventTimeline>` y `<LibretaSanitariaView>` cuando renderean events con performed_by linked:

```
💉 Vacuna antirrábica
   Administrada por Dr. Juan Pérez ✓ Vet matriculado
   2024-03-15
   Próxima dosis: 2025-03-15
```

```
💉 Vacuna antirrábica
   Administrada por "Vet de la esquina"  ⓘ Sin verificación
   2018-08-22
```

Click en el linked name → preview chip con:
- Para organization: link al perfil público (`/refugios/[orgToken]`)
- Para profile: chip con info pública (display name + verified badge + cantidad agregada de events firmados — sin más PII)

---

## 7. Tests

```ts
// __tests__/performed-by-search.test.ts
it('query corta (< 2 chars) devuelve []');
it('orgs + profiles mezclados en resultados');
it('verified orgs en la misma jurisdicción aparecen primero');
it('vets matriculaVerified=false NO aparecen');
it('orgs unverified NO aparecen');
it('start-match boost funciona');

// __tests__/event-schema-performed-by.test.ts
it('Zod schema permite ambos paths: solo text o text + FK');
it('Zod rechaza FK populated sin text snapshot');
it('Zod rechaza string vacío con FK populated');

// __tests__/performed-by-combobox.test.ts (component, jsdom)
it('typing 2+ chars dispara search');
it('seleccionar suggestion sets hidden inputs');
it('clear suggestion vuelve a input vacío');
it('typing sin matches muestra fallback free-text mode');
```

---

## 8. Open questions

- **Backfill opcional v1.1** — un script "match texts históricos a orgs/vets reales" usando fuzzy match (display_name vs payload.administered_by). El user confirma 1-a-1. Útil pero scope creep para v1.
- **Vet sin matriculaVerified=true** — aparece o no? PB2 dice solo verified. Pero un vet recién registrado puede ser legítimo aunque no verified. Tendencia: NO mostrar — la verification es el gate. Si el dueño quiere registrarlo, fall through a free text.
- **Multi-language search** — query "vete" vs "vet" no debería matter. Tendencia: usar ILIKE simple por ahora; FTS si problemas reales aparecen.
- **Performance del helper si search load crece** — Postgres ILIKE sobre tabla orgs (10k+ rows) puede ser lento. Mitigación: trigram indexing (`gin_trgm_ops`) cuando aparezca latency.
- **Sugerencias de la pet's own custody history** — si esta pet ya tuvo turnos con la Clínica X (visible en libreta), boostear esa clínica al top del autocomplete. Mejora UX significativa. Defer a v1.1.
- **Display vet's matriculaProvincial pública es OK?** — PB9 dice solo `display_name` + `matriculaProvincial`. ¿La matrícula es info pública? Sí — el ejercicio profesional es público y la matrícula identifica formalmente. Confirmar con SME legal antes de release.

---

## 9. Out of scope

- **Editing del linkage post-INSERT** — events son append-only. Si el linkage está mal, se inserta evento corrección (otro `note_added` o similar). NO se UPDATE el event original.
- **Suggestion de vets que YA no son matriculaVerified** (e.g., suspendido por colegio) — defer. v1 simple verified=true / false.
- **Mass-import de vets desde colegios de veterinarios** (CVPBA, etc.) — fuera de scope. Bulk-create de profiles requiere coordinación institucional.
- **Aprobación por parte del vet linkado** — el dueño elige "Dr. Juan Pérez" del autocomplete. ¿El Dr. recibe notif "fuiste linkado a este evento"? Defer — si genera ruido al vet, agregar opt-out.

---

## 10. Implementation outline (para plan ejecutable post-OK)

1. **Fase 1** — Schema delta a los 6 Zod schemas + helper `searchVetsAndClinics` + action wrapper con rate limit. ~1 día.
2. **Fase 2** — Component `PerformedByCombobox` con tests. ~1 día.
3. **Fase 3** — Integration en los 6 forms (vacuna, antiparasitario, esterilización, vet visit, clinical info, microchip). ~1-2 días.
4. **Fase 4** — Display enhancements en `<EventTimeline>` + `<LibretaSanitariaView>` (badge "linkeado" vs "texto libre"). ~1 día.
5. **Fase 5** — Index optimization (GIN sobre payload partial expressions). ~½ día.
6. **Fase 6** — Tests. ~1 día.

Total ~5-6 días. Independiente del sistema de casos — se puede ejecutar en paralelo.
