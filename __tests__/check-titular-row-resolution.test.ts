// The titular-row fence, tested against the SEVEN SHAPES IT WAS BORN FOR.
//
// The fence is green on the tree it shipped with, because the two commits
// before it fixed all seven sites. Green on a clean tree proves nothing about a
// scanner — so every RED case below is a real query as it read BEFORE its fix,
// copied from the diff, and the fence has to reject each one. The GREEN cases
// are the shapes that are legitimately single-row and must never be flagged, or
// the fence becomes noise somebody silences.

import { describe, expect, it } from "vitest";

import { findOffenders, ownershipQuerySites } from "@/scripts/check-titular-row-resolution";

function offenders(source: string): string[] {
  return findOffenders(ownershipQuerySites("fixture.ts", source));
}

describe("titular-row fence — the shapes that shipped broken", () => {
  // cad8b854d. The public credential published the CARETAKER's phone number on
  // a lost pet's page.
  it("flags a bare limit(1) resolving the owner user id", () => {
    expect(
      offenders(`
        const [owner] = await db
          .select({ userId: ownerships.ownerUserId })
          .from(ownerships)
          .where(and(eq(ownerships.petId, pet.id), isNull(ownerships.endedAt)))
          .limit(1);
      `),
    ).toHaveLength(1);
  });

  // afd01fb3c, the printable lost poster: a caretaker's name and phone on a
  // flyer stapled to a lamppost. No `.limit(1)` — the array destructure IS the
  // limit, which is how three of the seven read.
  it("flags an array destructure with no limit(1)", () => {
    expect(
      offenders(`
        const [holder] = await db
          .select({ userId: ownerships.ownerUserId })
          .from(ownerships)
          .innerJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
          .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));
      `),
    ).toHaveLength(1);
  });

  // The seventh site (setPetFoundAction) — the one the previous sweep declared
  // the corpus bounded without having seen.
  it("flags the seventh site's shape", () => {
    expect(
      offenders(`
        const [ownerRow] = await db
          .select({ ownerUserId: ownerships.ownerUserId })
          .from(ownerships)
          .where(and(eq(ownerships.petId, pet.id), isNull(ownerships.endedAt)))
          .limit(1);
        const ownerUserId = ownerRow?.ownerUserId ?? user.id;
      `),
    ).toHaveLength(1);
  });

  // The eighth, whatever it turns out to be. A fence that only knows the seven
  // is the thing this repo has a written lesson against.
  it("flags a shape nobody has written yet", () => {
    expect(
      offenders(`
        const [current] = await tx
          .select({ role: ownerships.role, userId: ownerships.ownerUserId })
          .from(ownerships)
          .where(and(isNull(ownerships.endedAt), eq(ownerships.petId, id)))
          .limit(1);
      `),
    ).toHaveLength(1);
  });
});

describe("titular-row fence — the shapes that must stay quiet", () => {
  it("accepts a role-filtered read", () => {
    expect(
      offenders(`
        const [owner] = await db
          .select({ userId: ownerships.ownerUserId })
          .from(ownerships)
          .where(and(
            eq(ownerships.petId, pet.id),
            eq(ownerships.role, "owner"),
            isNull(ownerships.endedAt),
          ))
          .orderBy(asc(ownerships.startedAt))
          .limit(1);
      `),
    ).toEqual([]);
  });

  it("accepts a caller-scoped read", () => {
    expect(
      offenders(`
        const [mine] = await db
          .select({ role: ownerships.role })
          .from(ownerships)
          .where(and(
            eq(ownerships.petId, pet.id),
            eq(ownerships.ownerUserId, user.id),
            isNull(ownerships.endedAt),
          ))
          .limit(1);
      `),
    ).toEqual([]);
  });

  it("accepts an org-scoped read", () => {
    expect(
      offenders(`
        const [row] = await db
          .select({ id: ownerships.id, role: ownerships.role })
          .from(ownerships)
          .where(and(
            eq(ownerships.petId, pet.id),
            eq(ownerships.ownerOrganizationId, orgId),
            isNull(ownerships.endedAt),
          ))
          .limit(1);
      `),
    ).toEqual([]);
  });

  it("accepts a read keyed on the ownership row's own id", () => {
    expect(
      offenders(`
        const [row] = await db
          .select({ userId: ownerships.ownerUserId })
          .from(ownerships)
          .where(and(eq(ownerships.id, ownershipId), isNull(ownerships.endedAt)))
          .limit(1);
      `),
    ).toEqual([]);
  });

  // The free-claim guard. It MUST stay role-blind: a pet is claimable only when
  // it has no active custody of ANY role, so narrowing it to `owner` would make
  // a refugio's foster-held animal directly claimable by a stranger.
  it("accepts an existence probe that projects only the row id", () => {
    expect(
      offenders(`
        const [activeCustody] = await tx
          .select({ id: ownerships.id })
          .from(ownerships)
          .where(and(eq(ownerships.petId, pet.id), isNull(ownerships.endedAt)))
          .limit(1);
        if (activeCustody) throw new FreeClaimGuardError("ya tiene custodia");
      `),
    ).toEqual([]);
  });

  // Reading every holder and deciding in JS is what RANKING is — the remedy
  // lib/infra/pet-alert-recipients.ts argues for, and the one a role filter
  // would break for a pet in shelter custody.
  it("accepts a read of all active holders", () => {
    expect(
      offenders(`
        const activeHolders = await db
          .select({ userId: ownerships.ownerUserId, role: ownerships.role })
          .from(ownerships)
          .where(and(
            eq(ownerships.petId, petId),
            isNull(ownerships.endedAt),
            isNotNull(ownerships.ownerUserId),
          ))
          .orderBy(asc(ownerships.startedAt), asc(ownerships.id));
      `),
    ).toEqual([]);
  });

  it("accepts a count", () => {
    expect(
      offenders(`
        const [row] = await db
          .select({ n: count() })
          .from(ownerships)
          .where(and(eq(ownerships.petId, pet.id), isNull(ownerships.endedAt)))
          .limit(1);
      `),
    ).toEqual([]);
  });

  // A query that does not filter on ended_at is not the subject: it is reading
  // history, where more than one row is the point.
  it("ignores a read that does not filter on ended_at", () => {
    expect(
      offenders(`
        const [first] = await db
          .select({ userId: ownerships.ownerUserId })
          .from(ownerships)
          .where(eq(ownerships.petId, pet.id))
          .orderBy(asc(ownerships.startedAt))
          .limit(1);
      `),
    ).toEqual([]);
  });
});

describe("titular-row fence — the slicer", () => {
  // The boundary walk has been wrong twice, in both directions, and each time
  // it produced a plausible-looking verdict: once it sliced the `.select({…})`
  // projection off (every existence probe read as unprojected), once it walked
  // back past whole `if (…) { … }` blocks and dragged an unrelated
  // `const [x] = …limit(1)` into a query that reads ALL rows.
  it("keeps the projection and stops at the previous block", () => {
    const source = `
      if (input.orgId) {
        const [targetOrg] = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, input.orgId))
          .limit(1);
        if (!targetOrg) throw new Error("no existe");
      }

      const activeRows = await tx
        .select({ id: ownerships.id, role: ownerships.role })
        .from(ownerships)
        .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));
    `;
    const [site] = ownershipQuerySites("fixture.ts", source);

    expect(site.text).toContain(".select({ id: ownerships.id, role: ownerships.role })");
    expect(site.text).not.toContain("targetOrg");
    expect(findOffenders([site])).toEqual([]);
  });
});
