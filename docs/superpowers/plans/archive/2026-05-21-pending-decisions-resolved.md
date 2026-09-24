# Closed decisions — pending chunks (owner-resolved 2026-05-21)

> Companion file to `dim-interno:docs/superpowers-private/plans/archive/2026-05-21-consolidated-cc-plan.md`. The owner answered the 14 open implementation questions raised during pre-CC handoff planning. CC reads this file BEFORE starting each chunk so the executable plan can be written without round-tripping to the owner.
>
> **Owner sign-off date:** 2026-05-21
> **Owner:** Ignacio Del Valle
> **Format:** decisions grouped by chunk; each decision has `Q:` (the question), `A:` (the answer), and `Implications:` (what changes in the executable plan).

---

## Chunk C — Vaccine-due UX

### C-D1. Build `<Badge>` now

**Q:** Build `<Badge>` as part of Chunk C, or compose inline and extract later?
**A:** Build now.
**Implications:**
- Add `components/poncho/Badge.tsx` to Chunk C's file list (already noted as conditional in `dim-interno:docs/design/06-vaccine-due.md` §G).
- Use the shape confirmed in C-D4 below: pill with optional icon + `variant` prop (`info | success | warning | danger | neutral`).
- Export from `components/poncho/index.ts` so Chunk E + Tier 7 specs can import without a follow-up extraction PR.
- Cost: ~30-45 min added to Chunk C; amortized across at least 5 downstream consumers.

### C-D2. `isReportable` lookup — hardcoded now

**Q:** Hardcoded list in `lib/vaccine-reminder-state.ts` with TODO toward the future ENO catalog, or wait for ENO spec to land?
**A:** Build now (hardcoded).
**Implications:**
- `lib/vaccine-reminder-state.ts` includes a `const REPORTABLE_VACCINES_BY_SPECIES` map (dog: rabia, parvo, distemper; cat: rabia, panleucopenia) with a comment linking to AGENTS.md zoonosis registry.
- Add a TODO above the constant referencing `2026-05-19-eno-vet-direct-report-and-owner-alerts-design.md` so the future ENO PR knows to swap this for a `getReportableVaccines(species, jurisdiction)` import from `lib/disease-public-alert-catalog.ts`.
- Public API stays a function — call sites pass `(species, jurisdiction)` even though jurisdiction is unused today, so the future swap is non-breaking.

---

## Chunk E — Govt dashboards

### E-D1. Map tiles — defer ARSAT, use the easiest path

**Q:** ARSAT (per spec) or OpenStreetMap fallback for `<MapChoropleth>` tiles?
**A:** Defer ARSAT; owner will add it to the research document. Use the easiest available option for v1.
**Implications:**
- v1 uses **OpenStreetMap** raster tiles via the default MapLibre demo style (`https://demotiles.maplibre.org/style.json`) OR a public OSM tile provider with attribution. CC picks the lowest-friction option that doesn't require an API key.
- Required attribution: `"© OpenStreetMap contributors"` shown in the map's lower-right corner per OSM tile usage policy.
- Add a comment in `components/poncho/MapChoropleth.tsx` flagging the tile source as a v1 placeholder, with a TODO pointing at the (forthcoming) research doc.
- **Owner follow-up:** create / update the research doc where ARSAT specifics live. Not a CC blocker.

### E-D2. Recharts — keep current pinned version

**Q:** Keep current pinned version or upgrade before E1?
**A:** Keep current pinned version.
**Implications:**
- CC must NOT run `pnpm up recharts` during Chunk E.
- If the pinned version lacks a feature the spec needs (e.g. specific chart type), CC documents the limitation in the plan and either works around it OR raises it as a follow-up — does not upgrade unilaterally.

### E-D3. Anonymization library for `/gob/analytics/export` — library OK if secure & fast

**Q:** Roll-our-own field-drop or use a library?
**A:** Use a library, provided it's secure and fast.
**Implications:**
- CC evaluates options during the executable-plan write-up. Recommended path given Argentina Ley 25.326 and the dataset shape (structured tabular, not free text):
  - **Preferred:** define a Zod schema per export slice (`pets`, `events`, `cases`, `organizations`) listing ONLY the fields that ship. The export pipeline parses each row through the schema, dropping anything not whitelisted. This is "library-backed" via Zod (already in the dependency tree) without adding a new dependency.
  - **If a dedicated library is preferred:** consider `@faker-js/faker` for surrogate generation (pet display names → "Pet-001") and `nanoid` for opaque identifiers (already available). Avoid pulling in PII-detection libraries — those target unstructured text, which is out of scope.
- The decision must be documented in the executable plan with rationale.
- Audit log row per export records which schema version was used (so the dataset is reproducible).

### E-D4. `<Badge>` shape confirmed

**Q:** Confirm "pill with optional icon + variant prop" (variants: `info | success | warning | danger | neutral`)?
**A:** Confirmed.
**Implications:**
- `components/poncho/Badge.tsx` API:
  ```ts
  type BadgeProps = {
    variant?: "info" | "success" | "warning" | "danger" | "neutral";
    icon?: string;                          // lucide-react icon name OR a slot for an existing icon component — pick during build
    children: React.ReactNode;
    "aria-label"?: string;                  // required when icon-only / when children is a short label needing expansion
  };
  ```
- Visual: `rounded-full px-2.5 py-0.5 text-xs font-medium`. Each variant gets a background tint + text color from existing `--color-gob-*` tokens (no new tokens needed).
- A pulse animation variant lives ONLY in the consumer (e.g. critical reminder PetCard badge wraps `<Badge>` inside a `<span className="animate-pulse">`). Don't bake animation into `<Badge>` itself.
- Built in Chunk C per C-D1; Chunk E reuses without modification.

---

## Tier 7 specs — pre-resolved decisions

These decisions unblock the plan-writing for the five Tier 7 specs whenever they're scheduled. They do NOT trigger any code today.

### T7-A. performed-by autocomplete (spec `2026-05-19-performed-by-autocomplete-design.md`)

#### T7-A1. No "no encontré" affordance

**Q:** Show an explicit "no encontré, escribilo manual" affordance after 3 chars + 500ms with 0 matches?
**A:** No message — the input remains a plain text field that ALSO surfaces matches when typing finds them. Absence of matches just leaves the user typing free text. No empty-state UI inside the combobox dropdown.
**Implications:**
- `<PerformedByCombobox>` dropdown is hidden entirely when there are 0 matches (rather than showing an "empty + manual entry" affordance).
- Submission semantics unchanged: typed text is the saved value when no option is selected; FK link is added only when an option from the dropdown is explicitly chosen.
- Add a single-line `aria-live="polite"` announcement when matches appear (e.g. "3 coincidencias") for screen reader users — the visual dropdown alone isn't enough without text feedback.

#### T7-A2. Locality-first with expander

**Q:** Locality-first results + "Buscar en otras localidades" expander, or nationwide by default?
**A:** Locality-first with "Buscar en otras localidades" expander.
**Implications:**
- Query order: matches in the pet's `jurisdictionLocality` first (sorted by relevance), then a static "Buscar en otras localidades" row that, when clicked, expands the dropdown with nationwide results.
- Expander click is tracked client-side; no server round-trip for the toggle (results come pre-fetched with a `scope: "locality" | "nationwide"` flag).
- The expander row has `role="button"` not `option` (it's a control, not a selectable result).

### T7-B. Pet profile v2 (spec `2026-05-19-pet-profile-v2-design.md`)

#### T7-B1. Achievement unlocks — badge-pulse on next visit (passive)

**Q:** Toast (intrusive) or badge-pulse on next visit (passive)?
**A:** Badge-pulse on next visit.
**Implications:**
- Newly-unlocked achievements get a `pulse_until` timestamp set to `unlocked_at + 7 days`.
- On profile load, if `pulse_until > now`, the achievement chip renders inside an `animate-pulse` wrapper.
- No toast, no notification, no inbox entry — the surprise + delight is entirely on the profile.
- After 7 days OR after the user has viewed the profile post-unlock (whichever first), `pulse_until` is cleared by a server action that the profile page fires on mount (debounced — once per session per pet).
- Respects `prefers-reduced-motion`: pulse becomes a subtle border color shift instead of animation.

#### T7-B2. Credentials leftmost, achievements after

**Q:** Credentials-vs-achievements row order — credentials leftmost, achievements after?
**A:** Yes — credentials always leftmost, achievements after.
**Implications:**
- Single horizontal row: `[Service-Dog credential]? [PPP credential]? [Achievement A1]? [Achievement A2]? ...`
- Mobile: row scrolls horizontally with momentum scrolling. Don't wrap to second row — wrap dilutes the "row of badges" reading affordance.
- Credentials use a slightly elevated visual register (subtle border treatment) to communicate legal weight; achievements are flatter chips.
- If a pet has no credentials and no achievements, the entire row is omitted (no empty state in this slot).

### T7-C. Pregnancy tracking (spec `2026-05-19-pregnancy-tracking-design.md`)

#### T7-C1. Start-date capture — three-option pattern

**Q:** Ask the user, default to today, with "no estoy segura → first-trimester midpoint" option?
**A:** All three: ask, default today, offer "no estoy segura".
**Implications:**
- `/anotar` matcher for "está embarazada" routes to the pregnancy form with `start_date` defaulting to today.
- Form shows three radios:
  - "Empezó hoy" (default selected)
  - "Empezó hace X días/semanas" → numeric input pair
  - "No estoy segura" → server sets `start_date = today - 30d` (first-trimester midpoint per canine + feline average gestation) and stamps the event payload with `start_date_estimated: true`
- The estimated flag surfaces in `<PetReminders>` on the profile: "Embarazo (fecha estimada)" instead of "Embarazo iniciado el {date}".

#### T7-C2. One active pregnancy per hembra — confirmed

**Q:** One active pregnancy at a time per hembra?
**A:** Yes — hard constraint.
**Implications:**
- Server action `recordPregnancyStartAction` checks `pets.pregnancy_status === 'none' | 'completed'` before inserting. If already `active`, returns `{ error: "Ya hay un embarazo activo registrado para esta mascota. Cerralo primero." }` with a link to the active pregnancy event.
- DB-level: add a partial unique index on `(pet_id) WHERE pregnancy_status = 'active'` in the migration. This is a belt-and-suspenders against race conditions.
- The constraint goes in the executable plan's Definition of Done.

### T7-D. ENO vet direct report (spec `2026-05-19-eno-vet-direct-report-and-owner-alerts-design.md`)

#### T7-D1. Lab evidence — optional with payload flag

**Q:** Optional file upload + payload flag `confirmation_strength: 'self_reported' | 'lab_uploaded'`?
**A:** Yes.
**Implications:**
- `clinical_info_logged(sub_kind='disease_diagnosis')` payload schema gets:
  ```ts
  confirmation_strength: z.enum(["self_reported", "lab_uploaded"]),
  lab_attachment_id: z.string().uuid().optional(),  // required when confirmation_strength === 'lab_uploaded'
  ```
- Form has an "Adjuntar resultado de laboratorio (opcional)" file input. If used, server validates the upload, sets `confirmation_strength = 'lab_uploaded'`, and writes `lab_attachment_id`.
- The emitted `outbreak_signal` carries the same `confirmation_strength` field. Govt dashboards (Chunk E `/gob/vigilancia`) surface "Lab-confirmado" pill on signals where it's `lab_uploaded` — adds a row to E-D4's `<Badge>` palette (variant `success` + icon `check-circle`).
- The owner-facing alert (when triggered) does NOT mention lab status — that's privacy from D1 of the surveillance spec.

### T7-E. Govt business rules POC (spec `2026-05-19-govt-business-rules-poc-design.md`)

#### T7-E1. Cascade — additive lists

**Q:** Replace or add? (Rec was replace; owner chose add.)
**A:** Additive lists.
**Implications:**
- Resolver semantics: `resolveRule(rule_type, jurisdiction)` returns the **union** of `country defaults ∪ province override ∪ locality override`. Each level adds entries; no level removes from a lower level.
- For PPP `dangerous_breeds` rule_type: if country lists `["rottweiler", "pit-bull"]` and CABA adds `["dogo argentino"]` and Comuna 4 adds `["mastín"]`, then for a pet in Comuna 4 the resolver returns `["rottweiler", "pit-bull", "dogo argentino", "mastín"]`.
- **Important corollary the executable plan must address:** since lower levels cannot remove from higher levels, the country-level default must be the **most-conservative-but-still-broadly-applicable** set. The plan needs an explicit decision on what goes in the AR country default vs. what's left to provinces. Owner action item: review the existing `lib/breeds.ts` AR set before the plan is written and confirm it's the right "minimum agreement" baseline.
- For `weight_threshold` rule_type: additive doesn't apply naturally (it's a single number, not a list). Resolution falls back to "lowest-of-defined" — locality wins if set, else province, else country default. The plan must call out this exception.
- For `attestation_registries` rule_type: additive (union of registries the jurisdictions accept).
- A jurisdiction that wants to **disagree** with a higher level needs to wait for a v2 of the framework (out of scope for the POC). Document this limitation in the spec's "Out of scope" section.

---

## Cross-cutting decision

### CX-1. Shared primitives sub-chunk

The owner's "build now" answers to C-D1 (Badge) plus the pattern reuse across Chunks C, E, F, and Tier 7 confirm the value of an explicit sub-chunk for design-system primitives.

**Action for the consolidated plan:** insert a "Chunk A.5 — Design-system primitives" line item between Chunk A (infra hardening) and Chunk B (cheap wins), containing:

| Primitive | Estimated effort | First consumer | Also consumed by |
|---|---|---|---|
| `<Badge>` | 30 min | Chunk C (PetCard badge) | Chunk E, pet-profile-v2, ENO outbreak pill |
| `<EmptyState>` | 30 min | Chunk C (vacunas history) | every dashboard panel in Chunk E |
| `<Panel>` / `<PanelHeader>` / `<PanelBody>` | 45 min | Chunk E | Chunk C, pet-profile-v2 |
| `<Tabs>` with searchParam persistence | 1h | Chunk C (`/notificaciones` categories) | Chunk E (`/gob/maltrato` queues), pet-profile-v2 |
| `<Alert>` | 30 min | Chunk E export anonymization notice | ENO alerts, pregnancy warnings |
| `<DateRangePicker>` | 1.5h | Chunk E analytics export | Chunk C custom schedule, pregnancy estimated dates |

**Total:** ~5 hours, lands as one PR. Sequenced after Chunk A so it ships against a clean CI.

CC should treat Chunk A.5 as the new dependency for Chunks C, E, F, and Tier 7 work.

---

## How CC uses this file

1. **Before writing the executable plan for a chunk**, read the relevant section here. The decisions are pre-baked — do not re-ask the owner unless something in the codebase has materially shifted since 2026-05-21.
2. **When the plan is written**, copy each decision verbatim into the plan's "Decisiones cerradas" / "Closed decisions" section so the plan is self-contained.
3. **If a decision turns out to be wrong during implementation**, do NOT just override it — open a tiny PR-prefixed `decision-revisit/` plan file proposing the change and ping the owner. The cost of one round-trip < the cost of silently diverging.
4. **After all referenced chunks ship**, this file moves to `docs/superpowers/plans/archive/`.

---

## Owner follow-up items

These are not CC tasks; they're things the owner explicitly committed to handling out-of-band:

- **OF-1 (E-D1).** Add ARSAT specifics to the research document (location TBD). Until then, MapLibre uses the OSM-compatible default.
- **OF-2 (T7-E1).** Before the govt-business-rules POC plan is written, review `lib/breeds.ts` AR default set and confirm it represents the "minimum agreement" baseline for additive cascading. Provinces and localities can only add to it, not remove.

---

## Reference

- `dim-interno:docs/superpowers-private/plans/archive/2026-05-21-consolidated-cc-plan.md` — the master sequenced plan this file decorates.
- `dim-interno:docs/design/06-vaccine-due.md` — design spec for Chunk C.
- `dim-interno:docs/design/04-govt-dashboards.md` — design spec for Chunk E.
- `docs/superpowers/specs/2026-05-19-performed-by-autocomplete-design.md` — Tier 7-A.
- `docs/superpowers/specs/2026-05-19-pet-profile-v2-design.md` — Tier 7-B.
- `docs/superpowers/specs/2026-05-19-pregnancy-tracking-design.md` — Tier 7-C.
- `docs/superpowers/specs/2026-05-19-eno-vet-direct-report-and-owner-alerts-design.md` — Tier 7-D.
- `docs/superpowers/specs/2026-05-19-govt-business-rules-poc-design.md` — Tier 7-E.
