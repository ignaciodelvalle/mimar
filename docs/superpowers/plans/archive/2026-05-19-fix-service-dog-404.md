# Fix — 404 al entrar a "Perro de asistencia" desde pet profile

> Plan ejecutable corto para Claude Code. Diagnóstico: el link "Perro de asistencia / guía (Ley 26.858) →" se muestra en el perfil de TODA pet de especie `dog`, pero la página `/asistencia` filtra estrictamente por `ownerships.role='owner'`. Para custodios que no son `owner` permanente (vecino-en-tránsito con `shelter_custody`, foster, co_owner, caretaker) el link aparece pero la página devuelve 404 cryptico.
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Estado:** ready for CC
> **Tamaño:** ~30 LOC + tests
> **Estimación:** ½ día

---

## 0. Antes de tocar nada

1. **`app/(app)/mis-mascotas/[publicToken]/page.tsx`** — pet profile que muestra el link (línea 532-541).
2. **`app/(app)/mis-mascotas/[publicToken]/asistencia/page.tsx`** — página que 404ea (líneas 34-47).
3. **`app/(app)/mis-mascotas/page.tsx`** — lista de mascotas, NO filtra por role (línea 30 de la query) — por eso una pet con role `shelter_custody` aparece y el usuario asume que es suya.
4. **`docs/superpowers/specs/2026-05-17-additional-species-design.md` §Bloque 2** — diseño de Service dogs (Ley 26.858). Confirma que la credencial es válida solo para owner legal permanente — NO para foster, custody temporal o caretaker.

## 1. Diagnóstico (causa raíz)

Asimetría entre 3 lugares:

| Lugar | Filtra por role |
|---|---|
| `/mis-mascotas/page.tsx` (lista) | NO — cualquier active ownership |
| `/mis-mascotas/[token]/page.tsx` (profile) — link "Perro de asistencia" | NO — solo verifica `pet.species==='dog'` |
| `/mis-mascotas/[token]/asistencia/page.tsx` (page destino) | SÍ — estricto `role='owner'` |

Resultado: vecino-en-tránsito (rol `shelter_custody`), foster, co_owner, caretaker → ven el link y al clickear obtienen 404.

**Caso más probable observado**: el usuario testeó con una pet registrada via `custodyKind='transito'` (vecino-en-tránsito). El flow lo crea con role `shelter_custody`, no `owner`. La pet aparece en `/mis-mascotas`, el profile muestra el link, click → 404.

## 2. Decisiones del fix

| # | Decisión | Razón |
|---|---|---|
| F1 | El link a `/asistencia` se renderiza SOLO si el usuario tiene `role='owner'` activo sobre la pet. Para otros roles (shelter_custody, foster, co_owner, caretaker), el link se esconde. | Mantiene la realidad legal: la credencial Ley 26.858 es del dueño legal permanente. Un vecino-en-tránsito legítimamente no puede registrar el animal como de asistencia |
| F2 | Si alguien navega por URL directa sin `role='owner'`, la página muestra un **mensaje friendly** en lugar de bare 404. Copy: "La credencial de perro de asistencia se registra solo bajo dueño legal permanente. Tu vínculo actual con [pet.name] es de [role label]. Para registrar al animal como de asistencia, primero debe completarse la transferencia legal de custodia." | UX. 404 sin contexto es lo peor; explicar el motivo permite al usuario entender qué tiene que pasar |
| F3 | Auditoría adicional: revisar OTROS sub-paths bajo `/mis-mascotas/[token]/` que usen el mismo filtro estricto (`devolucion/page.tsx` lo usa también). `devolucion` ES legítimamente owner-only (acepta return-to-owner), así que se mantiene — pero seguir el mismo patrón F2 de mensaje friendly. | Consistencia transversal |

## 3. Cambios concretos

### 3.1 `app/(app)/mis-mascotas/[publicToken]/page.tsx`

Antes (líneas 532-541):

```tsx
{pet.species === "dog" && (
  <section>
    <Link
      href={`/mis-mascotas/${pet.publicToken}/asistencia`}
      className="..."
    >
      Perro de asistencia / guía (Ley 26.858) →
    </Link>
  </section>
)}
```

Después:

```tsx
{pet.species === "dog" && ownershipRole === "owner" && (
  <section>
    <Link
      href={`/mis-mascotas/${pet.publicToken}/asistencia`}
      className="..."
    >
      Perro de asistencia / guía (Ley 26.858) →
    </Link>
  </section>
)}
```

Para que `ownershipRole` esté disponible: extender la query del perfil para traer `ownerships.role` del row activo del current user. Ya se está haciendo en `/mis-mascotas/page.tsx` con `ownerships.role`; replicar el mismo join + select acá.

### 3.2 `app/(app)/mis-mascotas/[publicToken]/asistencia/page.tsx`

Antes (líneas 26-48):

```tsx
const [petRow] = await db
  .select({ pet: pets })
  .from(pets)
  .innerJoin(ownerships, eq(ownerships.petId, pets.id))
  .where(and(
    eq(pets.publicToken, publicToken),
    eq(ownerships.ownerUserId, user.id),
    eq(ownerships.role, "owner"),
    isNull(ownerships.endedAt),
  ))
  .limit(1);
if (!petRow) notFound();
```

Después: separar en dos queries. Primero verifico que la pet existe Y el user tiene CUALQUIER ownership activo (sino real 404 — pet ajena). Si pasa eso pero el role NO es owner, renderizo mensaje friendly.

```tsx
const [accessRow] = await db
  .select({ pet: pets, role: ownerships.role })
  .from(pets)
  .innerJoin(ownerships, eq(ownerships.petId, pets.id))
  .where(and(
    eq(pets.publicToken, publicToken),
    eq(ownerships.ownerUserId, user.id),
    isNull(ownerships.endedAt),
  ))
  .limit(1);

if (!accessRow) notFound(); // sí 404 — pet ajena de verdad

if (accessRow.role !== "owner") {
  return <FriendlyOwnerOnlyPage pet={accessRow.pet} role={accessRow.role} />;
}

const pet = accessRow.pet;
// ... resto igual
```

Componente `FriendlyOwnerOnlyPage` inline en el mismo archivo (no merece su propio file):

```tsx
function FriendlyOwnerOnlyPage({ pet, role }: { pet: Pet; role: string }) {
  const roleLabel = {
    shelter_custody: "custodia temporal (tránsito)",
    foster: "tránsito formal",
    co_owner: "co-dueño",
    caretaker: "cuidador",
  }[role] ?? role;
  return (
    <main className="min-h-screen p-6 bg-white dark:bg-neutral-950">
      <div className="max-w-2xl mx-auto pt-10 space-y-4">
        <Link
          href={`/mis-mascotas/${pet.publicToken}`}
          className="text-sm text-neutral-500 hover:text-neutral-900"
        >
          ← Volver al perfil
        </Link>
        <h1 className="text-2xl font-semibold">Perro de asistencia · {pet.name}</h1>
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-4 text-sm text-amber-900 dark:text-amber-100">
          <p className="font-medium">La credencial de perro de asistencia (Ley 26.858) se registra solo bajo dueño legal permanente.</p>
          <p className="mt-2">
            Tu vínculo actual con <strong>{pet.name}</strong> es de <strong>{roleLabel}</strong>.
            Para registrar al animal como de asistencia, primero debe completarse la transferencia legal de custodia (adopción finalizada o pase a dueño definitivo).
          </p>
        </div>
      </div>
    </main>
  );
}
```

### 3.3 Audit de `/mis-mascotas/[token]/devolucion/page.tsx`

Mismo patrón F2: si el user no tiene role='owner' activo, mensaje friendly explicando que devolver es acción de dueño legal. NO renderizar 404 cryptico.

## 4. Tests

`__tests__/asistencia-page-access.test.ts` (nuevo):

```ts
// Mock auth + DB. Tres escenarios:
it('owner ve form de service dog');
it('shelter_custody (vecino-en-tránsito) ve mensaje friendly, NO 404');
it('foster ve mensaje friendly, NO 404');
it('user sin ownership activo sobre el pet ve 404 real (pet ajena)');
```

`__tests__/pet-profile-link-visibility.test.ts` (nuevo o extender existente):

```ts
it('owner ve link "Perro de asistencia"');
it('shelter_custody NO ve link');
it('foster NO ve link');
```

## 5. Verificación

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verdes
- [ ] Manual: registrar pet via `custodyKind='transito'` (`/mis-mascotas/nueva?custodyKind=transito`) → ir al profile de la pet creada → confirmar que NO aparece link "Perro de asistencia"
- [ ] Manual: navegar a URL directa `/mis-mascotas/[token]/asistencia` como vecino-en-tránsito → ver mensaje friendly amarillo, NO 404
- [ ] Manual: registrar pet normal (no tránsito) → confirmar link aparece + página funciona
- [ ] Manual: testear el mismo flow en `devolucion/page.tsx`

## 6. Out of scope

- Reorganización general del autorization helper para sub-pages — patrón actual con queries inline funciona bien, no merece refactor a `requirePetAccess(role='owner')`.
- Permitir a foster registrar service dog — la Ley 26.858 ata la credencial al dueño legal; cambiarlo es decisión de producto, no fix de UX.

---

**Listo para CC.** PR único, sin dependencias.
