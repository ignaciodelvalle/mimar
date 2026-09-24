# Data retention (`retention_until`) — pending product/legal decision

> Snapshot: `c10f4ff03` (`main`) · Facts: `docs/architecture/facts.json` generated 2026-09-02
> Verified against code on 2026-09-02 by writer D (sonnet subagent) · Status: draft
> Numbers in this file are `<!-- fact:key -->` markers checked by `__tests__/architecture-facts.test.ts`.
>
> Status: PENDING PO DECISION as of 2026-09

**Status: OPEN — requires legal sign-off. No engineering action until then.**
**Date raised: 2026-06-11 (ARCH-G / ARCH-U of the data-architecture remediation series)**

## Context

Four tables carry a `retention_until` column applied by the PII baseline
(`pii.apply_baseline()`). The columns are deliberately **inert**: no writer
sets them and no cron purges by them. The data-lifecycle cron
(`/api/cron/data-lifecycle`, ARCH-G) purges only targets with explicit,
non-PII expiry semantics (notifications, rate-limit buckets, cron_runs).

Wiring retention for the tables below means choosing legal retention periods
for personal data under **Ley 25.326 (Protección de los Datos Personales)**.
That is not an engineering decision. This document captures what the decision
requires so it can be made once, deliberately.

## Tables and the decision each one needs

| Table | PII purpose tag | What retention means here | Open question |
|---|---|---|---|
| `profiles` | personal / identidad | Owner identity: name, DNI (optional), contact | How long after account erasure (`erase_subject_data` soft-delete) may the anonymized husk persist before hard-delete? ARCH-H already unblocked hard-deletion structurally. |
| `pets` | identidad_mascota | The pet credential itself — core registry entity | Is indefinite retention the *explicit* policy (national registry semantics), or does a pet record expire N years after `death_recorded`? |
| `pet_identifications` | identidad_mascota | Microchip/tattoo identifier records | Identifiers are quasi-legal records (chip uniqueness disputes). Same question as pets: indefinite, or N years post-death? |
| `custody_disputes` | auditoria_legal | Legal-proceeding records | Retention is governed by judicial timelines. N years after `resolved_at` / `withdrawn`? Counsel must confirm against prescription periods. |

## What is already true (no decision needed)

- Subject-rights RPCs exist: `erase_subject_data` anonymizes PII on request
  (Ley 25.326 art. 16). Retention is about the *residual* records.
- Hard-deletion of users is structurally possible since ARCH-H (PR #488):
  audit/config rows survive via `ON DELETE SET NULL` actor FKs.
- The purge infrastructure exists (ARCH-G, `lib/data-lifecycle.ts`): once
  periods are defined, wiring is a writer per table + one purge entry in the
  existing cron. Estimated effort: one small PR.

## ERRATA (2026-08-17) — the sanitary-event retention rationale was false

Until 2026-08-17 the codebase justified retaining sanitary events after an
erasure request with a **legal obligation that does not exist**, and used it to
condition the exercise of a right. Recorded here because the two places the
claim was written (migrations) are immutable and cannot be corrected in place.

**Where it was written**

| Site | Text |
|---|---|
| `db/migrations/0059_subject_rights_rpcs.sql:102-104` | "sus eventos sanitarios (libreta) se preservan para la conservación obligatoria por norma (Res. SENASA, Ley 14.072 ejercicio profesional, etc)" |
| `db/migrations/0159_erase_subject_data_free_text_payload_keys.sql:6-7` | "retains sanitary events by design (SENASA/Ord. CABA 41.831/Ley 14.072 retention — see `app/(app)/cuenta/privacidad/page.tsx`)" |
| `app/(app)/cuenta/privacidad/page.tsx:48-55` (fixed) | "su conservación es obligatoria por norma (Res. SENASA, Ord. CABA 41.831, Ley 14.072) … lo evaluamos caso por caso bajo la base legal de auditoría" |
| `app/(app)/cuenta/privacidad/PrivacyActions.tsx:96-98` (fixed) | "los eventos sanitarios de tus mascotas se preservan por norma (ver nota debajo)" |
| `AGENTS.md:1071` (fixed) | "eventos sanitarios preservados por conservación obligatoria de norma SENASA / Ley 14.072" |

The migrations cited the privacy page and the privacy page cited the migrations.
Nothing outside that loop sourced the duty.

**Why it is false** (verified against `docs/legal-framework-full.md`)

1. **Ord. CABA 41.831** imposes registration and reporting duties on the
   **owner** (art. 23 inscription at four months; art. 25 duty to report
   transfer, baja or death). It establishes no event-log retention duty and
   fixes no period.
2. **Ley 14.072/1951** governs the **professional practice of veterinary
   medicine** (matriculación) — not data retention. Its reach is
   national/CABA (`docs/legal-framework-full.md:43,221`), so it binds nothing
   for a user in Salta. *(An external review described it as a Buenos Aires
   provincial law; the repo's own legal reference says national/CABA. Either
   way it is not a retention rule.)*
3. No **SENASA** resolution catalogued in `docs/legal-framework-full.md`
   establishes a retention period for these records.

**Why it mattered.** Ley 25.326 art. 16 inc. 5 permits refusing supresión only
*"cuando existiera una obligación legal de conservar los datos"*. Invoking a
non-existent obligation converts a documentation defect into grounds for a
hábeas data — it denied the exercise of a right, not merely misinformed.

**What changed (2026-08-17).** Only the copy. The user-facing pages now give
the real, factual reason (the health history outlives a single owner), state
that the retention period is still being defined, and state explicitly that no
legal obligation is invoked to refuse an erasure request. Pinned by
`__tests__/privacy-retention-claim.guard.test.ts`. **Behaviour is unchanged**:
`erase_subject_data` still retains the events.

**New open question this errata adds to the decision.** `pet_events` carries no
`retention_until` column and is absent from the table above, yet it is now the
only record class whose post-erasure retention we promise the user we are
defining. Add it to the decision: period (or indefinite-by-policy) and anchor
event for sanitary events on a soft-deleted pet after an art. 16 request.

**What this errata does NOT decide.** Whether sanitary events should be purged,
and after how long, is exactly the open decision this document exists to carry.
The removal of a false legal shield does not by itself create a purge duty — it
removes the pretext for not deciding.

## What the decision must produce

For each table: **(period | indefinite-by-policy)**, the **anchor event** the
period counts from (erasure request, pet death, dispute resolution), and any
**legal-hold override** (e.g. open custody dispute freezes the pet's clock).

## Explicitly rejected alternatives

- **Provisional conservative periods** ("10 years, adjust later"): rejected
  2026-06-11 — provisional legal periods have a way of becoming permanent,
  and a wrong period in either direction is a compliance defect.
- **Error-shape unification (legacy `{error}` vs hexagonal `Result`)** —
  unrelated to retention but recorded here as the other deliberate skip from
  the same review round: the strangler migration converges module-by-module;
  a forced global refactor was judged low-ROI (2026-06-11).

## When the decision lands

1. Record periods + anchors in this file (flip status to DECIDED).
2. Wire writers: set `retention_until` at the anchor event in the same tx.
3. Backfill existing rows from historical anchor data.
4. Add the purge to `runDataLifecyclePurge()` with the same batched-delete
   pattern; legal-hold guards in the WHERE clause.
5. Extend `__tests__/cron-data-lifecycle.test.ts`.
