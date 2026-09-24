# Denuncia anónima — public intake redesign

**2026-05-20 · scope: `/denuncias/nueva` (anonymous path) + `/denuncias/codigo/{ref}` follow-up**

## Why this plan

Argentina's Ley Nacional 14.346 makes animal cruelty a criminal offense. The path from a witness in the street to a DPZ inspector standing on the property runs through a denuncia, and the system already has the rails: `welfareReports` table (anonymous-by-default via nullable `reporterUserId`), a moderation queue at `/admin/moderacion`, a govt triage view at `/gob/maltrato`, a reference code (`DEN-XXXX-XXXX`) for follow-up, and routes at `/denuncias/{nueva,buscar,codigo/[code]}`.

What's missing is **the intake**. The current `WelfareReportForm.tsx` is a single long form on a desktop-styled page — kind, severity, subject_kind, description, location, contact toggle, evidence uploader. It works, but it asks too much at once, doesn't read mobile-first, and doesn't make the reference code feel like the thing the reporter should keep.

This plan redesigns the public intake to be embarrassingly easy: a four-step wizard that builds the same `welfareReports` row, ends on a reference-code screen the reporter can screenshot, and surfaces follow-up cleanly. **No schema change** — every field maps to a column that already exists.

## Anchored principles

- **Anonymous-first.** The wizard never asks for identity unless the reporter explicitly chooses to attach their contact at the end. Submitting without contact is a single-tap.
- **One question per screen on mobile.** Each step asks for one thing; the next step is one tap, never a scroll-and-find.
- **The reference code IS the receipt.** No "thanks for your submission" confetti — the success screen is dominated by the DEN-XXXX-XXXX code, big, copyable, with a "save to photos" affordance.
- **No identity collection means no DNI verification dependency.** This entire flow ships in front of Phase 2 of the action plan (the `claimStubProfileAction` security hold), because nothing in it claims a profile.
- **Public route, rate-limited.** `/denuncias/nueva` is unauthenticated. The existing `rate_limit_buckets` table (migration 0027) handles the throttle. Moderation handles the spam.

## Existing state (what already ships)

| Piece | File / Table | Status |
|---|---|---|
| `welfareReports` table with all needed columns | `db/schema.ts`, migration 0029 (moderation) | shipped |
| `referenceCode` generator | `lib/welfare-codes.ts` | shipped |
| `createWelfareReportAction` server action | `app/actions/welfare.ts` | shipped |
| `WelfareReportForm` | `app/denuncias/nueva/WelfareReportForm.tsx` | shipped (will be rewritten) |
| Moderation queue | `/admin/moderacion`, `flaggedAt`/`flagReasons` columns | shipped |
| Govt triage | `/gob/maltrato` | shipped |
| Follow-up by code | `/denuncias/codigo/[code]/page.tsx` | shipped (will be refreshed) |
| Search by code | `/denuncias/buscar` | shipped |
| Evidence upload | `welfare_report_attachments` table + Supabase Storage | shipped |
| Rate limit infra | `rate_limit_buckets` (migration 0027) | shipped |
| Welfare kinds / severities / subject kinds | `lib/welfare.ts` | shipped |

## Redesigned flow

### Step 1 — Qué pasó

A vertical list of welfare kind cards (the `WELFARE_REPORT_KINDS` enum already exists — `physical_abuse`, `neglect`, `abandonment`, `fighting`, etc.). Each card has an icon + plain-language label + one-line description. Single-select. Tap a card → goes to step 2.

| Field collected | `welfareReports` column |
|---|---|
| Kind card selection | `kind` |

A small "No estoy seguro" card at the bottom maps to `other` and lets the reporter free-text their concern in step 3.

### Step 2 — Qué tan grave

Three severity buttons stacked, with concrete examples on each card:

- **Grave / urgente** — "el animal está en peligro inmediato o hay heridas visibles"
- **Moderado** — "condiciones de vida malas, abandono, descuido"
- **Sospecha** — "creo que algo no está bien pero no estoy seguro"

Wording trades the enum labels for what reporters actually think. Maps to `severity`.

### Step 3 — Dónde y cuándo

- **Dónde**: `LocationFields` in point mode (the component the existing form already uses). Geocoder forward / reverse-geocode on drag. The bias province/locality defaults to the user's last-known geolocation (browser API, opt-in) or empty.
- **Cuándo**: three radio options — "ahora mismo", "hoy / ayer", "hace varios días". `occurredAt` resolves to a coarse server-side timestamp; the reporter can be more precise via an "ajustar fecha" expander.
- **Descripción**: a textarea labeled "Contanos lo que viste" with a soft 500-char target. Maps to `description`.

| Field collected | Column |
|---|---|
| Map pin | `locationLat`, `locationLng` |
| Address text | `locationAddress` |
| Geocoded admin | `jurisdictionProvince`, `jurisdictionLocality` |
| When | `occurredAt` |
| What | `description` |

### Step 4 — Sobre quién (opcional pero recomendado)

Two-card choice for `subjectKind`:

- **Una mascota** — opens an optional MiMAR chip-ID lookup (existing `microchipId` index) and a small free-text fallback. Maps to `subjectPetId` if matched, else stays null.
- **Un animal sin dueño / no lo sé** — collapses; sets `subjectKind='unowned_animal'`. Reporter can free-text describe the animal (color, size, distinguishing marks). Maps to `subjectDescription`.

An "Edificio / persona / lugar" tertiary option maps to `subjectKind='location'` — useful for hoarding cases, broken refugios, etc.

### Step 5 — Evidencia (opcional, fuerte recomendación)

The evidence uploader (already implemented). v2 keeps the existing limits (5 files, 25 MB, image + video mime types). Refresh the visual: drop zone with three sample tiles greyed out, tap to capture from camera on mobile (`accept="image/*,video/*" capture="environment"`).

### Step 6 — Cerrar (anónima o sumar contacto)

A two-button choice at the end, neither pre-selected:

- **Enviar anónimo →** (primary). Submits with `reporterUserId=null`, `reporterContactEmail=null`, `reporterContactPhone=null`. Goes straight to step 7.
- **Sumar mi contacto (más útil) →** (secondary). Expands to two fields — email **or** phone (one of either suffices). Saves to `reporterContactEmail` / `reporterContactPhone`. Still anonymous in the sense that DNI is not collected — but contactable. This is the **midway path** between fully anónima and fully vinculante and the form should explain that in one sentence.

The wording matters: "anonymous + contact" is what most reporters actually want. Many *think* they want anónima but actually mean "I don't want my DNI on a court file." Contact + no identity is the sweet spot for DPZ follow-up and converts more denuncias into actionable cases.

### Step 7 — Tu código

The receipt screen. Big DEN-XXXX-XXXX. Three things on this screen and nothing else:

1. The reference code in tabular-nums display, copyable on tap.
2. "Guardar en fotos" button — generates a small image with the code + a "MiMAR — denuncia" header for the reporter's gallery.
3. "Seguir esta denuncia" link → `/denuncias/codigo/{ref}` (existing).

A footer reads: "Si decidiste no sumar contacto, este código es la única forma de seguir tu denuncia. Guardalo."

## Follow-up surface (`/denuncias/codigo/[code]`)

Currently this route exists; v2 refreshes it. Three states:

| State | Body |
|---|---|
| `open` | Status pill + last update + "estamos triando tu denuncia" + a comment textarea so the reporter can add more info ("hoy vi otra cosa") — appends a new event, doesn't mutate the row. |
| `triaged` | Same pill + the assigned inspector's first name (if disclosed by the org) + estimated next step. |
| `closed` | Resolution summary (free text from `resolutionNotes`) + a "vincular esta denuncia a una nueva" option so the reporter can re-file with the previous code as context. |

The code page does NOT require login. The reporter pastes the code on `/denuncias/buscar` and lands here.

## Component plan

All under `components/denuncia/`:

| File | Role |
|---|---|
| `DenunciaWizardShell.tsx` | Layout wrapper. Step indicator (1 of 6), back button, sticky bottom CTA, mobile-first. |
| `DenunciaStepKind.tsx` | Step 1 — kind cards. |
| `DenunciaStepSeverity.tsx` | Step 2 — three severity cards with examples. |
| `DenunciaStepWhere.tsx` | Step 3 — `LocationFields` + occurredAt radio + description textarea. |
| `DenunciaStepSubject.tsx` | Step 4 — subject kind cards + optional chip-ID lookup. |
| `DenunciaStepEvidence.tsx` | Step 5 — drop zone + camera capture. (Largely lifts the existing implementation.) |
| `DenunciaStepClose.tsx` | Step 6 — anónima vs anónima + contacto. |
| `DenunciaSuccessScreen.tsx` | Step 7 — big code + save-to-photos + follow-up link. |
| `DenunciaFollowUpStatus.tsx` | `/denuncias/codigo/[code]` body — three states. |

State machine: a client-side wizard that submits via the existing `createWelfareReportAction` server action **only on step 6 → 7**, with the full payload assembled across steps. No partial saves, no draft persistence — the form is short enough that a step-back covers regret. Browser refresh = restart (acceptable trade for anti-spam + simplicity).

## Moderation interplay

The existing `flaggedAt` + `flagReasons` columns plus `/admin/moderacion` continue to work. The wizard adds two client-side anti-spam soft gates that don't trigger backend flags:

- Honeypot field (CSS-hidden input that bots fill).
- Minimum dwell time of ~10 seconds across all steps combined (reporters take longer than that anyway).

Server-side flagging stays where it is: rate limit by IP bucket, soft-flag by content-quality heuristic, queue for admin moderation. Govt only sees triage-ready (non-flagged or moderation-cleared) rows in `/gob/maltrato` — that's already the current behavior.

## Eventual vinculante extension

Building on this foundation, vinculante is **the same wizard plus a step 6.5 that captures identity**:

1. After step 6 ("sumar contacto"), if the reporter chose to add contact AND is signed in AND has `dni_verified=true`, a new card appears: "Querés convertir esta denuncia en vinculante? Tu DNI queda asociado y puede ir a la justicia."
2. Confirming sets `reporterUserId` to the user id AND adds a future column `reportIsBinding: boolean` (TBD — needs schema add). For now we can derive from `reporterUserId IS NOT NULL AND user.dni_verified=true`.
3. Org-side denuncias (existing `reporterOrganizationId`) are vinculantes by definition — that path doesn't go through this wizard. It lives on the org portal and is its own surface.

Vinculante depends on:

- Action plan Phase 2.1 (gate `claimStubProfileAction`) — until that lands, DNI-bound identity claims are unsafe.
- A small spec for the priority bump in `/gob/maltrato` when a denuncia becomes vinculante (mentioned in `2026-05-19-org-abuse-investigation-design.md` for orgs; needs extending to vinculantes from individuals).

So the strict order is: this plan ships, vinculante extends it after Phase 2.

## Where the entry points should live

| Surface | Entry |
|---|---|
| Public landing | Big "Denunciar maltrato" button (anonymous-friendly framing — "Sin cuenta. Tu identidad es opcional."). |
| Owner home `/inicio-v2` | Quiet link in the footer or a "Mis casos" entry if the owner has filed before. |
| Pet profile (any role) | A small "Denunciar maltrato sobre esta mascota" link near the bottom of the page for the cases when the pet is the subject of concern. Pre-fills `subjectPetId`. |
| Public credential `/p/{token}` | A small link visible at all times — "¿Ves algo que no está bien? Denunciar." Pre-fills `subjectPetId`. |
| Org portal | Separate flow (vinculante-by-default), not in this plan. |

## Open decisions

1. **What does "contact" mean — email, phone, or either?** v1 asks for either, one suffices. If we ever want to call the reporter back, phone is more useful in Argentina. Recommendation: phone primary, email optional, but accept either.
2. **Camera-capture vs gallery-first on mobile.** `accept="image/*,video/*" capture="environment"` opens the camera directly; without `capture`, the OS shows a chooser. Witnessing maltreatment likely means the person is at the scene — `capture="environment"` (open camera) is the right default. Worth a quick test on iOS / Android.
3. **Step 4 chip lookup vs deferred.** Looking up `microchipId` against `pets` for a maybe-stray creates a tiny privacy concern (anonymous reporter can probe whether a chip is registered). Solution: server-side lookup returns boolean "matched / not matched" without leaking the pet record. Or skip the lookup entirely in v1 and let triage handle it.
4. **Should anonymous reporters be able to upload location-tagged photos?** EXIF metadata can deanonymize. Server-side EXIF stripping on attachment ingestion is a small lib addition; recommend on by default for `welfare_report_attachments`.
5. **"Save to photos" implementation.** Two paths: (a) render the code into a small PNG via canvas and `<a download>`, (b) hand-off to the OS share sheet via `navigator.share`. (a) works everywhere; (b) feels more native. Both are cheap; ship (a) first.
6. **Naming.** The Argentinian legal term is *"denuncia por maltrato animal"* but the existing UI uses "denuncia". Keep the short form in chrome; spell out "denuncia por maltrato animal" only in the welcoming copy.

## Out of scope

- Vinculante (next plan after Phase 2.1 security work).
- Org-side denuncia entry — separate plan; uses verified-org capability grants.
- Decomiso (animal seizure) workflow — `2026-05-19-decomiso-welfare-authority-design.md` covers this.
- Whatsapp Business / SMS-based denuncia intake. Real value, but its own integration plan.
- Multi-language. Argentina is es-AR; deferred.

## Suggested next step

After this session: pick the wizard up at the seven-component plan. Build `DenunciaWizardShell` first (state machine + step indicator + bottom CTA), then steps 1–7 in order. The server action and table contract don't change. When the wizard reaches parity with the current form (steps 1–5), retire `WelfareReportForm.tsx` and wire `/denuncias/nueva` to the new shell. Step 6 (close-with-contact) is the only step that changes behavior — once it ships, anónima-with-contact becomes the recommended path, anónima-without-contact stays available.
