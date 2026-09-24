# Hub de credencial física + disponibilidad por jurisdicción — implementation plan

> Plan ejecutable para Claude Code. Capa de orquestación owner-facing del componente físico: botón en el
> perfil → sheet con 3 canales (QR imprimible / chapa grabada / tag NFC), greying por jurisdicción de la
> mascota, control admin vía un `ruleType` nuevo de `govt_business_rules`. Recicla el placeholder §4.20.
>
> **Fecha:** 2026-06-19 · **Owner:** Ignacio Del Valle
> **Spec:** `docs/superpowers/specs/2026-06-19-physical-credential-hub-and-channel-availability-design.md` (gana el spec ante cualquier duda)
> **Tamaño:** ~7 archivos nuevos, ~6 tocados, 1 migración (`physical_tag_interest.channel`), 0 event types, 0 RLS nueva
> **Estimación:** 3–4 días, 6 PRs (Fases A→F)
> **Decisiones cerradas:** D1–D6 del spec §3 + §9 Q1–Q4. **Nada pendiente del dueño.**

## 0. Antes de tocar nada

1. Leé el spec (arriba) entero. Leé también:
   - `specs/2026-05-18-physical-tag-design.md` (Item 5) — la cadena `/t/[serial]` y la open question #2 (DIY QR) que este plan **resuelve** con el canal `printable_qr`. **Este plan NO implementa `pet_tags` ni `/t/[serial]`** — solo hace hand-off a los canales de chapa/NFC.
   - `specs/2026-05-19-govt-business-rules-poc-design.md` (Item 16) — el framework de reglas que reusamos.
   - `AGENTS.md → Privacy tiers` — la credencial física resuelve a Tier 0 estable; no expone más que `/p/[publicToken]`.

2. **Hechos verificados del código (NO re-descubrir):**

   **Business rules (Item 16, ya en código):**
   - Tabla `govtBusinessRules` en `db/schema.ts`. `ruleType` es `text().$type<GovtBusinessRuleType>()` con CHECK `govt_business_rules_rule_type_valid IN ('ppp_breed_list','ppp_weight_threshold','ppp_attestation_required_registries')`. Columnas: `id, jurisdictionCountry (def 'AR'), jurisdictionProvince, jurisdictionLocality, ruleType, rulePayload (jsonb), notes, legalAnchorIds (text[]), createdAt, createdByUserId, updatedAt, updatedByUserId`.
   - `@/db` exporta `GOVT_BUSINESS_RULE_TYPES` (readonly array) y el type `GovtBusinessRuleType`. **Acá se agrega `'physical_credential_channels'`.**
   - `lib/business-rules-defaults.ts`: `BUSINESS_RULES_DEFAULTS` (objeto keyed por ruleType) + interfaces de payload (`PppBreedList`, etc.) + `BusinessRulePayloadByType` map.
   - `lib/business-rules-resolver.ts`: `resolveBusinessRule<T extends GovtBusinessRuleType>(ruleType: T, jurisdiction: { country?; province?: string|null; locality?: string|null }, executor = db): Promise<ResolvedRule<T>>`. Cascada **locality > province > country > default**. `ResolvedRule<T> = { payload, source: 'default'|'country'|'province'|'locality', matchedRow }`.
   - `lib/business-rules-validators.ts`: `validateRulePayload(ruleType, payload): { ok:true; data } | { ok:false; error }` + registry `BUSINESS_RULE_VALIDATORS: Record<GovtBusinessRuleType, z.ZodSchema>`. **Agregar el schema nuevo acá + entry en el registry.**
   - `app/actions/business-rules.ts`: `createBusinessRuleAction`, `updateBusinessRuleAction(ruleId, ...)`, `deleteBusinessRuleAction` + writers (`createBusinessRuleWriter`, etc.). Gate `requireAdminOrRedirect()` desde `@/lib/auth-guards`. Audit strings: `govt_business_rule_created|updated|deleted`. **El form nuevo reusa estas actions tal cual** (son agnósticas al ruleType: validan vía `validateRulePayload`). Verificá esto leyendo el writer — si el writer hace algo PPP-específico (p. ej. `reEvaluatePppBreedListChange`), envolvelo en un guard `if (ruleType.startsWith('ppp_'))`.
   - Rutas admin: `app/admin/jurisdicciones/[country]/[province]/[locality]/reglas/` → `page.tsx` (lista), `nueva/page.tsx` (switch en `?ruleType=`, valida contra `GOVT_BUSINESS_RULE_TYPES`), `editar/[ruleId]/page.tsx`, forms `Ppp*Form.tsx` en `nueva/`. `DeleteRuleButton.tsx`.
   - `/gob/reglas` **existe** (read-only govt). Usa `resolveBusinessRule`.

   **Physical tag interest (§4.20, ya en código):**
   - Tabla `physicalTagInterest` en `db/schema.ts`: `id, petId (FK→pets, cascade), userId (FK→profiles, cascade), createdAt, cancelledAt, notifiedAt, notes`. Unique `physical_tag_interest_pet_user_unique (petId, userId)`. Migración `0044_physical_tag_interest.sql`.
   - `lib/physical-tag-interest.ts`: `getPhysicalTagInterest(petId, userId): Promise<{ interested: boolean; requestedAt: Date|null }>`.
   - `app/actions/physical-tag-interest.ts`: `togglePhysicalTagInterestAction(petPublicToken): Promise<{ ok:true; state:'interested'|'cancelled' } | { error }>`. Gatea `requirePetAccess` + `accessPath==='owner'`. Toggle tri-estado (insert → set cancelled_at → clear cancelled_at).
   - `components/pet-profile/PhysicalTagInterestCard.tsx` — card placeholder (client, optimistic). **Se deprecia al final.**

   **Perfil + chrome:**
   - `app/(app)/mis-mascotas/[publicToken]/page.tsx`: sección `data-section="credentials"` (~L1216–1253). `PhysicalTagInterestCard` se renderiza ~L1327–1333 con props `petPublicToken, petName, initialInterested, initialRequestedAt` (datos de `getPhysicalTagInterest`). **Mover el render al bloque de credenciales y reemplazar por `PhysicalCredentialCard`.**
   - `app/(app)/mis-mascotas/[publicToken]/SheetMounter.tsx`: switch client-side en el query `sheet`. IDs existentes: `vacuna, peso, sintoma, medicacion, nota, mostrar-tier2, compartir-libreta, transferir-mascota, marcar-perdida, marcar-encontrada, editar-mascota`. **Agregar `credencial-fisica`.**
   - `lib/pet-access.ts`: `requirePetAccess(token)` → `{ ok, user:{id}, pet, accessPath:'owner'|'org', ... }`.

   **QR / cartel:**
   - `app/(app)/mis-mascotas/[publicToken]/cartel/page.tsx`: `QRCode.toString(qrTargetUrl, { type:'svg', margin:1, width:180, errorCorrectionLevel:'M' })`, `qrTargetUrl = ${baseUrl}/p/${publicToken}`. CSS `./cartel-print.css`. Gate `requirePetAccess` + guard `pet.status !== 'lost'`. **El canal QR imprimible reusa este patrón pero SIN el guard de lost** (es permanente).
   - Público: `app/(public)/p/[publicToken]/page.tsx`. URL canónica `${process.env.NEXT_PUBLIC_SITE_URL ?? 'https://mimar.ar'}/p/{token}`.

   **UI:**
   - `components/ui/Sheet.tsx` → `LnSheetPage` props `tone('azul'|'verde'|'violeta'|'seal'|'warn'|'rosa') | icon | title | subtitle | onClose | ctaLabel | formId | isPending | wide`.
   - `components/ui/Button.tsx` → `LnButton` variants `primary|seal|ghost|ok|warn`, sizes `sm|md|lg`, `block`, `loading`, `disabled` (opacity-60).
   - `components/ui/Card.tsx` → `LnCard` / `LnCardHead` / `LnCardBody`.

   **Jurisdicción / reference:**
   - `pets`: `jurisdictionCountry`, `jurisdictionProvince`, `jurisdictionLocality`.
   - `lib/ar-provincias.ts`: `PROVINCES`. `lib/ar-localidades.ts`: `listLocalitiesByProvince(...)`, tabla `arLocalities`.

   **Tooling:**
   - Scripts: `pnpm typecheck` (`tsc --noEmit`), `pnpm lint` (`biome check .`), `pnpm test` (`vitest run`), `pnpm build` (`next build`). `pnpm db:generate` (drizzle-kit), `pnpm db:migrate` (`tsx scripts/migrate.ts`).
   - Tests en `__tests__/` (mirá `__tests__/business-rules-resolver.test.ts` como modelo). Migraciones `db/migrations/NNNN_*.sql`, **última `0101` → la nueva es `0102`**.

3. Baseline verde antes de empezar: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Rojos pre-existentes → parar y avisar.

## 1. Qué construye este plan

Un único entry point en el perfil que ofrece tres canales para llevar la credencial al físico, con disponibilidad resuelta por jurisdicción y configurable por admin — reusando `govt_business_rules`, la infra de QR de `/cartel`, y el mecanismo de interés del §4.20.

## 2. Decisiones cerradas (del spec — no relitigar)

- **D1**: 3 canales configurables por jurisdicción; `printable_qr` default ON (apagable), `engraved_plate`/`nfc_tag` default OFF.
- **D2**: reusar `govt_business_rules` con `ruleType='physical_credential_channels'`. Sin tabla dedicada.
- **D3**: sin event types nuevos. QR imprimible = generate stateless; chapa/NFC = hand-off al proveedor; "Avisame" = `physical_tag_interest`.
- **D5**: el QR imprimible apunta directo a `/p/[publicToken]` (NO `/t/[serial]`). Resuelve open question #2 de physical-tag.
- **D6**: disponibilidad se resuelve contra la jurisdicción de la **mascota**.
- **§9 Q1**: un proveedor por canal por jurisdicción. **Q2**: PDF = una hoja A4 (chapita + tarjeta billetera), sin opciones. **Q3**: copy gris = "No disponible en tu zona todavía". **Q4**: 3-canales-apagados permitido → empty state con "Avisame" global.

## 3. Scope

**Incluido:** ruleType nuevo + resolver + admin form + read-only en `/gob/reglas`; columna `channel` en `physical_tag_interest`; `PhysicalCredentialCard` + `GetPhysicalCredentialSheet` + sheet `credencial-fisica`; canal QR imprimible (print view). **Excluido:** `pet_tags`/`/t/[serial]`/activación (spec physical-tag), checkout/pago/fulfillment, evento `physical_credential_ordered`, override org-level, Web NFC nativo.

## 4. Plan paso a paso

### Fase A — ruleType `physical_credential_channels` + resolver (1 PR, sin UI)

**`db/schema.ts`** — agregar `'physical_credential_channels'` a `GOVT_BUSINESS_RULE_TYPES` y al CHECK `govt_business_rules_rule_type_valid`. (Esto exige migración del constraint → incluir en `0102`, ver Fase C, o una migración propia `0102a` si preferís separar. Recomendado: una sola migración 0102 que cubra constraint + columna de interés.)

**`lib/business-rules-defaults.ts`** — extender `BusinessRulePayloadByType` + `BUSINESS_RULES_DEFAULTS`:
```ts
export interface PhysicalCredentialProvider { enabled: boolean; providerName?: string; providerUrl?: string }
export interface PhysicalCredentialChannels {
  printable_qr: boolean;
  engraved_plate: PhysicalCredentialProvider;
  nfc_tag: PhysicalCredentialProvider;
}
// en BUSINESS_RULES_DEFAULTS:
physical_credential_channels: {
  printable_qr: true,
  engraved_plate: { enabled: false },
  nfc_tag: { enabled: false },
}
```

**`lib/business-rules-validators.ts`** — schema Zod + entry en `BUSINESS_RULE_VALIDATORS`:
```ts
const providerSchema = z.object({
  enabled: z.boolean(),
  providerName: z.string().min(1).max(120).optional(),
  providerUrl: z.string().url().max(300).optional(),
}).strict().refine(p => !p.enabled || (p.providerName && p.providerUrl), {
  message: "Proveedor (nombre + URL) requerido cuando el canal está habilitado.",
});
export const physicalCredentialChannelsSchema = z.object({
  printable_qr: z.boolean(),
  engraved_plate: providerSchema,
  nfc_tag: providerSchema,
}).strict();
// BUSINESS_RULE_VALIDATORS['physical_credential_channels'] = physicalCredentialChannelsSchema
```

**`lib/physical-credential-channels.ts`** (nuevo) — helper de resolución sobre el resolver existente:
```ts
import { resolveBusinessRule } from "@/lib/business-rules-resolver";
import type { PhysicalCredentialChannels } from "@/lib/business-rules-defaults";

export type ChannelKey = "printable_qr" | "engraved_plate" | "nfc_tag";
export type ChannelAvailability = PhysicalCredentialChannels;

export async function resolvePhysicalCredentialChannels(jurisdiction: {
  country: string; province: string | null; locality: string | null;
}): Promise<ChannelAvailability> {
  const r = await resolveBusinessRule("physical_credential_channels", jurisdiction);
  return r.payload;
}
```

**`app/actions/business-rules.ts`** — si algún writer hace trabajo PPP-específico (re-eval de pets), envolverlo en guard por ruleType para que `physical_credential_channels` no lo dispare.

**Tests** (`__tests__/physical-credential-channels.test.ts`): default → `printable_qr:true`, resto `enabled:false`; regla a nivel localidad pisa provincia/país (cascada); payload con proveedor se propaga; validator rechaza `enabled:true` sin proveedor.

### Fase B — Admin form + read-only govt (1 PR)

**`app/admin/jurisdicciones/[country]/[province]/[locality]/reglas/nueva/PhysicalCredentialChannelsForm.tsx`** (nuevo) — client form al estilo de `PppWeightThresholdForm`: 3 checkboxes (`printable_qr` checked por default; `engraved_plate`/`nfc_tag`) y, al tildar chapa/NFC, revelar inputs `providerName` + `providerUrl`. Hidden inputs de jurisdicción. Submit a `createBusinessRuleAction` / `updateBusinessRuleAction` (mode create/edit), serializando el payload a JSON en el campo que esperan las actions (mirá cómo lo hacen los forms PPP — probablemente un hidden `rulePayload` o campos planos parseados en el writer).

**`nueva/page.tsx`** — agregar el case:
```tsx
{ruleType === "physical_credential_channels" && (
  <PhysicalCredentialChannelsForm mode="create" country={country} province={province} locality={locality}
    initial={{ printable_qr: true, engraved_plate: { enabled: false }, nfc_tag: { enabled: false } }} />
)}
```
**`editar/[ruleId]/page.tsx`** — agregar el mismo case en modo edit, hidratando del row.
**`reglas/page.tsx`** — si lista ruleTypes disponibles para crear, sumar `physical_credential_channels` con label legible ("Canales de credencial física").

**`/gob/reglas`** — sumar la regla resuelta a la vista read-only (label + canales habilitados + proveedor). Reusa `resolveBusinessRule`.

**Tests**: crear regla con NFC enabled exige proveedor (server-side via writer/validator); no-op detection si payload == default; audit `govt_business_rule_created` escrito. Si hay tests de la pantalla reglas, extender el invariante de "ruleType soportado".

### Fase C — Migración `physical_tag_interest.channel` + interés por canal (1 PR)

**`db/migrations/0102_physical_credential_channels.sql`** (nuevo) — dos cosas:
1. Constraint de `govt_business_rules` ampliado para incluir `'physical_credential_channels'` (de Fase A).
2. `physical_tag_interest`: agregar `channel text` nullable + CHECK `channel IN ('printable_qr','engraved_plate','nfc_tag') OR channel IS NULL`; **dropear** unique `physical_tag_interest_pet_user_unique` y crear `physical_tag_interest_pet_user_channel_unique (pet_id, user_id, channel)`. Filas existentes quedan `channel=NULL` (interés legacy global).

> Generá con `pnpm db:generate` tras editar `db/schema.ts`, pero revisá el SQL a mano (el cambio de unique constraint y el CHECK suelen necesitar ajuste manual). Aplicá con `pnpm db:migrate`.

**`db/schema.ts`** — reflejar la columna `channel` y el nuevo unique en `physicalTagInterest`.

**`lib/physical-tag-interest.ts`** — extender:
```ts
export async function getPhysicalTagInterestByChannel(
  petId: string, userId: string,
): Promise<Record<ChannelKey, { interested: boolean; requestedAt: Date | null }>>;
```
Mantener `getPhysicalTagInterest` (legacy `channel IS NULL`) para back-compat hasta deprecar la card vieja.

**`app/actions/physical-tag-interest.ts`** — `togglePhysicalTagInterestAction(petPublicToken: string, channel?: ChannelKey)`: si `channel` provisto, opera sobre esa fila `(pet, user, channel)`; si no, comportamiento legacy (`channel IS NULL`). Mantener el gate `accessPath==='owner'`.

**Tests**: toggle por canal aísla canales (interés NFC no toca chapa ni el legacy null); migración no rompe filas existentes (smoke).

### Fase D — `PhysicalCredentialCard` + `GetPhysicalCredentialSheet` + perfil (1 PR)

**`components/pet-profile/PhysicalCredentialCard.tsx`** (nuevo, server-friendly wrapper + client trigger) — card en la sección credenciales:
- Título "🏷️ Credencial física para {petName}", copy corto, botón `LnButton primary` "Obtener credencial física" → navega a `?sheet=credencial-fisica` (mismo patrón que los triggers existentes que setean el query `sheet`).
- Props: `petPublicToken, petName, availability: ChannelAvailability, interestByChannel`.

**`components/pet-profile/GetPhysicalCredentialSheet.tsx`** (nuevo, client) — `LnSheetPage tone="azul"`, título "Credencial física para {petName}". Renderiza las 3 filas-canal desde un array con estado derivado (§4.3 del spec):
- `printable_qr` disponible → botón primary "Descargar para imprimir" → abre la print view (Fase E).
- `engraved_plate`/`nfc_tag` disponible → botón ghost "Pedir" → `window.open(providerUrl)` (hand-off).
- canal `enabled:false` → fila `opacity-50`, `aria-disabled`, leyenda "No disponible en tu zona todavía" + botón secundario "Avisame" → `togglePhysicalTagInterestAction(token, channel)` (optimistic, reusa el patrón de la card vieja). Si ya hay interés → "Te avisamos cuando esté disponible. Solicitado el {fecha}." + "Cancelar".
- los 3 apagados → empty state con copy + "Avisame" global (`togglePhysicalTagInterestAction(token)` sin channel).
- A11y: cada fila `role="group"` + `aria-describedby` a la leyenda; grises con `disabled` real, no solo color.

**`SheetMounter.tsx`** — registrar `credencial-fisica` → `GetPhysicalCredentialSheet` (pasarle `availability` + `interestByChannel`; estos vienen del server component del perfil y se pasan vía props del mounter, igual que otros sheets reciben datos del pet).

**`app/(app)/mis-mascotas/[publicToken]/page.tsx`** — en `data-section="credentials"`:
- resolver `const availability = await resolvePhysicalCredentialChannels({ country: pet.jurisdictionCountry, province: pet.jurisdictionProvince, locality: pet.jurisdictionLocality })`.
- `const interestByChannel = await getPhysicalTagInterestByChannel(pet.id, user.id)`.
- renderizar `<PhysicalCredentialCard .../>` dentro del bloque de credenciales; **quitar** el render viejo de `PhysicalTagInterestCard` (~L1327–1333).
- Mantener el orden v2.1 (la card va en la sección 03, no arriba del hero).

**Tests** (componente, sin DB): los 4 estados por canal renderizan el control correcto; gris usa `disabled` + `aria-disabled`; empty state cuando los 3 off; el perfil ya no referencia `PhysicalTagInterestCard`.

### Fase E — Canal QR imprimible (print view) (1 PR)

**`app/(app)/mis-mascotas/[publicToken]/credencial/page.tsx`** (nuevo) + **`credencial-print.css`** — reusa el patrón de `cartel/`:
- Gate `requirePetAccess(publicToken)` (cualquier `accessPath` que sea owner; **sin** guard de `status==='lost'`).
- `QRCode.toString(`${baseUrl}/p/${publicToken}`, { type:'svg', margin:1, width:180, errorCorrectionLevel:'M' })` (D5: directo a `/p/`).
- Layout A4 (Q2): chapita troquelable (QR + nombre + "Escaneá para ver mi credencial MiMAR") + tarjeta tamaño billetera, en una sola hoja. Print stylesheet con `@media print`.
- Footer "Generada por MiMAR · {fecha}" para presentabilidad (mismo tono que el Tier-2 libreta).

El botón "Descargar para imprimir" del sheet navega acá; la página ofrece `window.print()` (botón visible, oculto en print).

**Tests**: la print view genera QR a `/p/[publicToken]` (no `/t/`); funciona con `status != 'lost'`; gate de acceso rechaza no-owners.

### Fase F — Tests integración + docs (1 PR)

- Smoke del flujo: admin habilita NFC en una localidad → owner de mascota en esa localidad ve la fila NFC activa con "Pedir"; owner de otra localidad la ve gris con "Avisame".
- `AGENTS.md → Privacy tiers`: nota de que la credencial física resuelve a Tier 0 estable.
- `specs/2026-05-18-physical-tag-design.md`: marcar open question #2 (DIY QR) resuelta por el canal `printable_qr`; referenciar este hub como entry point owner-facing.
- `specs/2026-05-19-govt-business-rules-poc-design.md`: sumar `physical_credential_channels` a la lista de ruleTypes.
- `docs/superpowers/README.md`: fila del spec → ✅ Implementado + SHA; actualizar la fila de prioridad 5b.

## 5. Orden / dependencias

A → B → C → D → E → F. A es prerequisito de todo (define el ruleType + resolver). C es prerequisito de D (el sheet usa interés por canal). E depende de D (el sheet linkea a la print view). B es independiente de C/D/E una vez hecha A — se puede paralelizar con C.

## 6. Verificación final (checklist)

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verde.
- [ ] Default sin reglas: QR imprimible disponible, chapa/NFC grises, en cualquier jurisdicción.
- [ ] Regla a nivel localidad pisa provincia/país (cascada correcta).
- [ ] Greying responde a la jurisdicción de la **mascota**, no del usuario.
- [ ] "Avisame" por canal aísla canales; interés legacy intacto.
- [ ] QR imprimible apunta a `/p/[publicToken]`, sin guard de lost.
- [ ] Admin form exige proveedor cuando chapa/NFC enabled; audit escrito.
- [ ] Perfil ya no renderiza `PhysicalTagInterestCard`; orden v2.1 intacto (hero primero).
- [ ] `/gob/reglas` muestra la regla read-only.
- [ ] Migración 0102 aplicada idempotente; filas de interés viejas quedan `channel=null`.

## 7. Riesgos / notas

- **Writer PPP-específico**: si `createBusinessRuleWriter`/`updateBusinessRuleWriter` invoca re-evaluación de pets (hook PPP), confirmá que está gateado por ruleType antes de Fase B; si no, agregá el guard ahí (Fase A).
- **Cambio de unique constraint** en `physical_tag_interest`: revisar el SQL generado a mano (drizzle-kit a veces no infiere el drop+create de constraints correctamente). Probar la migración contra Postgres local antes del PR.
- **Paso de `availability`/`interestByChannel` al SheetMounter**: seguí el patrón con el que el mounter ya recibe datos del pet (props del server component), no fetchees de nuevo en el client.
