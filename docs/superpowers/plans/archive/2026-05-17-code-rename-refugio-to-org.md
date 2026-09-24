# Code rename: `/refugio` → `/org/[orgToken]`

> ## ✅ ESTADO: EJECUTADO
>
> Este plan fue aplicado. `app/refugio/` ya no existe en el repo, todo el portal vive bajo `app/org/[orgToken]/`, los `Link` internos apuntan al nuevo path y AGENTS.md / specs consistentemente referencian `/org/[orgToken]/*`. Se conserva este documento como referencia histórica del refactor — no volver a ejecutar. La convención `refugio` (es-AR copy + ruta pública `/refugios/[orgToken]`) vs `org` (identificadores internos + portal admin) está fijada en `AGENTS.md → Naming convention: refugio vs org`.
>
> Plan ejecutable para Claude Code. Mueve físicamente la carpeta `app/refugio/` a `app/org/[orgToken]/`, introduce el `orgToken` explícito como segment de URL, actualiza todos los `Link` internos, agrega validación de membership por orgToken en el layout, y deja middleware de redirect para bookmarks viejos. No agrega features — es rename + refactor estructural.
>
> **Fecha:** 2026-05-17
> **Owner:** Ignacio Del Valle
> **Tamaño:** ~25 archivos movidos, ~15-20 archivos tocados (Links + server actions), 1 archivo nuevo (middleware redirect)
> **Estimación:** medio día / ~4-5 horas

---

## 0. **CUÁNDO EJECUTAR ESTE PLAN** ⚠️

### Prerequisitos (hard-blocking)

**Antes de empezar este plan, los siguientes pasos DEBEN estar mergeados en main:**

1. **`docs/superpowers/plans/2026-05-17-mimar-rebrand-and-portal-restructure.md` aplicado en su totalidad** — eso reescribió AGENTS.md + todos los specs/plans para que referencien `/org/[orgToken]/*` consistentemente. Si ese plan no está mergeado todavía, los specs todavía dicen `/refugio` y este rename te deja con inconsistencias raras
2. **`pnpm typecheck && pnpm lint && pnpm test && pnpm build` verdes** en main al momento de arrancar. Si hay failures pre-existentes, decirle a Nacho antes de avanzar — no arrastres rojos

### Lo que NO debe estar mergeado todavía (orden importa)

Estos planes tienen referencias pesadas a `/refugio/*` en su contenido. Si los ejecutás **antes** que este rename, escriben código que después hay que migrar:

- ❌ `docs/superpowers/plans/2026-05-16-health-campaigns-and-scheduling.md` — espera hasta que este rename esté mergeado
- ❌ `docs/superpowers/plans/2026-05-17-lost-and-found-complete.md` — idem

Estos planes pueden ejecutarse en paralelo o antes (no tocan paths de org):

- ✅ `docs/superpowers/plans/2026-05-16-libreta-sanitaria-parte-b.md` y `parte-c.md`
- ✅ `docs/superpowers/plans/2026-05-16-event-agent-foundations.md`
- ✅ `docs/superpowers/plans/2026-05-17-symptom-disease-surveillance.md`

### Cuándo NO ejecutar este plan

**Si vas a parar el desarrollo del producto en próximas 2 semanas o más,** este rename no urge — los bookmarks de `/refugio/*` siguen sirviendo sin redirect mientras el código viejo esté en main. Hacelo cuando vayas a retomar.

**Si hay un release crítico inminente** que toca features de org (intake, foster, adoption, transfer), retrasá este rename hasta después del release. Mezclar refactor estructural con bugfixes urgentes es receta para regresiones.

---

## 1. Antes de tocar nada

Lectura obligatoria:

1. **`AGENTS.md` → User roles & account types** completo, en su versión post-doc-rebrand. La nueva tabla de portales y el bloque sobre capability-driven portal access definen el modelo target
2. **`app/refugio/` completo** — explorá la estructura actual de subfolders y archivos. Vas a moverlos todos
3. **`app/refugio/page.tsx`** específicamente — el actual dashboard root. Es lo que más cambia (ya no infiere active org de session; el orgToken viene del URL)
4. **`lib/capabilities.ts`** y **`lib/auth-guards.ts`** — el patrón actual de `requireActiveOrgOrRedirect()` infiere la org de session/cookies. Vas a refactorearlo a `requireOrgAccessByToken(orgToken)` que valida que el user tenga membership activa para ese orgToken específico
5. **Grep en el repo de `"/refugio"` y `\`/refugio\`** — listá TODOS los call sites. Probablemente hay 20-40 `Link href="/refugio..."`, varios redirect en server actions, y maybe alguna fixture de tests. Hacé el list antes de empezar para no perderte nada

```bash
# Sugerido para inventory inicial
rg "/refugio" --type ts --type tsx -l
rg "/refugio" --type ts --type tsx -n
```

## 2. Qué construye este plan

Tres cambios estructurales:

**2.1 Rename físico.** Mover todo `app/refugio/*` a `app/org/[orgToken]/*`. Cada subfolder (intake, mascotas, admin, etc.) viaja completo bajo el nuevo padre dinámico.

**2.2 OrgToken explícito.** El segment `[orgToken]` reemplaza la inferencia de active-org desde session. Cada page server component recibe `orgToken` en `params` y valida que el user tenga membership activa para esa org. Si no, retorna 404 (no leak de orgs ajenas).

**2.3 Middleware redirect.** Cualquier `/refugio/*` bookmarkeado se redirige a `/org` (índice donde el user ve sus orgs y elige). No intentamos adivinar a qué org redirigir — sería ambiguo en multi-org cases.

**Lo que NO se construye:**

- `/profesional` route group (PR separado)
- Polymorphic `service_offerings` schema (PR separado)
- `/gobierno` route group (parte del admin page Fase 0)
- Cambios al feature set de la org portal — todo lo que hoy funciona en `/refugio/intake` debe funcionar igual en `/org/[orgToken]/intake` después de este rename, sin regresiones

## 3. Decisiones cerradas (heredadas del doc rebrand)

| # | Decisión | Razón |
|---|---|---|
| D1 | El segment se llama `[orgToken]`, NO `[publicToken]` | Para distinguir del `[publicToken]` del pet en URLs anidadas como `/org/[orgToken]/mascotas/[publicToken]` |
| D2 | El orgToken es el `organizations.publicToken` (formato `ORG-XXXX-XXXX`) | Ya existe; no inventamos identificador nuevo |
| D3 | El layout valida membership ANTES de renderizar cualquier child | RLS es defense-in-depth, no la primaria. Auth check en server component es el gate |
| D4 | Si el user no tiene membership para el orgToken pedido, retorna `notFound()` (404), NO redirect | No leakear existencia de orgs que no son tuyas. 404 es indistinguible para attackers |
| D5 | `/refugio/*` redirige a `/org` (índice), no intenta resolver al orgToken correcto | Multi-org users tienen N orgs activas; adivinar es ambiguo. El índice `/org` les muestra la lista para elegir |
| D6 | El context switcher actual (si existe) se simplifica o se elimina | Con orgToken en URL, no hay "active org en sesión". El switcher pasa a ser la página `/org` que lista orgs del user |
| D7 | Server actions que hoy redirigen a `/refugio/...` se actualizan para tomar `orgToken` como argumento y redirigir a `/org/[orgToken]/...` | Cada `Link` que dispara la action ya sabe el orgToken del contexto donde está; pasarlo es trivial |

## 4. Scope

**Dentro:**
- Mover `app/refugio/*` → `app/org/[orgToken]/*` (filesystem move, preservar git history con `git mv`)
- Nuevo `app/org/page.tsx` (índice de orgs del user, reemplaza el dashboard de la org "active")
- Actualizar todos los `Link href="/refugio..."` a `Link href={\`/org/${orgToken}/...\`}` en componentes
- Actualizar todos los `redirect("/refugio/...")` en server actions
- Refactorear auth helper: `requireActiveOrgOrRedirect()` → `requireOrgAccessByToken(orgToken)`
- Nueva middleware `middleware.ts` (o extender la existente) con redirect `/refugio/*` → `/org`
- Update de tests que hardcodean paths

**Fuera:**
- Funcionalidad nueva (no hay)
- `/profesional` implementation
- Schema migration de service_offerings
- Admin page implementation
- Touch a routes que NO son /refugio (mis-mascotas, p, libreta, admin, auth, etc.)

## 5. Plan paso a paso

### Paso 1 — Inventory + map

Antes de mover nada, listá:

```bash
# All current refugio routes
find app/refugio -type f \( -name "*.tsx" -o -name "*.ts" \)

# All call sites referencing /refugio in code
rg "/refugio" --type-add 'ts:*.{ts,tsx}' --type ts -n

# Server actions that redirect to /refugio
rg 'redirect\(.*/refugio' --type-add 'ts:*.{ts,tsx}' --type ts -n
```

Documentá el inventory en un comentario / scratch file. Lo vas a usar como checklist mientras movés.

### Paso 2 — Crear el shell de `/org`

Antes de mover archivos, plantar la estructura:

**Paso 2.1.** Crear `app/org/page.tsx` (índice de orgs del user):

```tsx
// app/org/page.tsx
// Replaces the old "active org" inference. Now the user picks which org to
// operate as via this index page. Each link goes to /org/[orgToken]/.

import { db, organizations, organizationMemberships } from "@/db";
import { createClient } from "@/lib/supabase/server";
import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function OrgIndexPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const myOrgs = await db
    .select({ org: organizations })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(and(
      eq(organizationMemberships.userId, user.id),
      isNull(organizationMemberships.leftAt),
    ));

  if (myOrgs.length === 0) {
    return (
      <main className="min-h-screen p-6 bg-white dark:bg-neutral-950 flex items-center justify-center">
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-2xl font-semibold">No sos miembro de ninguna organización</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Si tu organización te invitó, revisá tu email para aceptar la invitación.
            Si querés registrar una nueva, andá a /cuenta/upgrade.
          </p>
          <Link href="/" className="inline-block px-4 py-2 rounded bg-neutral-900 dark:bg-neutral-50 text-white dark:text-neutral-900 text-sm font-medium">
            Volver al inicio
          </Link>
        </div>
      </main>
    );
  }

  if (myOrgs.length === 1) {
    // Single membership — auto-redirect to that org's dashboard
    redirect(`/org/${myOrgs[0].org.publicToken}`);
  }

  // Multi-org: render picker
  return (
    <main className="min-h-screen p-6 bg-white dark:bg-neutral-950">
      <div className="max-w-2xl mx-auto pt-8 space-y-6">
        <h1 className="text-3xl font-semibold">¿Con cuál organización querés trabajar?</h1>
        <ul className="space-y-3">
          {myOrgs.map(({ org }) => (
            <li key={org.id}>
              <Link
                href={`/org/${org.publicToken}`}
                className="block p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors"
              >
                <p className="font-medium">{org.displayName}</p>
                <p className="text-sm text-neutral-500">
                  {org.orgType} · {org.jurisdictionLocality ?? "Sin localidad"}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
```

**Paso 2.2.** Crear `app/org/[orgToken]/layout.tsx`:

```tsx
// app/org/[orgToken]/layout.tsx
// Validates membership for the requested orgToken. Returns 404 (notFound) if
// the user has no active membership for this org — never leak which orgs exist.

import { db, organizations, organizationMemberships } from "@/db";
import { createClient } from "@/lib/supabase/server";
import { and, eq, isNull } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [membership] = await db
    .select({ org: organizations, membership: organizationMemberships })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(and(
      eq(organizationMemberships.userId, user.id),
      eq(organizations.publicToken, orgToken),
      isNull(organizationMemberships.leftAt),
    ))
    .limit(1);

  if (!membership) {
    // Either the orgToken doesn't exist or user has no active membership.
    // Same response either way → no leak.
    notFound();
  }

  // children render with valid membership confirmed
  return <>{children}</>;
}
```

Notá que este layout no toca la UI — solo gates. Si querés un chrome compartido (org name in header, sidebar de navegación), se agrega encima.

### Paso 3 — Mover archivos preservando git history

**Importante:** usar `git mv` (no `mv` o copiar-y-borrar) para que git rastree los renames y blame funcione.

Para cada archivo o subfolder de `app/refugio/`:

```bash
git mv app/refugio/page.tsx app/org/\[orgToken\]/page.tsx
git mv app/refugio/intake app/org/\[orgToken\]/intake
git mv app/refugio/mascotas app/org/\[orgToken\]/mascotas
git mv app/refugio/admin app/org/\[orgToken\]/admin
# ... y cualquier otro subfolder
```

Después del move, `app/refugio/` debería estar vacío. Borrarlo:

```bash
rmdir app/refugio
```

### Paso 4 — Refactor del auth helper

**Paso 4.1.** Identificar el helper actual. Probablemente está en `lib/auth-guards.ts` con firma tipo:

```ts
export async function requireActiveOrgOrRedirect(): Promise<{ active: { organization: ..., membership: ... } }>
```

**Paso 4.2.** Renombrar y refactorearlo a:

```ts
export async function requireOrgAccessByToken(orgToken: string): Promise<{
  organization: typeof organizations.$inferSelect;
  membership: typeof organizationMemberships.$inferSelect;
  user: User;
}>
```

Implementación:

```ts
export async function requireOrgAccessByToken(orgToken: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [result] = await db
    .select({ organization: organizations, membership: organizationMemberships })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(and(
      eq(organizationMemberships.userId, user.id),
      eq(organizations.publicToken, orgToken),
      isNull(organizationMemberships.leftAt),
    ))
    .limit(1);

  if (!result) notFound();

  return { ...result, user };
}
```

**Paso 4.3.** El layout del paso 2.2 puede invocar este helper en lugar de duplicar la lógica.

**Paso 4.4.** El helper viejo (`requireActiveOrgOrRedirect`) se elimina. Sus call sites se actualizan en el paso siguiente.

### Paso 5 — Update de todas las pages movidas

Cada page bajo `app/org/[orgToken]/*` que antes usaba `requireActiveOrgOrRedirect()` ahora debe:
- Recibir `params: Promise<{ orgToken: string; ... }>`
- Llamar `await requireOrgAccessByToken(orgToken)`
- Usar el `organization` y `membership` returned por el helper

Ejemplo de transformación para `app/org/[orgToken]/intake/page.tsx`:

```ts
// Antes:
export default async function IntakePage() {
  const { active } = await requireActiveOrgOrRedirect();
  const granted = await getGrantedCapabilities(active.membership);
  // ... use active.organization, active.membership
}

// Después:
export default async function IntakePage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  const { organization, membership } = await requireOrgAccessByToken(orgToken);
  const granted = await getGrantedCapabilities(membership);
  // ... use organization, membership directly
}
```

Para pages con multiple params (e.g., `/org/[orgToken]/mascotas/[publicToken]/foster`), el shape de `params` lista todos:

```ts
params: Promise<{ orgToken: string; publicToken: string }>
```

### Paso 6 — Update de Links internos

`grep` por todos los `Link href="/refugio` en el repo. Para cada uno:

**Paso 6.1.** Identificar de qué orgToken viene el contexto. Casi siempre:
- El page padre ya lo tiene en params, lo pasa al componente como prop
- O el componente lee de un contexto provider (si existe)

**Paso 6.2.** Reemplazar:

```tsx
// Antes:
<Link href="/refugio/intake">Registrar ingreso</Link>

// Después:
<Link href={`/org/${orgToken}/intake`}>Registrar ingreso</Link>
```

Para Links con parámetros dinámicos (e.g., `/refugio/mascotas/${petToken}`), ambos tokens viajan en la URL:

```tsx
<Link href={`/org/${orgToken}/mascotas/${petToken}`}>Ver detalle</Link>
```

**Paso 6.3.** Si un componente que está deep en el tree necesita orgToken pero no lo recibe, dos opciones:
1. Pasarlo como prop desde el padre (preferible — explicit, no magic)
2. Crear un Context provider OrgTokenContext en el layout y consumirlo en el child (menos preferible, agrega indirección)

Para v1, opción 1. Si después se vuelve tedioso, refactorizar a context.

### Paso 7 — Update de server actions

`grep` por `redirect\(.*/refugio` en `app/actions/*.ts`. Cada uno:

**Paso 7.1.** La signature del action típicamente recibe `publicToken` (pet token). Si necesita el orgToken, agregárselo como argumento:

```ts
// Antes:
export async function createIntakeAction(
  _previous: IntakeFormState,
  formData: FormData,
): Promise<IntakeFormState> {
  // ...
  redirect("/refugio/mascotas");
}

// Después:
export async function createIntakeAction(
  orgToken: string,
  _previous: IntakeFormState,
  formData: FormData,
): Promise<IntakeFormState> {
  // ... existing logic
  redirect(`/org/${orgToken}/mascotas`);
}
```

**Paso 7.2.** En el page que monta el form, hacer el `.bind(null, orgToken, ...)`:

```ts
const boundAction = createIntakeAction.bind(null, orgToken);
// pass boundAction to form component
```

Algunos actions pueden no necesitar orgToken — si el redirect es a otro module (e.g., `/`, `/mis-mascotas`), dejarlo igual. Solo los que redirigen DENTRO del portal org necesitan el orgToken.

### Paso 8 — Middleware redirect

Crear o extender `middleware.ts` en root:

```ts
// middleware.ts
import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Redirect old /refugio/* URLs to /org (the org index, where multi-org
  // users pick which org to work as). We don't try to resolve to a specific
  // /org/[orgToken]/... because we'd have to guess which org for users
  // with multiple memberships.
  if (pathname === "/refugio" || pathname.startsWith("/refugio/")) {
    return NextResponse.redirect(new URL("/org", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/refugio", "/refugio/:path*"],
};
```

Si ya existe `middleware.ts` (para auth de Supabase), extender el handler para incluir este check.

### Paso 9 — Tests update

**Paso 9.1.** Tests E2E que naveguen a `/refugio/*`:
- Actualizar URLs a `/org/${seedOrgToken}/*` donde `seedOrgToken` viene del fixture de la org del test

**Paso 9.2.** Tests unitarios de server actions que asserten redirect:
- Actualizar el redirect target

**Paso 9.3.** Tests de capabilities / auth:
- Si hardcodean ruta, actualizar
- Si testean lógica del helper viejo `requireActiveOrgOrRedirect`, refactor a testear `requireOrgAccessByToken`

**Paso 9.4.** Smoke test: agregar un test nuevo que verifica el redirect del middleware:

```ts
it("redirects /refugio/intake to /org for backward compat", async () => {
  const response = await fetch("/refugio/intake", { redirect: "manual" });
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toContain("/org");
});
```

### Paso 10 — Final cleanup

**Paso 10.1.** Buscar refs residuales:

```bash
rg "/refugio" --type-add 'ts:*.{ts,tsx}' --type ts -n
```

Debería retornar cero (excepto comments explícitos sobre el rename, que están bien) o solo `middleware.ts` matching el legacy redirect.

**Paso 10.2.** Verificar que `app/refugio/` no existe:

```bash
ls app/refugio 2>/dev/null || echo "Folder removed correctly"
```

**Paso 10.3.** Verificar imports — TypeScript se va a quejar si quedó algún import roto.

## 6. Verificación

1. **Typecheck.** `pnpm typecheck` cero errores.
2. **Lint.** `pnpm lint` cero errores nuevos.
3. **Tests.** `pnpm test` todos verdes (incluyendo los actualizados).
4. **Build.** `pnpm build` compila.
5. **Smoke manual:**
   - Login como user con UNA membership org → al ir a `/org` debería auto-redirigir a `/org/[su-org-token]`
   - Login como user con MÚLTIPLES memberships → `/org` muestra picker
   - Login como user SIN memberships → `/org` muestra empty state con CTA
   - Navegar a `/org/[org-X-token]/intake` siendo miembro de X → renderiza el form
   - Navegar a `/org/[org-Y-token]/intake` NO siendo miembro de Y → 404
   - Bookmark viejo `/refugio/intake` → redirige a `/org`
   - Crear un intake (flujo end-to-end) → funciona igual que antes, redirect destino es `/org/[orgToken]/mascotas` o similar
   - El feature de transfer org-to-org (si hay tests E2E) → funciona
   - El feature de foster assign → funciona
   - El feature de adoption finalize → funciona

6. **No-regression check.** Lo que antes funcionaba en `/refugio/*` debe funcionar IDÉNTICAMENTE en `/org/[orgToken]/*`. Si algún flow cambió comportamiento, es bug, no expected.

## 7. Casos borde y trampas

- **Server actions invocadas desde forms con `.bind(null, ...)`.** Si una action ya recibe args (e.g., `publicToken`) y vos agregás `orgToken` adelante, hay que actualizar AMBOS lados — la signature de la action AND el `.bind` del component. Si solo tocás uno, los args se desalinean en runtime.
- **`useActionState` cuando se cambia signature.** El form re-renderiza con state inicial cuando los args cambian. No es problema funcional pero puede ser confuso si los tests lo ven.
- **Email links / notification URLs ya emitidas.** Las notifications en `notifications.cta_url` que apunten a `/refugio/...` siguen funcionando vía middleware redirect. Pero el redirect es a `/org` genérico, no al destino original — si el user clickea desde una notif vieja, llega al picker, no al detalle específico. Aceptable como graceful degradation; no vale la pena hacer migración de strings en filas existentes.
- **Componentes que usan paths absolutos en strings.** Si algún archivo tiene `const ROUTE = "/refugio/intake"` y luego lo concatena, encontralo y actualizalo. El grep del paso 1 debería haberlo capturado.
- **Tests E2E con login + nav.** Si los tests hardcodean `/refugio` en `page.goto()`, actualizar para usar `page.goto(\`/org/${seedOrgToken}\`)`.
- **`useRouter().push("/refugio/...")`** en client components — mismo tratamiento que Links.
- **Capability checks que asuman estado de session.** El helper `requireActiveOrgOrRedirect` probablemente leía cookies para saber qué org era "active". Esa cookie / state ya no es necesaria. Si hay código que lee/escribe esa cookie, removerlo.

## 8. Cuando termines

1. Marcá los chequeos de §6 como hechos
2. Reportá a Nacho:
   - Lista final de archivos movidos (output de `git log --name-status` del último commit)
   - Conteo de Links updateados (aproximado)
   - Tests añadidos/modificados
   - Cualquier caso borde que encontraste no anticipado
3. Commit message sugerido:
   ```
   refactor(routes): rename /refugio/* → /org/[orgToken]/*

   Generalizes the org portal from refugio-specific to all org types
   (clinic, shelter, rescue_network, sanitary_authority, other). The
   orgToken (organizations.publicToken, format ORG-XXXX-XXXX) is now
   an explicit segment of the URL instead of inferring active-org from
   session state.

   - Moves app/refugio/* → app/org/[orgToken]/* via git mv (history preserved)
   - New app/org/page.tsx index — single-membership users auto-redirect,
     multi-membership users get a picker
   - New app/org/[orgToken]/layout.tsx validates active membership for the
     orgToken; returns 404 if not (no leak of org existence)
   - Refactors lib/auth-guards: requireActiveOrgOrRedirect →
     requireOrgAccessByToken(orgToken)
   - Updates all internal Link href and server-action redirect targets
   - Middleware redirects /refugio/* → /org for backward-compat bookmarks
   - Zero functional changes; only routing structure

   Unblocks:
   - plans/2026-05-16-health-campaigns-and-scheduling.md (heavy /refugio refs)
   - plans/2026-05-17-lost-and-found-complete.md (some /refugio refs)
   ```
4. Marcar en `docs/superpowers/README.md` que este rename está completo (cambiar el status del corresponiente plan a ✅ Implementado)

## 9. Lo que viene después

Una vez este rename mergea, los siguientes planes ya tienen path consistency y pueden ejecutarse sin retoques:

- `2026-05-16-health-campaigns-and-scheduling.md` — usará `/org/[orgToken]/servicios`, `/org/[orgToken]/agenda` directamente
- `2026-05-17-lost-and-found-complete.md` — usará `/org/[orgToken]/mascotas/[publicToken]/devolver-al-dueno`

Los planes que NO dependían de este rename (libreta sanitaria, event-agent foundations, symptom surveillance) podían haber corrido en paralelo. Si todavía no corrieron, ahora también pueden.

Lo que sigue sin existir (PRs futuros):
- Implementación de `/profesional` route group para vets independientes
- Schema migration de `service_offerings` polymorphic (org_id O provider_user_id)
- Implementación de `/gobierno` route group (parte del admin page plan)
- Implementación final del admin page con su split `/admin` + `/gobierno`
