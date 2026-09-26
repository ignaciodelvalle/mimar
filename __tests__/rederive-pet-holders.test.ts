// Drift detection for the owner / co_owner / shelter_custody / foster rows of
// `ownerships` (audit K3/W8) — the full replay in lib/projections/pet-holders.ts
// compared by rederivePetHolderOwnerships.
//
// Every fixture writes a spine and the rows the real writers put beside it, in
// a transaction that is ROLLED BACK (pet_events is append-only; a rollback is
// not a delete, so nothing is left behind). Two layers per transition:
//   1. the correct history reports NO mismatch;
//   2. non-vacuity — the same history with one planted defect reports exactly
//      that defect, with the right kind. A detector that always answered
//      "clean" passes layer 1 and fails every case of layer 2.
//
// Timestamps are fixed literals on both sides (started_at, occurred_at,
// recorded_at), never a host clock against a defaultNow() column.

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petEvents, pets } from "@/db";
import {
  type HolderMismatchKind,
  compareHolderIntervals,
  rederivePetHolderOwnerships,
} from "@/lib/infra/rederive-pet-ownerships";

class Rollback extends Error {}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Role = "owner" | "co_owner" | "shelter_custody" | "foster";
type Subject = { user: string } | { org: string };

const T0 = new Date("2026-03-01T10:00:00.000Z");
const T1 = new Date("2026-04-01T10:00:00.000Z");
const T2 = new Date("2026-05-01T10:00:00.000Z");
const T3 = new Date("2026-06-01T10:00:00.000Z");

let U1: string;
let U2: string;
let U3: string;
let ORG_A: string;
let ORG_B: string;

beforeAll(async () => {
  const users = (await db.execute(
    sql`select id::text as id from profiles order by id limit 3`,
  )) as unknown as Array<{ id: string }>;
  const orgs = (await db.execute(
    sql`select id::text as id from organizations order by id limit 2`,
  )) as unknown as Array<{ id: string }>;
  // Non-vacuity of the fixtures themselves: three distinct people, two orgs.
  expect(users).toHaveLength(3);
  expect(orgs).toHaveLength(2);
  [U1, U2, U3] = users.map((u) => u.id);
  [ORG_A, ORG_B] = orgs.map((o) => o.id);
});

class Fixture {
  constructor(
    readonly tx: Tx,
    readonly petId: string,
  ) {}

  async event(
    eventType: string,
    at: Date,
    payload: Record<string, unknown>,
    author: { user?: string; org?: string; role?: "owner" | "shelter" | "govt" } = {},
  ): Promise<string> {
    const [row] = await this.tx
      .insert(petEvents)
      .values({
        petId: this.petId,
        eventType,
        occurredAt: at,
        recordedAt: at,
        recordedByUserId: author.user ?? null,
        authorOrganizationId: author.org ?? null,
        authorRole: author.role ?? (author.org ? "shelter" : "owner"),
        payload,
      })
      .returning({ id: petEvents.id });
    return row.id;
  }

  async row(role: Role, subject: Subject, startedAt: Date, endedAt: Date | null = null) {
    const [row] = await this.tx
      .insert(ownerships)
      .values({
        petId: this.petId,
        role,
        ownerUserId: "user" in subject ? subject.user : null,
        ownerOrganizationId: "org" in subject ? subject.org : null,
        startedAt,
        endedAt,
      })
      .returning({ id: ownerships.id });
    return row.id;
  }

  async kinds(): Promise<HolderMismatchKind[]> {
    const report = await rederivePetHolderOwnerships(this.petId, this.tx as unknown as typeof db);
    return report.mismatches.map((m) => m.kind).sort();
  }
}

/** Builds a pet, runs `fn`, and always rolls the whole thing back. */
async function scenario(
  fn: (f: Fixture) => Promise<void>,
  opts: { seedTag?: string } = {},
): Promise<void> {
  await expect(
    db.transaction(async (tx) => {
      const token = `HLD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const [pet] = await tx
        .insert(pets)
        .values({
          publicToken: token,
          name: "Deriva",
          species: "dog",
          seedTag: opts.seedTag ?? null,
        })
        .returning({ id: pets.id });
      await fn(new Fixture(tx, pet.id));
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

const registered = (kind: string) => ({ custody_kind: kind });
const transfer = (p: Record<string, unknown>) => ({
  from_user_id: null,
  from_organization_id: null,
  to_user_id: null,
  to_organization_id: null,
  foster_ended_event_id: null,
  notes: null,
  ...p,
});

/** Owner registration followed by a person-to-person sale. */
async function p2pHistory(f: Fixture) {
  await f.event("pet_registered", T0, registered("owner"), { user: U1 });
  await f.event(
    "custody_transferred",
    T1,
    transfer({ from_user_id: U1, to_user_id: U2, from_role: "owner", to_role: "owner" }),
    { user: U2 },
  );
}

/** Org intake → foster → foster ends → adoption. */
async function adoptionHistory(f: Fixture) {
  await f.event("pet_registered", T0, registered("shelter_custody_by_org"), {
    user: U3,
    org: ORG_A,
  });
  await f.event(
    "shelter_intake_recorded",
    T0,
    { intake_reason: "rescue" },
    { user: U3, org: ORG_A },
  );
  await f.event("foster_assigned", T1, { foster_user_id: U2 }, { user: U3, org: ORG_A });
  await f.event("foster_ended", T2, { foster_user_id: U2, reason: "returned" }, { org: ORG_A });
  return f.event(
    "adoption_finalized",
    T3,
    { previous_owner_organization_id: ORG_A, adopter_user_id: U1, foster_user_id: null },
    { user: U3, org: ORG_A },
  );
}

describe("rederivePetHolderOwnerships — owner transitions", () => {
  it("a P2P transfer with both rows correct is clean", async () => {
    await scenario(async (f) => {
      await p2pHistory(f);
      await f.row("owner", { user: U1 }, T0, T1);
      await f.row("owner", { user: U2 }, T1);
      expect(await f.kinds()).toEqual([]);
    });
  });

  it("reports the previous owner's wrong ended_at", async () => {
    await scenario(async (f) => {
      await p2pHistory(f);
      await f.row("owner", { user: U1 }, T0, T2);
      await f.row("owner", { user: U2 }, T1);
      expect(await f.kinds()).toEqual(["wrong_ended_at"]);
    });
  });

  it("reports a missing row for the new owner", async () => {
    await scenario(async (f) => {
      await p2pHistory(f);
      await f.row("owner", { user: U1 }, T0, T1);
      expect(await f.kinds()).toEqual(["missing_row"]);
    });
  });

  it("reports a live row nothing on the spine opened", async () => {
    await scenario(async (f) => {
      await p2pHistory(f);
      await f.row("owner", { user: U1 }, T0, T1);
      await f.row("owner", { user: U2 }, T1);
      await f.row("co_owner", { user: U3 }, T2);
      expect(await f.kinds()).toEqual(["extra_active_row"]);
    });
  });

  it("reports a row with the wrong role", async () => {
    await scenario(async (f) => {
      await f.event("pet_registered", T0, registered("shelter_custody_by_citizen"), { user: U1 });
      await f.row("owner", { user: U1 }, T0);
      expect(await f.kinds()).toEqual(["wrong_role"]);
    });
  });

  it("a free claim is clean", async () => {
    await scenario(async (f) => {
      await f.event("ownership_claimed", T1, { claimed_by_user_id: U2 }, { user: U2 });
      await f.row("owner", { user: U2 }, T1);
      expect(await f.kinds()).toEqual([]);
    });
  });

  it("a dispute resolution closes every holder and opens the new one", async () => {
    await scenario(async (f) => {
      await f.event("pet_registered", T0, registered("owner"), { user: U1 });
      await f.event("foster_assigned", T1, { foster_user_id: U3 }, { user: U1 });
      // resolve-dispute.ts: foster_ended and a reason-less, govt-signed
      // custody_transferred share one instant; the resolution itself comes a
      // moment later with its own `now`.
      const govt = { user: U3, role: "govt" as const };
      await f.event(
        "custody_transferred",
        T2,
        transfer({ from_user_id: U1, to_user_id: U2, from_role: "owner", to_role: "owner" }),
        govt,
      );
      await f.event("foster_ended", T2, { foster_user_id: U3, reason: "other" }, govt);
      await f.event(
        "custody_dispute_resolved",
        new Date(T2.getTime() + 40),
        { outcome: "ownership_transferred" },
        govt,
      );
      await f.row("owner", { user: U1 }, T0, T2);
      await f.row("foster", { user: U3 }, T1, T2);
      await f.row("owner", { user: U2 }, T2);
      expect(await f.kinds()).toEqual([]);
    });
  });
});

describe("rederivePetHolderOwnerships — shelter custody, foster and adoption", () => {
  it("intake → foster → adoption with correct rows is clean", async () => {
    await scenario(async (f) => {
      await adoptionHistory(f);
      await f.row("shelter_custody", { org: ORG_A }, T0, T3);
      await f.row("foster", { user: U2 }, T1, T2);
      await f.row("owner", { user: U1 }, T3);
      expect(await f.kinds()).toEqual([]);
    });
  });

  it("reports a foster row left open after foster_ended", async () => {
    await scenario(async (f) => {
      await adoptionHistory(f);
      await f.row("shelter_custody", { org: ORG_A }, T0, T3);
      await f.row("foster", { user: U2 }, T1);
      await f.row("owner", { user: U1 }, T3);
      expect(await f.kinds()).toEqual(["wrong_ended_at"]);
    });
  });

  it("reports org custody still live after the adoption", async () => {
    await scenario(async (f) => {
      await adoptionHistory(f);
      await f.row("shelter_custody", { org: ORG_A }, T0);
      await f.row("foster", { user: U2 }, T1, T2);
      await f.row("owner", { user: U1 }, T3);
      expect(await f.kinds()).toEqual(["wrong_ended_at"]);
    });
  });

  it("an adoption reversal reopens org custody and ends the adopter", async () => {
    await scenario(async (f) => {
      const finalizeId = await adoptionHistory(f);
      const T4 = new Date("2026-07-01T10:00:00.000Z");
      await f.event(
        "adoption_reversed",
        T4,
        { actor: "shelter", reason: null, reverted_finalization_event_id: finalizeId },
        { user: U3, org: ORG_A },
      );
      await f.row("shelter_custody", { org: ORG_A }, T0, T3);
      await f.row("foster", { user: U2 }, T1, T2);
      await f.row("owner", { user: U1 }, T3, T4);
      await f.row("shelter_custody", { org: ORG_A }, T4);
      expect(await f.kinds()).toEqual([]);
    });
  });

  it("a foster converting to owner closes every holder", async () => {
    await scenario(async (f) => {
      await f.event("pet_registered", T0, registered("owner"), { user: U1 });
      await f.event("foster_assigned", T1, { foster_user_id: U2 }, { user: U1 });
      const endedId = await f.event("foster_ended", T2, { foster_user_id: U2, reason: "adoption" });
      await f.event(
        "custody_transferred",
        T2,
        transfer({
          from_user_id: U2,
          to_user_id: U2,
          from_role: "owner",
          to_role: "owner",
          foster_ended_event_id: endedId,
        }),
        { user: U2 },
      );
      await f.row("owner", { user: U1 }, T0, T2);
      await f.row("foster", { user: U2 }, T1, T2);
      await f.row("owner", { user: U2 }, T2);
      expect(await f.kinds()).toEqual([]);
    });
  });

  it("a finder's custody and the return to the owner are clean", async () => {
    await scenario(async (f) => {
      await f.event("pet_registered", T0, registered("owner"), { user: U1 });
      await f.event("shelter_intake_recorded", T1, { intake_reason: "stray_found" }, { user: U2 });
      await f.event(
        "custody_transferred",
        T2,
        transfer({
          from_user_id: U2,
          to_user_id: U1,
          from_role: "shelter_custody",
          to_role: "owner",
          reason: "return_to_original_owner",
        }),
        { user: U1 },
      );
      await f.row("owner", { user: U1 }, T0);
      await f.row("shelter_custody", { user: U2 }, T1, T2);
      expect(await f.kinds()).toEqual([]);
    });
  });

  it("a rehome sponsorship is keyed by its ownership_id", async () => {
    await scenario(async (f) => {
      await f.event("pet_registered", T0, registered("owner"), { user: U1 });
      const custodyId = await f.row("shelter_custody", { org: ORG_A }, T1, T2);
      await f.row("owner", { user: U1 }, T0);
      await f.event(
        "rehome_sponsorship_started",
        T1,
        { ownership_id: custodyId, sponsoring_organization_id: ORG_A },
        { org: ORG_A },
      );
      await f.event(
        "rehome_sponsorship_ended",
        T2,
        { ownership_id: custodyId, outcome: "withdrawn_by_titular" },
        { user: U1 },
      );
      expect(await f.kinds()).toEqual([]);
    });
  });
});

describe("rederivePetHolderOwnerships — decomiso", () => {
  async function seizure(f: Fixture) {
    await f.event("pet_registered", T0, registered("owner"), { user: U1 });
    await f.event(
      "shelter_intake_recorded",
      T1,
      { intake_reason: "seizure", intended_receiver_organization_id: ORG_B },
      { user: U3, org: ORG_A },
    );
  }

  it("seizure then hand-off to the receiver org is clean", async () => {
    await scenario(async (f) => {
      await seizure(f);
      await f.event(
        "custody_transferred",
        T2,
        transfer({
          from_organization_id: ORG_A,
          to_organization_id: ORG_B,
          from_role: "shelter_custody",
          to_role: "shelter_custody",
          reason: "org_to_org_handoff",
        }),
        { org: ORG_B },
      );
      await f.row("owner", { user: U1 }, T0, T1);
      await f.row("shelter_custody", { org: ORG_A }, T1, T2);
      await f.row("shelter_custody", { org: ORG_B }, T2);
      expect(await f.kinds()).toEqual([]);
    });
  });

  it("the return to the owner reactivates the owner's own row", async () => {
    await scenario(async (f) => {
      await seizure(f);
      await f.event(
        "custody_transferred",
        T2,
        transfer({
          from_organization_id: ORG_A,
          to_user_id: U1,
          from_role: "shelter_custody",
          to_role: "owner",
          reason: "return_to_original_owner",
        }),
        { org: ORG_A },
      );
      // return-custody-to-owner.ts sets ended_at back to NULL on the SAME row.
      await f.row("owner", { user: U1 }, T0);
      await f.row("shelter_custody", { org: ORG_A }, T1, T2);
      expect(await f.kinds()).toEqual([]);
    });
  });

  it("reports an owner row the seizure should have ended", async () => {
    await scenario(async (f) => {
      await seizure(f);
      await f.row("owner", { user: U1 }, T0);
      await f.row("shelter_custody", { org: ORG_A }, T1);
      expect(await f.kinds()).toEqual(["wrong_ended_at"]);
    });
  });
});

describe("rederivePetHolderOwnerships — seed data", () => {
  it("an unexplained row on a seed-tagged pet is seed_unexplained", async () => {
    await scenario(
      async (f) => {
        await f.row("shelter_custody", { org: ORG_A }, T0);
        expect(await f.kinds()).toEqual(["seed_unexplained"]);
      },
      { seedTag: "panorama" },
    );
  });

  it("the same row on an untagged pet is real drift", async () => {
    await scenario(async (f) => {
      await f.row("shelter_custody", { org: ORG_A }, T0);
      expect(await f.kinds()).toEqual(["extra_active_row"]);
    });
  });

  it("a seed tag never hides a missing row or a wrong ended_at", async () => {
    await scenario(
      async (f) => {
        await p2pHistory(f);
        await f.row("owner", { user: U1 }, T0, T2);
        expect(await f.kinds()).toEqual(["missing_row", "wrong_ended_at"]);
      },
      { seedTag: "panorama" },
    );
  });
});

describe("compareHolderIntervals (pure)", () => {
  it("an ended row nothing explains is extra_ended_row", () => {
    const kinds = compareHolderIntervals(
      [],
      [
        {
          id: "00000000-0000-4000-8000-000000000001",
          role: "foster",
          ownerUserId: "00000000-0000-4000-8000-0000000000aa",
          ownerOrganizationId: null,
          startedAt: T0,
          endedAt: T1,
        },
      ],
      { seeded: false },
    ).map((m) => m.kind);
    expect(kinds).toEqual(["extra_ended_row"]);
  });
});
