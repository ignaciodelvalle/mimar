// Offline guard for the spine-integrity fence's exemption rule
// (scripts/check-spine-integrity.ts). The gate itself needs a database; this
// pins the part that decides what gets waved through, which is the part that
// would quietly rot.

import { describe, expect, it } from "vitest";

import {
  EXEMPT_SEED_TAGS,
  type OrphanPetRow,
  partitionOrphans,
} from "@/scripts/check-spine-integrity";

const row = (over: Partial<OrphanPetRow> = {}): OrphanPetRow => ({
  public_token: "DIM-TEST-0001",
  name: "Test Dog",
  seed_tag: null,
  created_at: "2026-07-26T00:00:00Z",
  ...over,
});

describe("partitionOrphans", () => {
  it("blocks an untagged orphan pet", () => {
    const { blocking, exempt } = partitionOrphans([row()]);
    expect(blocking).toHaveLength(1);
    expect(exempt).toHaveLength(0);
  });

  it("exempts a pet tagged 'perf'", () => {
    const { blocking, exempt } = partitionOrphans([row({ seed_tag: "perf" })]);
    expect(blocking).toHaveLength(0);
    expect(exempt).toHaveLength(1);
  });

  it("does NOT exempt on a token prefix — the exemption is the seed_tag alone", () => {
    // The whole point of keying on seed_tag: a token is unowned, any test can
    // mint one. These must all still block.
    const impostors = [
      row({ public_token: "PERF-0001-AAAA" }),
      row({ public_token: "PERF-BULK-0001", name: "perf" }),
      row({ public_token: "DIM-PERF-0001" }),
    ];
    const { blocking, exempt } = partitionOrphans(impostors);
    expect(blocking).toHaveLength(3);
    expect(exempt).toHaveLength(0);
  });

  it("does not exempt other seed tags used by the real seeds", () => {
    // panorama / panorama-hist pets DO go through registerPet, so they should
    // never appear as orphans — and if one ever does, it must fail loudly.
    const { blocking, exempt } = partitionOrphans([
      row({ seed_tag: "panorama" }),
      row({ seed_tag: "panorama-hist" }),
    ]);
    expect(blocking).toHaveLength(2);
    expect(exempt).toHaveLength(0);
  });

  it("treats the seed_tag match as exact, not a substring", () => {
    const { blocking, exempt } = partitionOrphans([
      row({ seed_tag: "perf-2" }),
      row({ seed_tag: "notperf" }),
      row({ seed_tag: "PERF" }),
    ]);
    expect(blocking).toHaveLength(3);
    expect(exempt).toHaveLength(0);
  });

  it("keeps the exemption list deliberately tiny", () => {
    // A tripwire: growing this list is a reviewable decision, not a drive-by.
    expect(EXEMPT_SEED_TAGS).toEqual(["perf"]);
  });

  it("partitions a mixed batch without losing rows", () => {
    const rows = [row(), row({ seed_tag: "perf" }), row({ seed_tag: "panorama" })];
    const { blocking, exempt } = partitionOrphans(rows);
    expect(blocking.length + exempt.length).toBe(rows.length);
    expect(exempt).toHaveLength(1);
  });
});
