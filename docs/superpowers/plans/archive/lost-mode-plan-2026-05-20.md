# Modo perdido — design alignment

**2026-05-20 · scope: owner cockpit + public credential lost view**

## Why this plan

Modo perdido already works end-to-end in the codebase. The activation form (`/mis-mascotas/{token}/perdida/MarkLostForm.tsx`) collects last location + reason + the five disclosure prefs that have lived on `pets` since migration 0012. The case spine has `lost_pet_episode` with a defined lifecycle. The public credential at `/p/{token}` has `FoundPetForm` and `ScanLogger` wired. What's missing is **a cockpit for the active state**: once the pet is lost, the owner needs a single screen that lets them share, watch the scans, read finder messages, and mark the pet found.

This plan brings modo perdido up to current system state — frame-color convention, Poncho buttons, Cases spine integration, rounded-2xl surfaces, mobile-first density — without adding new schema. Everything renders against data that already exists.

## What already ships

| Concern | File / Table | Status |
|---|---|---|
| Activation form (point picker + 5 prefs + reason) | `app/(app)/mis-mascotas/[publicToken]/perdida/MarkLostForm.tsx` | shipped |
| `setPetLostAction` server action | `app/actions/events.ts` | shipped |
| Disclosure prefs on `pets` | migration 0012 | shipped |
| `lost_pet_episode` case kind + lifecycle | `lib/case-kinds.ts`, `lib/case-lifecycles/lost-pet-episode.ts` | shipped |
| Cron auto-close after 180 d | `cronCloseRoute: "/api/cron/close-stale-lost-episodes"` | shipped |
| Public credential / `/p/{token}` | `app/p/[publicToken]/page.tsx` | shipped |
| Finder form | `app/p/[publicToken]/FoundPetForm.tsx` | shipped |
| QR scan logging | `app/p/[publicToken]/ScanLogger.tsx` | shipped |
| Lost-pets feed for govt | `/gob/perdidas` | shipped |
| "Mark found" button | `MarkFoundButton.tsx` | shipped |

## What this pass adds (presentation only)

Six new files under `components/pet-profile/`. None imports `@/db`. All compose existing data.

| File | Role |
|---|---|
| `LostModeBanner.tsx` | Red strip with photo, "{Name} está perdida", "hace 3h 42min", case ref link, big white "Marcar encontrada" button. |
| `LostShareCard.tsx` | Client. WhatsApp / Twitter / Facebook / Afiche buttons + copy-link. Uses `navigator.share` when available. |
| `LostLastSeenCard.tsx` | Static map preview + place name + locality + owner note + edit link + add-sighting link. |
| `LostDisclosureCard.tsx` | Five toggle rows mapped 1:1 to the existing `pets.disclose_*_when_lost` columns. Each row is a server-action form. |
| `LostScanFeed.tsx` | Two count tiles + unified scans + finder-messages feed, grouped by burst. |
| `LostPublicCredential.tsx` | The view a stranger sees when scanning the QR while the pet is lost. Drop-in for the lost branch of `/p/{token}`. |

Preview routes:

- `app/(app)/mis-mascotas/[publicToken]/perdida-v2/page.tsx` — owner cockpit (auth-gated by `requirePetAccess`).
- `app/p/[publicToken]/v2/page.tsx` — public lost view (no auth).

## State-color alignment

The pet's frame color in `EventCatcher`, `PetProfileHero`, and any future pet card uses the same `PetState` map. While lost:

- `state: "urgent"` (red ring)
- `stateLabel: "Perdida"`
- The hero badge straddles the bottom of the photo ring as before.

The cockpit's red banner sits **above** the hero on the active-lost profile. Combined, the page reads: red banner → red-ringed hero → red badge — a single coordinated signal that the pet is missing.

## Owner cockpit hierarchy

```
┌─ LostModeBanner             status + case ref + "Marcar encontrada"
├─ LostShareCard              WhatsApp · X · Facebook · Afiche · Copiar link
├─ LostLastSeenCard           pin + caption + edit + add-sighting
├─ LostDisclosureCard         five prefs · live "ver como público"
├─ LostScanFeed               18 escaneos · 3 mensajes · merged timeline
└─ small caption              "tocá Marcar encontrada cuando vuelva"
```

The regular profile sections (Salud, Vacunas, Tracking, Credencial, Travel docs) collapse under "Ver perfil completo →" or move into a tab. The owner during a crisis should not see weight charts and travel docs unless they ask for them.

## Public lost view hierarchy (`/p/{token}` when lost)

```
┌─ red rooftop strip          "Mascota perdida — desde hace 3 h"
├─ photo (red-ringed)         big, centered
├─ "¡Hola! Soy Roma —         …estoy perdida"
├─ identity line              "Canino · marrón · collar rojo"
├─ distinguishing features    italics, in quotes
├─ primary actions row        "📞 Llamar a Ignacio" (if phone disclosed)
│                              "📍 La encontré" (if finder form allowed)
├─ last-seen card             place + locality + small map (if disclosed)
└─ small footer               "Esta credencial pertenece a MiMAR…"
```

Vaccines, weight, full libreta — all hidden by default in lost mode. The lost view's job is to convert a scan into a contact, not to tour the pet's history.

## Data wiring (post-recovery)

Once Phase 0 of the action plan is clean and the cases table is back in `db/schema.ts`, the v2 page bodies wire up like this — no new queries required, only composition.

| Field | Source |
|---|---|
| `lostSince` | `cases.openedAt` for the open `lost_pet_episode` |
| `casePublicCode` | `cases.publicCode` |
| `jurisdictionLabel` | `pets.jurisdictionLocality` (already denormalized) |
| `placeName` / `lat,lng` | `cases.primary_location_*` |
| `note` | opening event payload (`reason` field on the `status_changed → lost`) |
| `feed.scans` | `petEvents.where(type='credential_scanned', petId, since=cases.openedAt)` |
| `feed.finder` | finder-form submissions — **see open decision 2** |
| Disclosure toggles | `pets.disclose_*_when_lost` columns |
| Share text | server-built from the disclosed fields |
| Poster | server route returns a PDF or PNG (TBD) |
| `markFound` | existing `setPetFoundAction` — closes the case atomically |

## Sharing infrastructure

The four share buttons in `LostShareCard` are client-only (window.open + navigator.share). The **server** is responsible for:

1. The canonical share text — built from disclosure prefs so we never send "call Ignacio at +54…" via Twitter if the phone toggle is off.
2. The OG meta on `/p/{token}` so the link previews well on WhatsApp / Twitter / Facebook.
3. The poster route. v1 candidate: `/casos/{publicCode}/afiche.pdf` rendered server-side (PDFKit or react-pdf — same decision as the gob reports). Until that ships, `LostShareCard` accepts any URL.

## Open decisions

1. **Finder messages — where are they stored?** Today `FoundPetForm` submits to a route that emits an event; the event type wasn't specified in the catalog I read. Options: (a) `incident_reported` with `incident_type='finder_message'`, (b) a new `finder_message` event_type, (c) a sibling `finder_messages` table referenced by `case_id`. Lean toward (b) — first-class type, simple to filter, fits the append-only model. Needs a small spec.
2. **Sightings vs. relocation of the pin.** When the owner gets a new sighting tip and wants to update where to look, do we (a) update the case's `primary_location_lat/lng`, or (b) emit a `sighting_recorded` event and let the read-side compute "latest sighting"? Append-only argues for (b). The cockpit shows "last sighting" and the case detail keeps the trail.
3. **Auto-close at 180 days — confirmation.** The cron already auto-closes stale episodes. Should the owner get a notification at day 150 ("¿Querés que sigamos buscando 30 días más?") so the close isn't surprising? Probably yes — easy add, big UX win.
4. **Poster generator.** PDFKit (more control, more code) vs react-pdf (declarative, heavier). Same call as the `/gob/reportes` plan; pick once for both. The component takes any URL today.
5. **Phone format on the public page.** International E.164 vs locally-formatted ("011 4567-8910"). The `tel:` href must be E.164; the displayed string can be local. Add a `lib/format-phone-AR.ts` helper.
6. **Public page when phone is off AND finder form is off.** Currently shows an amber notice. Better: in the activation form, block saving with both off ("Necesitás dejar al menos una forma de contacto"). Plan recommends the second.

## Out of scope

- Live tracker integration (Phase 2 of the owner profile plan).
- Org-side fanout broadcast of new lost pets to verified orgs in the jurisdiction (Fase 6 of the existing lost & found spec). The infra is in place (`receives_broadcasts` on `organization_memberships`); the UI is its own plan.
- Govt-side `/gob/perdidas` redesign — separate plan in the govt track.
- Rewards. Modo perdido can offer one, schema doesn't model it yet. Defer.

## Suggested next step

Once Phase 0 of the action plan lands, point a Claude Code session at `app/(app)/mis-mascotas/[publicToken]/perdida-v2/page.tsx`. Swap the sample blocks for live queries — the case row, the scan events, the disclosure prefs. Then fold the body into the live `/mis-mascotas/{token}/page.tsx` behind a `pets.status === "lost"` branch. Public side: same drill for `/p/{token}/v2` → fold into the existing public page's lost branch.

Once both fold in, retire the `/v2` previews. The v2 routes exist solely to let us iterate without touching the live tree while it's still corrupted.
