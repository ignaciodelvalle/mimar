> **▶ ARCHIVADO 2026-08-04** — triage de planes: el trabajo que describe está shippeado (verificado contra el árbol). Se conserva por su método y su evidencia; como plan de trabajo, está cerrado.

# `lib/` Bucketize Plan — taxonomy + per-file migration recipe

> Created: 2026-06-26
> Status: **✅ COMPLETADO — verificado 2026-08-04.** `lib/` root tiene CERO
> archivos `.ts` sueltos; todo vive en `lib/{domain,infra,reference,analytics,
> events,ui,utils}/` y `pnpm lint:lib-root` mantiene la puerta cerrada.
>
> El encabezado decía "PLANNED — not started" con el trabajo terminado, y eso
> tuvo consecuencia: esta misma migración dejó **44 rutas muertas** en
> AGENTS/README/CLAUDE que nadie corrigió (arregladas el 04/08), porque el
> documento que habría avisado que la mudanza ocurrió decía que no había
> ocurrido.
> Owner: TBD (multi-session program)
> CI guard: `pnpm lint:lib-root` (baseline: `scripts/lib-root-baseline.json`)

---

## Context

`lib/` root currently holds **208 `.ts` files** with no subdir organization (staff critique F2).
This is a friction point: new contributors have no signal on where to add code, file discovery
is O(n) through a flat list, and cross-cutting concerns are invisible.

The codebase **already uses lib subdirs** for some things — `lib/metrics/`, `lib/projections/`,
`lib/supabase/` — which serve as precedent. The goal is to extend that pattern to the full
`lib/` tree.

**What is NOT in scope for this plan:**
- F4: lost/ consolidation
- F5: enum extraction
- F6: import spelling (`@/lib` vs relative)
- F7: AGENTS slim

Those are separate tasks listed in the backlog section below.

---

## Proposed taxonomy

```
lib/
  domain/       # Pure domain rules — no DB/IO/framework imports.
  infra/        # DB queries, storage, external services, rate-limiting, auth.
  reference/    # Static catalogs / lookup tables (ar-provincias, breeds, diseases …).
  analytics/    # Metrics, dashboards, exports, KPI aggregations (all DB-read, no writes).
  ui/           # Shell nav, breadcrumbs, formatting, presentation helpers.
  utils/        # Pure utility functions with no domain semantics.
  events/       # Event schemas, outbox, idempotency, upcasters.
  (metrics/     # Already exists — keep as-is)
  (projections/ # Already exists — keep as-is)
  (supabase/    # Already exists — keep as-is)
```

> **Naming rationale**
> - `domain/` mirrors hexagonal-lite language; `infra/` aligns with `src/modules/*/infrastructure/`.
> - `reference/` signals "read-only catalog data" — distinct from live DB queries.
> - `analytics/` separates read-only metric aggregations from domain write logic.
> - `ui/` keeps presentation helpers visible without mixing with pure logic.
> - `events/` already has a coherent cluster; promoting it to a subdir signals the
>   event-driven boundary.
> - `utils/` catches genuinely cross-cutting helpers with no domain semantics.

---

## Per-bucket file classification

Rough heuristic: name + top-level imports.  
Key: `@/db` or `drizzle-orm` = infra; no db imports, no framework = domain; static objects/maps = reference.
"needs confirmation" where imports were not fully inspected.

### `lib/reference/` — static catalogs (no DB writes, mostly in-memory maps)

| File | Notes |
|---|---|
| `ar-provincias.ts` | Province code map, pure static data |
| `ar-viewboxes.ts` | SVG viewbox map per province, pure static |
| `ar-phone.ts` | Phone format rules, pure |
| `breeds.ts` | Breed catalog, pure static array |
| `diseases.ts` | Disease catalog, pure static |
| `drugs.ts` | Drug catalog + classification helpers |
| `symptoms.ts` | Symptom list, pure static |
| `lookups.ts` | General lookup helpers, pure |
| `sanitary-vocab.ts` | Sanitary vocabulary labels, pure |
| `service-kinds.ts` | Service kind labels keyed by EventType |
| `legal-version.ts` | Legal document version constants |
| `disease-legal-anchors.ts` | Disease→legal-article mapping |
| `disease-public-alert-catalog.ts` | Public alert catalog, static |
| `permanent-conditions.ts` | Permanent condition flags, static |
| `medication-schedule.ts` | Medication schedule schemas |
| `scheduling-schemas.ts` | Scheduling zod schemas |

Approximate count: **16 files**

---

### `lib/domain/` — pure domain rules (no DB/IO, may import reference/)

| File | Notes |
|---|---|
| `disposition.ts` | Pet disposition bucket rules, pure |
| `authority.ts` | Authority/role resolution logic, pure |
| `gov-scope.ts` | Govt jurisdiction scope — imports DB; **needs confirmation** (may be infra) |
| `jurisdiction-canonical.ts` | Canonical jurisdiction normalization |
| `jurisdiction-validation.ts` | Jurisdiction validation, imports ar-localidades (DB) — **infra candidate** |
| `jurisdiction-rules-href.ts` | URL-building for jurisdiction rules, pure |
| `approval-scope.ts` | Approval queue scoping, imports DB — **infra candidate** |
| `approval-routing.ts` | Approval routing rules |
| `revocation-scope.ts` | Revocation scope type definitions |
| `revocation-validation.ts` | Revocation validation rules |
| `institutional-scope.ts` | Scope/role type definitions, likely pure |
| `case-normatives.ts` | Case normative rules, imports modules/cases |
| `case-helpers.ts` | Case domain helpers |
| `business-rules-defaults.ts` | Default business rule values |
| `business-rules-validators.ts` | Rule validation pure functions |
| `microchip-validation.ts` | Chip format validation, pure |
| `dni-hash.ts` | DNI hashing (crypto only, no DB), pure util |
| `dni-next.ts` | Next DNI assignment rules |
| `location.ts` | Location type definitions, pure |
| `location-normalize.ts` | Location normalization, pure |
| `location-value.ts` | Location value object, pure |
| `amendment.ts` | Amendment domain logic |
| `apply-intent.ts` | Intent application logic |
| `disposition.ts` | (already listed above) |
| `libreta-health-status.ts` | Health status derivation, pure |
| `poncho-status.ts` | Poncho certificate status logic |
| `ppp-public-badge.ts` | PPP badge status derivation |
| `public-credential-confidence.ts` | Confidence scoring, pure |
| `rule-impact.ts` | Rule impact type definitions |
| `rule-impact-gate.ts` | Impact gate evaluation |
| `service-dog-labels.ts` | Service dog label mappings, pure |
| `service-dog-presentar.ts` | Presentar logic for service dogs |
| `vaccine-reminder-state.ts` | Vaccine reminder state machine |
| `libreta-sanitaria.ts` | Sanitary record rules — **needs confirmation** (may import DB) |
| `surveillance-eyebrow.ts` | Surveillance summary text helpers |
| `welfare-moderation.ts` | Welfare moderation rules |
| `scan-retention.ts` | Scan retention policy logic |
| `data-lifecycle.ts` | Data lifecycle rules |
| `privacy-prefs.ts` | Privacy preference rules |
| `bulk-select.ts` | Bulk selection state logic |
| `destructive-confirmation.ts` | Confirmation flow helpers |
| `lost-mode.ts` | Lost-mode state rules |
| `demo-mode.ts` | Demo mode flag logic |
| `escape-html.ts` | HTML escaping utility (pure) — could be utils/ |
| `format.ts` | Label formatting (imports EventType schema) |
| `magic-link-ttl.ts` | TTL constant + helper, pure |
| `mask-contact.ts` | Contact masking, pure |
| `keyset-pagination.ts` | Keyset cursor helpers (Drizzle types only) — **infra edge** |

Approximate count: **~45 files** (some will move to infra after confirmation)

---

### `lib/infra/` — DB queries, storage, external services

| File | Notes |
|---|---|
| `ar-localidades.ts` | Localities from DB via Drizzle |
| `breeds-server.ts` | Breed server-side DB query |
| `case-queries.ts` | Case paginated queries, Drizzle |
| `case-access.ts` | DB-backed access checks |
| `case-attachment.ts` | Attachment storage operations |
| `case-cron.ts` | Cron job for case lifecycle, DB |
| `adoption-listing.ts` | Adoption listing queries, Drizzle |
| `lost-listing.ts` | Lost-pet listing queries, Drizzle |
| `lost-pet-broadcast.ts` | Broadcast operations, external/DB |
| `pets.ts` | Pet DB queries |
| `pet-access.ts` | Pet access checks, DB + Supabase auth |
| `pet-identifier-mapping.ts` | Identifier mapping queries, DB |
| `pet-identifiers.ts` | Identifier operations, DB |
| `pet-pipeline.ts` | Pet pipeline queries, DB |
| `pet-projections.ts` | Projection queries, DB |
| `rederive-pet-cache.ts` | Cache derivation, DB |
| `identifications.ts` | Identification DB operations |
| `photo-helpers.ts` | Photo storage operations |
| `storage.ts` | Supabase storage client wrapper |
| `uploads.ts` | File upload helpers |
| `welfare-uploads.ts` | Welfare-specific upload helpers |
| `geocoding.ts` | Geocoding via Nominatim/external |
| `geo-join.ts` | Geo join queries, DB |
| `rate-limit.ts` | Rate limiting via DB bucket |
| `db-errors.ts` | DB error helpers |
| `unique-token.ts` | Unique token generator with DB retry |
| `request-cache.ts` | Request-scoped cache helper |
| `miarg-oidc.ts` | OIDC integration, external service |
| `auth-guards.ts` | Auth guard helpers, Supabase + DB |
| `cron-auth.ts` | Cron authentication (timing-safe, pure-ish) |
| `role-landing.ts` | Role landing page query, DB |
| `microchip-force-token.ts` | Force-token operations, DB |
| `chip-lookup.ts` | Chip lookup queries, DB |
| `tattoo-ack-token.ts` | Tattoo ack token, DB |
| `tattoo-lookup.ts` | Tattoo lookup, DB |
| `libreta-share-token.ts` | Share token operations, DB |
| `publicToken.ts` | Public token helpers, DB |
| `scan-retention.ts` | (see domain — may belong here if DB) |
| `like-helpers.ts` | SQL LIKE helpers (Drizzle) |
| `defer-print.ts` | Deferred print token, DB |
| `physical-tag-interest.ts` | Physical tag interest, DB |
| `physical-credential-channels.ts` | Credential delivery channels, DB |
| `approval-payloads.ts` | Approval payload builders, DB |
| `approval-payload-view.ts` | Approval payload view, DB |
| `approval-queue-breakdown.ts` | Queue breakdown query, DB |
| `business-rules-resolver.ts` | Rule resolver, DB |
| `business-rules-reeval.ts` | Rule re-evaluation, DB |
| `org-census.ts` | Org census queries, DB |
| `org-dashboard.ts` | Org dashboard queries, DB |
| `org-public-offerings.ts` | Org public offerings query, DB |
| `org-public-profile.ts` | Org public profile query, DB |
| `org-setup-checklist.ts` | Setup checklist state, DB |
| `origin-org.ts` | Origin org lookup, DB |
| `outreach-pipelines.ts` | Outreach pipeline queries, DB |
| `owner-nudges.ts` | Owner nudge logic, DB |
| `owner-disease-alerts.ts` | Disease alert queries, DB |
| `performed-by-search.ts` | Performer search, DB |
| `omnibox-search.ts` | Omnibox full-text search, DB |
| `parse-registries.ts` | Registry parse, DB |
| `govt-roster.ts` | Govt roster queries, DB |
| `admin-search.ts` | Admin search, DB |
| `admin-province-link.ts` | Province link queries, DB |
| `admin-approval-queue.ts` | Approval queue admin queries, DB |
| `slot-materialization.ts` | Slot materialization, DB |
| `notifications.ts` | Notification queries, DB |
| `rabies-observation-closer.ts` | Rabies observation operations, DB |
| `welfare-location-audit.ts` | Welfare location audit, DB |
| `welfare-org-projection.ts` | Welfare org projection, DB |
| `backfill-eno-trigger-helpers.ts` | Backfill helpers, DB |
| `eno-trigger.ts` | ENO trigger via module infra |
| `eno-queue-processor.ts` | ENO queue processing, DB |
| `outbox-drainer.ts` | Outbox drainer, DB |
| `outbox-list.ts` | Outbox listing, DB |
| `outbox-queries.ts` | Outbox queries, DB |

Approximate count: **~70 files**

---

### `lib/events/` — event schemas, outbox, idempotency, upcasters

| File | Notes |
|---|---|
| `events.ts` | Event query / projection, DB |
| `event-schemas.ts` | Zod event payload schemas |
| `event-upcasters.ts` | Event version upcasters |
| `event-confidence.ts` | Event confidence scoring |
| `event-idempotency.ts` | Idempotency key helpers |
| `event-outbox-enqueue.ts` | Outbox enqueue operation |
| `event-outbox-rules.ts` | Outbox routing rules |
| `event-capture-matcher.ts` | Event capture pattern matcher |
| `event-capture-registry.ts` | Event capture registry |

Approximate count: **9 files**

---

### `lib/analytics/` — metrics, KPIs, dashboards, exports (DB-read, no writes)

| File | Notes |
|---|---|
| `analytics-load.ts` | Analytics loading, DB |
| `analytics-period.ts` | Analytics period helpers |
| `analytics-ranking.ts` | Ranking computations |
| `campaign-metrics.ts` | Campaign metric queries, DB |
| `compliance-metrics.ts` | Compliance metrics, DB |
| `mortality-metrics.ts` | Mortality metrics, DB |
| `surveillance-metrics.ts` | Surveillance metrics, DB |
| `admin-metrics.ts` | Admin dashboard metrics, DB |
| `govt-dashboards.ts` | Govt dashboard aggregations, DB |
| `govt-dashboards-confidence.ts` | Confidence dashboard, DB |
| `govt-exports.ts` | Govt data exports |
| `govt-home-kpis.ts` | Home KPI computations, DB |
| `org-census.ts` | (also listed in infra — confirm) |
| `org-dashboard.ts` | (also listed in infra — confirm) |
| `owner-dashboard.ts` | Owner dashboard aggregations, DB |
| `ppp-exports.ts` | PPP export generation |
| `welfare-exports.ts` | Welfare export generation |
| `viz-scales.ts` | Chart/visualization scale helpers |

Approximate count: **~18 files**

---

### `lib/ui/` — shell nav, breadcrumbs, presentation helpers, React hooks

| File | Notes |
|---|---|
| `shell-nav.ts` | Shell navigation structure (imports components) |
| `operator-breadcrumbs.ts` | Operator breadcrumb computation |
| `audit-entry-view.ts` | Audit entry presentation helpers |
| `audit-target-link.ts` | Audit target link builder |
| `audit-action-labels.ts` | Audit action label map |
| `branding.ts` | Branding constants / helpers |
| `govt-exports.ts` | (also in analytics — confirm) |
| `form-checkbox.ts` | Checkbox form helper |
| `use-evidence-upload.ts` | Upload React hook |
| `use-form-error-focus.ts` | Form error focus React hook |
| `use-idempotency-key.ts` | Idempotency key React hook |
| `denuncia-autosave.ts` | Autosave hook for denuncia form |
| `sheet-helpers.ts` | Sheet/modal helper functions |
| `chip-lookup.ts` | (see infra — chip lookup could be here if UI-only) |
| `surveillance-eyebrow.ts` | Dashboard eyebrow text, pure presentation |
| `libreta-health-status.ts` | (see domain — presentation of status) |
| `ux-3.5-polish.ts` | UX polish helpers (needs confirmation) |
| `owner-dashboard-confidence.ts` | Confidence display helpers, DB |

Approximate count: **~17 files**

---

### `lib/utils/` — pure cross-cutting utilities

| File | Notes |
|---|---|
| `escape-html.ts` | HTML escaping, pure |
| `format.ts` | Label formatting helpers |
| `keyset-pagination.ts` | Keyset cursor encoding (Drizzle types) |
| `like-helpers.ts` | SQL LIKE wrapper |
| `mask-contact.ts` | Contact masking, pure |
| `magic-link-ttl.ts` | TTL constants, pure |
| `dni-hash.ts` | DNI HMAC hash, pure |
| `unique-token.ts` | (DB-backed — may stay in infra/) |
| `parse-registries.ts` | (DB — may stay in infra/) |

Approximate count: **~9 files**

---

### Uncategorized / needs confirmation (~24 files)

These overlap two or more buckets; assign after reading imports fully:

`gov-scope.ts`, `jurisdiction-validation.ts`, `institutional-scope.ts`,
`approval-scope.ts`, `revocation-scope.ts`, `case-normatives.ts`,
`libreta-sanitaria.ts`, `scan-retention.ts`, `data-lifecycle.ts`,
`privacy-prefs.ts`, `demo-mode.ts`, `role-landing.ts`, `notifications.ts`,
`outreach-pipelines.ts`, `owner-nudges.ts`, `owner-disease-alerts.ts`,
`welfare-moderation.ts`, `welfare-location-audit.ts`, `welfare-org-projection.ts`,
`welfare-exports.ts`, `ppp-exports.ts`, `ppp-public-badge.ts`,
`poncho-status.ts`, `public-credential-confidence.ts`

---

## Migration recipe (per file)

1. **Confirm bucket** — read imports; assign to `domain/`, `infra/`, `reference/`, `analytics/`, `events/`, `ui/`, or `utils/`.
2. **`git mv`** — `git mv lib/<file>.ts lib/<bucket>/<file>.ts`
3. **Repoint imports** — `@/lib/<file>` → `@/lib/<bucket>/<file>` (mechanical; caught by typecheck).
4. **Move sibling test** — `git mv lib/<file>.test.ts lib/<bucket>/<file>.test.ts` if it exists.
5. **Update baseline** — remove the moved file from `scripts/lib-root-baseline.json`.
6. **Verify** — `pnpm lint:lib-root && pnpm typecheck && pnpm build` must stay green.
7. **Commit per batch** — one commit per bucket batch keeps diffs reviewable.

> **Import repointing is mechanical but wide.** The `@/lib/x` alias pattern is used throughout
> `app/`, `src/modules/`, and other `lib/` files.  A bulk search-replace (`rg -l '@/lib/<file>'`)
> then `sd '@/lib/<file>' '@/lib/<bucket>/<file>'` is the fastest path.  Run typecheck to catch
> any missed repoints before committing.

---

## Batch order (recommended)

1. **`lib/reference/`** — smallest blast-radius; files have few inbound references; pure static.
2. **`lib/events/`** — coherent cluster; already logically grouped; moderate inbound refs.
3. **`lib/utils/`** — pure utilities; easy to verify; small set.
4. **`lib/ui/`** — touches component tree; run Playwright smoke after this batch.
5. **`lib/analytics/`** — all DB-read; no write side-effects; medium blast-radius.
6. **`lib/domain/`** — highest inbound fan-in; tackle after lower-risk buckets are done.
7. **`lib/infra/`** — largest bucket; do last; split into sub-batches by feature area.

---

## Existing subdirs (keep, do not rename)

- `lib/metrics/` — already used; `analytics/` files that depend on `lib/metrics/` stay consistent.
- `lib/projections/` — keep; projection helpers already isolated.
- `lib/supabase/` — keep; Supabase client factory stays here.
- `lib/achievements/` — keep; already bucketed.
- `lib/case-closers/` — keep; already bucketed.

---

## Remaining F-items (out of scope for this task)

- **F4** — `lost/` consolidation (lost-listing, lost-mode, lost-pet-broadcast consolidation)
- **F5** — Enum extraction from DB schema into `lib/reference/` or `src/modules/*/domain/`
- **F6** — Import spelling audit (`@/lib/x` vs `./x` vs `../lib/x`) — enforce consistent `@/lib/` alias
- **F7** — AGENTS.md / slim orchestration instructions

These are tracked separately and should not block the bucketize migration.

---

## CI guard summary

| Script | What it checks |
|---|---|
| `pnpm lint:lib-root` | No new `.ts` files at `lib/` root beyond baseline |
| `pnpm typecheck` | All import repoints are valid after each move |
| `pnpm build` | Next.js build succeeds end-to-end |

The ratchet (`lint:lib-root`) will stay green throughout migration: each `git mv` is
accompanied by removing the moved file from `scripts/lib-root-baseline.json`, so the
baseline count decreases monotonically toward zero.
