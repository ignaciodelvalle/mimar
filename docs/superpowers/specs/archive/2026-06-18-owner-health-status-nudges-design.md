# Owner health-status nudges (`/inicio`) — design spec

> **Status:** 🟢 Ready for Claude Code · **Date:** 2026-06-18 · **Item 5**
> · Umbrella: `dim-interno:docs/superpowers-private/specs/archive/2026-06-18-metrics-ia-handoff-design.md`

## 1. Por qué este documento existe

`/inicio` is the owner's landing page but isn't framed around action. The same compliance signals the authority dashboards aggregate (overdue vaccine, missing chip) are, at the individual level, exactly the nudges that move owner behavior — and owner behavior is what actually raises the population-level coverage the authority measures. This item adds a per-pet "estado sanitario" surface to `/inicio`. It is **owner-facing only**: derived from the owner's own events, never from surveillance signals.

## 2. Decisiones cerradas

- **D1 — Owner data only.** Nudges read the owner's pets' events. No `outbreak_signal`, no `disease_reported`, no cross-pet data. (Dangerous-zoonosis owner alerts are a *different*, SME-gated spec: `2026-05-19-eno-vet-direct-report-and-owner-alerts-design.md`. Out of scope here.)
- **D2 — Derive, don't store.** All nudges are computed on read from existing events/reminders. No new column, no new event type.
- **D3 — Reuse the owner design language**, not the `Op*` operator chrome. Use the existing owner card/components on `/inicio`.
- **D4 — Nudges are encouraging, never alarming.** Copy stays supportive ("Vacuna antirrábica vencida — agendá un turno"), with a direct action link (schedule/booking). No red-alarm framing; this is a health companion, not an enforcement notice.

## 3. Nudges (per pet, derived)

| Nudge | Source | Action link |
|-------|--------|-------------|
| Overdue / upcoming vaccine | latest `vaccination_administered.next_due_at` vs now (+ the `vaccine-due` reminder/cron already in `api/cron`) | `/turnos/buscar` or `…/eventos/nuevo/vacuna` |
| Microchip status | presence of `microchip_implanted` | `…/eventos/nuevo/microchip` if missing |
| Next reminder | open `reminders` for the pet | reminder target |
| Sterilization status | presence of `sterilization_performed` (informational) | `…/eventos/nuevo/esterilizacion` |
| Credential activity | recent `credential_scanned` (non-self) count | `/mis-mascotas/[token]` (e.g. "tu credencial fue escaneada 2 veces") |
| Libreta share activity | active Tier-2 share tokens / `share_telemetry` | `…/mostrar-libreta` |

A small per-pet "estado" summary (e.g. "Al día" vs "2 pendientes") rolls these up.

## 4. Implementation

- **`lib/owner-home.ts`** (new or extend existing `/inicio` data loader): `fetchPetHealthStatus(ownerId)` → per-pet `{ vaccineStatus, hasChip, openReminders, lastScan, shareActive, summary }`. Pure reads over the owner's events/reminders.
- **`app/(app)/inicio/page.tsx`** + `_components/`: render a per-pet status strip/card using existing owner components. Server component fetches.
- Reuse the `lib/projections/` pure replay helpers for pet status where they already exist (they're "domain-grade" per the README) — don't re-derive status logic.

## 5. Test plan (test-first)

`__tests__/owner-home-status.test.ts`:
1. Pet with expired `next_due_at` → vaccine nudge present; with a future one → absent.
2. Pet with no `microchip_implanted` → chip nudge present; chipped → absent.
3. Open reminder surfaces; completed one doesn't.
4. `credential_scanned` with `is_self_scan=true` excluded from activity count; external scan counted.
5. Isolation: owner A never sees owner B's pets (RLS/scope).

## 6. Docs to update (same PR)

- `AGENTS.md` → **Feature inventory › Owner-facing**: add the `/inicio` health-status nudges row.
- `README.md` → **Status › Owner**: mention the estado-sanitario nudges.
- `docs/superpowers/README.md` — row ✅ + SHA.

## 7. Lo que NO está acá

- No surveillance/diagnoses surfaced to owners.
- No push/email channel changes — reuse existing notifications; this is an on-page surface.
- No gamification/achievements (that's `2026-05-19-pet-profile-v2-design.md`).
- No behavior-change analytics (whether nudges worked) — future.

## 8. Phasing

- **Fase 1 (1 PR):** `fetchPetHealthStatus` + vaccine/chip/reminder nudges + tests.
- **Fase 2 (1 PR):** scan + share activity + per-pet rollup summary.

---

## Próximo paso
Independent of Items 1–4; can be picked up any time. CC matches the copy tone to the existing owner-portal voice guide when wiring strings (no owner input needed).
