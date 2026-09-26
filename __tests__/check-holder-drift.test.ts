// Offline guard for the holder-drift fence (scripts/check-holder-drift.ts).
//
// The fence's DB half is a three-query load; its verdict is the pure
// classifyHolderDrift, pinned here without a database. Non-vacuity: a fence
// that always answered "clean" passes the first case and fails every other.
// The replay and the pairing themselves are pinned against real rows by
// __tests__/rederive-pet-holders.test.ts.

import { describe, expect, it } from "vitest";

import type { StoredHolderRow } from "@/lib/infra/rederive-pet-ownerships";
import type { HolderEvent } from "@/lib/projections/pet-holders";

import { type HolderPet, classifyHolderDrift } from "../scripts/check-holder-drift";

const USER = "00000000-0000-4000-8000-0000000000a1";
const ORG = "00000000-0000-4000-8000-0000000000b1";
const T0 = new Date("2026-03-01T10:00:00.000Z");
const T1 = new Date("2026-04-01T10:00:00.000Z");

let seq = 0;
function registered(at: Date, user = USER): HolderEvent {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    eventType: "pet_registered",
    occurredAt: at,
    recordedAt: at,
    payload: { custody_kind: "owner" },
    recordedByUserId: user,
    authorOrganizationId: null,
  } as HolderEvent;
}

function row(
  role: StoredHolderRow["role"],
  holder: { user?: string; org?: string },
  startedAt: Date,
  endedAt: Date | null = null,
): StoredHolderRow {
  seq++;
  return {
    id: `00000000-0000-4000-9000-${String(seq).padStart(12, "0")}`,
    role,
    ownerUserId: holder.user ?? null,
    ownerOrganizationId: holder.org ?? null,
    startedAt,
    endedAt,
  };
}

function pet(id: string, seedTag: string | null = null): HolderPet {
  return { id, publicToken: `TOK-${id}`, seedTag };
}

describe("classifyHolderDrift", () => {
  it("passes a pet whose owner row matches its registration", () => {
    const result = classifyHolderDrift(
      [pet("p1")],
      new Map([["p1", [registered(T0)]]]),
      new Map([["p1", [row("owner", { user: USER }, T0)]]]),
    );
    expect(result).toEqual({
      scanned: 1,
      blocking: [],
      seedUnexplainedPets: 0,
      seedUnexplainedRows: 0,
    });
  });

  it("fails a row the spine does not explain on a real pet", () => {
    const result = classifyHolderDrift(
      [pet("p1")],
      new Map([["p1", [registered(T0)]]]),
      new Map([
        ["p1", [row("owner", { user: USER }, T0), row("shelter_custody", { org: ORG }, T1)]],
      ]),
    );
    expect(result.blocking).toHaveLength(1);
    expect(result.blocking[0].mismatches.map((m) => m.kind)).toEqual(["extra_active_row"]);
  });

  it("fails an interval with no row (missing_row), and a row started at the wrong time", () => {
    const missing = classifyHolderDrift(
      [pet("p1")],
      new Map([["p1", [registered(T0)]]]),
      new Map(),
    );
    expect(missing.blocking[0].mismatches.map((m) => m.kind)).toEqual(["missing_row"]);

    const late = classifyHolderDrift(
      [pet("p2")],
      new Map([["p2", [registered(T0)]]]),
      new Map([["p2", [row("owner", { user: USER }, T1)]]]),
    );
    expect(late.blocking[0].mismatches.map((m) => m.kind)).toEqual(["wrong_started_at"]);
  });

  it("pairs two same-instant intervals of one holder by their ends, whatever the row order", () => {
    // pet_registered and adoption_finalized in one instant: the registration's
    // owner interval is closed at once and the adopter's opened. Rows come
    // back in random id order within a tie; both orders must be clean.
    seq++;
    const adoption = {
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      eventType: "adoption_finalized",
      occurredAt: T0,
      recordedAt: T1,
      payload: { adopter_user_id: USER },
      recordedByUserId: USER,
      authorOrganizationId: ORG,
    } as HolderEvent;
    const events = [registered(T0), adoption];
    const ended = row("owner", { user: USER }, T0, T0);
    const live = row("owner", { user: USER }, T0);
    for (const rows of [
      [ended, live],
      [live, ended],
    ]) {
      const result = classifyHolderDrift(
        [pet("p1")],
        new Map([["p1", events]]),
        new Map([["p1", rows]]),
      );
      expect(result.blocking).toEqual([]);
    }
  });

  it("tolerates an unexplained row on a seed-tagged pet, and counts it", () => {
    const result = classifyHolderDrift(
      [pet("p1", "panorama")],
      new Map([["p1", [registered(T0)]]]),
      new Map([
        ["p1", [row("owner", { user: USER }, T0), row("shelter_custody", { org: ORG }, T1)]],
      ]),
    );
    expect(result.blocking).toEqual([]);
    expect(result.seedUnexplainedPets).toBe(1);
    expect(result.seedUnexplainedRows).toBe(1);
  });

  it("still fails a seed-tagged pet whose events and rows contradict each other", () => {
    // The re-pointed shape the panorama seed used to write: the registration
    // opens owner(user), the only row is shelter_custody(org).
    const result = classifyHolderDrift(
      [pet("p1", "panorama")],
      new Map([["p1", [registered(T0)]]]),
      new Map([["p1", [row("shelter_custody", { org: ORG }, T0)]]]),
    );
    expect(result.blocking).toHaveLength(1);
    const kinds = result.blocking[0].mismatches.map((m) => m.kind);
    expect(kinds).toEqual(["missing_row"]);
    expect(result.seedUnexplainedRows).toBe(1);
  });
});
