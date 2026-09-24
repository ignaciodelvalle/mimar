// `listFosterHubForVolunteer` — shaping the repository's rows into the DTO.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. `expired` IS COMPUTED FROM THE INJECTED CLOCK, not from the real one,
//      so the boundary is testable rather than racy.
//   2. `expired` DOES NOT GATE ANYTHING — see `my-foster.ts`'s header — this
//      file only proves the flag itself is right; the route's refusal table
//      proves accept still runs past it.
//   3. `active` IS `endedAt === null`, nothing else.
//   4. THE REPOSITORY'S ROWS PASS THROUGH VERBATIM where the DTO has no
//      opinion of its own (pet identity, org name, durations).
//
// The fake repo returns objects narrower than the real Drizzle row types
// (`ProposalRow`, `PetRow`) and is cast at the boundary — the same move
// `accept-foster-proposal.test.ts`'s `makeFakeRepo` makes for the same
// reason: this use-case reads a handful of fields from each, and a literal
// `pets.$inferSelect` here would test nothing extra while dragging every
// column into every test case.

import { describe, expect, it, vi } from "vitest";

import type { FosterRepository } from "../infrastructure/foster-repository";

import { listFosterHubForVolunteer } from "./list-foster-hub-for-volunteer";

const PET = { id: "pet-1", publicToken: "DIM-PAMP-0001", name: "Pampa", species: "dog" };

function proposalRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    proposal: {
      publicToken: "FP-1",
      proposedDurationWeeks: 3,
      proposedNotes: "Le gustan los paseos largos.",
      proposedAt: new Date("2026-09-01T00:00:00.000Z"),
      expiresAt: new Date("2026-09-08T00:00:00.000Z"),
      ...over,
    },
    pet: PET,
    organizationName: "Refugio Esperanza",
  };
}

function fosterRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    ownership: {
      id: "own-1",
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      endedAt: null as Date | null,
      ...over,
    },
    pet: PET,
    organizationName: "Refugio Esperanza" as string | null,
    proposedDurationWeeks: 4,
  };
}

function makeRepo(hub: {
  proposals?: ReturnType<typeof proposalRow>[];
  fosters?: ReturnType<typeof fosterRow>[];
}): Pick<typeof FosterRepository, "listHubRowsForVolunteer"> {
  const fn = vi.fn().mockResolvedValue({
    proposals: hub.proposals ?? [],
    fosters: hub.fosters ?? [],
  });
  return { listHubRowsForVolunteer: fn } as unknown as Pick<
    typeof FosterRepository,
    "listHubRowsForVolunteer"
  >;
}

describe("proposals", () => {
  it("marks a proposal expired when the clock is past expiresAt", async () => {
    const result = await listFosterHubForVolunteer(
      { userId: "u1" },
      {
        repo: makeRepo({ proposals: [proposalRow()] }),
        now: () => new Date("2026-09-09T00:00:00.000Z"),
      },
    );
    expect(result.proposals[0]?.expired).toBe(true);
  });

  it("marks a proposal not expired one instant before its boundary", async () => {
    const result = await listFosterHubForVolunteer(
      { userId: "u1" },
      {
        repo: makeRepo({ proposals: [proposalRow()] }),
        now: () => new Date("2026-09-07T23:59:59.999Z"),
      },
    );
    expect(result.proposals[0]?.expired).toBe(false);
  });

  it("treats the exact boundary as expired — mirrors MyCaretakerGrantV1.expired", async () => {
    const result = await listFosterHubForVolunteer(
      { userId: "u1" },
      {
        repo: makeRepo({ proposals: [proposalRow()] }),
        now: () => new Date("2026-09-08T00:00:00.000Z"),
      },
    );
    expect(result.proposals[0]?.expired).toBe(true);
  });

  it("passes the pet, org and proposal fields through unchanged", async () => {
    const result = await listFosterHubForVolunteer(
      { userId: "u1" },
      {
        repo: makeRepo({ proposals: [proposalRow()] }),
        now: () => new Date("2026-09-01T00:00:00.000Z"),
      },
    );
    expect(result.proposals[0]).toMatchObject({
      proposalToken: "FP-1",
      pet: { publicToken: "DIM-PAMP-0001", name: "Pampa", species: "dog" },
      organizationName: "Refugio Esperanza",
      proposedDurationWeeks: 3,
      proposedNotes: "Le gustan los paseos largos.",
    });
  });
});

describe("fosters", () => {
  it("is active when endedAt is null", async () => {
    const result = await listFosterHubForVolunteer(
      { userId: "u1" },
      { repo: makeRepo({ fosters: [fosterRow()] }) },
    );
    expect(result.fosters[0]).toMatchObject({ active: true, endedAt: null });
  });

  it("is not active once endedAt is set, and carries the end date through", async () => {
    const endedAt = new Date("2026-09-10T12:00:00.000Z");
    const result = await listFosterHubForVolunteer(
      { userId: "u1" },
      { repo: makeRepo({ fosters: [fosterRow({ endedAt })] }) },
    );
    expect(result.fosters[0]).toMatchObject({ active: false, endedAt });
  });

  it("carries a null org name through when the custody lookup found none", async () => {
    const result = await listFosterHubForVolunteer(
      { userId: "u1" },
      { repo: makeRepo({ fosters: [{ ...fosterRow(), organizationName: null }] }) },
    );
    expect(result.fosters[0]?.organizationName).toBeNull();
  });
});

it("asks the repository with the caller's own userId", async () => {
  const fn = vi.fn().mockResolvedValue({ proposals: [], fosters: [] });
  const repo = { listHubRowsForVolunteer: fn } as unknown as Pick<
    typeof FosterRepository,
    "listHubRowsForVolunteer"
  >;
  await listFosterHubForVolunteer({ userId: "u42" }, { repo });
  expect(fn).toHaveBeenCalledWith("u42");
});
