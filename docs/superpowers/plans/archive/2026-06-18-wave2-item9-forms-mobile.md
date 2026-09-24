# Wave 2 Item 9 — Event-forms consistency + mobile hardening

> **Status:** ✅ Implemented (PR #tbd) · **Date:** 2026-06-18
> **Spec:** `dim-interno:docs/superpowers-private/specs/archive/2026-06-18-wave2-ux-hardening-handoff.md` → Item 9
> **Branch:** `feat/wave2-item9-forms-mobile`

---

## Audit matrix

One row per form. Rules from `AGENTS.md → Design rules`:
- Rule 1: L1/L2 location capture
- Rule 2: Four-verb CTA pattern
- Rule 3: `WizardShell` if ≥3 steps or destructive
- Rule 4: `LnSuccessScreen` if trámite

| Form | Verb (Rule 2) | WizardShell (Rule 3) | SuccessScreen (Rule 4) | L1/L2 (Rule 1) | Mobile | Action |
|------|---------------|---------------------|------------------------|----------------|--------|--------|
| **vacuna** | ✅ "Registrar vacuna" | N/A (1 step) | N/A (routine log) | N/A (no location) | ✅ after fix | errorFocus hook |
| **antiparasitario** | ✅ "Registrar antiparasitario" | N/A | N/A | N/A | ✅ after fix | errorFocus hook |
| **peso** | ✅ "Registrar peso" | N/A | N/A | N/A | ✅ after fix | inputMode=decimal |
| **vet** | ✅ "Registrar visita" | N/A | N/A | ✅ L1 | ✅ after fix | errorFocus hook |
| **clinico** | ❌ "Guardar información clínica" → **fixed** "Registrar información clínica" | N/A | N/A | ✅ L1 | ✅ after fix | verb fix + errorFocus |
| **microchip** | ✅ "Registrar microchip" | N/A | N/A | N/A | ✅ after fix | errorFocus hook |
| **microchip-reemplazo** | ✅ "Confirmar reemplazo de chip" | N/A (2-screen w/ confirm) | N/A | N/A | ✅ after fix | errorFocus hook |
| **mordedura** | ✅ "Reportar mordedura" | N/A (checkbox consent inline) | ❌ missing → **added** | ✅ L1 | ✅ after fix | SuccessScreen + errorFocus |
| **esterilizacion** | ✅ "Registrar esterilización" | N/A | N/A | N/A | ✅ after fix | errorFocus hook |
| **medicacion-inicio** | ❌ "Registrar inicio" (no object) → **fixed** "Registrar inicio de medicación" | N/A | N/A | N/A | ✅ after fix | verb fix + inputMode + errorFocus |
| **medicacion-fin** | ✅ "Confirmar cierre de medicación" | N/A | N/A | N/A | ✅ after fix | errorFocus hook |
| **embarazo** | ✅ "Registrar embarazo" | N/A | N/A | N/A | ✅ after fix | inputMode=numeric |
| **embarazo (fin)** | ✅ "Confirmar fin de gestación" | N/A | N/A | N/A | ✅ after fix | inputMode=numeric |
| **fallecimiento** | ✅ "Registrar fallecimiento" | N/A | N/A (has inline confirm checkbox) | N/A | ✅ after fix | errorFocus hook |
| **tatuaje** | ✅ "Registrar tatuaje" | N/A | N/A | N/A | ✅ after fix | errorFocus hook |
| **nota** | ✅ "Guardar nota" (lightweight inline edit — Rule 4 exempt) | N/A | N/A (not trámite) | N/A | ✅ via LnField | none needed |
| **checkin** | ✅ "Enviar check-in" | N/A | N/A | ✅ L1 | ✅ after fix | errorFocus hook |
| **sintoma** | ❌ "Registrar en la libreta" → **fixed** "Registrar síntoma" | N/A | N/A | N/A | ✅ via LnField | verb fix |
| **atestar-raza** | — | — | — | — | — | Not in codebase (future) |

**Already compliant (no changes):** vacuna (verb), antiparasitario (verb), peso (verb), vet (verb + L1), microchip (verb), microchip-reemplazo (verb), esterilizacion (verb), medicacion-fin (verb), embarazo (verb), fallecimiento (verb), nota (verb), checkin (verb + L1).

**Changed:** clinico (verb), medicacion-inicio (verb + inputMode), sintoma (verb), mordedura (SuccessScreen).

**Mobile polish applied to all:** font-size 16px, min-height 44px, sticky CTA footer, error focus management, numeric inputMode on weight/dose/duration/weeks/births, tel inputMode on phone.

---

## Implementation

### Shared component changes

**`components/ui/Field.tsx`**
- `controlBase` gains `text-[16px] sm:text-[13.5px]` — prevents iOS Safari auto-zoom on focus.
- `controlBase` gains `min-h-[44px]` — WCAG 2.5.5 touch target.

**`components/ui/Sheet.tsx`**
- `LnSheetFooter` footer div gains `sticky bottom-0 z-10` — CTA stays reachable on long forms.
- `LnSheetFooter` now accepts `pendingLabel?: string` (default `"Registrando…"` for event forms; callers that want old wording pass `pendingLabel="Guardando…"`).
- `LnSheetPage` forwards `pendingLabel` to `LnSheetFooter`.

### New lib

**`lib/use-form-error-focus.ts`**
- `useFormErrorFocus<T>` — focuses the attached ref when `error` transitions from falsy → truthy (new submit failure). Safe: no re-fire on re-render with same error.
- Used in 13 forms (all that have a bottom `role="alert"` error paragraph).

### New page

**`app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/mordedura/exito/page.tsx`**
- `LnSuccessScreen` with title, 10-day observation description, and 2 actions.
- `reportBiteAction` redirect updated to point here instead of back to pet profile with a query param.

### Verb fixes

| Form | Before | After |
|------|--------|-------|
| clinico | `"Guardar información clínica"` | `"Registrar información clínica"` |
| medicacion-inicio | `"Registrar inicio"` | `"Registrar inicio de medicación"` |
| sintoma | `"Registrar en la libreta"` | `"Registrar síntoma"` |

### inputMode additions

| Form | Field | inputMode | enterKeyHint |
|------|-------|-----------|--------------|
| peso | kg | decimal | done |
| medicacion-inicio | dose | decimal | next |
| medicacion-inicio | customHours | numeric | next |
| medicacion-inicio | durationDays | numeric | next |
| embarazo | weeksAtDiagnosis | numeric | next |
| embarazo (fin) | liveBirthsCount | numeric | done |
| mordedura | victimContactPhone | tel | next |

---

## Tests

**`components/ui/event-forms-mobile.test.tsx`**
- `LnInput/LnSelect/LnTextarea` have `text-[16px]` class (iOS zoom prevention)
- `LnInput/LnSelect` have `min-h-[44px]` class (touch target)
- `LnSheetFooter` renders `sticky bottom-0` (CTA reachability)
- `LnSheetFooter` default pending label is `"Registrando…"`; custom `pendingLabel` overrides it
- `LnSheetFooter` button is `disabled` while pending
- `LnSuccessScreen` renders `<h1>` with title (focus target)
- `LnInput` forwards `inputMode` attributes correctly

---

## Spec contradictions / notes

- **atestar-raza**: listed in spec but the form does not exist in the codebase. Marked N/A — future work.
- **nota**: CTA "Guardar nota" retained. Per AGENTS.md Rule 4: "Lightweight inline edits (toggle, save profile field) keep their existing inline Toast confirmation; SuccessScreen is for full trámites only." A note is a lightweight personal memo, not a trámite.
- **fallecimiento / mordedura destructive**: both have 1 step with inline acknowledgment (checkbox). Rule 3 says "≥3 sections OR ≥1 destructive step" → WizardShell. However, if a flow has only two screens (form + confirm), don't use wizard — use ConfirmDialog or SuccessScreen. `mordedura` gets SuccessScreen (trámite). `fallecimiento` has an inline disclaimer checkbox — it's a single form (not multi-step), so WizardShell is not triggered; the risk is handled by the inline checkbox pattern.
