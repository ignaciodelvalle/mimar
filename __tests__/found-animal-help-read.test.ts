// P4 — the finder's plan-B read (migration 0292; design note
// docs/superpowers/specs/2026-10-p4-receptoras-cercanas.md §4).
//
// WHAT THIS DEFENDS
// -----------------
//   - the projection: a card carries EXACTLY the public-safe keys, and none of
//     an org's private fields (legal name, account e-mail / phone, coordinates)
//     reaches the result in any form;
//   - who is listed: an org that did not opt in, is not verified, is suspended,
//     or is of a type that may not receive, never appears — decided in SQL;
//   - nearest first, within the radius;
//   - the vets are the public directory's opted-in clinics, and only when asked;
//   - the finder's place is coarsened and NOTHING is written: the whole lookup
//     runs inside a READ ONLY transaction, which would refuse any write, and
//     that transaction never gets an id;
//   - the empty state walks the jurisdiction cascade.
//
// The fixtures sit in the Patagonian steppe, far from every seeded org, so
// rows other files write elsewhere cannot enter these lists.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/db";
import { findNearbyHelp } from "@/src/modules/organizations/application/find-nearby-help";
import {
  NEARBY_ORG_CARD_KEYS,
  type NearbyHelp,
  type NearbyOrgCard,
} from "@/src/modules/organizations/domain/nearby-help";
import { readHelpPlaceNear } from "@/src/modules/organizations/infrastructure/found-animal-help-read";

import {
  type FoundAnimalFixtures,
  makeOrg,
  makeProfile,
  newFoundAnimalFixtures,
  setIntake,
  teardownFoundAnimalFixtures,
} from "./_helpers/found-animal-fixtures";

const fx: FoundAnimalFixtures = newFoundAnimalFixtures();

// The finder's hand-placed point, deliberately OFF the 0.01° grid so a leak of
// the raw value is recognisable in the output.
const FINDER = { lat: -45.50347, lng: -69.50891 };
// Far from every fixture above (~400 km south): nobody receives there.
const EMPTY_PLACE = { lat: -49.3, lng: -70.1 };

let actor = "";
const names: Record<string, string> = {};

async function org(label: string, spec: Parameters<typeof makeOrg>[1], intake?: boolean) {
  const id = await makeOrg(fx, spec);
  names[label] = `Receptora ${spec.label} ${fx.suffix}`;
  if (intake !== false)
    await setIntake(id, actor, {
      publicContactKind: "whatsapp",
      publicContactValue: "+54 9 2945 55-0001",
      publicHours: "Lunes a viernes de 9 a 13",
    });
  return id;
}

beforeAll(async () => {
  actor = await makeProfile(fx, "admin");
  // ~1.1 km and ~5.6 km north of the finder (on the grid): nearest first.
  await org("near", {
    label: "NEAR",
    orgType: "rescue_network",
    at: { lat: -45.493, lng: -69.509 },
    locality: "Paraje Uno",
  });
  await org("mid", {
    label: "MID",
    orgType: "shelter",
    at: { lat: -45.453, lng: -69.509 },
    locality: "Paraje Dos",
  });
  // Each of these says "accepting" (or is a listed clinic) and must NOT appear.
  await org("unverified", { label: "UNVER", verified: false, at: { lat: -45.5, lng: -69.5 } });
  await org("suspended", { label: "SUSP", status: "suspended", at: { lat: -45.5, lng: -69.5 } });
  await org("other", { label: "OTHER", orgType: "other", at: { lat: -45.5, lng: -69.5 } });
  await org("far", { label: "FAR", at: { lat: -46.6, lng: -69.5 } });
  const optedOut = await org("optedOut", { label: "OUT", at: { lat: -45.5, lng: -69.5 } }, false);
  await setIntake(optedOut, actor, { accepting: false });
  // Vets: an opted-in clinic is listed; a clinic that did not opt into the
  // directory is not, even right next to the finder.
  await org(
    "vet",
    {
      label: "VET",
      orgType: "clinic",
      publicDirectoryOptIn: true,
      at: { lat: -45.513, lng: -69.509 },
    },
    false,
  );
  await org(
    "vetHidden",
    {
      label: "VETHID",
      orgType: "clinic",
      publicDirectoryOptIn: false,
      at: { lat: -45.5, lng: -69.5 },
    },
    false,
  );
});

afterAll(async () => {
  await teardownFoundAnimalFixtures(fx);
});

function allCards(help: NearbyHelp): NearbyOrgCard[] {
  const fallbackCard = help.fallback?.kind === "municipal_service" ? [help.fallback.card] : [];
  return [...help.vets, ...help.receivers, ...fallbackCard];
}

describe("findNearbyHelp — who is listed, and in what order", () => {
  it("lists only verified, active, opted-in receivers of an allowed type, nearest first", async () => {
    const help = await findNearbyHelp({ kind: "point", point: FINDER, includeVets: false });
    expect(help).not.toBeNull();
    const listed = help?.receivers.map((r) => r.displayName) ?? [];
    expect(listed).toEqual([names.near, names.mid]);
    for (const excluded of ["unverified", "suspended", "other", "far", "optedOut", "vet"]) {
      expect(listed).not.toContain(names[excluded]);
    }
    expect(help?.receivers.map((r) => r.distanceLabel)).toEqual(["a menos de 2 km", "a unos 6 km"]);
  });

  it("returns no vets unless asked, and then only the directory's opted-in clinics", async () => {
    const without = await findNearbyHelp({ kind: "point", point: FINDER, includeVets: false });
    expect(without?.vets).toEqual([]);

    const withVets = await findNearbyHelp({ kind: "point", point: FINDER, includeVets: true });
    const vets = withVets?.vets.map((v) => v.displayName) ?? [];
    expect(vets).toContain(names.vet);
    expect(vets).not.toContain(names.vetHidden);
    expect(withVets?.receivers.map((r) => r.displayName)).toEqual([names.near, names.mid]);
  });
});

describe("findNearbyHelp — the projection is public-safe", () => {
  it("every card carries exactly the public keys and nothing private", async () => {
    const help = await findNearbyHelp({ kind: "point", point: FINDER, includeVets: true });
    if (!help) throw new Error("expected a result");
    const cards = allCards(help);
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(Object.keys(card).sort()).toEqual([...NEARBY_ORG_CARD_KEYS].sort());
    }
    const receiver = help.receivers[0];
    expect(receiver.capacityLabel).toBe("Recibimos");
    expect(receiver.contact).toEqual({
      label: "WhatsApp",
      value: "+54 9 2945 55-0001",
      href: "https://wa.me/5492945550001",
    });
    // A clinic carries no capacity or contact of its own here: its contact
    // lives on its directory profile.
    expect(help.vets[0].contact).toBeNull();
    expect(help.vets[0].profileHref).toMatch(/^\/refugios\/P4-/);

    const wire = JSON.stringify(help);
    expect(wire).not.toMatch(/Razon Social Privada/);
    expect(wire).not.toMatch(/privado-/);
    expect(wire).not.toContain("0000-0000");
    // Neither the finder's point nor any org coordinate, raw or coarse.
    expect(wire).not.toMatch(/-45\.\d|-69\.\d/);
  });
});

describe("findNearbyHelp — coarse, and never stored or logged", () => {
  it("answers a raw point exactly as it answers the same point snapped to the grid", async () => {
    const raw = await findNearbyHelp({ kind: "point", point: FINDER, includeVets: true });
    const coarse = await findNearbyHelp({
      kind: "point",
      point: { lat: -45.5, lng: -69.51 },
      includeVets: true,
    });
    expect(raw).toEqual(coarse);
  });

  it("writes nothing: the lookup runs in a READ ONLY transaction that never gets an id", async () => {
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      }),
    );
    try {
      const xid = await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        const help = await findNearbyHelp(
          { kind: "point", point: FINDER, includeVets: true },
          { executor: tx },
        );
        expect(help?.receivers.length).toBe(2);
        const [row] = (await tx.execute(
          sql`SELECT pg_current_xact_id_if_assigned()::text AS xid`,
        )) as unknown as Array<{ xid: string | null }>;
        return row.xid;
      });
      expect(xid).toBeNull();
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(logged.join("\n")).not.toMatch(/45\.50347|69\.50891/);
  });

  it("refuses a point outside Argentina without reading anything", async () => {
    await expect(
      findNearbyHelp({ kind: "point", point: { lat: 40.4, lng: -3.7 }, includeVets: true }),
    ).resolves.toBeNull();
  });
});

describe("findNearbyHelp — a picked locality", () => {
  it("resolves the place by catalogue id and answers with names only", async () => {
    const place = await readHelpPlaceNear({ lat: -45.5, lng: -69.51 });
    if (!place) throw new Error("the INDEC catalogue is not seeded");
    const help = await findNearbyHelp({
      kind: "locality",
      localityId: place.localityId,
      includeVets: false,
    });
    expect(help?.place).toEqual({ province: place.provinceName, locality: place.localityName });
  });

  it("refuses an id that is not a catalogue row", async () => {
    await expect(
      findNearbyHelp({ kind: "locality", localityId: "not-a-uuid", includeVets: false }),
    ).resolves.toBeNull();
    await expect(
      findNearbyHelp({
        kind: "locality",
        localityId: "00000000-0000-4000-8000-000000000000",
        includeVets: false,
      }),
    ).resolves.toBeNull();
  });
});

describe("findNearbyHelp — the empty state walks the jurisdiction cascade", () => {
  it("offers an opted-in municipal service of the place's province, at any distance", async () => {
    const place = await readHelpPlaceNear({ lat: -49.3, lng: -70.1 });
    if (!place?.provinceName) throw new Error("the INDEC catalogue is not seeded");

    const before = await findNearbyHelp({ kind: "point", point: EMPTY_PLACE, includeVets: false });
    expect(before?.receivers).toEqual([]);
    expect(["local_government", "general", "municipal_service"]).toContain(before?.fallback?.kind);

    await org("authority", {
      label: "ZOONOSIS",
      orgType: "sanitary_authority",
      province: place.provinceName,
    });
    const after = await findNearbyHelp({ kind: "point", point: EMPTY_PLACE, includeVets: false });
    expect(after?.receivers).toEqual([]);
    expect(after?.fallback?.kind).toBe("municipal_service");
    if (after?.fallback?.kind === "municipal_service") {
      expect(after.fallback.card.displayName).toBe(names.authority);
      expect(after.fallback.card.distanceLabel).toBe("en tu provincia");
    }
  });
});
