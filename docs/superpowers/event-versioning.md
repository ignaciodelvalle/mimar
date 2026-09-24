# Event payload versioning

`pet_events` is append-only. Once a row is written, its payload shape is
frozen forever. When a writer's payload needs to change shape — a field
added, removed, renamed, restructured — historical rows still have the OLD
shape and the read path has to tolerate both.

This doc captures the contract for evolving an event payload safely.

## The pieces

- **`lib/events/event-schemas.ts`** — Zod schemas for every event type. Each schema
  is `z.object(withVersion({...})).strict()` where `withVersion` injects
  `payload_version: z.literal(N).default(N)` for whatever the latest version
  is for that schema. `validateEventPayload` is called from every writer — the
  use-cases under `src/modules/*/application/**` (and a few module repositories
  such as `src/modules/events/infrastructure/events-repository.ts`), reached
  through the server actions in `src/modules/*/actions.ts` — to validate the
  payload BEFORE insert. It returns the parsed payload with `payload_version`
  filled in, which writers MUST use (enforced by
  `__tests__/event-payload-validation-convention.test.ts`).
- **`lib/events/event-upcasters.ts`** — upcasters that transform an older payload
  into the latest shape. The registry is keyed by event type, with an array
  of upcasters indexed by `fromVersion - 1`. `upcastPayload(eventType, payload)`
  walks the chain from the payload's current version up to the latest.
- **Migration 0039** — backfilled `payload_version: 1` on every historical
  row that lacked it. The baseline. Every row in `pet_events` carries a
  `payload_version` field from this point forward.

## How to bump a schema from v1 to v2

You want to change the shape of `weight_recorded` (say) to add a new field
or rename an old one. The current schema is at `payload_version: 1`.

1. **In `lib/events/event-schemas.ts`**, take the existing schema and convert it:

   ```ts
   // Before
   const weightRecorded = z
     .object(withVersion({ kg: z.string() }))
     .strict();

   // After
   const weightRecorded = z
     .object({
       payload_version: z.literal(2).default(2),
       kg_grams: z.number().int(),    // ← shape change
     })
     .strict();
   ```

   Do NOT keep the v1 fields in the new schema — `validateEventPayload`
   only accepts the LATEST shape. Old rows reach the read path via
   the upcaster.

2. **In `lib/events/event-upcasters.ts`**, register a v1 → v2 upcaster for this
   event type:

   ```ts
   const Upcasters: Partial<Record<EventType, ReadonlyArray<Upcaster>>> = {
     weight_recorded: [
       // v1 → v2: `kg: string` becomes `kg_grams: number`
       (v1) => ({
         payload_version: 2,
         kg_grams: Math.round(parseFloat(v1.kg as string) * 1000),
       }),
     ],
   };
   ```

   The upcaster is a pure function — same v1 input always produces the
   same v2 output. If the migration is lossy, encode the loss explicitly
   (e.g. `legacy_kg: v1.kg`) rather than dropping data silently.

3. **Update every writer under `src/modules/*/application/**`** (the use-cases,
   plus any module repository) that calls
   `validateEventPayload("weight_recorded", ...)` to produce the new
   shape. The convention test catches any callsite that discards the
   return value.

4. **Update every reader** of `weight_recorded` payloads (event reducers,
   history views, projections, exports) to wrap the row through
   `upcastPayload(...)` before consuming the payload:

   ```ts
   const event = await db.select().from(petEvents).where(...);
   const payload = upcastPayload(event.eventType, event.payload);
   //                                              ^^^^^^^^^^^^^^
   //                              now guaranteed to be v_latest shape
   ```

5. **Land everything in the same PR.** A schema bump without its upcaster
   leaves every historical row failing validation. An upcaster without
   reader adoption leaves projections rebuilt from a mix of v1 and v2
   shapes.

## What you do NOT do

- **Do NOT write a data migration to rewrite historical payloads.** That
  defeats the append-only contract. The whole point of upcasters is to
  leave the immutable log untouched and lift on read.
- **Do NOT keep both v1 and v2 fields in the same schema.** The schema
  validates the latest shape only. Old fields are only seen by the
  upcaster, which converts them away before the reader ever sees a v(N)
  payload.
- **Do NOT skip the upcaster.** Even if "the new shape is a superset of
  the old", the schema's `.strict()` means missing fields fail. Write
  the upcaster.

## When you have v3, v4, v5

The upcaster array chains naturally:

```ts
const Upcasters = {
  weight_recorded: [
    v1ToV2,
    v2ToV3,
    v3ToV4,
  ],
};
```

`upcastPayload` walks the chain from the payload's current version up to
the latest. A v1 row goes through `v1ToV2 → v2ToV3 → v3ToV4`; a v3 row
goes through just `v3ToV4`. Upcasters compose; they never need to know
about each other.

## Tests

- `__tests__/event-schemas.test.ts` — every registered schema includes
  `payload_version` (catches a future schema added without
  `withVersion(...)` or an explicit literal).
- `__tests__/event-payload-validation-convention.test.ts` — every
  `validateEventPayload(...)` callsite assigns the return value (catches
  the failure mode where a writer discards the version-filled payload
  and inserts the original).

Add reducer/projection tests as needed when introducing a v(N+1) — they
should exercise both the v1 and v(N+1) read paths to confirm the
upcaster chain produces the same downstream behavior.
