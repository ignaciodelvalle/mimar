# P4 — Organizaciones cercanas que reciben animales encontrados

**Status:** implemented on `integration/p4-receptoras-cercanas` (migration `0292`).
**Scope:** web only. The native owner side is a follow-up (§8).

## 1. The problem and the principle

Someone finds an animal and cannot keep it until its family appears. Today the
product helps them reach the FAMILY (the credential, `/perdidas`) and nothing
else. P4 adds a way to reach an organization that actually receives found
animals nearby — without exposing anyone's private data.

**Principle (PO, 2026-10-07): reuniting with the family comes first; a
receiving organization is plan B.** Concretely:

- the plan-B list never appears as a primary action on a lost pet's page. There
  is no "llevar al refugio" button on `/p/{token}`: it would divert animals from
  their families and overload shelters;
- on `/p/{token}/encontre` the list appears only AFTER a successful submission,
  under the "le avisamos" confirmation, as a quieter secondary block;
- on the new page for an untagged animal, the order is: check for a microchip →
  look for its family on `/perdidas` → only then the receiving organizations.

## 2. What exists today (explored 2026-10-07)

### 2.1 Finder flows

| Flow | Where | What it does |
|---|---|---|
| "La vi" (sighting) | `app/(public)/p/[publicToken]/sighting` | anonymous sighting on a lost pet; L2 point |
| "La tengo conmigo" | `app/(public)/p/[publicToken]/encontre` (`page.tsx`, `FinderInPossessionForm.tsx`, `action.ts`) | anonymous finder in possession: contact, an **L2 point placed by hand** ("¿Dónde la tenés ahora?"), a condition (`bien` / `herida` / `asustada` / `necesita_vet_urgente`), availability. Rate-limited per (IP, token) and per token (`lib/infra/anonymous-report-limits.ts`). Success renders inline in the form ("¡Gracias! Le avisamos al dueño/a…"). |
| Notify a found pet | `src/modules/pets/application/public/notify-owner-of-found-pet.ts` | the lighter "avisar" path |
| `/perdidas` | `app/(public)/perdidas` | public board, filters `?provincia=&localidad=` (`lib/infra/lost-listing.ts`) |
| Landing door "Encontré una mascota" | `components/landing/landing-content.ts` → `CRISIS_DOORS` | pointed at `/perdidas` |
| Native found path | none for a finder (the app is the owner's); the owner's lost mode is `apps/mobile/src/lost/LostScreen.tsx` | — |

An animal with **no tag and no QR** — the most common case — had no page at all:
the landing door sent the finder straight to the board.

### 2.2 The organization model

- `organizations.org_type`: `clinic`, `shelter`, `rescue_network`,
  `sanitary_authority`, `other`. `verified`, `status` (`active` / `suspended` /
  `dissolved`), `jurisdiction_province` / `jurisdiction_locality`, `locality_id`
  (FK to `ar_localities`, migration 0248), `location_lat` / `location_lng`.
- Since 0278–0280 **anon reads zero organizations** through PostgREST; every
  public org read is server-side over Drizzle (BYPASSRLS) projecting public
  fields only.
- **The public directory (0283)**: `lib/infra/org-directory.ts →
  publicDirectoryVisible()` — verified, active, and either a rehoming org
  (shelter / rescue network) or a clinic that opted in
  (`public_directory_opt_in`). Its privacy rules
  (`lib/infra/org-public-profile.ts`): the list carries five public fields;
  contact details only on the profile; a clinic's legal name and **its
  coordinates are never published**; switching the opt-in is audited.
- The directory has no geo query. Distances in the repo are computed with an
  equirectangular SQL expression over catalogue centroids
  (`lib/infra/ar-localidades.ts → nearestLocalities`) — the local stack has no
  PostGIS.

### 2.3 The jurisdiction cascade

`lib/infra/business-rules-resolver.ts` resolves rules **locality → province →
country → default**. There is no "municipal channel" rule type, and no contact
data for local governments in the repo. What exists is the official
local-government reference (`lib/reference/locality-gobierno-local.json`, read by
`lib/place/local-governments.ts`): INDEC locality id → the municipality/comuna
that governs it, name only.

### 2.4 A constraint the brief did not mention: W8

The brief allows the location "from the device with explicit consent". The PO
decided on 2026-09-24 (W8) that **the product never reads the device's
location**: `scripts/check-no-device-gps.ts` (`pnpm lint:no-device-gps`) bans
`navigator.geolocation`, the "usar mi ubicación" copy, and native location
modules, and `next.config.ts` sends `Permissions-Policy: geolocation=()`, so
the browser refuses the API on every page anyway. See §6, decision D1.

## 3. Data — migration 0292

One table, one row per organization: `public.org_found_animal_intake`.

| Column | Meaning |
|---|---|
| `organization_id` (PK, FK cascade) | the org |
| `accepting` (default **false**) | "Recibimos animales encontrados" |
| `capacity_status` | `recibimos` · `consultar` · `sin_lugar` → "Recibimos" / "Consultar antes" / "Sin lugar por ahora" |
| `public_contact_kind` + `public_contact_value` | optional, both or neither: `telefono` / `whatsapp` / `email` / `web` — a channel the org CHOOSES to publish, never copied from its account email or phone |
| `public_hours` | optional free text, ≤ 120 chars |
| `created_at`, `updated_at` | |

No person column: who changed what lives in `audit_log`.

**RLS.** Enabled; anon holds no privilege. `authenticated`: SELECT for an
active member of the org, INSERT and UPDATE only for an **active admin** of the
org (`public.caller_is_active_org_admin(uuid)`, SECURITY DEFINER, same shape as
0273's member helper — a policy subquery on `organization_memberships`
recurses). No DELETE policy: turning off is `accepting = false`. The app writes
over Drizzle like every other write; the policies are the backstop.

**Every change is audited, whatever the path.** A row trigger writes
`org_found_animal_intake_changed` (payload: `org_id`, `before_values`,
`after_values`, `public_contact_value_changed`) on INSERT and on any UPDATE that
changes a governed column. The contact VALUE is never copied into `audit_log`:
that table is append-only and cannot be redacted, and for a one-person org the
published channel may be a person's phone. The row records that it changed and
its kind; the value lives only in the settings table (a declared `KNOWN_GAP`). The
actor is `auth.uid()` (a PostgREST write) or the transaction-local
`app.actor_user_id` the server action sets. Putting the audit in the database —
not in the action — is what makes "every change" true for the RLS write path
too; a second app-side audit row would have been a duplicate.

**Who may opt in:** `shelter`, `rescue_network`, `clinic`,
`sanitary_authority` (a municipal zoonosis service is exactly the "municipal
channel"). Not `other`. **Who appears publicly:** the row says `accepting` AND
the org is verified AND `status = active` AND of an allowed type — checked in
the query, not in the render (privacy checklist §4).

## 4. The public read

One server-side read, `findNearbyHelp`, behind two doors:

1. `/p/{token}/encontre`'s own submit action (already rate-limited per IP and
   token). The finder's hand-placed point is coarsened and used for the lookup
   in the same request; the result travels back in the action state.
2. `findNearbyHelpAction` — a public server action for the new page. Input: a
   catalogue **locality id** the finder picked, never a coordinate. Per-IP
   rate limit, its own bucket (`found_help_lookup`).

A server action is a POST: nothing about the place rides in a URL, so it never
lands in an access log. A route handler with `?lat=&lng=` would have.

**Coarsening.** Both ends are snapped to a 0.01° grid (~1 km) BEFORE the
distance: the finder's point, and every organization's coordinates. Distances
are labelled in coarse buckets ("a menos de 2 km", "a unos 3 km", over 10 km to
the nearest 5). The org end matters too: a clinic's coordinates are withheld by
0283's rule, and an exact distance from chosen points would trilaterate them.

**Never stored, never logged.** The read issues no write (pinned by a test that
runs it in a transaction and asserts no transaction id was assigned); the rate
limiter's row is keyed on the caller's address, never the place; nothing in the
path logs the point.

**What a row carries:** name, type label, locality (name), the coarse distance
label, the capacity status, the published contact (receivers only), and a link
to `/refugios/{token}` only when the org is listed in the public directory.
Never coordinates, email, phone from the account, CUIT, legal name or members.
The owner's data is not part of this feature's read at all.

**Lists.** Receivers: up to 5, nearest first, within 50 km, `sin_lugar` kept
(the status is the information) but sorted by distance only. Vets: the 0283
directory's opted-in clinics (`publicDirectoryVisible()` ∧ `org_type =
clinic`), up to 3, within 50 km. An org without a pin falls back to its
catalogue locality's centroid; with neither it cannot be ranked and is not
listed (the settings card says so).

**Empty state, through the cascade:** the point's locality (the nearest
catalogue locality to the coarsened point, or the one picked) → an opted-in,
verified `sanitary_authority` in that locality, else in that province, with its
published channel, at any distance → else the governing municipality's NAME
from the official reference with general guidance → else general guidance only.
No phone number is ever invented.

## 5. Surfaces

- **`/org/{token}/configuracion`** — a new card "Animales encontrados" for admins
  of an allowed type. Off by default. A note when the org is not verified ("no
  aparece hasta que la organización esté verificada") or has no location.
- **`/p/{token}/encontre`** — after success, below the confirmation, a quieter
  block: "¿No podés tenerla hasta que la busquen? Estas organizaciones cercanas
  reciben animales encontrados". If the condition was `necesita_vet_urgente`,
  the nearest vets come FIRST, then the receivers.
- **`/encontre-un-animal`** (new, `(public)` group, force-dynamic) — three blocks
  in order: (1) "¿Tiene chip?" — "cualquier veterinaria lo lee gratis" + the
  nearest vets; (2) a link to `/perdidas` filtered to the picked locality; (3)
  the receiving organizations. In the sitemap, allowed in robots. Reached from
  the landing's "Encontré una mascota" door (repointed from `/perdidas`) and
  from `/perdidas`.

## 6. Decisions (safest by default)

| # | Decision | Why |
|---|---|---|
| D1 | **No device location.** The new page takes a locality the finder picks; `/encontre` reuses the point the finder already placed by hand. | W8 (PO 2026-09-24) bans reading the device location and the browser policy refuses it. Lifting W8 is a PO decision, not this change's. |
| D2 | Coarsen to 0.01° on BOTH ends; coarse distance labels | the finder's place is theirs; a clinic's coordinates are withheld by 0283 and must not be recoverable by trilateration |
| D3 | Server action (POST), no coordinates from the client on the new page | nothing about the place in a URL or an access log |
| D4 | Audit in a DB trigger | the RLS write path must be audited too |
| D5 | Receiver visibility independent of the directory opt-in, but the profile link only for listed orgs | the intake opt-in is its own consent to appear here; the profile is the directory's consent |
| D6 | Published contact is a separate field, never the account email/phone | publishing a channel is the org's choice (0283's line: a business signed up for records, not to be advertised) |
| D7 | `sanitary_authority` may opt in and is the empty-state "municipal channel" | it is what a municipal channel is in this model; no contact table for municipalities exists |
| D8 | Radius 50 km, 5 receivers, 3 vets | AMBA-scale; vets are the urgent short list, receivers stay visible below them |
| D9 | The landing door "Encontré una mascota" now opens `/encontre-un-animal` | the page links the board first; a finder of an untagged animal gets the chip advice before anything else |

## 7. Tests

`__tests__/found-animal-intake-*.test.ts` and the module's unit tests: the
public projection's keys (exact set); opted-out, unverified, suspended and
`other` orgs never appear; coarsening and no writes; RLS (admin positive,
member / other-org admin / anon negative; audit row per change); the rate
limit; distance ordering. e2e: `e2e/found-animal-help.spec.ts` (seeded receiving
shelter and opted-in clinic in CABA). The `/encontre` walks and the filled lists
run on a local target only: on the nightly staging pass they would file real
reports and the fixtures may not exist there.

## 8. Follow-ups

- **Native, owner side** — in the owner's lost mode: "Avisales a las
  organizaciones cerca de donde se perdió". Not built: `LostScreen.tsx` is being
  refactored in another branch. It would reuse `findNearbyHelp` through an
  `/api/v1` read with the same projection.
- **Notify receivers** (push a lost animal to nearby receivers) — needs its own
  consent model on the receiving side; out of scope.
- A real municipal-channel registry (phone / hours per local government).

## 9. Open points for the PO

1. **W8 vs "location from the device".** Built without it (D1). If the PO wants
   it, W8's fence, the `Permissions-Policy` header and the copy ban must change
   first, in their own decision.
2. **Radius and counts** (D8) are a first guess; rural provinces may need more.
3. **`sanitary_authority` as receiver** (D7) — confirm municipal services
   should self-serve this switch.
4. **Who verifies the published contact?** Today the org admin types it and it
   is published as typed (audited). No verification of the channel.
5. **The landing door** (D9) changed destination; confirm.
6. **Capacity freshness** — "Recibimos" can go stale; a "actualizado hace N
   días" line or an expiry could follow.
