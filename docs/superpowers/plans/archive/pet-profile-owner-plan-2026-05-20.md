# Pet profile — owner view redesign

**2026-05-20 · scope: `/mis-mascotas/{publicToken}` for `owner` role**

## Why this plan

The pet profile is the single most-used page in DIM after the home, and it currently does too much: AchievementsSection, PetOpenCasesSection, PpPCard, PregnancyInProgressCard, ServiceDogCredentialCard, libreta sanitaria filters, medication doses, an inline event timeline — all stacked. It works, but the **most time-critical reasons an owner opens a pet's profile are buried**: an emergency, a vaccine due, a question about an alert.

The user call: *"Make it tidy first, then we go deeper. Each role views the pet completely different. Owner view is optimized for emergencies."* This plan is the owner half. Vet, shelter, and govt views will follow as their own plans — same hero, different sections beneath.

Most forms already exist. This plan is about **viewing**, not capturing — pages that capture (`/anotar`, `/editar`, `/vacunas`, `/perdida`, etc.) stay where they are.

## Anchored principles

- Emergencies are the top priority. The vet phone number should be one tap away from the profile root.
- The pet's state has one consistent visual signal everywhere. The frame color around the photo in the home chip row, the hero, and any pet card is the **same** color from the **same** map (`ok` / `info` / `attention` / `urgent`).
- One affirmative blue button per section, max. Modo perdido is `danger` (outline red), Compartir QR is `primary` (gob navy), Editar is `link`. The page should not feel "buy now."
- The owner profile assumes mobile-first. Single column, generous tap targets (≥44px).
- Append-only model is preserved. The profile shows projections — no UI that mutates pet rows except where existing actions already do.

## Hierarchy (owner view, top to bottom)

```
┌─ Hero            big photo + state badge + name/meta + actions
├─ Emergencias     vet phone · contacto emergencia · alertas médicas
├─ Salud           filter chips + recent events + weight sparkline
├─ Vacunas         overdue + upcoming with "Agendar"
├─ Track tu mascota   placeholder CTA — "Conectar dispositivo"
├─ Identificación digital   QR + token + link to libreta pública
└─ Documentos de viaje  pasaporte + certif. internacional
```

What's deliberately demoted off the root (owner can still reach all of it via menu / subroutes):

- `AchievementsSection` — fun, not urgent. Lives in `/cuenta/logros`.
- `PetOpenCasesSection` — duplicated by the new "Mis casos" widget on /inicio.
- `PpPCard`, `ServiceDogCredentialCard`, `PregnancyInProgressCard` — contextual cards that the live page already shows conditionally. They stay in the profile but **below** the seven sections above; only render when applicable.

## New components

All under `components/pet-profile/` to avoid further crowding of `components/` root.

| File | Role | Imports `@/db`? |
|---|---|---|
| `PetProfileHero.tsx` | Server. Hero with state-colored 148px photo ring, name/meta line, primary actions row. | No |
| `PetEmergencyCard.tsx` | Server. Vet + emergency contact buttons (tel: links) + medical alerts list. | No |
| `PetHealthTimeline.tsx` | Client (filter state). Top events with filter chips. | No |
| `PetWeightChart.tsx` | Server. SVG sparkline from `WeightSample[]`. No JS, no chart lib. | No |
| `PetVaccineReminders.tsx` | Server. Overdue + upcoming vaccines with "Agendar" CTAs. | No |
| `PetTrackingPlaceholder.tsx` | Server. Big dashed-emerald CTA to pair a tracker. | No |
| `PetCredentialCard.tsx` | Server. QR image + token + link to `/p/{token}`. | No |
| `PetTravelDocs.tsx` | Server. Pasaporte + certif. internacional, with empty states. | No |

Preview composer: `app/(app)/mis-mascotas/[publicToken]/v2/page.tsx`. Same `requirePetAccess` guard as the live profile, all data hardcoded for now.

### State convention reused

The `PetState` enum + `PET_STATE_RING` / `PET_STATE_LABEL` maps already live in `components/EventCatcher.tsx` (added in the home-v3 pass). `PetProfileHero` duplicates the maps inline for visual clarity — when v3 ships, we extract to `lib/pet-state.ts` and dedupe.

## Data wiring (post-recovery)

Once Phase 0 of the action plan completes and the Drizzle schema is whole again, the v2 page replaces sample data with the queries the live profile already uses, plus three small additions:

| Section | Source | Status |
|---|---|---|
| Hero (`PetHeroPet`) | `pets` + a `derivePetState(events, status)` helper that maps to `PetState`. | Helper TBD. |
| Hero (`weightLabel`) | Latest `weight_recorded` event. | Selector exists; just expose. |
| Hero (`lostMode`) | `pets.status === "lost"`. | Already there. |
| Emergencias (`vet`) | `profile.preferredVetContact` (TBD column) or first vet appointment's provider. | Decision needed — see "Open decisions". |
| Emergencias (`emergencyContact`) | `profile.emergencyContact*` columns. | TBD; likely add. |
| Emergencias (`alerts`) | Derived from petEvents: active rabies observation, allergy detections, ongoing critical conditions. | Helper TBD: `derivePetAlerts(events)`. |
| Salud | `fetchPetEvents(petId, limit=5, libretaFilter=null)`. | Exists. |
| Salud (weight chart) | `petEvents.filter(e => e.type === "weight_recorded")` last 12 months. | Selector TBD. |
| Vacunas | `reminders.where(petId, type='vaccine', deletedAt is null)` ordered by dueAt. | Exists. |
| Tracking | Stub for v1. Phase 2: query `pet_tracker_devices`. | New table TBD. |
| Credencial | `pets.publicToken` + `/p/{token}.png` route. | Token exists; QR route TBD. |
| Docs viaje | `pet_attachments.where(kind in ('passport', 'intl_cert'))`. | Table TBD or fold into `attachments`. |

## Role-split intent (this plan + three to follow)

The hero stays the same across roles — name, photo, state badge — because identity should be invariant. The sections below the hero change:

| Section | Owner | Vet | Shelter | Govt |
|---|---|---|---|---|
| Emergencias | ✅ | ✅ (different contacts — clinic) | partial | — |
| Salud (timeline) | ✅ (read) | ✅ (write — primary action) | ✅ (write) | ✅ (read, jurisdiction-scoped) |
| Vacunas | ✅ (book) | ✅ (administer) | ✅ (book) | metric only |
| Tracking | ✅ (pair) | — | — | — |
| Credencial | ✅ (share) | view-only | view-only | view-only |
| Travel docs | ✅ (upload) | view + sign | — | view |
| Custody / case | when applicable | — | ✅ (primary surface) | ✅ (cross-org cases) |
| Sanidad pública | — | — | — | ✅ (vaccines, surveillance, bites) |

These four plans share the hero + emergency primitives; each lives in its own `[publicToken]/v2/page.tsx`-style preview before we resolve which surfaces compose into the canonical route by role.

## Open decisions

1. **Where do vet + emergency contacts live in the schema?** Three options: (a) on `profiles` as `preferredVetContactName/Phone` + `emergencyContactName/Phone`; (b) on `pets` per-pet override; (c) both — profile default with per-pet override. Recommendation: (c), since people often have different vets for cat vs. dog.
2. **Alert derivation.** The active alerts shown in the emergency card come from a derived projection. We need to decide which event types produce alerts and how long they persist. Initial list: `rabies_observation_started` until matching `_ended`, `clinical_info_logged` where `sub_kind === "allergy_detection"`, ongoing `medication_started` (terminate on `_stopped`). Worth a small spec.
3. **Tracking placeholder vs ad.** The placeholder CTA can either (a) explain the concept and stay neutral, or (b) link to a specific recommended device. (a) is honest; (b) drives adoption faster but couples DIM to a vendor. Current draft is (a).
4. **Public credential page (`/p/{token}`) vs lost-mode public page.** When a pet enters Modo perdido, does the same `/p/{token}` URL render a different layout, or does the QR redirect to `/p/{token}/perdida`? Cleaner to keep one URL and switch the layout server-side on `pets.status === "lost"`.
5. **Travel docs storage.** Either reuse `attachments` (with a new `kind`) or add a `pet_attachments` table. Reuse is cheaper, dedicated table is cleaner. Lean toward reuse for v1.

## Out of scope

- Vet view, shelter view, govt view (separate plans, same hero).
- Real GPS tracker integration. v1 is a placeholder.
- QR-image generation route. The component takes a URL; the route is TBD.
- The `derivePetState` and `derivePetAlerts` helpers — names reserved, implementations follow once events queries are live again.
- Sharing UX for the credential card (the share sheet, link expiry, opt-in copy).

## Suggested next step

Once Phase 0 of the action plan is verified clean, point a Claude Code session at `app/(app)/mis-mascotas/[publicToken]/v2/page.tsx`. Swap the seven sample blocks for live queries one section at a time — hero first, then emergencias (which needs the schema decision in Open decision #1), then salud (existing queries), then the rest. When the v2 page reaches parity, fold its body into the live profile page and retire `/v2`.
