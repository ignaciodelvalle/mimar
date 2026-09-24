# Fix — Vet con professional.provider no debe landar en /mis-mascotas

> **Estado (2026-06-04):** ⊘ SUPERSEDED por PR #84 — el portal `/pro` fue ELIMINADO (no placeholdeado); los vets operan vía `/org/[orgToken]`. El ruteo de vets quedó resuelto por otro mecanismo (`resolveVetLanding` en lib/role-landing.ts + redirect 308 en middleware.ts). Residual menor: los layouts `/gob` y `/admin` tienen "← Salir" a `/mis-mascotas` (posible escape-hatch intencional, no bloqueante).

> Plan ejecutable corto para Claude Code. El `(app)/layout.tsx` actual solo bounce-redirige admin y govt; un vet con `professional.provider` aprobado pasa el gate y entra al portal de owners por default. Eso es incoherente con el modelo de cuatro roles (admin page spec v2.3). Además, los portales non-owner (/pro, /org, /gob, /admin) NO deben mostrar link a "Mis mascotas" en el chrome (topbar/sidebar) — solo links contextuales.
>
> **Importante**: NO se bloquea el acceso por URL directa. Un vet sigue siendo persona y puede tener mascotas propias — debe poder navegar a `/mis-mascotas` cuando quiere actuar como dueño. Lo que se arregla es (a) el **default landing** post-login y (b) **el chrome de los portales non-owner** que automáticamente sugería /mis-mascotas.
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Estado:** ready for CC
> **Tamaño:** ~50 LOC repartido en 3-4 archivos + tests
> **Estimación:** ½-1 día

---

## 0. Antes de tocar nada

1. **`app/(app)/layout.tsx`** — gate actual. Solo redirige admin y govt; ahí va el cambio principal.
2. **`docs/superpowers/specs/2026-05-17-admin-page-design.md` (v2.3)** — modelo de los cuatro roles. Vet con `professional.provider` granted = profesional independiente con portal propio (/pro). Sin `professional.provider`, el vet sigue siendo owner normal.
3. **`lib/capabilities.ts`** — cómo se computa `professional.provider`. El check ya existe; reusar.
4. **`lib/auth-guards.ts`** (línea 163) — gate de `/pro` ya hace `if (profile.role !== "vet") redirect("/pro")` defensivo. Mirar para entender el patrón.
5. **Chrome / nav de los portales non-owner**: identificar dónde viven los headers/sidebars de `/pro`, `/org/[orgToken]`, `/gob`, `/admin`. Probablemente en sus respectivos layouts o en componentes shared (`components/AppShell`, `Topbar`, etc.).

## 1. Diagnóstico

`app/(app)/layout.tsx` actual:

```tsx
if (profile?.role === "admin") redirect("/admin");
if (profile?.role === "govt") redirect("/gob");
return <>{children}</>;
```

Resultado: el vet con `role='vet'` pasa el gate, no importa si tiene `professional.provider`. Cae en `/mis-mascotas` como cualquier owner.

Cuando el `/pro` portal exista (sigue 🟡 spec only), va a tener el problema cruzado: el vet va a tener dos portales válidos (`/mis-mascotas` como dueño, `/pro` como profesional). Sin gate inteligente, el default es ambiguo.

## 2. Decisiones del fix

| # | Decisión | Razón |
|---|---|---|
| F1 | **Default landing post-login** cuando `role='vet'` AND tiene `professional.provider` granted → redirect a `/pro`. Cuando NO tiene la capability granted → comportamiento actual (cae en `/mis-mascotas` como owner) | Coherente con el modelo de cuatro roles. El vet sin capability granted es operativamente un owner; el vet con capability es profesional con portal propio |
| F2 | **`/pro` aún no existe** (status 🟡 spec only). Hasta que se construya, `/pro` debe servir un **placeholder mínimo** ("Portal profesional en construcción. Mientras tanto, podés operar desde la organización en la que sos miembro, si aplica.") con link a `/org` y link contextual a `/mis-mascotas` (texto chico: "Tengo mascotas propias →"). | Sin placeholder, redirect a `/pro` rompe — la ruta no existe. Placeholder permite shipear el fix YA y la ruta real llega cuando `/pro` se construya |
| F3 | **NO bloquear** `/mis-mascotas` por URL directa para `role='vet'` (con o sin capability). El vet legítimamente puede tener mascotas propias. Solo cambia el **default**, no el access | Realidad humana: muchos veterinarios tienen sus propias mascotas. Bloquear sería incorrecto |
| F4 | **Auditoría de chrome non-owner**: revisar headers/sidebars de `/pro` (placeholder + futuro), `/org/[orgToken]`, `/gob`, `/admin`. NINGUNO debe mostrar link automático a "Mis mascotas" en el menú principal. Sí pueden mostrar link contextual cuando aplique (e.g., signed-in user es subject_owner de un pet visto en un caso del portal) | Anti-confusión. Cuando estás operando como org admin, no querés ver tu propio pet en el menú |
| F5 | **Indicador visible del rol activo** en el chrome de cada portal: badge "Trabajando como: [Vet profesional independiente | Miembro de Refugio X | Govt CABA | etc.]" arriba a la derecha. Click → menú con switch al otro portal disponible | UX. Multi-portal sin indicador es desorientador |

## 3. Cambios concretos

> **Nota arquitectónica:** Los cambios concretos detallados abajo fueron supersedidos — el portal `/pro` fue eliminado en lugar de crearse como placeholder. Ver banner de estado arriba.

### 3.1 `app/(app)/layout.tsx`

Reemplazar la guarda actual:

```tsx
import { getGrantedCapabilities } from "@/lib/capabilities";

// ... después de obtener profile:
if (profile?.role === "admin") redirect("/admin");
if (profile?.role === "govt") redirect("/gob");

if (profile?.role === "vet") {
  const capabilities = await getGrantedCapabilities(user.id);
  if (capabilities.includes("professional.provider")) {
    redirect("/pro");
  }
  // sin capability granted: vet opera como owner normal, deja pasar
}

return <>{children}</>;
```

**Subtleza**: el redirect se hace en el layout, así que solo afecta el default landing. Si el vet navega explicitamente a `/mis-mascotas/[token]/...` cuando ya está en /pro, **NO debe re-redirigir**. La regla es: el layout redirige solo si el path es la home del portal (`/mis-mascotas` exactamente, sin segmentos), no si va a un sub-path. Implementación: chequear `request.nextUrl.pathname === '/mis-mascotas'` ANTES de redirect.

Como esto requiere acceso al pathname desde el layout (que no lo recibe direct), una opción: dejar el redirect en el layout para CUALQUIER ruta bajo `(app)/`, y agregar middleware adicional que detecte "este vet venía de /pro y vino a click un link directo a /mis-mascotas/[token]" usando query param `?as=owner`. Más simple: el chrome del portal /pro tiene link "Tengo mascotas propias →" que linkea a `/mis-mascotas?as=owner`, y la guarda del layout chequea ese query param y deja pasar.

Decisión simple en este fix:

```tsx
// El redirect solo dispara si pathname es exactamente /mis-mascotas (home).
// Sub-paths siempre permiten al vet operar como owner (vino por link directo).
import { headers } from "next/headers";

const hdrs = await headers();
const pathname = hdrs.get("x-pathname") ?? ""; // requiere setear el header en middleware
const isOwnerHome = pathname === "/mis-mascotas" || pathname === "/mis-mascotas/";

if (profile?.role === "vet" && isOwnerHome) {
  const capabilities = await getGrantedCapabilities(user.id);
  if (capabilities.includes("professional.provider")) {
    redirect("/pro");
  }
}
```

**O alternativa más limpia**: redirigir SOLO si pathname empieza con `/mis-mascotas` Y query param `?as` está ausente. Cuando viene de `/pro` con `?as=owner`, deja pasar.

Adopto la alternativa con query param porque no requiere setear x-pathname header (no nativo).

### 3.2 Middleware — setear pathname header

`middleware.ts` ya existe. Agregar antes del `return`:

```ts
// Set x-pathname so server components (specifically layouts) can read it
// (Next.js layouts don't get the request directly).
const response = await updateSession(request);
response.headers.set("x-pathname", request.nextUrl.pathname);
return response;
```

### 3.3 Crear `app/pro/page.tsx` placeholder

(Si la carpeta `/pro` no existe, crear estructura mínima.)

```tsx
import Link from "next/link";
import { requireUserOrRedirect } from "@/lib/auth-guards";
import { getGrantedCapabilities } from "@/lib/capabilities";
import { redirect } from "next/navigation";

export default async function ProPlaceholder() {
  const { user } = await requireUserOrRedirect();
  const capabilities = await getGrantedCapabilities(user.id);
  if (!capabilities.includes("professional.provider")) {
    redirect("/mis-mascotas"); // defensive — no debería pasar
  }

  return (
    <main className="min-h-screen p-6 bg-white dark:bg-neutral-950">
      <div className="max-w-2xl mx-auto pt-10 space-y-6">
        <header>
          <h1 className="text-3xl font-semibold">Portal profesional</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-2">
            En construcción. La página completa con servicios + agenda + clientes
            llega pronto.
          </p>
        </header>

        <section className="rounded-lg border border-neutral-300 dark:border-neutral-700 p-4 space-y-2">
          <p className="text-sm font-medium">Mientras tanto, podés:</p>
          <ul className="text-sm space-y-2 mt-2 list-disc list-inside text-neutral-700 dark:text-neutral-300">
            <li>
              <Link href="/org" className="text-blue-600 hover:underline">
                Operar desde una organización
              </Link>{" "}
              en la que seas miembro (refugio, clínica, red de rescate)
            </li>
            <li>
              <Link href="/cuenta" className="text-blue-600 hover:underline">
                Gestionar tu cuenta y capabilities
              </Link>
            </li>
          </ul>
        </section>

        <section className="border-t border-neutral-200 dark:border-neutral-800 pt-6">
          <Link
            href="/mis-mascotas?as=owner"
            className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-50"
          >
            ¿Tenés mascotas propias? Ir a tu portal de dueño →
          </Link>
        </section>
      </div>
    </main>
  );
}
```

### 3.4 Audit de chrome — sacar link automático a "Mis mascotas"

Para cada portal non-owner, encontrar el componente que renderiza el topbar/sidebar/nav:

- `app/org/[orgToken]/layout.tsx` — su chrome
- `app/gob/layout.tsx` — su chrome
- `app/admin/layout.tsx` — su chrome
- `app/pro/layout.tsx` (cuando exista) — su chrome

En cada uno, verificar que **no exista link automático a `/mis-mascotas`** en el nav principal. Si existe (legacy), eliminarlo. Mantener solo links contextuales:
- En `/org/...`: "Ver mascotas de la organización" (link a `/org/[orgToken]/mascotas`), NO "Mis mascotas".
- En `/gob/...`: "Casos en mi jurisdicción", NO "Mis mascotas".
- En `/admin/...`: "Métricas del sistema", NO "Mis mascotas".

Cada portal puede tener una sección **secundaria** ("Tu cuenta" / "Settings") con link a `/mis-mascotas?as=owner` si el usuario tiene mascotas propias — pero NO en el main nav.

### 3.5 (Opcional, scope creep — defer si presiona) Badge "Trabajando como"

Componente reusable `<ActiveRoleBadge>` que renderiza chip arriba a la derecha mostrando el rol activo del portal actual. Click → dropdown con switch a portales alternativos.

**Defer si quedás corto de tiempo**: F5 puede quedar para el spec de admin page next phases o un follow-up del rebrand. Lo importante para este fix son F1-F4.

## 4. Tests

`__tests__/app-layout-routing.test.ts` (nuevo o extender existente):

```ts
it('owner ingresa a /mis-mascotas → deja pasar');
it('admin ingresa a /mis-mascotas → redirect a /admin');
it('govt ingresa a /mis-mascotas → redirect a /gob');
it('vet sin professional.provider ingresa a /mis-mascotas → deja pasar');
it('vet con professional.provider ingresa a /mis-mascotas (sin ?as) → redirect a /pro');
it('vet con professional.provider ingresa a /mis-mascotas?as=owner → deja pasar');
it('vet con professional.provider ingresa a /mis-mascotas/[token] → deja pasar (sub-path no afectado)');
```

`__tests__/pro-placeholder.test.ts` (nuevo):

```ts
it('vet con capability ve placeholder');
it('vet sin capability → redirect a /mis-mascotas (defensive)');
```

`__tests__/non-owner-chrome.test.ts` (nuevo o extender):

```ts
it('chrome de /org NO contiene link a /mis-mascotas');
it('chrome de /gob NO contiene link a /mis-mascotas');
it('chrome de /admin NO contiene link a /mis-mascotas');
```

## 5. Verificación

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verdes
- [ ] Manual: login como vet aprobado (con `professional.provider`) → confirmar landing en `/pro` placeholder
- [ ] Manual: link "¿Tenés mascotas propias?" → navega a `/mis-mascotas?as=owner` y queda ahí (no rebote)
- [ ] Manual: login como vet sin capability → landing en `/mis-mascotas` normal
- [ ] Manual: login como owner → landing en `/mis-mascotas` normal
- [ ] Manual: login como admin → landing en `/admin`, NO ve link a "Mis mascotas" en topbar
- [ ] Manual: navegar de un /pro a un caso de bite que involucra mascota tuya → linkbacks contextuales OK; chrome principal sigue siendo /pro

## 6. Out of scope

- **Construcción real del `/pro` portal** — sigue siendo trabajo separado (status 🟡 en README). Este fix solo deja el placeholder para que el redirect tenga destino.
- **F5 ActiveRoleBadge** — opcional, defer si no entra en tiempo. Es UX nice-to-have, no fix de bug.
- **Multi-vet / multi-org switching UI sofisticada** — fuera de scope. Un único redirect default + acceso por URL directa cubre v1.

---

**Listo para CC.** PR único. Dependencias: ninguna (no toca schema, no toca otras specs en flight).
