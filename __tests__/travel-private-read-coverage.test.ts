// The SET of reads that must hide the owner's trips — derived from source
// (viajes-fase-2, design D8).
//
// A trip (`transport_recorded`) and a CVI (`cvi_issued`) say when a household
// will be away and where it is going. `notTravelPrivateClause()`
// (lib/infra/travel-private-events.ts) drops them, and every correction of
// them, for anyone `canAccessTravel` refuses. This fence ships BEFORE any trip
// writer beyond Fase 1's exists, so the first real trip lands on a tree where
// every non-titular read is already closed.
//
// Modelled on subject-hidden-event-read-coverage and content-report-read-
// coverage, with the second one's lesson kept: a claim about a SET is checked
// in both directions.
//   source → list: every file that queries `pet_events` in a shape that can
//     return a travel row or a correction of one is triaged into exactly one
//     list below. A new such read in no list fails here.
//   list → source: every entry still exists and still queries `pet_events`.
//
// WHAT THE SCAN CAN SEE. A reader is flagged when it queries pet_events AND
// names `movement_recorded`, a travel sub-kind, `event_amended`, or reads one
// row by `eventId`. A read that selects EVERY event type and names none of
// those spells nothing this regex can match — that is a known blind spot, the
// same one content-report-read-coverage declares. If you add a query over
// `pet_events` with no type filter, triage it yourself.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TRAVEL_PRIVATE_SUB_KINDS } from "@/lib/infra/travel-private-events";

const ROOT = process.cwd();
const CLAUSE_MODULE = "lib/infra/travel-private-events.ts";

/**
 * Reads a non-titular can reach. Each CARRIES the clause — conditionally on
 * `canAccessTravel` where a titular also reads through it, unconditionally
 * where nobody should ever see a trip there.
 */
const MUST_HIDE: readonly string[] = [
  // The owner's own event detail — also opened by a caretaker and an org member.
  "app/(app)/mis-mascotas/[publicToken]/eventos/[eventId]/page.tsx",
  // The public credential's streamed medical section (event_amended overlay).
  "app/(public)/p/[publicToken]/CredentialStreamedSections.tsx",
  // The printable libreta — reachable by a caretaker and the org path.
  "app/api/mis-mascotas/[publicToken]/libreta-export/route.ts",
  // The /libreta/compartir link a vet opens.
  "lib/infra/libreta-share-events.ts",
  // v1 events/{id} and its amend route read through this loader.
  "src/modules/events/application/read/load-pet-event-detail.ts",
  // The public credential's shell (event_amended overlay).
  "src/modules/pets/application/read/load-public-credential.ts",
  // The libreta face: web page, server-action shim and v1 libreta.
  "src/modules/pets/application/tab-data/get-libreta-face-data.ts",
  // Atender's walk-in libreta.
  "src/modules/pets/application/tab-data/get-walk-in-libreta.ts",
];

/**
 * Code that reads travel rows ON PURPOSE, each with the reason no
 * non-titular receives them.
 */
const TITULAR_OR_WRITER: readonly string[] = [
  // The correction WRITER. It must read its target to validate it; for a
  // travel target it asks holdsPetAsTravelTitular and refuses everyone else
  // with `travel_private_target` (asserted below).
  "src/modules/events/application/amendment/amend-event.ts",
  // The titular's travel PDF. Its ownership join refuses a caretaker row, the
  // same rule as canAccessTravel (asserted below; behaviour in
  // __tests__/travel-export.test.ts).
  "src/modules/pets/application/travel-export/generate-travel-export.ts",
  // Cache derivations: they read movement rows to rebuild pets.jurisdiction_*
  // from jurisdiction_changed and render nothing.
  "lib/infra/rederive-pet-cache.ts",
  "src/modules/events/application/amendment/refresh-pet-cache-after-amendment.ts",
];

/** Aggregate and admin surfaces — counts and flags, never a trip's fields. */
const AGGREGATES: readonly string[] = [
  // /gob/vigilancia. cvi/transport counts below ANONYMITY_K publish as null
  // (suppressTravelCounts), never with a corridor/date/airline breakdown.
  "lib/metrics/movement.ts",
  // /admin/libro — admin-only. Type, date, pet token and a has-correction flag;
  // it selects no payload.
  "lib/metrics/event-ledger.ts",
  // /admin/libro's correction chain — admin-only, the operator's audit view.
  "app/admin/libro/actions.ts",
];

/**
 * Readers that fetch `event_amended` only to FOLD it onto a type allow-list
 * that excludes `movement_recorded`, or name it only in a comment. A trip's
 * correction can ride in, but it has nothing to fold onto and is never
 * rendered as a row.
 */
const OVERLAY_ONLY: readonly string[] = [
  "lib/analytics/compliance-metrics.ts",
  "lib/analytics/owner-dashboard.ts",
  "lib/analytics/surveillance-metrics.ts",
  "lib/infra/amendment-sql.ts",
  "lib/metrics/population-control.ts",
  "lib/metrics/rabies.ts",
  "src/modules/events/application/amendment/amend-authorship.ts",
  "src/modules/events/application/amendment/fetch-latest-amendments.ts",
  "src/modules/events/application/amendment/reevaluate-outbox-after-amendment.ts",
  "src/modules/events/infrastructure/events-repository.ts",
  "src/modules/pets/application/pregnancy/rederive-pregnancy-status.ts",
  "src/modules/surveillance/infrastructure/surveillance-repository.ts",
];

/** Flagged by the coarse scan, but not a read of a travel row at all. */
const NOT_A_TRAVEL_READ: readonly string[] = [
  // The clause's own module: its only `FROM public.pet_events` is the
  // correlated lookup inside the clause.
  CLAUSE_MODULE,
  // ENO routing: one event by id, to find its bite case. No payload out.
  "lib/events/eno-target-jurisdiction.ts",
  // Defines libretaSanitariaClause, which already EXCLUDES movement_recorded.
  "lib/infra/libreta-sanitaria.ts",
  // Names movement_recorded only in a comment about species corrections.
  "src/modules/pets/infrastructure/pets-repository.ts",
];

const ALL_LISTS = [
  ...MUST_HIDE,
  ...TITULAR_OR_WRITER,
  ...AGGREGATES,
  ...OVERLAY_ONLY,
  ...NOT_A_TRAVEL_READ,
];

/** Every non-test source file under the app's own roots. */
function sourceFiles(): string[] {
  const found: string[] = [];
  for (const root of ["app", "lib", "src"]) {
    for (const entry of readdirSync(join(ROOT, root), { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      if (name.includes(".test.")) continue;
      found.push(
        join(entry.parentPath, name)
          .slice(ROOT.length + 1)
          .replaceAll("\\", "/"),
      );
    }
  }
  return found.sort();
}

const READS_PET_EVENTS = /\.from\(petEvents\)|FROM public\.pet_events|FROM pet_events/;
const CAN_CARRY_TRAVEL =
  /movement_recorded|transport_recorded|cvi_issued|event_amended|eq\(petEvents\.id, eventId\)/;
const CALL = "notTravelPrivateClause()";

function read(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

describe("travel-private read coverage", () => {
  const files = sourceFiles();

  it("scans a real source tree", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("every MUST_HIDE read carries the shared clause, imported from its one home", () => {
    const missing = MUST_HIDE.filter((f) => {
      const src = read(f);
      return !src.includes(CALL) || !src.includes('from "@/lib/infra/travel-private-events"');
    });
    expect(missing).toEqual([]);
  });

  it("the correction writer refuses a travel target on its own", () => {
    const src = read("src/modules/events/application/amendment/amend-event.ts");
    expect(src).toContain("holdsPetAsTravelTitular(");
    expect(src).toContain('code: "travel_private_target"');
  });

  it("the travel PDF refuses a caretaker in its ownership join", () => {
    const src = read("src/modules/pets/application/travel-export/generate-travel-export.ts");
    expect(src).toContain('ne(ownerships.role, "caretaker")');
  });

  it("a correction may not change a movement's sub_kind — the clause reads it raw", () => {
    const src = read("src/modules/events/application/amendment/amend-event.ts");
    expect(src).toMatch(/movement_recorded: \["sub_kind"\]/);
    expect(src).toContain('code: "discriminator_locked"');
  });

  it("every entry exists and really queries pet_events", () => {
    const stale = ALL_LISTS.filter((f) => !files.includes(f) || !READS_PET_EVENTS.test(read(f)));
    expect(stale).toEqual([]);
  });

  it("no file sits in two lists", () => {
    const twice = ALL_LISTS.filter((f, i) => ALL_LISTS.indexOf(f) !== i);
    expect(twice).toEqual([]);
  });

  it("NO read that can carry a travel row is outside the lists", () => {
    const unaccounted = files.filter((f) => {
      if (ALL_LISTS.includes(f)) return false;
      const src = read(f);
      if (!READS_PET_EVENTS.test(src)) return false;
      if (!CAN_CARRY_TRAVEL.test(src)) return false;
      // A file that carries the clause is accounted for by definition.
      return !src.includes(CALL);
    });
    expect(unaccounted).toEqual([]);
  });

  it("no module keeps a private copy of the travel predicate", () => {
    const copies = files.filter(
      (f) => f !== CLAUSE_MODULE && /IN \('transport_recorded', 'cvi_issued'\)/.test(read(f)),
    );
    expect(copies).toEqual([]);
  });

  it("the SQL clause names exactly the exported travel sub-kinds", () => {
    const src = read(CLAUSE_MODULE);
    const inList = `IN (${TRAVEL_PRIVATE_SUB_KINDS.map((k) => `'${k}'`).join(", ")})`;
    // Twice: the root row, and the target of a correction.
    expect(src.split(inList).length - 1).toBe(2);
  });

  it("every movement sub-kind is triaged — a new one must be classified", () => {
    // The schema's discriminated union is the list of sub-kinds that can be
    // written. Each is either travel-private or the one public move.
    const schema = read("lib/events/event-schemas.ts");
    const subKinds = [...schema.matchAll(/sub_kind: z\.literal\("([a-z_]+)"\)/g)].map((m) => m[1]);
    expect(subKinds.length).toBeGreaterThan(0);
    const untriaged = subKinds.filter(
      (k) =>
        k !== "jurisdiction_changed" &&
        !(TRAVEL_PRIVATE_SUB_KINDS as readonly string[]).includes(k),
    );
    expect(untriaged).toEqual([]);
  });
});
