# Surveillance metrics hardening (`/gob/vigilancia`) — design spec

> **Status:** 🟢 Ready for Claude Code · **Date:** 2026-06-18 · **Item 3**
> · Umbrella: `dim-interno:docs/superpowers-private/specs/archive/2026-06-18-metrics-ia-handoff-design.md` · **Depends on Item 0 (`lib/metrics/`)**

## 1. Por qué este documento existe

`/gob/vigilancia` (brotes/zoonosis/investigaciones) already reads `outbreak_signal`, `symptom_observed`, bites and active-zoonosis KPIs. Four high-value signals are present in the event log but not yet measured: (A7) whether our **ENO notification duty** is actually being met on time, (A8/A9) whether the legally-mandated **10-day rabies observation** is closing within the window, (A12) **antimicrobial-use density** for AMR surveillance (an explicit dashboard target in `AGENTS.md`), and (A6/A10) **reportable-disease incidence + lab-confirmation rate**. These turn vigilancia from "we detected signals" into "we are demonstrably discharging the legal surveillance obligations" — the thing a sanitary authority is audited on.

## 2. Decisiones cerradas

- **D1 — Measure our own pipeline, not external delivery.** A7 reads `event_notification_outbox` rows with `target_kind='eno_authority'`: time from row-created to row-drained, and count of breached/over-SLA rows. It does **not** assert SENASA received anything (umbrella §6).
- **D2 — Rabies-observation compliance reads the existing pair.** A8/A9 use `rabies_observation_started`/`_ended` + `pets.rabies_observation_status` (shipped by the bite-rabies-observation feature). "Breached" = period open past the 10-day legal window without a closing event.
- **D3 — AMR needs an antimicrobial classifier.** Add `isAntimicrobial(drugCode)` to `lib/drugs.ts` (or a sibling `lib/antimicrobials.ts`) seeded from the existing drug catalog. A12 = antimicrobial `medication_started` per 1,000 active pets per quarter. If the catalog can't be classified confidently, ship A12 as a raw count with a "classification provisional" note rather than a rate.
- **D4 — Reuse `notificable_eno` codes.** A6/A7 keyed off `pet_events.notificable_eno=true` (vacunacion_antirrabica / observacion_antirrabica / mordedura_notificada) per `lib/sanitary-vocab.ts`.
- **D5 — k-anonymity + jurisdiction scope via Item 0.** Uses `suppressSmallCells`, `ProjectionContext`, and the shared scope/denominator helpers from `lib/metrics/` (Item 0). This item no longer introduces its own `lib/anonymity.ts` — that boundary now lives in Item 0 and is consumed here.

## 3. Metrics

| Code | Metric | Definition | Source |
|------|--------|------------|--------|
| A7 | **ENO-notification SLA** | `% outbox rows (target_kind='eno_authority') drained within target` + breached count; median latency | `event_notification_outbox` |
| A8 | **Rabies-observation compliance** | `% observations closed within 10 days / all closed`; count currently open | `rabies_observation_started/_ended`, `pets.rabies_observation_status` |
| A9 | Rabies-observation breaches | count of observations open past day 10 (live `OpBreach`) | same |
| A12 | **AMR / antimicrobial density** | antimicrobial `medication_started` per 1,000 active pets / quarter, by jurisdiction | `medication_started` + `isAntimicrobial` |
| A6 | Reportable-disease incidence | count by `disease_code` from `disease_reported` + `death_recorded.is_reportable` | `disease_reported`, `death_recorded` |
| A10 | Lab-confirmation rate | `% confirmed_by_lab / all reportable` | `disease_reported.confirmed_by_lab`, `death_recorded.confirmed_by_lab` |
| A5 | Symptom→signal latency (stretch) | median(`outbreak_signal.occurred_at − source symptom occurred_at`) | `symptom_observed`→`outbreak_signal` |

## 4. UI surfaces

Add to `/gob/vigilancia` (and where natural, its `brotes`/`zoonosis` subscreens):

```
KPI row additions (OpKpi):  Cumplimiento observación 10d (A8)  ·  SLA notificación ENO (A7)  ·  Densidad ATM/AMR (A12)
OpCard "Cumplimiento legal":  A8 gauge + A9 OpBreach list (open-past-10d observations, linkable to /admin/observaciones)
OpCard "Notificación ENO":    A7 latency + breached outbox rows (link to /admin/outbox)
OpCard "Enfermedades":        A6 incidence by disease_code + A10 lab-confirmation rate
OpCard "AMR":                 A12 density trend by quarter
```

Admin mirror: surface A7 breached-row count on `/admin/sistema` (it already shows queue health) and as the existing `/admin/outbox` badge — reuse, don't duplicate.

## 5. Implementation

- **`lib/govt-dashboards.ts`** (or new `lib/surveillance-metrics.ts`): `fetchSurveillanceCompliance(actor, jurisdiction, period)` → `{ enoSla, rabiesObsCompliance, openObsBreaches, amrDensity, reportableIncidence, labConfirmationRate }`. Each sub-metric a scoped aggregate.
- **`lib/metrics/`** (from Item 0): consume `suppressSmallCells`, `buildProjectionContext`, and the shared scope/denominator helpers. Do not create a local anonymity helper.
- **`lib/antimicrobials.ts`** or extend `lib/drugs.ts`: `isAntimicrobial(code): boolean` + the curated list; unit-tested.
- **`app/gob/vigilancia/page.tsx`** + `_components/`: add the four cards. Keep fetch in the server component.

## 6. Test plan (test-first)

`__tests__/surveillance-compliance.test.ts`:
1. Seed outbox rows drained inside/outside SLA → assert A7 % + breached count + median.
2. Seed observations: one closed on day 8, one open on day 12 → A8 = 100% of *closed* within window, A9 = 1 open breach.
3. Seed `medication_started` antimicrobial vs not → A12 rate uses only antimicrobials; assert per-1,000 math.
4. Seed reportable deaths/disease reports with/without `confirmed_by_lab` → A6 counts + A10 rate.
5. k-anonymity + jurisdiction-scope cases.
`__tests__/antimicrobials.test.ts`: classifier truth table on known catalog codes.

## 7. Docs to update (same PR)

- `AGENTS.md` → **Dashboards & projections › Public-health analyst** and **› Sanitary authority**: add ENO-SLA, rabies-observation compliance, AMR density, reportable-disease incidence + lab-confirmation.
- `AGENTS.md` → **SENASA reference vocabularies**: cross-link the `notificable_eno` paragraph to the new A7 metric (the outbox SLA is now measured even though auto-fire is still follow-up).
- `AGENTS.md` → **Feature inventory** (Surveillance & health rows).
- `docs/superpowers/README.md` — row ✅ + SHA. Note the relationship to the existing `2026-05-21-eno-pipeline-design.md` (this measures the pipeline that spec defines).

## 8. Lo que NO está acá

- No auto-fire of ENO notifications to external authorities (separate follow-up; we only measure outbox latency).
- No new disease codes or reportability rules — read the existing `notificable_eno` vocabulary.
- No owner-facing disease alerts (that's `2026-05-19-eno-vet-direct-report-and-owner-alerts-design.md`).
- No predictive/anomaly modeling for clusters — counts and rates only; anomaly highlighting is a later analytics spec.

## 9. Phasing

- **Fase 1 (1 PR):** A8/A9 rabies-observation compliance card + tests (lowest-dependency, pure read of existing pair) on top of Item 0's `lib/metrics/`.
- **Fase 2 (1 PR):** A7 ENO-SLA card + admin mirror.
- **Fase 3 (1 PR):** A6/A10 incidence + lab-confirmation.
- **Fase 4 (1 PR):** `isAntimicrobial` + A12 density (depends on classifier decision, umbrella §7).

---

## Próximo paso
Decide the AMR classifier source (umbrella §7). Fases 1–3 have zero open questions and can start immediately.
