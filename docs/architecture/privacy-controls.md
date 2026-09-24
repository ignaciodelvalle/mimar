# Privacy controls — mechanisms, and where each one stops

> Snapshot: `c10f4ff03` (`main`) · Facts: `docs/architecture/facts.json` generated 2026-09-02
> Verified against code on 2026-09-02 by writer C (opus subagent) · Status: reviewed
> Numbers in this file are `<!-- fact:key -->` markers checked by `__tests__/architecture-facts.test.ts`.

## What this document answers

Where personal data lives, what is applied to it before it leaves the server,
and what each control does NOT cover. The legal frame is Ley 25.326 (Protección
de los Datos Personales); the controls described here are engineering
mechanisms, not a compliance opinion.

Two companion registers hold the parts a mechanism cannot fix:
`docs/architecture/privacy-known-limitations.md` (accepted limitations, with the
triggers that reopen them) and `docs/architecture/client-error-sink-pending-decision.md`
(the open telemetry decision).

## 1. DNI — HMAC only, never plaintext

`lib/utils/dni-hash.ts` is the whole mechanism. Two exported functions:

- `hashDni(dni)` — `lib/utils/dni-hash.ts:72`. HMAC-SHA256 over the digits with
  a server-side pepper, hex digest. Deterministic, so equality matching in SQL
  works (`WHERE dni_hash = hashDni(input)`).
- `dniLast4(dni)` — `lib/utils/dni-hash.ts:81`. The last four digits, for human
  disambiguation in an operator UI. Never an identifier.

The storage side matches: `db/schema.ts:321` and `db/schema.ts:322` declare
`dni_hash` and `dni_last4` on `profiles`, and there is no plaintext DNI column
anywhere. A unique index on the hash (`db/schema.ts:414`) makes the equality
match a real key.

**The pepper is the whole security of this.** The Argentine DNI space is seven
to eight digits — small enough that a known pepper makes every stored hash
reversible by rainbow table. `getPepper` (`lib/utils/dni-hash.ts:23`) therefore
fails closed on a real deployment rather than falling back to the committed dev
value, and it does so on **two independent triggers** (`:50-54`): running on a
deploy platform at all, OR `NODE_ENV=production` against a non-local database.
The second trigger exists because keying on `NODE_ENV` alone left a residual — a
deploy that fails to set it, or whose `DATABASE_URL` merely contains the
substring "localhost", fell through to the public pepper in silence.

A06's refuter narrowed the claim, and the narrower version is the true one:
`isDeployPlatform` reads `process.env.VERCEL`, so on a **self-hosted** deploy
the gate collapses back to the `NODE_ENV` half. Closed on Vercel; the
self-hosted residual is real.

**What no mechanism here provides: the DNI is SELF-DECLARED.** There is no
RENAPER verification and no provider has been chosen — `docs/onboarding/README.md`
records it as an explicit cut from the funcionario guide. A hash proves the same
person typed the same number twice. It proves nothing about whose number it is.

## 2. The `pii` schema — a database object, not a Drizzle one

Migration `db/migrations/0058_pii_baseline.sql` creates a `pii` schema carrying
`purpose` / `retention_until` / `deleted_at` baselines under Ley 25.326 art. 4°
(base legal del tratamiento), applied to the PII-bearing tables. `db/schema.ts:165`
declares the matching `data_purpose` enum so a row can name its legal basis.

**It is not modelled in Drizzle.** `db/schema.ts` declares exactly one
`pgSchema`, and it is `ref` (`db/schema.ts:4743`), not `pii`. Everything under
`pii` is reachable only by raw SQL and by the SECURITY DEFINER functions that
live there — `pii.caller_is_admin` (`db/migrations/0059_subject_rights_rpcs.sql`)
being the load-bearing one.

Two consequences worth stating rather than discovering:

1. `retention_until` is **inert**. `lib/infra/data-lifecycle.ts` says so in its
   own header: the four `retention_until` tables carry Ley 25.326 PII, no
   retention policy has been defined in any design document, and the columns are
   deliberately left unread pending a product/legal decision. The purge job
   prunes five operational targets (rate-limit buckets, expired notifications,
   revoked push subscriptions, old `org_contact_messages` submitter IPs, old
   `cron_runs`) and no personal record.
2. Coverage of the subject-rights RPCs is **not** derived from the `pii`
   baseline, and `scripts/check-subject-rights-coverage.ts:31-36` explains why:
   only six tables are under the baseline while the RPCs already reach
   twenty-two, so deriving from it would declare sixteen covered tables out of
   scope and call the result coverage.

## 3. Buckets, signed reads, and signed-upload tickets

Reads from private buckets are signed **server-side, as service role, at render
time**. `lib/infra/storage.ts` holds the three signers
(`eventAttachmentSignedUrl` at `:57`, `welfareAttachmentSignedUrl` at `:94`, the
batch `eventAttachmentSignedUrls` at `:115`), and the module header states the
rule they follow: *no signer in this module takes a caller client, because an
authenticated-role SELECT on a private bucket is an enumeration grant, not an
access check.*

Attachment signed URLs live for
<!-- fact:signed_url_ttl_seconds -->3600<!-- /fact --> seconds
(`lib/infra/storage.ts:21` and `:22`).

Because signing runs as service role, the **in-query predicate is the only
authorization**. `sign-timeline-attachments.ts` filters on the pet id resolved
by `requirePetAccess` as well as on the caller-supplied event ids, so a caller
with access to pet A cannot hand in pet B's event ids and receive B's clinical
attachments. Its docblock says this is the only check there is.

Uploads go the other way: the server mints a signed **upload** URL against the
private `uploads-staging` bucket (`db/migrations/0206_uploads_staging_bucket.sql`),
the client PUTs the bytes directly, and a confirm step re-derives the object key
from the pet the access check just resolved (`lib/infra/pet-photo-upload.ts`).
The bucket declares its own size and MIME ceilings at the object store, so an
oversized or wrongly-typed PUT is refused even when none of our code runs; the
migration asserts both at replay time. Bucket policies are fenced by
`scripts/check-storage-write-policies.ts`.

Four honest exceptions to "private, short-lived, scoped":

| Exception | Where | Status |
|---|---|---|
| `pet-photos` and `org-logos` are PUBLIC buckets | `db/storage.sql`, `lib/infra/storage.ts:24` and `:31` build the URLs deterministically | By design for the public credential. `pet-photos` has an unscoped authenticated INSERT and no bucket MIME ceiling — `A07-1`, MED |
| Avatar upload validates a caller-supplied NUMBER, not the blob | `src/modules/pets/application/profile/upload-avatar.ts` | `A07-2`, MED |
| Art. 16 erasure sweeps three buckets and leaves `avatars` | `src/modules/auth/application/subject-rights/erase-subject-data.ts` | `A07-3`, MED |
| The MPF export bakes seven-day signed evidence URLs into a PDF that travels to the fiscal authority | `lib/analytics/welfare-exports.ts`, `src/modules/welfare/actions.ts` | Deliberate and DISCLOSED — the validity note is printed inside the PDF itself |

There is **no storage garbage collection**. Twenty-five cron route directories
exist and none of them touches storage; only event-triggered deletion happens.
Every replaced photo, failed-transaction orphan and unconfirmed staged blob
accumulates without bound (`A07-6` / RN-4 B30).

## 4. Subject rights — Ley 25.326 art. 14 and art. 16

Two SECURITY DEFINER RPCs, whose live definitions are in
`db/migrations/0208_subject_rights_watermarks_tag_interest_org_invitations.sql`:
`export_subject_data` (art. 14, acceso) and `erase_subject_data` (art. 16,
supresión). The TypeScript around them is
`src/modules/auth/application/subject-rights/export-subject-data.ts:100` and
`src/modules/auth/application/subject-rights/erase-subject-data.ts:581`. The API
surface is `app/api/v1/me/privacy/route.ts` — `GET` at `:97` is art. 14, `POST`
at `:175` is art. 16.

### The asymmetry is a decision, and it is pinned by a test

An institutionally deactivated account is **refused** the art. 14 export and
**granted** the art. 16 erasure, on the same bearer
(`app/api/v1/me/privacy/route.ts:214-219` carries the reasoning). An
organisation cannot stand between a person and Ley 25.326 by flipping one
column. Making the two halves symmetric again requires deleting a test on
purpose — `__tests__/api-v1-me-privacy-route.test.ts` holds three named
assertions on it.

### Erasure never deletes a spine row

Invariant #2 survives art. 16. The erasure UPDATEs `pet_events` and
`case_events` payloads inside one explicitly opened, explicitly closed audited
override window attributed to the acting user; no migration in the repo issues a
`DELETE` against either table. The lock is the append-only trigger from
`db/migrations/0127_pet_events_append_only.sql`.

Say it the honest way: **append-only is enforced by policy and by a DB trigger
with an audited override**, not by physics. "Impossible to modify" is not a
claim this system can make.

### What erasure keeps in pet_events, and what it removes

PO decision 5A (2026-09-22): **erasure removes what belongs to the person,
never the pet's health or compliance history.** Since
`db/migrations/0240_erasure_pet_events_by_key.sql` (T3-A2b) every payload key,
every column and every `pet_profile_updated` changelog field carries a privacy
class in `lib/events/payload-privacy.ts`:

| Class | Erasure does | Examples |
|---|---|---|
| `compliance_fact` | keeps it | vaccine, batch, next due date; bite type, severity, victim kind; death cause, disease code; rabies outcome; microchip numbers and the **enum** `reason` of a replacement |
| `professional_act` | keeps it, even after the professional's own erasure (art. 16 inc. 5) | `administered_by`, `vet_name`, `vet_matricula`, `firma_hash` |
| `professional_act`, author-gated | keeps it when the row's `author_role` is vet, govt or system, or a **verified** shelter; sentinel otherwise (an unverified org member's words are personal data) | `diagnosis`, `closure_notes`, `cause_detail`, the `notes` column |
| `personal_data` | sentinel, drop, null, empty array, age band or a 2-decimal point | victim contacts (dropped), injuries (sentinel, whoever wrote them), victim age (kept as a band), finder name and contact, the owner's prose, insurance, the applicant's home |

The erasure reaches four scopes (`pii.pet_event_scopes`): rows the subject
**authored**, on any pet, ever; legacy owner rows with no recorded author
inside the subject's ownership intervals; every row on the pets **going dark**
(the subject's current owner pets); and rows that **name the subject** as a
party (an adoption application, a foster's notes) — for those, only the keys
about that person.

Two guards from the fresh-context security review: the sentinel never
overwrites a **machine code** a writer stores under a prose key
(`status_changed.reason = 'return_to_original_owner'`), and every such code is
declared next to its key; and every event type's coordinates are classified
in `COORDINATE_PRIVACY` — `lint:subject-rights` fails on a live type storing a
point that is not.

What it is not: the key-name sweep that ran from 0159 to 0228 overwrote the
enum `reason` of `microchip_replaced`, `foster_ended`, `custody_transferred`
and `custody_transfer_proposed` on every erased owner's pets. Those values are
gone — there is no pre-image to restore them from. Residuals the classification
does not reach: `event_notification_outbox.payload_snapshot`, the decomiso
audit payload's `judicial_ref`, and notification bodies already delivered to
other people.

Two fences hold it. `lint:string-sweep` (`scripts/check-event-payload-privacy.ts`)
walks every zod payload schema and fails an unclassified leaf or a transform
that does not fit it — a sentinel on an enum is a violation. `lint:subject-rights`
compares the live `pii.pet_event_redaction_rules` with the TypeScript both ways.

### The coverage fence, and what it cannot express

`scripts/check-subject-rights-coverage.ts` classifies every public table **per
right**: `CLASSIFICATION` states its export (art. 14) side and its erase
(art. 16) side separately, each `covered`, `covered_outside_sql` (a named
TypeScript step of the erasure, checked to exist), `exempt(reason)` or
`gap(reason)`, and a side left unstated or unreasoned is a failure. Every
`covered` side is verified **in both directions** against the live function
body; a non-covered side the body actually names is itself a failure, so a gap
can only close by the RPC reaching the table, never by editing the list.
`IN_EXPORT`, `IN_ERASE`, `EXEMPT` and `KNOWN_GAP` are derived from it.

The fence states its own limit at `scripts/check-subject-rights-coverage.ts:19-28`:
**it proves MENTION, not predicate correctness.** A table can be named with a
WHERE clause matching the wrong subject and this fence passes it.

`A05-2` (HIGH) was that the first design sorted TABLES into flat lists, so a
table reached by exactly ONE of the two RPCs read as fully covered. The per-side
classification closed the blind spot, not the debt: the one-sided gaps are now
written down and printed on every run — the export side of `attachments`,
`case_events` and `libreta_share_tokens`, and the erase side of
`organization_memberships`. The concrete consequence of that last one is
unchanged: an erased subject stays an open organization member.

### Erased-actor semantics: the column is set and almost nothing reads it

`erase_subject_data` soft-deletes the profile — it sets `deleted_at` and leaves
`role`, `account_type` and `deactivated_at` untouched. Four confirmed audit
findings are downstream of exactly that (`A05-1`, `A10-G1`, `A10-G3`, `A06-G2`),
and the correct predicate already exists one migration family over:
`db/migrations/0188_revocations_upload_admin_govt_only.sql` writes
`AND p.deleted_at IS NULL`. See
`dim-interno:docs/reviews/2026-09-fresh/SYNTHESIS.md` §6.

## 5. K-anonymity

One constant, one policy: `ANONYMITY_K` at `lib/metrics/anonymity.ts:28`, value
<!-- fact:k_anonymity_k -->5<!-- /fact -->.

It is deliberately **not overridable per call site**
(`lib/metrics/anonymity.ts:19-26`). Every entry point used to accept a `k`
argument and four callers answered it with a literal — no-ops that read like
decisions. A policy floor any caller may lower is not a floor; raising or
lowering it is now a one-line edit on the line that documents itself as the
policy.

`suppressSmallCells` (`lib/metrics/anonymity.ts:59`) returns
`{ visible, suppressed, suppressedCount }`, and the `visible` array carries the
brand that satisfies `SuppressedCells` (`lib/metrics/types.ts`). The rule the
module states at `lib/metrics/anonymity.ts:5`: **every fetcher that groups by
locality MUST route its output through it.**

Public open data goes further. `lib/open-data/province-suppression.ts` sets
`OPEN_DATA_K = ANONYMITY_K` (deriving it rather than re-typing a literal),
applies complementary suppression across the whole country, and applies JOINT
suppression across datasets sharing a population base — so no arithmetic
difference between published cells and the published national total can recover
a sub-k count. `lib/open-data/datasets.ts` documents the joint rule; the
serving route is `app/(public)/transparencia/datos/[dataset]/route.ts`.

### The declared limits — KA1, KA2, KA4, KA5 and PD1

`docs/architecture/privacy-known-limitations.md` is the register. Its headings,
verbatim:

```
## KA1 + KA2 — differencing via the raw provincial density marginal
## KA5 — per-offering campaign enrollment differencing vs geo-reach k-anon
## PD1 — `/gob/analytics/export` is a row-level padrón, declared OUTSIDE the k-anon policy
```

Two notes on how to read that list, because the labels are not what a reader
expects:

- **KA4 has no heading of its own.** It is described inside the KA1+KA2 entry:
  a narrow scrubber window on the `mortalidad` layer can expose an individual
  death's date and `disposition_method` under an otherwise ≥k cell. The KA1+KA2
  reopen triggers include "the `mortalidad` scrubber gains finer-than-daily
  granularity", which sharpens it.
- **KA3 does not appear in that file at all**, under any heading or inline. If
  something was filed as KA3 elsewhere, it is not registered here. Do not cite a
  KA3 acceptance from this document.

What each one means in one line:

| id | The leak | Why accepted |
|---|---|---|
| KA1 + KA2 | `complementarySuppress` promotes exactly one sibling cell and does not widen to a feasible interval; per-province density is published RAW. Subtraction recovers a suppressed cell | Operator-gated, jurisdiction-scoped screens; aggregate pet-event counts, not direct human PII; the fix hides legitimate cells |
| KA4 | A narrow `mortalidad` scrubber window can isolate one death | Same envelope as KA1/KA2 |
| KA5 | Per-offering campaign enrollment and completion are published at full precision while the sibling geo-reach surface is k-suppressed; `attended ≈ enrollment × completitud` reconstructs what geo-reach hides | Treated as operational data an org owns about its own campaigns in its own jurisdiction, not human PII |
| PD1 | `/gob/analytics/export` emits ROW-LEVEL CSV/JSON and the k-anon policy is simply not applied to it. Measured 2026-08-22: 98% of mortality-by-locality cells are under the threshold, i.e. nearly every cell the dashboards hide is recoverable with one spreadsheet formula | An official needs the padrón of their own territory; a padrón with holes is not a padrón. Declared rather than suppressed |

PD1's acceptance **rests on two verified properties**, and the register says it
is void if either stops holding: every fetcher fails closed for a govt with zero
jurisdictions, and every export writes an audit row. Both were verified against
the code on 2026-08-23. It also names the residual it does not fix: the audit
row is inserted after the file is uploaded and the URL minted, so a crash in
between leaves a downloadable file with no trail.

**Closed 2026-09-22 (`A06-1`, was LOW).** `fetchCasesPerLocality`
(`lib/analytics/dashboards/surveillance.ts`) now returns
`MetricResult<SuppressedCells>`, built by `suppressSmallCells` — the branded
type the compiler enforces cannot be constructed any other way. A future
second consumer of locality-grain data (a table, a CSV, a tooltip) cannot
skip suppression — the return type will not let it.

/gob/vigilancia's province choropleth does NOT consume that locality-grain
fetcher: it calls the new `fetchCasesPerProvinceChoropleth`, which folds the
RAW per-locality rows to province grain first and suppresses once, at the
grain the map actually displays (via `aggregateChoroplethData`, the same
mechanism /gob/perdidas already trusts). A province whose cases are split
across several sub-k localities still shows its true total once that total
reaches k=5 — suppressing at locality grain first and folding afterward
would have undercounted it instead, which is worse for a health authority
than the original gap: a silent-looking zero, not a visibly hidden cell.

## 6. Logging, redaction, and the two error planes

### Server — structured stdout, no vendor

`lib/infra/report-error.ts` writes one structured JSON line to stdout, which
Vercel's function logs make queryable. No third-party processor is involved.

### The redaction layer

`lib/observability/redact.ts` runs **before** anything reaches a sink, so no
future provider adapter can leak by forgetting to scrub.

- `CREDENTIAL_TOKEN_PREFIXES` (`lib/observability/redact.ts:79`) —
  <!-- fact:token_prefixes -->12<!-- /fact --> product credential prefixes, from
  `DIM-` through `DEN-`. The list is **drift-fenced**:
  `lib/observability/redact-prefix-coverage.test.ts` re-derives the true set
  from the repo on every run and fails when the two disagree. That fence is not
  decoration — the first version of the rule covered three prefixes out of the
  twelve.
- `SCRUB_RULES` (`:173`) and `redactText` (`:251`) — DNI, phones, e-mails, JWTs,
  `Authorization` headers, capability tokens in URL path segments, sensitive
  query-string values.
- `redactContextValue` (`:270`) — context values are an allowlist, not a filter.

Two gaps A06 confirmed by refutation, and they are the common forms rather than
exotic ones: **no rule matches a dotted DNI** (`12.345.678` contains no run of
seven or more digits, and Argentine DNIs are conventionally dotted), and
`OPAQUE_CONTEXT_KEYS` admits `correlationId` under a shape an eight-digit DNI or
an eleven-digit CUIT satisfies, bypassing `redactText` entirely. A third,
declared in `docs/architecture/client-error-sink-pending-decision.md`: the
physical tag activation code is deliberately unprefixed and therefore
unredacted, because a bare four-four alphanumeric group is indistinguishable
from ordinary text.

### The web has NO Sentry, and this is a pending decision, not an oversight

`docs/architecture/client-error-sink-pending-decision.md` is the open decision.
Its table states where an error goes today: the server row is observable, the
web client row dies in the browser tab, and the transport seam
(`lib/observability/sink.ts`) is finished and waiting for one adapter.

It is gated on **law before price**: any hosted sink is an international
transfer of personal data under Ley 25.326 art. 12, and an error report is
unstructured by nature — the redaction layer is a strong filter, not a proof.
The document's own recommendation is to do the Vercel-only option first because
it introduces no new data processor, then decide hosted-versus-self-hosted
deliberately.

**One row of that table is now stale, and this is the honest correction.** It
says mobile has "nothing", verified as zero occurrences of Sentry across the
three `package.json` files. That was true when it was written on 2026-08-29 and
is not true at this snapshot: `apps/mobile/src/observability/sentry.ts` exists
and initialises the SDK.

### Mobile HAS Sentry, with no scrub hook

`apps/mobile/src/observability/sentry.ts:38` (`initSentry`) calls `Sentry.init`
at `:41` with exactly three options: the DSN, `sendDefaultPii: false`, and
`tracesSampleRate: 0`. The DSN arrives from the EAS build environment via
`apps/mobile/app.config.ts` and resolves to null on a build without one, in
which case `initSentry` deliberately does nothing. The SDK's error boundary is
attached at `apps/mobile/app/_layout.tsx:330` (`Sentry.wrap`), and `initSentry`
is called at `:44`.

There is **no `beforeSend` and no `beforeBreadcrumb`** anywhere under
`apps/mobile`, and the web's `redact.ts` is wired server-side only. So:

- `sendDefaultPii: false` suppresses IP and cookies. It does not touch message
  text or breadcrumb URLs.
- The default Breadcrumbs integration records request URLs, and the signed
  upload ticket carries its capability in the query string — so a crash inside
  the breadcrumb window ships that URL verbatim to the vendor. That is `A06-2`
  (MED). What leaves today is a short-lived, server-revalidated capability, not
  PII, which is why it is MED and not HIGH.

The file's header is honest about the trade-offs it DID make: `sendDefaultPii`
is stated even though it is the default, because "this product hashes DNIs at
the boundary; its crash reporter does not get to be the one surface that ships
identifying data by accident."

Erasure on the phone drops the offline credential cache and the keychain in the
same act (`apps/mobile/src/credential/credential-cache.ts`,
`apps/mobile/src/auth/session-store.ts`). A05's refuter checked and found the
behaviour reproduces but **no test asserts it** — removing the teardown breaks
nothing.

## 7. What this page does not claim

- Not a compliance opinion. The statutes cited in code were confirmed as
  anchors, never verified as legally correct or current.
- Nothing was executed to produce this document — no test run, no build, no
  database query. Every claim is read from repo source at `c10f4ff03`.
- The live policy state of a running database is not established here. The live
  authority is `__tests__/rls`, which needs a database and was not run.
- A06's own coverage notes several areas it never reached, including the
  e-mail leg of notifications, the turnos agenda's PII exposure, and the
  anonymous credential JSON endpoint field by field.

## Related documents

- `docs/architecture/privacy-known-limitations.md` — the accepted-limitation register
- `docs/architecture/client-error-sink-pending-decision.md` — the open telemetry decision
- `docs/architecture/authorization.md` — who may reach any of this
- `docs/architecture/government-views.md` — the operator-facing aggregate surfaces
- `dim-interno:docs/reviews/2026-09-fresh/lenses/A05.md` — erasure vs immutability
- `dim-interno:docs/reviews/2026-09-fresh/lenses/A06.md` — privacy and PII flows
- `dim-interno:docs/reviews/2026-09-fresh/lenses/A07.md` — uploads and storage
