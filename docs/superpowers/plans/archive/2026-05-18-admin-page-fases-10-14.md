# Plan ejecutable — Admin page Fases 10-14

> Implementa las cinco fases definidas en `docs/superpowers/specs/2026-05-18-admin-page-next-phases-design.md` v3.0. Cada fase es un PR independiente. Las fases 11-14 no tienen dependencias entre sí. La Fase 10 requiere que `plans/2026-05-18-event-catalog-cleanup.md` esté aplicado primero (necesita event_types `custody_dispute_raised/resolved` y columna `pets.in_custody_dispute`).
>
> **Fecha:** 2026-05-18
> **Owner del plan:** Claude Code
> **Pre-lectura obligatoria:**
> - `AGENTS.md` end-to-end
> - `docs/superpowers/specs/2026-05-17-admin-page-design.md` v2.3
> - `docs/superpowers/specs/2026-05-18-admin-page-next-phases-design.md` v3.0
> - Para Fase 10: `docs/superpowers/plans/2026-05-18-event-catalog-cleanup.md`
> - Para Fase 11: `docs/superpowers/plans/2026-05-17-symptom-disease-surveillance.md`
> - Para Fase 14: `docs/superpowers/plans/2026-05-18-scheduling-24h-reminder-cron-todo.md` (similar cron pattern)

## Orden recomendado

1. **Fase 11** (govt dashboards) — sin schema, da valor visible inmediato, low risk.
2. **Fase 12** (admin metrics) — sin schema crítico, idem.
3. **Fase 13** (bulk ops) — sin schema, refactor UX.
4. **Fase 14** (cron + cron_runs table) — pequeña migración, requiere Vercel Cron config.
5. **Fase 10** (custody disputes) — después de cleanup plan. La fase más grande.

Podés reordenar 10 al frente si el cleanup ya se aplicó.

---

## 0. Antes de tocar nada

```bash
# Verificar baseline limpio
cd <repo>
git status                 # debe estar limpio
git checkout main
git pull
pnpm install
pnpm test                  # debe pasar
pnpm typecheck             # debe pasar
```

Crear branch base:

```bash
git checkout -b admin-fases-10-14-base
```

Y dentro de esa branch, una sub-branch por fase. Mergeas cada fase a main antes de empezar la siguiente.

---

## Fase 11 — Govt regional dashboards

### Fase 11 — Qué se construye

- Ruta `/gob/vigilancia` con feed de `outbreak_signal` events filtrados al scope del govt (universal para admin).
- Ruta `/gob/perdidas` con feed de pets en status='lost' filtrados al scope.
- Helpers en `lib/govt-dashboards.ts` con queries SQL puras + tests.
- Updates al `/gob/page.tsx` dashboard con cards link a las dos vistas nuevas.
- Updates al `app/gob/layout.tsx` nav con dos links nuevos.

Sin schema. Sin server actions de escritura. Pure read.

### Fase 11 — Archivos

**Nuevos:**
- `lib/govt-dashboards.ts`
- `lib/govt-dashboards.test.ts`
- `app/gob/vigilancia/page.tsx`
- `app/gob/vigilancia/_components/SurveillanceFiltersBar.tsx` (client component para filtros)
- `app/gob/vigilancia/_components/DiseaseSummaryTable.tsx`
- `app/gob/perdidas/page.tsx`
- `app/gob/perdidas/_components/LostFiltersBar.tsx`

**Modificados:**
- `app/gob/layout.tsx` — agregar links "Vigilancia" + "Pérdidas"
- `app/gob/page.tsx` — agregar cards a las dos vistas nuevas

### Fase 11 — Paso 1: `lib/govt-dashboards.ts`

Crear archivo con dos funciones principales:

```ts
import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db, govtAssignments, ownerships, petEvents, pets, profiles } from "@/db";
import type { AdminOrGovtJurisdiction } from "@/lib/auth-guards";

export type SurveillanceFilters = {
  since: Date;                 // inclusive
  diseaseCode?: string;        // optional filter
  province?: string;           // optional filter (subset of jurisdictions)
  locality?: string;
};

export type SurveillanceSignal = {
  signalEventId: string;
  petId: string;
  petPublicToken: string;
  petDisplayName: string;
  diseaseCode: string;
  diseaseName: string;          // resolved from catalog
  jurisdictionProvince: string;
  jurisdictionLocality: string;
  detectedAt: Date;
};

export type DiseaseSummary = {
  diseaseCode: string;
  count30d: number;
  count7d: number;
  count24h: number;
};

export async function fetchSurveillanceSignals(
  actor: { role: "admin" | "govt"; id: string },
  jurisdictions: AdminOrGovtJurisdiction[],
  filters: SurveillanceFilters,
): Promise<SurveillanceSignal[]> {
  // Build the scope clause. Admin: no scope filter. Govt: payload's
  // jurisdiction_province + jurisdiction_locality must match one of the
  // actor's active govt_assignments.
  const baseConditions = [
    eq(petEvents.eventType, "outbreak_signal"),
    gte(petEvents.occurredAt, filters.since),
  ];

  // Apply optional explicit filters from UI
  if (filters.diseaseCode) {
    baseConditions.push(sql`${petEvents.payload}->>'disease_code' = ${filters.diseaseCode}`);
  }
  if (filters.province && filters.locality) {
    baseConditions.push(sql`${petEvents.payload}->>'jurisdiction_province' = ${filters.province}`);
    baseConditions.push(sql`${petEvents.payload}->>'jurisdiction_locality' = ${filters.locality}`);
  }

  // Govt scope clause: at least one assignment must match the signal's
  // jurisdiction. For admin, no scope check.
  if (actor.role === "govt") {
    if (jurisdictions.length === 0) return [];
    // Build a SQL OR clause: (province='X' AND locality='Y') OR (province='X' AND locality='Z') ...
    const scopeClause = sql.join(
      jurisdictions.map(
        (j) => sql`(${petEvents.payload}->>'jurisdiction_province' = ${j.province} AND ${petEvents.payload}->>'jurisdiction_locality' = ${j.locality})`,
      ),
      sql` OR `,
    );
    baseConditions.push(sql`(${scopeClause})`);
  }

  const rows = await db
    .select({
      signalEventId: petEvents.id,
      petId: pets.id,
      petPublicToken: pets.publicToken,
      petDisplayName: pets.displayName,
      diseaseCode: sql<string>`(${petEvents.payload}->>'disease_code')`,
      jurisdictionProvince: sql<string>`(${petEvents.payload}->>'jurisdiction_province')`,
      jurisdictionLocality: sql<string>`(${petEvents.payload}->>'jurisdiction_locality')`,
      detectedAt: petEvents.occurredAt,
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...baseConditions))
    .orderBy(desc(petEvents.occurredAt))
    .limit(500);

  // Resolve disease names from catalog (assumes lib/reportable-diseases.ts exists from surveillance feature)
  const { REPORTABLE_DISEASES } = await import("@/lib/reportable-diseases");
  return rows.map((r) => ({
    signalEventId: r.signalEventId,
    petId: r.petId,
    petPublicToken: r.petPublicToken,
    petDisplayName: r.petDisplayName,
    diseaseCode: r.diseaseCode,
    diseaseName: REPORTABLE_DISEASES[r.diseaseCode]?.name ?? r.diseaseCode,
    jurisdictionProvince: r.jurisdictionProvince,
    jurisdictionLocality: r.jurisdictionLocality,
    detectedAt: r.detectedAt,
  }));
}

export async function fetchDiseaseSummary(
  actor: { role: "admin" | "govt"; id: string },
  jurisdictions: AdminOrGovtJurisdiction[],
): Promise<DiseaseSummary[]> {
  // Aggregate over 30d window
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const all = await fetchSurveillanceSignals(actor, jurisdictions, { since: since30 });

  const byDisease = new Map<string, { count30d: number; count7d: number; count24h: number }>();
  const now = Date.now();
  for (const s of all) {
    const ageMs = now - s.detectedAt.getTime();
    const e = byDisease.get(s.diseaseCode) ?? { count30d: 0, count7d: 0, count24h: 0 };
    e.count30d += 1;
    if (ageMs <= 7 * 24 * 60 * 60 * 1000) e.count7d += 1;
    if (ageMs <= 24 * 60 * 60 * 1000) e.count24h += 1;
    byDisease.set(s.diseaseCode, e);
  }

  return Array.from(byDisease.entries())
    .map(([diseaseCode, counts]) => ({ diseaseCode, ...counts }))
    .sort((a, b) => b.count30d - a.count30d);
}

export type LostPetRow = {
  petId: string;
  petPublicToken: string;
  petDisplayName: string;
  species: string;
  markedLostAt: Date | null;
  ownerDisplayName: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  lastSeenLat: number | null;
  lastSeenLng: number | null;
};

export async function fetchLostPets(
  actor: { role: "admin" | "govt"; id: string },
  jurisdictions: AdminOrGovtJurisdiction[],
  filters: { since: Date; species?: string },
): Promise<LostPetRow[]> {
  const baseConditions = [eq(pets.status, "lost")];

  // Owner-locality scope: lookup via active ownership → owner profile → profile.jurisdiction_*.
  // Profile may or may not have jurisdiction columns; if missing, fallback to pet.
  // For v1 we treat the latest status_changed payload.context_locality if present,
  // else owner.locality. Defer to actual data shape — adjust if tests fail.

  const rows = await db
    .select({
      petId: pets.id,
      petPublicToken: pets.publicToken,
      petDisplayName: pets.displayName,
      species: pets.species,
      ownerUserId: ownerships.ownerUserId,
      lastSeenLat: pets.lastSeenLat,
      lastSeenLng: pets.lastSeenLng,
    })
    .from(pets)
    .leftJoin(ownerships, and(eq(ownerships.petId, pets.id), isNull(ownerships.endedAt)))
    .where(and(...baseConditions))
    .limit(500);

  // For each row, derive markedLostAt from latest status_changed → 'lost' event
  const petIds = rows.map((r) => r.petId);
  if (petIds.length === 0) return [];

  const lostEvents = await db
    .select({
      petId: petEvents.petId,
      occurredAt: petEvents.occurredAt,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(
      and(
        sql`${petEvents.petId} = ANY(${petIds})`,
        eq(petEvents.eventType, "status_changed"),
        sql`${petEvents.payload}->>'new_status' = 'lost'`,
      ),
    )
    .orderBy(desc(petEvents.occurredAt));

  const lostAtByPet = new Map<string, Date>();
  const lostJurisByPet = new Map<string, { province: string | null; locality: string | null }>();
  for (const e of lostEvents) {
    if (!lostAtByPet.has(e.petId)) {
      lostAtByPet.set(e.petId, e.occurredAt);
      const payload = e.payload as Record<string, unknown>;
      lostJurisByPet.set(e.petId, {
        province: (payload?.locality_context as Record<string, string> | null)?.province ?? null,
        locality: (payload?.locality_context as Record<string, string> | null)?.locality ?? null,
      });
    }
  }

  // Apply scope (govt) and species filter
  const ownerIds = rows.map((r) => r.ownerUserId).filter(Boolean) as string[];
  const ownerJuris = new Map<string, { province: string | null; locality: string | null }>();
  if (ownerIds.length > 0) {
    const ownerRows = await db
      .select({ id: profiles.id, displayName: profiles.displayName })
      .from(profiles)
      .where(sql`${profiles.id} = ANY(${ownerIds})`);
    for (const o of ownerRows) {
      ownerJuris.set(o.id, { province: null, locality: null }); // jurisdiction lives elsewhere; fallback to status_changed payload
    }
  }

  return rows
    .map((r): LostPetRow => {
      const lostJuris = lostJurisByPet.get(r.petId) ?? { province: null, locality: null };
      return {
        petId: r.petId,
        petPublicToken: r.petPublicToken,
        petDisplayName: r.petDisplayName,
        species: r.species,
        markedLostAt: lostAtByPet.get(r.petId) ?? null,
        ownerDisplayName: null,
        jurisdictionProvince: lostJuris.province,
        jurisdictionLocality: lostJuris.locality,
        lastSeenLat: r.lastSeenLat ? Number(r.lastSeenLat) : null,
        lastSeenLng: r.lastSeenLng ? Number(r.lastSeenLng) : null,
      };
    })
    .filter((r) => (filters.species ? r.species === filters.species : true))
    .filter((r) => (r.markedLostAt ? r.markedLostAt >= filters.since : true))
    .filter((r) => {
      if (actor.role === "admin") return true;
      if (!r.jurisdictionProvince || !r.jurisdictionLocality) return false; // can't scope-match unknown locality
      return jurisdictions.some(
        (j) => j.province === r.jurisdictionProvince && j.locality === r.jurisdictionLocality,
      );
    })
    .sort((a, b) => (b.markedLostAt?.getTime() ?? 0) - (a.markedLostAt?.getTime() ?? 0));
}
```

### Fase 11 — Paso 2: Test `lib/govt-dashboards.test.ts`

Test fixtures: 5 pets, 3 outbreak_signal events en distintas localities + 2 pets en status='lost'. Verifica:
- `fetchSurveillanceSignals` con admin retorna todos
- `fetchSurveillanceSignals` con govt con scope = solo CABA-Caballito retorna sólo el signal de esa locality
- `fetchDiseaseSummary` agrupa correctamente
- `fetchLostPets` aplica species filter
- `fetchLostPets` con govt scope retorna sólo pets en su scope

Run: `pnpm test lib/govt-dashboards.test.ts`. Debe pasar.

### Fase 11 — Paso 3: `app/gob/vigilancia/page.tsx`

```tsx
import { Suspense } from "react";

import { SurveillanceFiltersBar } from "./_components/SurveillanceFiltersBar";
import { DiseaseSummaryTable } from "./_components/DiseaseSummaryTable";
import { requireAdminOrGovtOrRedirect } from "@/lib/auth-guards";
import { fetchSurveillanceSignals, fetchDiseaseSummary } from "@/lib/govt-dashboards";

const DAY = 24 * 60 * 60 * 1000;

export default async function GobVigilanciaPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; disease?: string }>;
}) {
  const { profile, jurisdictions } = await requireAdminOrGovtOrRedirect();
  const sp = await searchParams;
  const days = Math.max(1, Math.min(90, Number(sp.days ?? 30) || 30));
  const since = new Date(Date.now() - days * DAY);

  const [signals, summary] = await Promise.all([
    fetchSurveillanceSignals(
      { role: profile.role, id: profile.id },
      jurisdictions,
      { since, diseaseCode: sp.disease },
    ),
    fetchDiseaseSummary({ role: profile.role, id: profile.id }, jurisdictions),
  ]);

  // PLACEHOLDERS para vaccination coverage + mortality clusters (Fase 17+18)
  return (
    <main className="px-6 py-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
            Vigilancia epidemiológica
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Señales de zoonosis y enfermedades reportables en tu cobertura.
          </p>
        </header>

        <SurveillanceFiltersBar days={days} diseaseCode={sp.disease ?? null} />

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Resumen por enfermedad</h2>
          <DiseaseSummaryTable summary={summary} />
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Detalle ({signals.length})</h2>
          {signals.length === 0 ? (
            <p className="text-sm text-neutral-500">No hay señales en este período.</p>
          ) : (
            <ul className="space-y-2">
              {signals.map((s) => (
                <li key={s.signalEventId} className="rounded-lg border border-neutral-200 dark:border-neutral-800 px-4 py-3">
                  <p className="text-sm font-medium">{s.diseaseName}</p>
                  <p className="text-xs text-neutral-500">
                    {s.jurisdictionLocality}, {s.jurisdictionProvince} ·{" "}
                    {new Date(s.detectedAt).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}
                  </p>
                  <p className="text-[10px] text-neutral-400 font-mono">{s.petPublicToken}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* TODO Fase 17 — Vaccination coverage placeholder */}
        <section className="rounded-lg border border-dashed border-neutral-200 dark:border-neutral-800 p-4 space-y-2">
          <p className="text-xs uppercase tracking-wider text-neutral-500">Cobertura de vacunación</p>
          <p className="text-sm text-neutral-500">Próximamente.</p>
        </section>

        {/* TODO Fase 17 — Mortality clusters placeholder */}
        <section className="rounded-lg border border-dashed border-neutral-200 dark:border-neutral-800 p-4 space-y-2">
          <p className="text-xs uppercase tracking-wider text-neutral-500">Clusters de mortalidad</p>
          <p className="text-sm text-neutral-500">Próximamente.</p>
        </section>
      </div>
    </main>
  );
}
```

Component `SurveillanceFiltersBar` (client): `<form>` con `<select>` de días y `<select>` de disease. Submits navigate to `?days=X&disease=Y`. `DiseaseSummaryTable` (server): tabla simple con count30d / 7d / 24h.

### Fase 11 — Paso 4: `app/gob/perdidas/page.tsx`

Similar pattern. Tabla con pet (mini-foto opcional, nombre), tiempo perdido (ahora - markedLostAt formateado humano), owner, ubicación (coords + link a OpenStreetMap si lat/lng presentes), link al `/p/[publicToken]`.

### Fase 11 — Paso 5: Nav updates

Editar `app/gob/layout.tsx`. Después del link "Servicios", agregar:

```tsx
<Link href="/gob/vigilancia" className="text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-50">
  Vigilancia
</Link>
<Link href="/gob/perdidas" className="text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-50">
  Pérdidas
</Link>
```

Editar `app/gob/page.tsx`. Después de la sección "Solicitudes por tipo", agregar dos cards:

```tsx
<section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
  <CardLink label="Vigilancia" description="Señales de zoonosis en tu cobertura" href="/gob/vigilancia" />
  <CardLink label="Pérdidas" description="Pets perdidos en tu cobertura" href="/gob/perdidas" />
</section>
```

### Fase 11 — Verificación

```bash
pnpm test
pnpm typecheck
pnpm build  # next.js build, debe pasar
pnpm dev    # navegar a /gob/vigilancia y /gob/perdidas como admin, como govt con scope, como govt sin scope
```

### Fase 11 — Commit

```
feat(gob): regional dashboards — vigilancia + pérdidas

Adds /gob/vigilancia (outbreak signals filtered to scope) and
/gob/perdidas (lost pets filtered to scope). Read-only over existing
tables (pet_events, pets, ownerships). No schema.

Placeholders for vaccination coverage and mortality clusters
(Fase 17+18 per spec).
```

---

## Fase 12 — Admin system metrics

### Fase 12 — Qué se construye

Ruta `/admin/sistema` con 4 cards de métricas operativas. Sin schema (cron_runs aparece en Fase 14, hasta entonces mostrar "Sin runs registrados").

### Fase 12 — Archivos

**Nuevos:**
- `lib/admin-metrics.ts`
- `lib/admin-metrics.test.ts`
- `app/admin/sistema/page.tsx`

**Modificados:**
- `app/admin/layout.tsx` — agregar link "Sistema"
- `app/admin/page.tsx` — link directo desde el dashboard

### Fase 12 — Paso 1: `lib/admin-metrics.ts`

```ts
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, approvalRequests, auditLog, govtAssignments, profiles } from "@/db";

const DAY = 24 * 60 * 60 * 1000;

export type UserMetrics = {
  totalPersonal: number;
  totalInstitutionalActive: number;
  new24h: number;
  new7d: number;
  new30d: number;
};

export type QueueHealth = {
  pendingTotal: number;
  oldestPendingDaysAgo: number | null;
  pending14dPlus: number;
  pending30dPlus: number;
  pending60dPlus: number;
};

export type DecisionsMetrics = {
  approved7d: number;
  rejected7d: number;
  approved30d: number;
  rejected30d: number;
  revocations30d: number;
};

export type GovtActivityRow = {
  userId: string;
  displayName: string;
  localitiesCount: number;
  decisions30d: number;
  lastActionAt: Date | null;
};

export async function fetchUserMetrics(): Promise<UserMetrics> {
  const now = Date.now();
  const [row] = await db
    .select({
      totalPersonal: sql<number>`count(*) filter (where ${profiles.accountType} = 'personal')`,
      totalInstitutionalActive: sql<number>`count(*) filter (where ${profiles.accountType} = 'institutional' and ${profiles.deactivatedAt} is null)`,
      new24h: sql<number>`count(*) filter (where ${profiles.createdAt} >= ${new Date(now - 1 * DAY)})`,
      new7d: sql<number>`count(*) filter (where ${profiles.createdAt} >= ${new Date(now - 7 * DAY)})`,
      new30d: sql<number>`count(*) filter (where ${profiles.createdAt} >= ${new Date(now - 30 * DAY)})`,
    })
    .from(profiles);
  return {
    totalPersonal: Number(row.totalPersonal),
    totalInstitutionalActive: Number(row.totalInstitutionalActive),
    new24h: Number(row.new24h),
    new7d: Number(row.new7d),
    new30d: Number(row.new30d),
  };
}

export async function fetchQueueHealth(): Promise<QueueHealth> {
  const now = Date.now();
  const [row] = await db
    .select({
      pendingTotal: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending')`,
      oldestPendingMs: sql<number | null>`extract(epoch from (now() - min(${approvalRequests.createdAt}) filter (where ${approvalRequests.status} = 'pending'))) * 1000`,
      pending14dPlus: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending' and ${approvalRequests.createdAt} < ${new Date(now - 14 * DAY)})`,
      pending30dPlus: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending' and ${approvalRequests.createdAt} < ${new Date(now - 30 * DAY)})`,
      pending60dPlus: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending' and ${approvalRequests.createdAt} < ${new Date(now - 60 * DAY)})`,
    })
    .from(approvalRequests);
  return {
    pendingTotal: Number(row.pendingTotal),
    oldestPendingDaysAgo: row.oldestPendingMs ? Math.floor(Number(row.oldestPendingMs) / DAY) : null,
    pending14dPlus: Number(row.pending14dPlus),
    pending30dPlus: Number(row.pending30dPlus),
    pending60dPlus: Number(row.pending60dPlus),
  };
}

export async function fetchDecisionsMetrics(): Promise<DecisionsMetrics> {
  const now = Date.now();
  const [row] = await db
    .select({
      approved7d: sql<number>`count(*) filter (where ${auditLog.action} = 'request_approved' and ${auditLog.performedAt} >= ${new Date(now - 7 * DAY)})`,
      rejected7d: sql<number>`count(*) filter (where ${auditLog.action} = 'request_rejected' and ${auditLog.performedAt} >= ${new Date(now - 7 * DAY)})`,
      approved30d: sql<number>`count(*) filter (where ${auditLog.action} = 'request_approved' and ${auditLog.performedAt} >= ${new Date(now - 30 * DAY)})`,
      rejected30d: sql<number>`count(*) filter (where ${auditLog.action} = 'request_rejected' and ${auditLog.performedAt} >= ${new Date(now - 30 * DAY)})`,
      revocations30d: sql<number>`count(*) filter (where ${auditLog.action} like 'revocation_%' and ${auditLog.performedAt} >= ${new Date(now - 30 * DAY)})`,
    })
    .from(auditLog);
  return {
    approved7d: Number(row.approved7d),
    rejected7d: Number(row.rejected7d),
    approved30d: Number(row.approved30d),
    rejected30d: Number(row.rejected30d),
    revocations30d: Number(row.revocations30d),
  };
}

export async function fetchGovtActivity(): Promise<GovtActivityRow[]> {
  // Drizzle no soporta lateral subselects natively, hacemos dos roundtrips
  const govts = await db
    .select({ id: profiles.id, displayName: profiles.displayName })
    .from(profiles)
    .where(
      and(
        eq(profiles.role, "govt"),
        eq(profiles.accountType, "institutional"),
        sql`${profiles.deactivatedAt} is null`,
      ),
    );

  if (govts.length === 0) return [];

  const govtIds = govts.map((g) => g.id);
  const localitiesByGovt = new Map<string, number>();
  const decisionsByGovt = new Map<string, number>();
  const lastActionByGovt = new Map<string, Date>();

  // Localities count
  const locRows = await db
    .select({
      userId: govtAssignments.userId,
      cnt: sql<number>`count(distinct (${govtAssignments.jurisdictionProvince}, ${govtAssignments.jurisdictionLocality}))`,
    })
    .from(govtAssignments)
    .where(and(sql`${govtAssignments.userId} = ANY(${govtIds})`, sql`${govtAssignments.revokedAt} is null`))
    .groupBy(govtAssignments.userId);
  for (const r of locRows) localitiesByGovt.set(r.userId, Number(r.cnt));

  // Decisions count
  const since30 = new Date(Date.now() - 30 * DAY);
  const decRows = await db
    .select({
      actorUserId: auditLog.actorUserId,
      cnt: sql<number>`count(*)`,
    })
    .from(auditLog)
    .where(
      and(
        sql`${auditLog.actorUserId} = ANY(${govtIds})`,
        sql`${auditLog.action} in ('request_approved','request_rejected')`,
        gte(auditLog.performedAt, since30),
      ),
    )
    .groupBy(auditLog.actorUserId);
  for (const r of decRows) decisionsByGovt.set(r.actorUserId, Number(r.cnt));

  // Last action per govt
  const lastRows = await db
    .select({ actorUserId: auditLog.actorUserId, lastAt: sql<Date>`max(${auditLog.performedAt})` })
    .from(auditLog)
    .where(sql`${auditLog.actorUserId} = ANY(${govtIds})`)
    .groupBy(auditLog.actorUserId);
  for (const r of lastRows) lastActionByGovt.set(r.actorUserId, r.lastAt);

  return govts.map((g) => ({
    userId: g.id,
    displayName: g.displayName,
    localitiesCount: localitiesByGovt.get(g.id) ?? 0,
    decisions30d: decisionsByGovt.get(g.id) ?? 0,
    lastActionAt: lastActionByGovt.get(g.id) ?? null,
  }));
}

// Placeholder for Fase 14 — sin tabla todavía, retorna []
export async function fetchCronRuns(): Promise<CronRunRow[]> {
  // TODO Fase 14: lee de cron_runs table
  return [];
}

export type CronRunRow = {
  cronName: string;
  lastRunAt: Date | null;
  lastStatus: "ok" | "failed" | "running" | null;
  itemsProcessed: number | null;
};
```

### Fase 12 — Paso 2: Test `lib/admin-metrics.test.ts`

Fixtures: 3 personal users, 2 institutional (1 govt 1 admin), 4 pending approval_requests (1 fresh, 1 14d old, 1 30d old, 1 60d old), 2 approved + 1 rejected in last 7d, 1 revocation_vet in last 30d. Verifica que las funciones devuelvan los counts correctos.

### Fase 12 — Paso 3: `app/admin/sistema/page.tsx`

```tsx
import { requireAdminOrRedirect } from "@/lib/auth-guards";
import {
  fetchUserMetrics,
  fetchQueueHealth,
  fetchDecisionsMetrics,
  fetchGovtActivity,
  fetchCronRuns,
} from "@/lib/admin-metrics";

export default async function AdminSistemaPage() {
  await requireAdminOrRedirect();

  const [users, queue, decisions, govts, crons] = await Promise.all([
    fetchUserMetrics(),
    fetchQueueHealth(),
    fetchDecisionsMetrics(),
    fetchGovtActivity(),
    fetchCronRuns(),
  ]);

  return (
    <main className="px-6 py-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <header><h1 className="text-3xl font-semibold">Salud del sistema</h1></header>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Card title="Usuarios">
            <Stat label="Total personal" value={users.totalPersonal} />
            <Stat label="Total institucional activo" value={users.totalInstitutionalActive} />
            <Stat label="Nuevos 24h / 7d / 30d" value={`${users.new24h} / ${users.new7d} / ${users.new30d}`} />
          </Card>
          <Card title="Cola">
            <Stat label="Pendientes" value={queue.pendingTotal} />
            <Stat label="Más vieja (días)" value={queue.oldestPendingDaysAgo ?? "—"} />
            <Stat label="14d+ / 30d+ / 60d+" value={`${queue.pending14dPlus} / ${queue.pending30dPlus} / ${queue.pending60dPlus}`} />
          </Card>
          <Card title="Decisiones">
            <Stat label="Aprobadas 7d / 30d" value={`${decisions.approved7d} / ${decisions.approved30d}`} />
            <Stat label="Rechazadas 7d / 30d" value={`${decisions.rejected7d} / ${decisions.rejected30d}`} />
            <Stat label="Revocaciones 30d" value={decisions.revocations30d} />
          </Card>
          <Card title="Crons (Fase 14)">
            {crons.length === 0 ? (
              <p className="text-sm text-neutral-500">Sin runs registrados. Tabla cron_runs aparece en Fase 14.</p>
            ) : (
              <ul>...</ul>
            )}
          </Card>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Actividad por govt</h2>
          {govts.length === 0 ? (
            <p className="text-sm text-neutral-500">No hay govts activos.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-neutral-500">
                  <th>Govt</th><th>Localidades</th><th>Decisiones 30d</th><th>Última acción</th>
                </tr>
              </thead>
              <tbody>
                {govts.map((g) => (
                  <tr key={g.userId} className="border-t">
                    <td>{g.displayName}</td>
                    <td>{g.localitiesCount}</td>
                    <td>{g.decisions30d}</td>
                    <td>{g.lastActionAt ? new Date(g.lastActionAt).toLocaleDateString("es-AR") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </main>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 space-y-2">
      <p className="text-xs uppercase tracking-wider text-neutral-500">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-neutral-600 dark:text-neutral-400">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}
```

### Fase 12 — Paso 4: Nav

Editar `app/admin/layout.tsx`. Agregar link "Sistema" después de "Auditoría":

```tsx
<Link href="/admin/sistema" className="text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-50">
  Sistema
</Link>
```

Editar `app/admin/page.tsx`. Agregar card link a `/admin/sistema`.

### Fase 12 — Verificación

```bash
pnpm test
pnpm typecheck
pnpm dev      # navegar a /admin/sistema como admin
```

### Fase 12 — Commit

```
feat(admin): system health metrics dashboard

Adds /admin/sistema with user counts, queue health, decisions, and
govt activity. Read-only aggregations over existing tables.

Crons & jobs section is a placeholder until Fase 14 introduces
cron_runs table.
```

---

## Fase 13 — Bulk approval/revocation

### Fase 13 — Qué se construye

Multi-select + bulk action modal en las 6 queues: `/admin/cola`, `/gob/cola`, `/admin/usuarios`, `/gob/usuarios`, `/admin/organizaciones`, `/gob/organizaciones`. Server actions bulk que wrappean single-action.

### Fase 13 — Archivos

**Nuevos:**
- `app/actions/bulk-actions.ts` (nuevo archivo de server actions)
- `app/actions/bulk-actions.test.ts`
- `components/BulkActionBar.tsx` (client component reusable)
- `components/BulkConfirmModal.tsx`

**Modificados (6 pages):**
- `app/admin/cola/page.tsx`
- `app/gob/cola/page.tsx`
- `app/admin/usuarios/page.tsx`
- `app/gob/usuarios/page.tsx`
- `app/admin/organizaciones/page.tsx`
- `app/gob/organizaciones/page.tsx`

### Fase 13 — Paso 1: `app/actions/bulk-actions.ts`

```ts
"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";

import {
  approveRequestForAuthority,
  rejectRequestForAuthority,
} from "@/app/actions/admin-decisions";
import {
  revokeOrgVerificationForAuthority,
  revokeVetRoleForAuthority,
  revokeGovtLocalityForAuthority,
} from "@/app/actions/admin-revocations";
import { requireAdminOrGovtOrRedirect } from "@/lib/auth-guards";

type BulkResult = { succeeded: string[]; failed: { id: string; reason: string }[] };

export async function bulkApproveRequestsAction(input: {
  requestIds: string[];
  decisionNotes?: string;
}): Promise<BulkResult> {
  const session = await requireAdminOrGovtOrRedirect();
  const bulkActionId = randomUUID();
  const succeeded: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const id of input.requestIds) {
    try {
      await approveRequestForAuthority({
        approvalRequestPublicToken: id,
        actor: session.profile,
        decisionNotes: input.decisionNotes,
        bulkActionId,
      });
      succeeded.push(id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown_error";
      failed.push({ id, reason });
    }
  }

  revalidatePath("/admin/cola");
  revalidatePath("/gob/cola");
  return { succeeded, failed };
}

export async function bulkRejectRequestsAction(input: {
  requestIds: string[];
  decisionNotes: string;
}): Promise<BulkResult> {
  if (!input.decisionNotes || input.decisionNotes.trim().length < 30) {
    return { succeeded: [], failed: input.requestIds.map((id) => ({ id, reason: "decision_notes_too_short" })) };
  }
  const session = await requireAdminOrGovtOrRedirect();
  const bulkActionId = randomUUID();
  const succeeded: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const id of input.requestIds) {
    try {
      await rejectRequestForAuthority({
        approvalRequestPublicToken: id,
        actor: session.profile,
        decisionNotes: input.decisionNotes,
        bulkActionId,
      });
      succeeded.push(id);
    } catch (err) {
      failed.push({ id, reason: err instanceof Error ? err.message : "unknown_error" });
    }
  }

  revalidatePath("/admin/cola");
  revalidatePath("/gob/cola");
  return { succeeded, failed };
}

export async function bulkRevokeAction(input: {
  targetIds: string[];
  targetKind: "vet" | "org" | "govt_assignment";
  reason: string;
  attachmentIds: string[];
}): Promise<BulkResult> {
  if (!input.reason || input.reason.trim().length < 30) {
    return { succeeded: [], failed: input.targetIds.map((id) => ({ id, reason: "reason_too_short" })) };
  }
  if (input.attachmentIds.length === 0) {
    return { succeeded: [], failed: input.targetIds.map((id) => ({ id, reason: "evidence_required" })) };
  }
  const session = await requireAdminOrGovtOrRedirect();
  const bulkActionId = randomUUID();
  const succeeded: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const id of input.targetIds) {
    try {
      if (input.targetKind === "vet") {
        await revokeVetRoleForAuthority({
          targetUserId: id, actor: session.profile, reason: input.reason,
          attachmentIds: input.attachmentIds, bulkActionId,
        });
      } else if (input.targetKind === "org") {
        await revokeOrgVerificationForAuthority({
          targetOrgId: id, actor: session.profile, reason: input.reason,
          attachmentIds: input.attachmentIds, bulkActionId,
        });
      } else {
        await revokeGovtLocalityForAuthority({
          govtAssignmentId: id, actor: session.profile, reason: input.reason,
          attachmentIds: input.attachmentIds, bulkActionId,
        });
      }
      succeeded.push(id);
    } catch (err) {
      failed.push({ id, reason: err instanceof Error ? err.message : "unknown_error" });
    }
  }

  revalidatePath("/admin/usuarios");
  revalidatePath("/gob/usuarios");
  revalidatePath("/admin/organizaciones");
  revalidatePath("/gob/organizaciones");
  revalidatePath("/admin/govts");
  return { succeeded, failed };
}
```

**Importante**: las funciones `approveRequestForAuthority`, `rejectRequestForAuthority`, `revokeVetRoleForAuthority`, `revokeOrgVerificationForAuthority`, `revokeGovtLocalityForAuthority` necesitan aceptar `bulkActionId?: string` opcional para que el audit_log payload lleve la marca. Editar las 5 funciones en `admin-decisions.ts` y `admin-revocations.ts` para aceptar el parámetro opcional y propagarlo al insert de audit_log payload.

### Fase 13 — Paso 2: Component `components/BulkActionBar.tsx`

```tsx
"use client";

export function BulkActionBar({
  selectedCount, primaryAction, secondaryAction, onClear,
}: {
  selectedCount: number;
  primaryAction: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
  onClear: () => void;
}) {
  if (selectedCount === 0) return null;
  return (
    <div className="fixed bottom-0 left-0 right-0 border-t border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 z-50">
      <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between gap-3">
        <p className="text-sm">
          <span className="font-medium">{selectedCount}</span> seleccionada{selectedCount === 1 ? "" : "s"}
        </p>
        <div className="flex items-center gap-2">
          <button onClick={onClear} className="text-xs text-neutral-500 hover:text-neutral-700">Limpiar</button>
          {secondaryAction && (
            <button onClick={secondaryAction.onClick} className="rounded px-3 py-1.5 text-sm border border-red-200 text-red-700 hover:bg-red-50">
              {secondaryAction.label}
            </button>
          )}
          <button onClick={primaryAction.onClick} className="rounded px-3 py-1.5 text-sm bg-neutral-900 text-white">
            {primaryAction.label}
          </button>
        </div>
      </div>
    </div>
  );
}
```

`BulkConfirmModal` recibe target list + textarea + (si revoke) attachment uploader + submit handler.

### Fase 13 — Paso 3: Wire-up en las 6 pages

Para cada page, convertir la lista de rows en client component (o agregar wrapper client `<QueueRowsClient items={items} />`). Cada row tiene `<input type="checkbox">` con state local `Set<string>`. `BulkActionBar` aparece cuando size > 0. Al click, abre `BulkConfirmModal`. Modal submit llama al server action correspondiente.

Implementación detallada por page omitida — patrón uniforme; CC lo aplica replicando el primero a los otros cinco.

### Fase 13 — Tests

`app/actions/bulk-actions.test.ts`: fixture con 3 pending requests, 1 out-of-scope para govt. Verifica:
- `bulkApproveRequestsAction` con admin aprueba los 3
- `bulkApproveRequestsAction` con govt scope-limitado aprueba 2 y reporta 1 en failed con reason='out_of_scope'
- `bulkRejectRequestsAction` con decisionNotes < 30 chars no muta nada
- `bulkRevokeAction` sin evidence no muta nada

### Fase 13 — Verificación

```bash
pnpm test
pnpm typecheck
pnpm dev   # seleccionar 3 rows en /admin/cola, bulk approve, verificar audit_log entries con mismo bulk_action_id
```

### Fase 13 — Commit

```
feat(admin/gob): bulk approve, reject, and revoke in queues

Adds multi-select + BulkActionBar + BulkConfirmModal to the 6 queue
pages. Server actions in app/actions/bulk-actions.ts wrap single-
action paths and tag audit_log entries with shared bulk_action_id
in payload.

Capability checks per-item; out-of-scope items are reported in
failed[] without aborting the bulk operation.
```

---

## Fase 14 — Auto-expiry de solicitudes pending viejas

### Fase 14 — Qué se construye

- Tabla `cron_runs` (migration).
- Route `/api/cron/auto-expire-approvals` con CRON_SECRET auth.
- Cron schedule en `vercel.json` (daily 04:00 UTC).
- Hook en `fetchCronRuns` (Fase 12) para mostrar last_run.
- Audit log new action `approval_request_withdrawn_by_system`.
- Notification type `approval_request_auto_expired`.

### Fase 14 — Archivos

**Nuevos:**
- `db/migrations/0017_cron_runs.sql`
- `app/api/cron/auto-expire-approvals/route.ts`
- `app/api/cron/auto-expire-approvals/route.test.ts`
- `vercel.json` (si no existe; sino editar)

**Modificados:**
- `lib/admin-metrics.ts` — `fetchCronRuns` reads from `cron_runs` real
- `db/schema.ts` — agregar `cronRuns` Drizzle model
- `app/admin/sistema/page.tsx` — render cron runs reales

### Fase 14 — Paso 1: Migration

`db/migrations/0017_cron_runs.sql`:

```sql
-- Cron health tracking. Shared by auto-expiry sweep + scheduling slot
-- materialization + (future) 24h reminder cron.
create table if not exists "public"."cron_runs" (
  "id"              uuid primary key default gen_random_uuid(),
  "cron_name"       text not null,
  "started_at"      timestamptz not null default now(),
  "finished_at"     timestamptz,
  "status"          text not null default 'running',
  "items_processed" integer not null default 0,
  "details"         jsonb not null default '{}'::jsonb,

  constraint cron_runs_status_valid check (status in ('running','ok','failed'))
);

create index if not exists "cron_runs_name_started_idx"
  on "public"."cron_runs" ("cron_name", "started_at" desc);

-- RLS: admin-only read
alter table "public"."cron_runs" enable row level security;

drop policy if exists "cron_runs select by admin" on "public"."cron_runs";
create policy "cron_runs select by admin"
  on "public"."cron_runs" for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
        and p.account_type = 'institutional'
        and p.deactivated_at is null
    )
  );

-- INSERT/UPDATE solo via server (no policy = denied a non-service-role).
```

Apply: `cat db/migrations/0017_cron_runs.sql | docker exec -i supabase_db_DIM psql -U postgres -d postgres -v ON_ERROR_STOP=1`.

### Fase 14 — Paso 2: Drizzle model en `db/schema.ts`

Agregar al final del archivo:

```ts
export const cronRuns = pgTable(
  "cron_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cronName: text("cron_name").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status").notNull().default("running"),
    itemsProcessed: integer("items_processed").notNull().default(0),
    details: jsonb("details").notNull().default({}),
  },
  (table) => ({
    nameStartedIdx: index("cron_runs_name_started_idx").on(table.cronName, table.startedAt),
  }),
);
export type CronRun = InferSelectModel<typeof cronRuns>;
```

Exportar también: `export { cronRuns }` en el barrel.

### Fase 14 — Paso 3: Route handler

`app/api/cron/auto-expire-approvals/route.ts`:

```ts
import { eq, and, lt } from "drizzle-orm";
import { NextResponse } from "next/server";

import {
  approvalRequests,
  auditLog,
  cronRuns,
  db,
  notifications,
  profiles,
} from "@/db";

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const CRON_NAME = "approval_requests_auto_expiry";

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Lookup the system-actor admin (first active institutional admin).
  const [systemActor] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(
      and(
        eq(profiles.role, "admin"),
        eq(profiles.accountType, "institutional"),
      ),
    )
    .limit(1);

  if (!systemActor) {
    return NextResponse.json({ error: "no_admin_found_for_system_actor" }, { status: 500 });
  }

  // Insert cron_runs row with status='running'
  const [run] = await db
    .insert(cronRuns)
    .values({ cronName: CRON_NAME, status: "running" })
    .returning();

  let itemsProcessed = 0;
  let status: "ok" | "failed" = "ok";
  const detailsErrors: { id: string; reason: string }[] = [];

  try {
    const cutoff = new Date(Date.now() - SIXTY_DAYS_MS);
    const stale = await db
      .select({
        id: approvalRequests.id,
        publicToken: approvalRequests.publicToken,
        applicantUserId: approvalRequests.applicantUserId,
        createdAt: approvalRequests.createdAt,
      })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.status, "pending"), lt(approvalRequests.createdAt, cutoff)));

    for (const r of stale) {
      try {
        await db.transaction(async (tx) => {
          await tx
            .update(approvalRequests)
            .set({
              status: "withdrawn",
              withdrawnAt: new Date(),
              decisionNotes: "Auto-expired after 60 days inactivity",
            })
            .where(eq(approvalRequests.id, r.id));

          await tx.insert(auditLog).values({
            actorUserId: systemActor.id,
            action: "approval_request_withdrawn_by_system",
            approvalRequestId: r.id,
            payload: {
              reason: "auto_expired",
              cron_run_id: run.id,
              days_pending: Math.floor((Date.now() - r.createdAt.getTime()) / (24 * 60 * 60 * 1000)),
            },
          });

          await tx.insert(notifications).values({
            userId: r.applicantUserId,
            notificationType: "approval_request_auto_expired",
            payload: { approval_request_public_token: r.publicToken },
          });
        });
        itemsProcessed += 1;
      } catch (err) {
        detailsErrors.push({ id: r.id, reason: err instanceof Error ? err.message : "unknown" });
      }
    }
  } catch (err) {
    status = "failed";
    detailsErrors.push({ id: "global", reason: err instanceof Error ? err.message : "unknown" });
  }

  await db
    .update(cronRuns)
    .set({
      status,
      finishedAt: new Date(),
      itemsProcessed,
      details: detailsErrors.length > 0 ? { errors: detailsErrors } : {},
    })
    .where(eq(cronRuns.id, run.id));

  return NextResponse.json({ status, itemsProcessed, runId: run.id });
}
```

### Fase 14 — Paso 4: `vercel.json`

```json
{
  "crons": [
    {
      "path": "/api/cron/auto-expire-approvals",
      "schedule": "0 4 * * *"
    }
  ]
}
```

Set env var `CRON_SECRET` en Vercel project settings (long random string).

### Fase 14 — Paso 5: Update `lib/admin-metrics.ts`

Replace `fetchCronRuns` stub:

```ts
export async function fetchCronRuns(): Promise<CronRunRow[]> {
  // Latest run per cron_name
  const rows = await db
    .select({
      cronName: cronRuns.cronName,
      lastRunAt: sql<Date>`max(${cronRuns.startedAt})`,
    })
    .from(cronRuns)
    .groupBy(cronRuns.cronName);

  // Get the latest run details for each
  const results: CronRunRow[] = [];
  for (const r of rows) {
    const [latest] = await db
      .select({
        status: cronRuns.status,
        itemsProcessed: cronRuns.itemsProcessed,
        startedAt: cronRuns.startedAt,
      })
      .from(cronRuns)
      .where(eq(cronRuns.cronName, r.cronName))
      .orderBy(desc(cronRuns.startedAt))
      .limit(1);
    results.push({
      cronName: r.cronName,
      lastRunAt: latest?.startedAt ?? null,
      lastStatus: (latest?.status as "ok" | "failed" | "running") ?? null,
      itemsProcessed: latest?.itemsProcessed ?? null,
    });
  }
  return results;
}
```

### Fase 14 — Paso 6: Test

`app/api/cron/auto-expire-approvals/route.test.ts`: con fixture de 3 pending requests (1 fresh, 1 65d old, 1 80d old) y 1 admin. Set CRON_SECRET env. Call GET handler. Verifica que 2 requests pasaron a 'withdrawn', 2 audit_log entries `approval_request_withdrawn_by_system` con cron_run_id apuntando al run actual, 2 notifications insertadas, cron_runs row con status='ok' y items_processed=2.

### Fase 14 — Verificación

```bash
# Run migration
cat db/migrations/0017_cron_runs.sql | docker exec -i supabase_db_DIM psql -U postgres -d postgres -v ON_ERROR_STOP=1

# Test
pnpm test
pnpm typecheck

# Manual test del route
curl -X GET http://localhost:3000/api/cron/auto-expire-approvals \
  -H "Authorization: Bearer $CRON_SECRET"
```

### Fase 14 — Commit

```
feat(cron): auto-expire approval_requests pending 60d+

Adds nightly cron at 04:00 UTC that sweeps approval_requests with
status='pending' AND created_at older than 60 days. Marks them
withdrawn with decision_notes='Auto-expired after 60 days
inactivity', emits audit_log entry and applicant notification.

Introduces cron_runs table for health tracking; surface in
/admin/sistema Cron section (replaces Fase 12 placeholder).
```

---

## Fase 10 — Custody dispute resolution

> Pre-requisito: `plans/2026-05-18-event-catalog-cleanup.md` ejecutado (event_types `custody_dispute_raised/resolved` registrados, `pets.in_custody_dispute` column existe).

### Fase 10 — Qué se construye

- Tablas `custody_disputes` + `custody_dispute_parties` (migration 0018).
- Server actions en `app/actions/custody-disputes.ts`.
- Surface `/gob/disputas` + `/gob/disputas/[disputeToken]`.
- Hook en server action que emite `custody_dispute_raised` (probablemente en `app/actions/events.ts` o donde se cree el evento) para que también inserte la row en `custody_disputes`.
- RLS para las dos tablas.
- Tests.

### Fase 10 — Archivos

**Nuevos:**
- `db/migrations/0018_custody_disputes.sql`
- `app/actions/custody-disputes.ts`
- `app/actions/custody-disputes.test.ts`
- `app/gob/disputas/page.tsx`
- `app/gob/disputas/[disputeToken]/page.tsx`
- `app/gob/disputas/[disputeToken]/ResolveDisputeForm.tsx` (client)
- `app/gob/disputas/[disputeToken]/AddPartyForm.tsx` (client)
- `lib/dispute-scope.ts` (scope-matching helpers)
- `lib/custody-disputes.ts` (read paths para vistas)

**Modificados:**
- `db/schema.ts` — agregar `custodyDisputes` + `custodyDisputeParties` models
- `app/actions/events.ts` o equivalente — hook al crear `custody_dispute_raised`: también insert row en `custody_disputes`
- `app/gob/layout.tsx` — link "Disputas"
- `app/gob/page.tsx` — card "Disputas abiertas"
- `lib/event-schemas.ts` — verificar que `custody_dispute_raised` y `custody_dispute_resolved` tienen Zod schemas (cleanup plan ya lo deja resuelto pero verificar)

### Fase 10 — Paso 1: Migration `db/migrations/0018_custody_disputes.sql`

```sql
-- ============================================================================
-- 1. custody_disputes
-- ============================================================================
create table if not exists "public"."custody_disputes" (
  "id"                          uuid primary key default gen_random_uuid(),
  "public_token"                text not null unique,
  "pet_id"                      uuid not null references "public"."pets"("id") on delete cascade,

  "raised_by_user_id"           uuid references "public"."profiles"("id"),
  "raised_by_org_id"            uuid references "public"."organizations"("id"),
  "raised_by_role"              text not null,
  "raising_event_id"            uuid not null references "public"."pet_events"("id"),

  "jurisdiction_country"        text not null default 'AR',
  "jurisdiction_province"       text not null,
  "jurisdiction_locality"       text not null,

  "status"                      text not null default 'open',
  "resolution"                  text,
  "resolution_summary"          text,
  "resolution_event_id"         uuid references "public"."pet_events"("id"),
  "resolved_by_user_id"         uuid references "public"."profiles"("id"),
  "resolved_at"                 timestamptz,

  "created_at"                  timestamptz not null default now(),
  "updated_at"                  timestamptz not null default now(),

  constraint "custody_disputes_status_valid" check (status in ('open','resolved','withdrawn')),
  constraint "custody_disputes_resolution_consistent" check (
    (status = 'open' and resolution is null and resolved_by_user_id is null and resolved_at is null)
    or
    (status in ('resolved','withdrawn') and resolved_by_user_id is not null and resolved_at is not null)
  ),
  constraint "custody_disputes_resolution_required_when_resolved" check (
    status != 'resolved' or (resolution is not null and resolution_summary is not null)
  ),
  constraint "custody_disputes_raised_role_valid" check (raised_by_role in ('owner','org','govt','admin'))
);

create unique index if not exists "custody_disputes_one_open_per_pet"
  on "public"."custody_disputes" ("pet_id") where status = 'open';

create index if not exists "custody_disputes_juris_open_idx"
  on "public"."custody_disputes" ("jurisdiction_province", "jurisdiction_locality") where status = 'open';

create index if not exists "custody_disputes_pet_idx"
  on "public"."custody_disputes" ("pet_id", "created_at" desc);

-- ============================================================================
-- 2. custody_dispute_parties
-- ============================================================================
create table if not exists "public"."custody_dispute_parties" (
  "id"                       uuid primary key default gen_random_uuid(),
  "dispute_id"               uuid not null references "public"."custody_disputes"("id") on delete cascade,
  "party_user_id"            uuid references "public"."profiles"("id"),
  "party_organization_id"    uuid references "public"."organizations"("id"),
  "party_role"               text not null,
  "party_position_summary"   text,
  "added_by_user_id"         uuid references "public"."profiles"("id"),
  "added_at"                 timestamptz not null default now(),

  constraint "dispute_party_exactly_one_subject" check (
    (party_user_id is not null and party_organization_id is null)
    or
    (party_user_id is null and party_organization_id is not null)
  ),
  constraint "dispute_party_role_valid" check (party_role in (
    'current_owner','claimant_owner','current_org_custody','claimant_org','witness'
  ))
);

create index if not exists "custody_dispute_parties_dispute_idx" on "public"."custody_dispute_parties" ("dispute_id");
create index if not exists "custody_dispute_parties_user_idx"    on "public"."custody_dispute_parties" ("party_user_id") where party_user_id is not null;
create index if not exists "custody_dispute_parties_org_idx"     on "public"."custody_dispute_parties" ("party_organization_id") where party_organization_id is not null;

-- ============================================================================
-- 3. RLS
-- ============================================================================
alter table "public"."custody_disputes" enable row level security;
alter table "public"."custody_dispute_parties" enable row level security;

drop policy if exists "custody_disputes select by parties and authorities" on "public"."custody_disputes";
create policy "custody_disputes select by parties and authorities"
  on "public"."custody_disputes" for select
  using (
    -- Admin or govt with scope
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and (
          (p.role = 'admin' and p.account_type = 'institutional' and p.deactivated_at is null)
          or
          (p.role = 'govt' and p.account_type = 'institutional' and p.deactivated_at is null
            and exists (
              select 1 from public.govt_assignments g
              where g.user_id = p.id
                and g.revoked_at is null
                and g.jurisdiction_province = custody_disputes.jurisdiction_province
                and g.jurisdiction_locality = custody_disputes.jurisdiction_locality
            )
          )
        )
    )
    or
    -- Parties involved
    exists (
      select 1 from public.custody_dispute_parties cdp
      where cdp.dispute_id = custody_disputes.id
        and (
          cdp.party_user_id = auth.uid()
          or cdp.party_organization_id in (
            select om.organization_id from public.organization_memberships om
            where om.user_id = auth.uid() and om.left_at is null
          )
        )
    )
  );

drop policy if exists "custody_dispute_parties select by parties and authorities" on "public"."custody_dispute_parties";
create policy "custody_dispute_parties select by parties and authorities"
  on "public"."custody_dispute_parties" for select
  using (
    -- Same logic: actor is the party, or admin, or govt in scope of the dispute
    party_user_id = auth.uid()
    or party_organization_id in (
      select om.organization_id from public.organization_memberships om
      where om.user_id = auth.uid() and om.left_at is null
    )
    or exists (
      select 1 from public.custody_disputes cd
      join public.profiles p on p.id = auth.uid()
      where cd.id = custody_dispute_parties.dispute_id
        and (
          (p.role = 'admin' and p.account_type = 'institutional' and p.deactivated_at is null)
          or
          (p.role = 'govt' and exists (
            select 1 from public.govt_assignments g
            where g.user_id = p.id
              and g.revoked_at is null
              and g.jurisdiction_province = cd.jurisdiction_province
              and g.jurisdiction_locality = cd.jurisdiction_locality
          ))
        )
    )
  );

-- INSERT/UPDATE/DELETE solo via server (no policies = denied).
```

### Fase 10 — Paso 2: Drizzle models en `db/schema.ts`

```ts
export const DISPUTE_STATUSES = ["open", "resolved", "withdrawn"] as const;
export const DISPUTE_RESOLUTIONS = [
  "confirmed_current",
  "transferred_to_claimant",
  "transferred_to_org",
  "transferred_to_third_party",
  "no_change_explained",
] as const;
export const DISPUTE_PARTY_ROLES = [
  "current_owner",
  "claimant_owner",
  "current_org_custody",
  "claimant_org",
  "witness",
] as const;

export const custodyDisputes = pgTable("custody_disputes", {
  id: uuid("id").primaryKey().defaultRandom(),
  publicToken: text("public_token").notNull().unique(),
  petId: uuid("pet_id").notNull().references(() => pets.id, { onDelete: "cascade" }),
  raisedByUserId: uuid("raised_by_user_id").references(() => profiles.id),
  raisedByOrgId: uuid("raised_by_org_id").references(() => organizations.id),
  raisedByRole: text("raised_by_role").notNull(),
  raisingEventId: uuid("raising_event_id").notNull().references(() => petEvents.id),
  jurisdictionCountry: text("jurisdiction_country").notNull().default("AR"),
  jurisdictionProvince: text("jurisdiction_province").notNull(),
  jurisdictionLocality: text("jurisdiction_locality").notNull(),
  status: text("status").notNull().default("open"),
  resolution: text("resolution"),
  resolutionSummary: text("resolution_summary"),
  resolutionEventId: uuid("resolution_event_id").references(() => petEvents.id),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => profiles.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const custodyDisputeParties = pgTable("custody_dispute_parties", {
  id: uuid("id").primaryKey().defaultRandom(),
  disputeId: uuid("dispute_id").notNull().references(() => custodyDisputes.id, { onDelete: "cascade" }),
  partyUserId: uuid("party_user_id").references(() => profiles.id),
  partyOrganizationId: uuid("party_organization_id").references(() => organizations.id),
  partyRole: text("party_role").notNull(),
  partyPositionSummary: text("party_position_summary"),
  addedByUserId: uuid("added_by_user_id").references(() => profiles.id),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CustodyDispute = InferSelectModel<typeof custodyDisputes>;
export type CustodyDisputeParty = InferSelectModel<typeof custodyDisputeParties>;
```

Exportar y agregar al barrel.

### Fase 10 — Paso 3: Server actions `app/actions/custody-disputes.ts`

```ts
"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import {
  custodyDisputeParties,
  custodyDisputes,
  db,
  petEvents,
  pets,
  organizations,
  ownerships,
  auditLog,
  notifications,
  profiles,
} from "@/db";
import { generatePublicToken } from "@/lib/publicToken";
import { requireAdminOrGovtOrRedirect } from "@/lib/auth-guards";
import { validateEventPayload } from "@/lib/event-schemas";

// Called from the event server action that emits `custody_dispute_raised`.
// Creates the dispute row + parties + flips pets.in_custody_dispute=true.
// This function is NOT a server action — it's an internal helper called by
// the action that raised the event. Same transaction.
export async function openDisputeFromEvent(tx: any, input: {
  petId: string;
  raisingEventId: string;
  raisedByUserId?: string;
  raisedByOrgId?: string;
  raisedByRole: "owner" | "org" | "govt" | "admin";
  jurisdictionProvince: string;
  jurisdictionLocality: string;
  initialParties: { userId?: string; orgId?: string; role: string; positionSummary?: string }[];
}): Promise<{ disputeId: string }> {
  // Anti-duplicate guard: if a dispute is already open for this pet, throw.
  const [existing] = await tx
    .select({ id: custodyDisputes.id })
    .from(custodyDisputes)
    .where(and(eq(custodyDisputes.petId, input.petId), eq(custodyDisputes.status, "open")));
  if (existing) throw new Error("Already an open dispute for this pet");

  const publicToken = await generatePublicToken({ prefix: "DIS" });
  const [dispute] = await tx
    .insert(custodyDisputes)
    .values({
      publicToken,
      petId: input.petId,
      raisedByUserId: input.raisedByUserId,
      raisedByOrgId: input.raisedByOrgId,
      raisedByRole: input.raisedByRole,
      raisingEventId: input.raisingEventId,
      jurisdictionProvince: input.jurisdictionProvince,
      jurisdictionLocality: input.jurisdictionLocality,
    })
    .returning();

  for (const p of input.initialParties) {
    await tx.insert(custodyDisputeParties).values({
      disputeId: dispute.id,
      partyUserId: p.userId,
      partyOrganizationId: p.orgId,
      partyRole: p.role,
      partyPositionSummary: p.positionSummary,
      addedByUserId: input.raisedByUserId,
    });
  }

  // Flip pet flag
  await tx.update(pets).set({ inCustodyDispute: true }).where(eq(pets.id, input.petId));

  // Audit log
  const actorId = input.raisedByUserId; // raiser is the actor for the raise audit
  if (actorId) {
    await tx.insert(auditLog).values({
      actorUserId: actorId,
      action: "dispute_raised",
      payload: { dispute_id: dispute.id, pet_id: input.petId, raising_event_id: input.raisingEventId, raised_by_role: input.raisedByRole },
    });
  }

  return { disputeId: dispute.id };
}

export async function addDisputePartyAction(input: {
  disputeToken: string;
  partyUserId?: string;
  partyOrgId?: string;
  partyRole: "current_owner" | "claimant_owner" | "current_org_custody" | "claimant_org" | "witness";
  positionSummary?: string;
}): Promise<{ partyId: string }> {
  const session = await requireAdminOrGovtOrRedirect();

  return await db.transaction(async (tx) => {
    const [dispute] = await tx
      .select()
      .from(custodyDisputes)
      .where(eq(custodyDisputes.publicToken, input.disputeToken));
    if (!dispute) throw new Error("Dispute not found");
    if (dispute.status !== "open") throw new Error("Dispute not open");

    // Scope check
    if (session.profile.role === "govt") {
      const inScope = session.jurisdictions.some(
        (j) => j.province === dispute.jurisdictionProvince && j.locality === dispute.jurisdictionLocality,
      );
      if (!inScope) throw new Error("Out of scope");
    }

    const [party] = await tx
      .insert(custodyDisputeParties)
      .values({
        disputeId: dispute.id,
        partyUserId: input.partyUserId,
        partyOrganizationId: input.partyOrgId,
        partyRole: input.partyRole,
        partyPositionSummary: input.positionSummary,
        addedByUserId: session.user.id,
      })
      .returning();

    await tx.insert(auditLog).values({
      actorUserId: session.user.id,
      action: "dispute_party_added",
      payload: { dispute_id: dispute.id, party_id: party.id, party_role: input.partyRole },
    });

    // Notification to the added party
    if (input.partyUserId) {
      await tx.insert(notifications).values({
        userId: input.partyUserId,
        notificationType: "custody_dispute_party_added",
        payload: { dispute_public_token: dispute.publicToken },
      });
    }

    revalidatePath(`/gob/disputas/${dispute.publicToken}`);
    return { partyId: party.id };
  });
}

export async function resolveDisputeAction(input: {
  disputeToken: string;
  resolution:
    | "confirmed_current"
    | "transferred_to_claimant"
    | "transferred_to_org"
    | "transferred_to_third_party"
    | "no_change_explained";
  resolutionSummary: string;
  transferToUserId?: string;
  transferToOrgId?: string;
}): Promise<{ resolvedAt: Date }> {
  if (input.resolutionSummary.trim().length < 100) {
    throw new Error("Resolution summary must be at least 100 characters");
  }
  const session = await requireAdminOrGovtOrRedirect();

  return await db.transaction(async (tx) => {
    const [dispute] = await tx
      .select()
      .from(custodyDisputes)
      .where(eq(custodyDisputes.publicToken, input.disputeToken));
    if (!dispute) throw new Error("Dispute not found");
    if (dispute.status !== "open") throw new Error("Dispute not open");

    // Scope check
    if (session.profile.role === "govt") {
      const inScope = session.jurisdictions.some(
        (j) => j.province === dispute.jurisdictionProvince && j.locality === dispute.jurisdictionLocality,
      );
      if (!inScope) throw new Error("Out of scope");
    }

    // If transferring, emit custody_transferred event + update ownership.
    let transferEventId: string | null = null;
    if (
      input.resolution === "transferred_to_claimant" ||
      input.resolution === "transferred_to_org" ||
      input.resolution === "transferred_to_third_party"
    ) {
      if (input.resolution === "transferred_to_claimant" && !input.transferToUserId) {
        throw new Error("transferToUserId required for transferred_to_claimant");
      }
      if (input.resolution === "transferred_to_org" && !input.transferToOrgId) {
        throw new Error("transferToOrgId required for transferred_to_org");
      }
      if (input.resolution === "transferred_to_third_party" && !input.transferToUserId && !input.transferToOrgId) {
        throw new Error("transfer target required for transferred_to_third_party");
      }

      const transferPayload = validateEventPayload("custody_transferred", {
        new_owner_user_id: input.transferToUserId ?? null,
        new_owner_organization_id: input.transferToOrgId ?? null,
        transferred_by_authority: true,
        transfer_authority: "dispute_resolution",
      });
      const [te] = await tx
        .insert(petEvents)
        .values({
          petId: dispute.petId,
          eventType: "custody_transferred",
          authorRole: session.profile.role,
          authorUserId: session.user.id,
          payload: transferPayload,
        })
        .returning();
      transferEventId = te.id;

      // Close previous ownership, open new one
      await tx
        .update(ownerships)
        .set({ endedAt: new Date() })
        .where(and(eq(ownerships.petId, dispute.petId), isNull(ownerships.endedAt)));

      await tx.insert(ownerships).values({
        petId: dispute.petId,
        ownerUserId: input.transferToUserId ?? null,
        organizationId: input.transferToOrgId ?? null,
        ownershipKind: input.transferToOrgId ? "shelter_custody" : "primary_owner",
        startedAt: new Date(),
      });
    }

    // Emit custody_dispute_resolved event
    const resolvedPayload = validateEventPayload("custody_dispute_resolved", {
      dispute_id: dispute.id,
      resolution: input.resolution,
      resolution_summary: input.resolutionSummary,
      transfer_event_id: transferEventId,
    });
    const [resolvedEvent] = await tx
      .insert(petEvents)
      .values({
        petId: dispute.petId,
        eventType: "custody_dispute_resolved",
        authorRole: session.profile.role,
        authorUserId: session.user.id,
        payload: resolvedPayload,
      })
      .returning();

    const now = new Date();
    await tx
      .update(custodyDisputes)
      .set({
        status: "resolved",
        resolution: input.resolution,
        resolutionSummary: input.resolutionSummary,
        resolutionEventId: resolvedEvent.id,
        resolvedByUserId: session.user.id,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(custodyDisputes.id, dispute.id));

    await tx.update(pets).set({ inCustodyDispute: false }).where(eq(pets.id, dispute.petId));

    await tx.insert(auditLog).values({
      actorUserId: session.user.id,
      action: "dispute_resolved",
      payload: {
        dispute_id: dispute.id,
        resolution: input.resolution,
        resolution_summary_excerpt: input.resolutionSummary.slice(0, 200),
      },
    });

    // Notify all parties
    const parties = await tx
      .select({ partyUserId: custodyDisputeParties.partyUserId })
      .from(custodyDisputeParties)
      .where(eq(custodyDisputeParties.disputeId, dispute.id));
    for (const p of parties) {
      if (p.partyUserId) {
        await tx.insert(notifications).values({
          userId: p.partyUserId,
          notificationType: "custody_dispute_resolved",
          payload: { dispute_public_token: dispute.publicToken, resolution: input.resolution },
        });
      }
    }

    revalidatePath("/gob/disputas");
    revalidatePath(`/gob/disputas/${dispute.publicToken}`);
    return { resolvedAt: now };
  });
}

export async function withdrawDisputeAction(input: {
  disputeToken: string;
  reason?: string;
}): Promise<{ withdrawnAt: Date }> {
  const session = await requireAdminOrGovtOrRedirect();
  return await db.transaction(async (tx) => {
    const [dispute] = await tx
      .select()
      .from(custodyDisputes)
      .where(eq(custodyDisputes.publicToken, input.disputeToken));
    if (!dispute) throw new Error("Dispute not found");
    if (dispute.status !== "open") throw new Error("Dispute not open");

    // Admin can always withdraw. Govt can withdraw if raised by them.
    if (session.profile.role === "govt" && dispute.raisedByUserId !== session.user.id) {
      throw new Error("Only the raiser or an admin can withdraw");
    }

    const now = new Date();
    await tx.update(custodyDisputes).set({
      status: "withdrawn",
      resolvedByUserId: session.user.id,
      resolvedAt: now,
      updatedAt: now,
    }).where(eq(custodyDisputes.id, dispute.id));

    await tx.update(pets).set({ inCustodyDispute: false }).where(eq(pets.id, dispute.petId));

    await tx.insert(auditLog).values({
      actorUserId: session.user.id,
      action: "dispute_withdrawn",
      payload: { dispute_id: dispute.id, withdrawn_by_user_id: session.user.id, reason: input.reason ?? null },
    });

    revalidatePath("/gob/disputas");
    return { withdrawnAt: now };
  });
}
```

### Fase 10 — Paso 4: Hook al evento `custody_dispute_raised`

En `app/actions/events.ts` (o donde se cree el evento via `createCustodyDisputeRaisedAction`), después del insert de `pet_events`, llamar `openDisputeFromEvent(tx, {...})` con los datos del raiser. Esto requiere que la server action que emite el evento conozca: petId, jurisdiccion (de pet o de owner), raised_by_role, initial parties (current_owner = current ownership; claimant = raiser).

**Decisión operativa**: la jurisdicción de la dispute se toma del pet:
- Si `pets.last_seen_locality_*` está set → usar eso
- Else, locality del current owner profile
- Else, fallback a `pets.country='AR'` con province='Buenos Aires' y locality='Sin especificar' (admin fallback automático)

### Fase 10 — Paso 5: Surface `/gob/disputas/page.tsx`

```tsx
import Link from "next/link";

import { requireAdminOrGovtOrRedirect } from "@/lib/auth-guards";
import { listOpenDisputesInScope } from "@/lib/custody-disputes";

export default async function GobDisputasPage() {
  const { profile, jurisdictions } = await requireAdminOrGovtOrRedirect();
  const disputes = await listOpenDisputesInScope({ role: profile.role, id: profile.id }, jurisdictions);

  return (
    <main className="px-6 py-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <header>
          <h1 className="text-3xl font-semibold">Disputas de custodia</h1>
          <p className="text-sm text-neutral-600">Disputas abiertas en tu cobertura.</p>
        </header>

        {disputes.length === 0 ? (
          <p className="text-sm text-neutral-500">No hay disputas abiertas.</p>
        ) : (
          <ul className="space-y-2">
            {disputes.map((d) => (
              <li key={d.id} className="rounded-lg border border-neutral-200 dark:border-neutral-800 px-4 py-3">
                <Link href={`/gob/disputas/${d.publicToken}`} className="block">
                  <p className="text-sm font-medium">{d.petDisplayName} ({d.species})</p>
                  <p className="text-xs text-neutral-500">
                    {d.jurisdictionLocality}, {d.jurisdictionProvince} ·{" "}
                    Abierta {new Date(d.createdAt).toLocaleDateString("es-AR")}
                  </p>
                  <p className="text-[10px] text-neutral-400 font-mono">{d.publicToken}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
```

### Fase 10 — Paso 6: Detail `/gob/disputas/[disputeToken]/page.tsx`

Carga: dispute + parties + pet info + filtered event history (solo eventos custody-related del pet) + attachments del raising event. Renders:
- Pet header mini (foto, nombre, especie, chip si tiene)
- Banner "Disputa abierta — pet bloqueado para transfer/adopción"
- Parties list (con ability de agregar via AddPartyForm)
- Custody event timeline (filtered)
- Evidencia (signed URLs, log audit on view)
- ResolveDisputeForm con dropdown de resolution + textarea min 100 chars + (si transfer) target picker

ResolveDisputeForm es client component que llama a `resolveDisputeAction`.
AddPartyForm es client component que llama a `addDisputePartyAction`.

### Fase 10 — Paso 7: `lib/custody-disputes.ts`

Functions: `listOpenDisputesInScope`, `getDisputeDetailByToken`. Drizzle queries con scope-matching.

### Fase 10 — Paso 8: Nav updates

`app/gob/layout.tsx`: agregar link "Disputas" después de "Servicios".

`app/gob/page.tsx`: agregar card "Disputas abiertas" con count.

### Fase 10 — Paso 9: Tests

`app/actions/custody-disputes.test.ts`:
- Fixture: 1 pet con current_owner, raising custody_dispute_raised event creates dispute with 2 parties.
- `addDisputePartyAction` con govt out-of-scope falla.
- `resolveDisputeAction` con resolutionSummary < 100 chars falla.
- `resolveDisputeAction` con resolution='transferred_to_claimant' emite custody_transferred + cierra ownership + opens new + flips in_custody_dispute=false.
- `withdrawDisputeAction` por govt que no es raiser falla. Admin puede.

### Fase 10 — Verificación

```bash
cat db/migrations/0018_custody_disputes.sql | docker exec -i supabase_db_DIM psql -U postgres -d postgres -v ON_ERROR_STOP=1
pnpm test
pnpm typecheck
pnpm dev   # simular flow completo
```

### Fase 10 — Commit

```
feat(gob): custody dispute resolution surface

Adds /gob/disputas + /gob/disputas/[disputeToken] for govt/admin to
resolve custody_dispute_raised events. New tables custody_disputes
+ custody_dispute_parties. Server actions addDisputeParty,
resolveDispute, withdrawDispute.

Resolving with a transfer resolution emits custody_transferred and
re-points ownership atomically. Flips pets.in_custody_dispute=false.

Pre-requisite: event-catalog-cleanup plan applied.
```

---

## Después de las 5 fases — Update README

Editar `docs/superpowers/README.md`:

1. En la sección "Specs (design docs)", agregar:

```
| `2026-05-18-admin-page-next-phases-design.md` (v3.0) | 🟢 Ready for CC (parcial — fases ya aplicadas se marcan) | `plans/2026-05-18-admin-page-fases-10-14.md` | Fases 10-14 + placeholders 15-25. Custody disputes, dashboards regionales, métricas admin, bulk ops, auto-expiry. |
```

2. En "Plans", agregar:

```
| `2026-05-18-admin-page-fases-10-14.md` | 🟢 Ready for CC | `specs/2026-05-18-admin-page-next-phases-design.md` (v3.0) | Cinco fases independientes (excepto F10 que depende de event-catalog-cleanup). Cada una = 1 PR. Orden recomendado: 11 → 12 → 13 → 14 → 10 (o 10 al frente si cleanup ya se aplicó). |
```

3. En "What to attack next", **remover** la línea de Admin page Fase 0+ (ya está implementado) y reemplazar con:

```
| 1 | **Event catalog cleanup** | `plans/2026-05-18-event-catalog-cleanup.md` | Bloquea custody-disputes (Fase 10). Estructural — borra event_types redundantes, agrega CI test EVENT_TYPES↔PayloadSchemas, refactorea bite events. |
| 2 | **Admin page Fase 11 (regional dashboards)** | `plans/2026-05-18-admin-page-fases-10-14.md` (Fase 11) | Sin dependencias. Da valor visible inmediato al govt portal. ~½ día. |
| 3 | **Admin page Fase 12 (admin metrics)** | (mismo plan, Fase 12) | Salud del sistema visible al admin. ~½ día. |
| 4 | **Admin page Fase 13 (bulk ops)** | (mismo plan, Fase 13) | UX para volumen. ~1 día. |
| 5 | **Admin page Fase 14 (auto-expiry cron)** | (mismo plan, Fase 14) | Cron + tabla cron_runs. ~½ día. |
| 6 | **Admin page Fase 10 (custody disputes)** | (mismo plan, Fase 10) | Post-cleanup. La más grande. ~2 días. |
```

4. Marcar el spec original `2026-05-17-admin-page-design.md` v2.3 como ✅ Implementado (ya está, pero el README lo tenía como 🟡 Spec only — corregir).

---

## Notas finales para Claude Code

- **Cada fase = 1 PR independiente**. NO mezcles cambios de fases distintas en el mismo commit.
- **Antes de cada PR** corre `pnpm test && pnpm typecheck && pnpm build`. Si algo falla, paralelizar el debug — no merge.
- **Las migraciones SQL** se aplican via `docker exec ... psql ... ON_ERROR_STOP=1`. Si el comando falla, NO continúes — revisar el error y corregir.
- **Los Zod schemas** para nuevos event types (`custody_dispute_raised`, `custody_dispute_resolved`) ya están definidos por `event-catalog-cleanup`. Si vas a ejecutar Fase 10 sin haber aplicado cleanup, **stop**: aplicá cleanup primero.
- **El audit_log** es append-only. NUNCA hagas UPDATE/DELETE en audit_log filas. Si necesitás corregir un audit erróneo, emit otro audit con `action='audit_correction'` (no existe; agregar al catálogo si emerge).
- **El estado `pets.in_custody_dispute`** se gestiona automáticamente: server action que emite `custody_dispute_raised` lo sube; `resolveDisputeAction` y `withdrawDisputeAction` lo bajan. NUNCA setearlo a mano.
- **El feature flag `transferred_by_authority`** en payload de `custody_transferred` es nuevo — registrar en el Zod schema de `custody_transferred` (puede que ya exista del cleanup; verificar).
- **Tests son obligatorios** para cada server action y para los helpers de lib/. UI components pueden quedar sin test si son puro render.
- **Reportá a Nacho al final de cada fase** con un resumen corto en español: qué quedó implementado, qué quedó como TODO (si algo se desvió del plan), qué CI rompió y se arregló (si pasó).

Si el plan dice algo que no se puede ejecutar (ej. una función que no existe, un schema field renombrado), **pausá y preguntá**. No improvisar — la coherencia con AGENTS.md y los specs previos es lo más importante.
