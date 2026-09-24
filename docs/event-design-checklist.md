# Event-design checklist

Use this checklist **before writing code** when you introduce a new `pet_event` type, or significantly change the payload of an existing one. The patterns in `AGENTS.md` are the source of truth; this file is the operational reminder so nothing important falls through.

If you can't answer one of these questions, the design isn't ready. Push back on the requirement or write a spec under `docs/superpowers/specs/` first.

---

## 1. Which cross-cutting pattern does this fit?

Pick one (or explicitly note "new pattern, see spec"):

- **`*_started` / `*_ended` pair** — time-bounded process. Examples: `rabies_observation_started`/`_ended`, `foster_assigned`/`_ended`. Each pair needs an auto-close cron with a hard upper bound (e.g., 10 days for rabies) and an idempotency guard (don't double-close a closed window).
- **`*_proposed` / `*_executed` / `*_rejected` / `*_cancelled`** — handshake with two parties. Examples: `cross_org_transfer`, `foster_proposal`, `adoption_application`. Each leaf event references the originating `*_proposed` event id in its payload.
- **Signal** — system-emitted observation that may or may not be visible to the owner. Examples: `outbreak_signal`, `credential_scanned`. Carries enough payload to route to authorities and dashboards without requiring a join back to the originating user event.
- **Umbrella with outcome discriminator** — single event type that covers multiple semantic outcomes via a `payload.sub_kind` or `payload.outcome`. Examples: `clinical_info_logged` (sub_kind: lab_work | imaging | surgery | …), `adoption_application_resolved` (outcome: approved | rejected). Use this when consumers would need parallel handlers anyway — collapsing reduces enum churn.

If your case doesn't fit, draft a spec arguing for a new pattern. Don't ship a one-off shape.

## 2. Which entity carries the status column it changes?

Most events update a projection column on the `pets` row (e.g. `status`, `rabies_observation_status`, `pregnancy_status`). Some update `cases.status`, `approval_requests.status`, or `ownerships.role`/`ended_at`.

State the target column up front. The projection helper lives in `lib/projections/` (one file per column family — see `pet-status.ts`, `pet-microchip.ts`, `pet-weight.ts`). If your event needs a column that has no projection helper yet, write the helper before you write the action.

If your event does NOT update any projection column, say so explicitly. Pure-history events exist (`note`, telemetry signals) and that's a valid answer — but make sure the reader of the spec knows.

## 3. Auto-close cron + idempotency strategy

Only required for `*_started` / `*_ended` pairs and time-bounded handshakes. Specify:

- **Hard upper bound** — the legal or product deadline at which the cron force-closes the window. Without this, an unended started-event grows the open-window set unboundedly.
- **Idempotency guard** — what stops the cron from emitting a second `*_ended` if one already exists for this window? Usually: query the events log for the latest `*_started` for this pet without a matching `*_ended` since.
- **Notification on auto-close** — does the cron-emitted `*_ended` notify the owner / org / authority differently from a manually-emitted one? If yes, include the discriminator in the payload (`auto_closed: true`, or distinct `notification_type`).

## 4. Payload Zod schema, with `payload_version`

Every payload lives in `lib/event-schemas.ts` as a Zod `.strict()` schema. Required fields:

- **`payload_version: z.literal(N).default(N)`** — start at `1`. When the payload shape needs to change, bump this and write an upcaster (`lib/event-upcasters.ts`), not a rewrite. See `docs/superpowers/event-versioning.md` for the full upgrade convention.
- **Use `.strict()`, not `.passthrough()`** — drift between writer and schema must throw at insert, not silently round-trip. Existing `pet_event` rows from before strict was enforced keep their old shape; validation runs only at insert time.

Test the schema with both a happy-path payload and at least one drift-catch case (an unexpected key, a missing required field). Mirror the pattern in `__tests__/event-schemas.test.ts`.

## 5. Libreta or non-libreta?

The libreta sanitaria is the owner-facing medical history. Events that belong in the libreta are user-visible by default; events that don't are operational telemetry the owner doesn't need.

- **Libreta events**: vaccinations, sterilization, weight, microchip, vet visits, deworming, medication, pregnancy, clinical info, death.
- **Non-libreta events**: `outbreak_signal`, `credential_scanned`, internal capability state transitions, system-emitted notifications.

State which one. If a libreta event has owner-facing copy, that copy lives in `lib/libreta/` (formatter + display logic), not in the event payload.

## 6. Which projections / dashboard queries consume this event?

List them. For each:

- **Projection**: the `lib/projections/<column>.ts` file that replays this event type into a column.
- **Dashboards / lists**: any `app/...` route that reads aggregated state from this event (e.g., owner dashboard ongoing-medications, admin pending-cases, authority outbreak watchlist).

If nothing consumes the event yet, that's fine — but say so explicitly. "Pure history for future replay" is a valid answer. "We'll figure it out later" is not.

## 7. Tests

At minimum:

- **Write happy path** — the action emits the event and the projection updates as expected.
- **Write rejection paths** — auth failure, schema-drift rejection, idempotency guard (re-emitting the same event for the same pet).
- **Projection drift detection** — for events that update a projection column, the `rebuild-projections` script must report `OK` for a pet with this event in its log.
- **(If applicable) Auto-close cron** — a simulated time-skip past the upper bound emits the `*_ended` and only emits it once.

Integration tests sit under `__tests__/` and require a local Supabase + Postgres (`pnpm db:start` first). Pattern: write inner-writer-style tests that call the pure function with a userId, bypassing FormData and the Supabase server client. See `__tests__/admin-decisions.test.ts` for a representative example.

---

## Quick reference

- Patterns and existing event catalog: `AGENTS.md` → "Event catalog — 55 types"
- Schema registry: `lib/events/event-schemas.ts` (uses `payload_version`, not `schemaVersion`)
- Payload versioning convention: `docs/superpowers/event-versioning.md`
- Upcasters: `lib/event-upcasters.ts`
- Projections: `lib/projections/`
- Rebuild script: `scripts/rebuild-projections.ts`
- Test patterns: `__tests__/admin-decisions.test.ts`, `__tests__/cross-org-transfer.test.ts`, `__tests__/libreta-share.test.ts`
