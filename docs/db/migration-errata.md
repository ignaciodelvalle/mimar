# Migration errata

Applied migration files are **immutable**. When one of them says something false, the correction is recorded here — never by editing the file.

Read this before trusting a comment inside `db/migrations/*.sql`. A migration's SQL is authoritative (it ran); its prose is not.

## Why the file cannot be fixed

`scripts/migrate.ts` stores the **sha256 of each file's bytes** in `public._dim_migrations.checksum` when it applies it. On every later run it re-hashes the file and compares:

- Default mode → a mismatch prints a loud `checksum drift` warning naming the file.
- `--strict` → a mismatch is fatal, exit code **3**, refusing to continue.

Editing an applied file — even a single comment character — changes its hash and trips that fence on every environment that already ran it. The fence is doing its job: it cannot tell a typo fix from someone quietly rewriting SQL that already shipped. So the file stays byte-identical forever and the truth lives here.

---

## E-1 — `0156_mpf_export_format_rule_type.sql`: wrong value counts, contradictory rollback

| | |
|---|---|
| **File** | `db/migrations/0156_mpf_export_format_rule_type.sql` |
| **Lines** | 42–44 (ROLLBACK note), 49–50 (DROP comment), 54 (ADD comment) |
| **Nature** | Comments only. **The SQL is correct** and produced the right constraint. |
| **Recorded** | PO decision 2026-08-04 |

### What the file claims vs. what is true

| Line | The file says | Actually |
|---|---|---|
| 42–44 | re-run 0150's constraint, a "10-value list, **before travel_corridor_requirements**/mpf_export_format" | 10 values is right, but 0150 **already includes** `travel_corridor_requirements` — 0120 added it |
| 49–50 | dropping the "**11-value** list from migration 0150, which already included travel_corridor_requirements" | "already included" is right; the count is **10**, not 11 |
| 54 | re-adding "the **12-value** list" | the new list is **11** values |

The two rollback-adjacent claims also contradict each other: line 43 says 0150 came *before* `travel_corridor_requirements`, line 50 says 0150 *already included* it. Both cannot hold. Line 50's version is the true one.

### The real lineage

| Migration | Values | Change |
|---|---|---|
| `0120_travel_corridor_rule_type.sql` | 9 | adds `travel_corridor_requirements` |
| `0150_microchip_required_rule_type.sql` | 10 | adds `microchip_required` |
| `0156_mpf_export_format_rule_type.sql` | **11** | adds `mpf_export_format` |

0120 and 0150 describe themselves accurately. The counting error starts and ends in 0156.

### Verified against the database

```
$ psql -c "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           WHERE t.relname = 'govt_business_rules'
             AND c.conname = 'govt_business_rules_rule_type_valid';"

CHECK ((rule_type = ANY (ARRAY['ppp_breed_list', 'ppp_weight_threshold',
  'ppp_attestation_required_registries', 'physical_credential_channels',
  'microchip_required', 'rabies_observation_window', 'due_soon_window',
  'reminder_windows', 'long_stay_days', 'travel_corridor_requirements',
  'mpf_export_format'])))
```

Eleven values. Matches 0156's SQL, not 0156's prose.

### If you ever roll 0156 back

Its ROLLBACK paragraph is the part most likely to hurt someone, because it is read under pressure. The corrected procedure:

1. `DELETE FROM govt_business_rules WHERE rule_type = 'mpf_export_format';`
2. Re-apply **0150's** constraint — the **10-value** list, which **keeps** `travel_corridor_requirements`. Dropping that value would break travel-corridor rules that 0120 legitimised four migrations earlier.

---

## E-2 — `0181_appointments_one_live_booking_per_pet_offering.sql`: remediation note lacks the operator SQL

| | |
|---|---|
| **File** | `db/migrations/0181_appointments_one_live_booking_per_pet_offering.sql` |
| **Lines** | 35–39 (the "Si el CREATE del índice por campaña falla acá" paragraph) |
| **Nature** | Comments only — an **addendum**, not a falsehood. **The SQL is correct.** |
| **Recorded** | Adversarial review fix 2026-08-14 |

### What is missing

The header correctly says that a failure of the per-campaign `CREATE UNIQUE
INDEX CONCURRENTLY` means the environment holds duplicate confirmed pairs per
(mascota, oferta), and that the fix is cancelling one of the two turnos — but
it never gives the operator the query that FINDS those pairs. Under pressure
(a failed migration on staging), that query should not have to be derived from
the index definition by hand. It is:

```sql
SELECT pet_id, service_offering_id, count(*)
  FROM appointments
 WHERE status = 'confirmed'
 GROUP BY pet_id, service_offering_id
HAVING count(*) > 1;
```

For each row returned: cancel the extra appointment **via the normal flow**
(owner cancel, or an org-side `cancelled_by_org` with a stated reason — never
by deleting history), then re-run the migration. The no-transaction re-run is
safe: the file's `DROP INDEX CONCURRENTLY IF EXISTS` + bare `CREATE` pattern
retries the invalid leftover instead of skipping it (see the file's own
"POR QUÉ SE RECONSTRUYE" section).

### Verified against the index definition

The query's shape is the index's predicate read back: `0181` lines 49–51
create `appointments_one_live_per_pet_offering` as `UNIQUE ... ON appointments
(pet_id, service_offering_id) WHERE status = 'confirmed'`. Grouping by exactly
those two columns under exactly that predicate and keeping `count(*) > 1`
enumerates precisely the rows that violate the uniqueness the CREATE tries to
certify — nothing more, nothing less.

---

## E-3 — staging ran a pre-0085 body of `enforce_audit_log_append_only()` while the ledger claimed 0085 applied

| | |
|---|---|
| **File** | `db/migrations/0085_audit_log_target_user_set_null.sql` (file is correct) |
| **Nature** | **Environment drift**, not a file error: staging's deployed function body predated 0085 even though `_dim_migrations` recorded `0085 … applied_at 2026-07-07`. |
| **Recorded** | Out-of-band repair 2026-08-14 |

### Symptom

`seed-panorama.ts --allow-remote` against staging failed deleting PANO
organizations with SQLSTATE `23001`:

```
audit_log is append-only. UPDATE blocked.
  SQL statement "UPDATE ONLY audit_log SET target_organization_id = NULL …"
```

That UPDATE is the `ON DELETE SET NULL` cascade that 0085 explicitly
whitelists. It cannot fail on a database actually running 0085's function.

### Diagnosis

```sql
SELECT prosrc FROM pg_proc WHERE proname = 'enforce_audit_log_append_only';
```

returned a short body — GUC bypass + RAISE only, **no cascade-nullification
rules** — while `SELECT filename, applied_at FROM _dim_migrations WHERE
filename LIKE '0085%'` returned an applied row dated 2026-07-07. Ledger row
and deployed body disagreed. A ledger entry proves a file was *recorded as
run*, not that the current object still matches it: `CREATE OR REPLACE
FUNCTION` from any later manual patch or partial restore silently wins, and
**function-body drift is invisible to table-level schema diffs** (the 2026-08
repo↔staging reconciliation compared relations, not `pg_proc` bodies).

### Repair (out-of-band, 2026-08-14)

Re-applied 0085's `CREATE OR REPLACE FUNCTION` byte-equivalent body, then
re-applied 0114's hardening (`ALTER FUNCTION … SET search_path = ''`), both
idempotent by their own files' declaration. Verified after:

```sql
SELECT length(prosrc)  AS body_len,        -- 2009 (was ~180)
       prosrc LIKE '%target_organization_id IS NOT DISTINCT FROM%' AS has_rules,  -- t
       proconfig                            -- {search_path=""}
  FROM pg_proc WHERE proname = 'enforce_audit_log_append_only';
```

The PANO org deletion cascade then succeeded on the next seed run.

### The fence this suggests

`migrate.ts --strict` fences file bytes against the ledger, but nothing fences
**deployed object bodies** against the files. Environments that were ever
patched by hand or restored partially can hold this class of drift on any
`CREATE OR REPLACE`d object (functions, triggers, views). A future
`check-function-parity` sweep (hash `pg_proc.prosrc` for repo-owned functions
against the last migration that defines each) would catch it before a seed or
a cascade does.

**BUILT (Lote B5, 2026-08-16)**: `scripts/check-function-parity.ts` — standalone
(`pnpm check:function-parity`) and as section D of `pnpm db:doctor`, which now
runs nightly against staging via `dim-interno:.github/workflows/db-doctor-staging.yml`
(gated on the `STAGING_DATABASE_URL` secret). One authority nuance discovered
while building it: for the functions `db/triggers.sql` defines, the LIVE body
matches *that file*, not their older migration snapshots (e.g.
`enforce_pet_events_append_only` vs 0127) — so triggers.sql wins the authority
rule for its functions, and a migration that patches one without updating
triggers.sql gets flagged until the two sources reconcile.

---

## E-4 — `0206_uploads_staging_bucket.sql`: the lifecycle note calls a rate limit a bound

| | |
|---|---|
| **File** | `db/migrations/0206_uploads_staging_bucket.sql` |
| **Lines** | 80–85 (the "WHAT IS LEFT" lifecycle note) |
| **Nature** | Comments only. **The SQL is correct** — the bucket, its two limits and the DO-block fence all do what the header says. |
| **Recorded** | 2026-08-28, from the uploads-firmados review |

### What the file claims vs. what is true

| Line | The file says | Actually |
|---|---|---|
| 80 | abandoned staged uploads are "**bounded** rather than collected, and the bounds are real" | They are **not bounded**. Nothing caps the total and nothing collects them. |
| 81–85 | offers the `media-upload` rate-limit family as one of those bounds | 120 requests/day/account is a **slope**, not a ceiling: ~600 MB/day/account at 5 MiB each, and unbounded in time. |

### The truth, and how it was verified

Exactly two things delete a staged object, and **both are event-triggered, neither scheduled**:

1. `confirmPetPhoto` (`lib/infra/pet-photo-upload.ts`) — on every path out, success and both refusals alike.
2. `purgeOwnedPetAttachments` (`erase-subject-data.ts`) — only when the subject erases their account.

An account that mints tickets, uploads, and never confirms — and never erases — leaves objects nothing will ever remove. Verified by enumerating the deleters: a single `rg` for `uploads-staging` across the tree returns those two call sites plus the migration and the contract, with no scheduled sweeper among them. RN-4 A9 is the general statement of the same fact: **no storage GC cron exists for any bucket** ("24 crons, none touches storage").

What *is* true is smaller and worth keeping: the objects are private and unreadable by any caller role, so this is storage cost and hygiene and **not** disclosure; each is capped at 5 MiB by the bucket; and every staged object is attributable to an account and a pet, because minting requires an authenticated holder — which is what will make a sweeper straightforward to write, and is not itself a sweeper.

### Why an erratum and not an edit

The table further down permits editing a **local-dev-only** file whose flaw is prose, and `0206` is in exactly that position on this machine — the ledger returns one row for it, applied 2026-08-28. The edit was **not** taken, because that same section says "'local only' is a claim about the world" and names `pnpm db:doctor -- --allow-remote` against staging as the way to check it rather than assume it. That check was not run here, and the branch has since been pushed. An erratum is correct whether or not `0206` has reached staging; an edit is correct only under a premise nobody verified. When the cheaper answer needs an unverified premise, take the more expensive one.

The live correction also exists at the code site — the `confirmPetPhoto` docblock in `lib/infra/pet-photo-upload.ts` — because that is where a reader of the upload path is standing. This entry is what a reader of the **migration** finds, which is the audience the header of this document names.

---

## The one case where editing the file IS the honest move

The closing rule below says a wrong SQL effect is not an erratum — it is a new
forward-only migration, "and the old file stays as the record of what actually
ran." That qualifier is the whole rule, and it has an edge the rest of this
document does not cover.

**If the file ran nowhere real, there is no record to preserve.** A migration
applied only to a developer's local Supabase stack has exactly one ledger row,
on a database that can be rebuilt from scratch with `pnpm db:bootstrap`. Delete
that row, re-run `pnpm db:migrate`, and the ledger records the corrected bytes:
no environment disagrees with the committed SQL, no drift warning fires, and
`pnpm db:doctor` section A stays green. Nothing has been hidden, because nothing
had been shipped.

**And for a DESTRUCTIVE statement, a corrective is not a fix at all.** A
corrective migration runs *after* the one it corrects, in the same
`pnpm db:migrate` invocation. If the flaw nulls or deletes a column, the damage
lands on staging and production first and the corrective can only apologise for
it. "Forward-only" protects the record; it was never meant to guarantee that a
known-destructive statement gets to run once on every environment before anyone
is allowed to fix it.

So the test is not "has it been applied" but **"has it been applied anywhere
whose history I would be falsifying"**:

| Applied to | Flaw is prose | Flaw is a wrong/destructive SQL effect |
|---|---|---|
| staging or production | erratum here (`## E-N`) | new forward-only migration |
| local dev only | edit the file | **edit the file**, delete the ledger row, re-apply |

Exercised once, deliberately: `0205_subject_rights_caretaker_grants_foster_contact.sql`
(2026-08-27). An adversarial review found its `C2` backfill missing
`o.ended_at IS NULL`, so it would have nulled a *living* third party's emergency
contact, vet and insurance on any pet an erased user had merely transferred
away. It had reached no environment but one local dev database. The file was
corrected in place — the predicate now matches the live RPC's, and the migration
header says so — the local ledger row was deleted, and `pnpm db:migrate`
re-recorded the true checksum. No erratum entry exists for it because there is
no divergence to record; this section is the record.

If you reach for this, say in the commit body **which** environments had run the
file, and how you confirmed it. "Local only" is a claim about the world, and
`pnpm db:doctor -- --allow-remote` against staging is how you check it rather
than assume it.

---

## Adding an entry

One `## E-N` section per erratum. Include, in this order: the file, the exact lines, whether SQL or prose is affected, the claim, the truth, and how the truth was verified. Say the verification out loud — an erratum that only asserts is a second unverified claim stacked on the first.

Prose-only errors go here. A **wrong SQL** effect is not an erratum: it is a new forward-only migration that corrects the schema, and the old file stays as the record of what actually ran.
