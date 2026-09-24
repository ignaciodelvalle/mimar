# /gob dashboard — extension plan

**2026-05-20 · scope: portal organismo (govt + admin)**

## Why this plan

Today `/gob` works but its center of gravity is the approval cola: matrículas vet, organization verification, service-dog credentials. The mockup explored in chat reframes `/gob` around **continuous supervision over a jurisdiction** — KPIs, geospatial incidence, cross-org casework, citizen denuncias — and demotes the cola to one card among many.

This plan maps that mockup to what already exists in the codebase, names the gaps, and sequences them into phases that each ship independently.

## Where this sits in the broader plan

Per `docs/unapplied-specs-audit-2026-05-20.md`, the project has unfinished foundational work (Tier 0 — corrupted working tree at `<repo>`; Tier 1 — CI test gating, coverage targets, Postgres-in-CI; Tier 2 — six pending security fixes; Tier 3 — DB/RLS hygiene). **Nothing in this plan is durable until at least Tier 0–2 land.** The phases below land at Tier 5 or later in that ordering.

## Two findings worth flagging before starting

- **The `cases` table is real but missing from the Drizzle schema.** The table is created by `db/migrations/0033_cases.sql` (RLS expanded in `0034`). The Drizzle TS definition for it has been lost because `db/schema.ts` is itself truncated mid-statement at line 2220 — see `docs/action-plan-2026-05-20.md` → Addendum → Finding 1. Resolution: re-do Phase 0 of the action plan, then verify the `cases` block is back in `schema.ts` (or regenerate via `pnpm drizzle-kit pull`).
- **`case_kind` is text, not a Postgres enum** (per the comment in `lib/case-kinds.ts`). Adding `inspection_visit` and `sanction_proceeding` is therefore a TS const edit + new files in `lib/case-lifecycles/` + a coverage test pass — no DB migration. Easier than I initially scoped.

## Phase 1 — what already exists in the tree

A starter pass added three additive component files plus a preview route:

- `components/KpiTile.tsx` + `KpiTileGrid` — metric tiles with `plain` / `target` / `delta` variants and five tones.
- `components/JurisdictionFilterBar.tsx` — client component, URL-search-param state, time chips + provincia / localidad / tipo dropdowns. Exports a server-side `readFilterParams()` helper.
- `components/GobDashboardShell.tsx` + `DashboardCard` — three-zone layout (header + filters + kpi strip + main/aside).
- `app/gob/dashboard-v2/page.tsx` — preview route composing all three with hardcoded sample data. Same `requireAdminOrGovtOrRedirect` guard as `/gob`.

These files do not import from `@/db`, so they compile independently of the schema-restoration work flagged above.

## Anchored principles

Every decision below must respect five non-negotiables from `AGENTS.md`:

1. Events are the spine. No new "denuncia" or "mordedura" tables — `welfareReports`, `petEvents`, and `cases` already cover them.
2. Projections are first-class. Every panel is `(events, filters) → view`, not a materialized denormalization.
3. govt is locality-scoped. Every query joins on `govtAssignments`. Admin sees universal.
4. Append-only. Corrections are new events, never updates.
5. gob.ar visual language. The `--color-gob-*` tokens already in `globals.css`, Poncho-style components.

## State of play (audit)

### What's already shipped

| Mockup element | Backing route / lib | Status |
|---|---|---|
| Cola de aprobaciones | `/gob/cola`, `approvalRequests`, `fetchVisiblePendingRequests` | shipped |
| Maltrato (denuncia ciudadana) | `/gob/maltrato`, `welfareReports` | shipped |
| Casos cross-org | `/gob/casos`, `cases`, `CaseBadge` | shipped |
| Vigilancia zoonótica | `/gob/vigilancia`, `fetchSurveillanceSignals`, `fetchDiseaseSummary` | shipped, table form |
| Organizaciones (list + revocar) | `/gob/organizaciones`, `organizations` | shipped |
| Disputas de tenencia | `/gob/disputas`, `custodyDisputes` | shipped |
| Servicios públicos | `/gob/servicios`, `serviceOfferings` | shipped |
| Pérdidas | `/gob/perdidas` | shipped |
| Usuarios institucionales | `/gob/usuarios` | shipped |
| Reglas de negocio | `/gob/reglas`, `govtBusinessRules` | shipped |
| Historial / auditoría | `/gob/historial`, `auditLog` | shipped |
| gob.ar design tokens | `--color-gob-*` in `app/globals.css` | shipped |
| CaseBadge primitive | `components/CaseBadge.tsx` | shipped |

### What the mockup shows but the codebase lacks

| Mockup element | Why it's a gap | Effort |
|---|---|---|
| Dashboard with KPI strip + map + cross-org kanban | Current `/gob` page is a cola overview only. | M |
| Cobertura antirrábica % per localidad | Calculable from `petEvents` vacuna entries × locality. No projection yet. | M |
| Mordeduras / 10k hab. | `bite_incident` cases exist; no per-population rate. Needs locality population reference. | M |
| Choropleth de incidencia | MapLibre is in stack, no choropleth component yet. | L |
| Habilitaciones (permits with expiry) | `organizations.verified` is a single boolean. No renewal cycle. | L |
| Sanciones / actas / expedientes | No schema today. Adjacent to `approvalRequests` revoke flow. | L |
| Inspecciones (planificación + acta) | No schema. Adjacent to `appointments`, different domain. | L |
| Búsqueda cruzada (chip / DNI / org / animal) | Each entity searchable in isolation, no unified surface. | S–M |
| Reportes públicos exportables | No CSV/PDF export endpoints yet. | M |
| Indicadores (KPI detail page) | No `/gob/indicadores` route. | M |

## Component-level deltas

The plan reuses the gob.ar Poncho tokens already wired in `globals.css`. New components needed beyond what's in `components/`:

### New primitives

- `KpiTile` — label, big number, target bar or delta indicator, semantic color. Variants: bare number, with target bar, with delta arrow.
- `ChoroplethMap` — MapLibre wrapper over locality GeoJSON, fill scale from a metric, click-to-filter, legend. One source of truth for every "mapa de incidencia" view.
- `CrossOrgCaseCard` — extends `CaseBadge` with org attribution, jurisdiction, and a left-border priority bar.
- `DiseaseTile` — colored card per zoonosis: count, status (sospechoso / confirmado / activos), localidades. Replaces the table view of `/gob/vigilancia` for dashboard summary.
- `JurisdictionFilterBar` — shared chip-and-dropdown row (Hoy / Esta semana / Este mes / Personalizado + Provincia + Localidad + Tipo). Today each page rolls its own.
- `PermitStatusPill` — habilitada / en revisión / vence en N días / vencida / sancionada.
- `CrossSearchInput` — typeahead over chip, DNI, org publicToken, animal publicToken.

### Patterns

- Dashboard shell — three zones (KPI strip / main column / right column). Replaces the single-column cola overview at `/gob`. Cola becomes one card in the right column.
- Case kanban — Nuevo / Investigando / Escalado columns driven by `cases.status`. Reuses `CaseBadge`; the kanban layout itself is new.
- Indicator drill-down — clicking a KpiTile opens a `/gob/indicadores` detail view with time-series and per-locality breakdown.

## Data model deltas

Three new regulatory domains. The architectural call: which fit the case spine, which need their own table.

### Habilitaciones — new table

Currently `organizations.verified` is one irreversible boolean. A real permit has expiry, renewal, suspension, revocation. It is **state with duration**, not an event.

Proposed `organizationPermits`:

- One row per issuance, renewal, suspension, revocation. Append-only.
- Columns: `id`, `organizationId`, `kind` (`habilitacion` | `habilitacion_renewal` | `suspension` | `revocation`), `validFrom`, `validUntil`, `issuedByUserId`, `jurisdictionLocality`, `evidenceAttachmentId`, `notes`.
- A view `organization_current_permit` projects the latest active row.
- Cron job emits `notifications` to the org N days before `validUntil`.

### Inspecciones — new case kind

Every inspection is conceptually a case with status, jurisdiction, audit log, parties, and attachments. All of that is already in `cases`.

Proposed: add `inspection_visit` to `caseKindEnum` and `lib/case-kinds.ts`. The typed outcome (`compliant` / `minor_findings` / `major_findings` / `severe_findings`) lives in `cases.metadata` jsonb.

### Sanciones — new case kind

Same logic: a sanction is `sanction_proceeding`, mapped onto existing `cases.status`:

- `open` = acta emitida, intimación enviada
- `escalated` = audiencia en curso, plazo a vencer
- `closed` = resuelto

The acta is an attachment. The intimación is a `notifications` entry. Parties reuse `cases.parties` (already used by custody disputes).

Tradeoff documented: habilitaciones get a dedicated table because permits are long-lived state with expiry, not events. Inspecciones and sanciones are events that fit the case spine.

### Population reference for `/10k hab.` metrics

Add `localityPopulation` (`locality`, `province`, `population`, `source`, `asOf`). One-time seed from INDEC census + per-locality estimates.

## Phased delivery

Each phase is mergeable on its own. Hour estimates are rough for Claude-driven implementation, multiplied by review.

### Phase 1 — Dashboard shell (1–2 sessions)

Replace the current `/gob` page with the three-zone layout from the mockup.

- Build `KpiTile`, `JurisdictionFilterBar`, dashboard shell.
- Migrate existing cola counts into a `ColaResumenCard` (right column).
- Surface the existing vigilancia summary as a `DiseaseTile` row.
- Surface existing casos cross-org as a kanban card linking to `/gob/casos`.
- Surface existing welfareReports as a denuncias card linking to `/gob/maltrato`.
- KPIs v1: pending approvals, open cases by kind, active surveillance signals, denuncias this month. Population-rate KPIs deferred to Phase 3.

### Phase 2 — Map and incidence (1–2 sessions)

Add the choropleth.

- Build `ChoroplethMap` over MapLibre + OSM.
- Seed locality GeoJSON for the locality set used in `govtAssignments`.
- Two map layers v1: bite incidents per locality (count), zoonosis active cases per locality (count). Layer toggle in the legend.
- Embed small on `/gob`, full on `/gob/mapa`.

### Phase 3 — Population-rate KPIs + indicadores route (1 session)

Turn raw counts into rates.

- Add `localityPopulation` table + seed.
- Add KPI queries: vaccination coverage %, sterilizations / month, bite incidence / 10k hab, sterilization coverage %.
- Build `/gob/indicadores` route with time-series + per-locality breakdown.
- Wire KpiTile click-through.

### Phase 4 — Habilitaciones (2 sessions)

Replace boolean `organizations.verified` with a recurring permit system.

- Add `organizationPermits` table + RLS.
- Migrate existing `verified=true` orgs to a synthetic initial permit (`validUntil = createdAt + 1 year`). Document the migration policy.
- Build `/gob/organizaciones/[orgToken]/permisos` issuance / renewal / suspension flow.
- Add right-column "Habilitaciones por vencer" card.
- Cron job for expiry notifications (reuses `cronRuns`).

### Phase 5 — Inspecciones + sanciones as case kinds (2 sessions)

Close the regulatory action loop.

**Prerequisite**: confirm the `cases` table exists in `db/schema.ts` (see finding at the top). If it does not, this phase starts with porting whichever migration defines it into the Drizzle schema, then proceeds.

- Add `inspection_visit` and `sanction_proceeding` to `CASE_KINDS` in `lib/case-kinds.ts` (text, no enum migration needed).
- Add the two lifecycle files in `lib/case-lifecycles/`.
- Build creation flows from `/gob/maltrato/[id]` (escalate denuncia → inspection) and `/gob/casos/[code]` (escalate to sanction).
- Build on-site inspection form (mobile-friendly — inspectors will use it in the field).
- Update `CaseBadge` icon map for the two new kinds.

### Phase 6 — Búsqueda cruzada + reportes públicos (1–2 sessions)

- Build `/gob/buscar` route + `CrossSearchInput`.
- Build `/gob/reportes` with CSV export (Drizzle → stream) and PDF export.
- Wire dashboard right column.

## Open decisions

These need resolution before Phase 4–6. None block Phase 1–3.

1. Habilitación duration default. One year (renewable) or two years (CABA's veterinary licensing standard)? Affects migration cutover.
2. Public transparency endpoint. Does DIM expose aggregated data publicly today, or only to verified orgs? AGENTS.md mentions k-anonymity for population data — Phase 6 needs a concrete `k` threshold (5? 10?).
3. Map data source. Argentina's IGN provides locality GeoJSON but it's heavy. Either trim to AR-AMBA + the active assignments, or use a vector tile provider. Affects Phase 2.
4. PDF generator. PDFKit (flexible, more code) vs react-pdf (declarative, heavier bundle). Affects Phase 6.
5. Inspection field form. PWA-on-tablet for inspectors, or paper-then-upload? `AGENTS.md` says PWA is owner-only today; inspectors are institutional, which contradicts the institutional-is-desktop rule. Probably PWA-on-tablet, worth a product call.
6. Nav style. The mockup shows a side nav; the current layout uses a top nav. Pragmatic compromise: keep the top nav for now, redesign the dashboard body. Switch to side nav later if the menu grows past ~10 items.

## Out of scope

- Multi-country expansion. The mockup says Pcia. Buenos Aires — DIM stays Argentina-only.
- Open-data API beyond CSV/PDF export.
- Mi Argentina handoff for citizen denuncias. Separate spec.
- Replacing `/gob/cola`. The cola stays the primary task list; the dashboard adds context, does not replace work.

## Suggested next concrete step

Start Phase 1, beginning with `KpiTile` and the dashboard shell. The cola data is already fetched in `app/gob/page.tsx`; the change is presentational, plus three to four supporting queries that already exist in `lib/govt-dashboards.ts`.
