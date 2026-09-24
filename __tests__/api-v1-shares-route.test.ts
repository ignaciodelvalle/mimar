// `/api/v1/pets/{token}/shares` — the four sharing commands, and the read that
// says which of them this caller may send.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE GUARDS ARE THE WEB'S, AND THEY ARE NOT ONE GUARD. Three commands are
//      titular-only (a caretaker refused, a co-owner and a foster and the ORG
//      path admitted); creation is narrowed AGAIN to the person path by the
//      writer's own `ownerships` join; revocation is CREATOR-OR-ADMIN, which is
//      sideways to all of it — a co-owner may not revoke somebody else's link.
//   2. THE PER-ROW CAPABILITY IS REPORTED, so a client can say why instead of
//      offering a control that answers 403.
//   3. THE TWO NARROWINGS THIS ENDPOINT ADDS ARE REAL AND BOUNDED: a share id
//      belonging to another animal answers 404, and an unknown Tier-2 window is
//      refused rather than silently becoming 24 hours.
//   4. `changed` IS MEASURED. A duplicate create reports `false` and still hands
//      back a working token; an equivalent Tier-2 re-open reports `false`.
//   5. NO TOKEN IS AN INPUT, EVER — revocation takes the row id, and a token in
//      that field is refused by shape.
//   6. THE REFUSALS CARRY THE RIGHT STATUS PER WHOSE FACT THEY ARE: 403 for the
//      CALLER, 409 for the ANIMAL, 400 for the request, 404 for anything a
//      caller may not see.
//   7. NOTHING IS WRITTEN when any gate refuses.

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "99999999-9999-4999-8999-999999999999";
const PET_ID = "22222222-2222-4222-8222-222222222222";
const SHARE_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "DIM-PAMP-0001";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  access: null as null | (() => unknown),
  /** Rows `getActiveLibretaShares` answers with. */
  shares: [] as Array<Record<string, unknown>>,
  /** The row `findShareForPet` answers with — `null` is "not this animal's". */
  shareRow: null as null | { id: string; revokedAt: Date | null },
  isAdmin: false,
  createResult: { shareToken: "LBR-NEW0-0001" } as Record<string, unknown>,
  revokeResult: { ok: true, shareTokenRowId: "33333333-3333-4333-8333-333333333333" } as Record<
    string,
    unknown
  >,
  tier2Before: { permanent: false, until: null } as null | {
    permanent: boolean;
    until: Date | null;
  },
  tier2After: { permanent: false, until: null } as null | {
    permanent: boolean;
    until: Date | null;
  },
  /** How many times `readTier2State` has been called THIS test. Reset per test. */
  tier2Reads: 0,
  /** Every writer call. Empty means nothing was written. */
  writes: [] as Array<{ command: string; input: Record<string, unknown> }>,
}));

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () =>
      control.live
        ? control.live()
        : { ok: true, supabase: {}, user: { id: OWNER_ID }, profile: null },
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return { ...actual, enforceRateLimit: async () => {} };
});

vi.mock("@/lib/infra/pet-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/pet-access")>();
  return {
    ...actual,
    resolvePetHolderAccess: async () =>
      control.access ? control.access() : { kind: "owner", pet: petRow(), holderRole: "owner" },
  };
});

vi.mock("@/src/modules/pets/application/libreta-share/get-active-libreta-shares", () => ({
  getActiveLibretaShares: async () => control.shares,
}));

vi.mock("@/src/modules/pets/application/libreta-share/find-share-for-pet", () => ({
  findShareForPet: async () => control.shareRow,
}));

// PARTIAL: `isPlatformAdmin` is the query, and `canRevokeShare` is the RULE —
// mocking the rule would make the per-row capability test prove nothing.
vi.mock("@/src/modules/pets/application/libreta-share/share-revocation-scope", async (orig) => {
  const actual =
    await orig<
      typeof import("@/src/modules/pets/application/libreta-share/share-revocation-scope")
    >();
  return { ...actual, isPlatformAdmin: async () => control.isAdmin };
});

vi.mock("@/src/modules/pets/application/libreta-share/create-libreta-share", () => ({
  createLibretaShareForUser: async (userId: string, input: Record<string, unknown>) => {
    control.writes.push({ command: "create_libreta_share", input: { userId, ...input } });
    return control.createResult;
  },
}));

vi.mock("@/src/modules/pets/application/libreta-share/revoke-libreta-share", () => ({
  revokeLibretaShareForUser: async (userId: string, shareId: string) => {
    control.writes.push({ command: "revoke_libreta_share", input: { userId, shareId } });
    return control.revokeResult;
  },
}));

// The `pet` argument is CAPTURED, not ignored. `enableTier2Public` reads
// `tier2PublicPermanent` and `tier2PublicEnabledUntil` off it to recognise its
// own no-ops; an endpoint that handed it a narrowed `{ id, status }` would break
// both guards while every assertion here still passed. See the test at the
// bottom of this file.
vi.mock("@/src/modules/pets/application/tier2-public/enable-tier2-public", () => ({
  enableTier2Public: async (pet: Record<string, unknown>, token: string, formData: FormData) => {
    control.writes.push({
      command: "enable_tier2",
      input: { token, duration: String(formData.get("duration")), pet },
    });
  },
}));

vi.mock("@/src/modules/pets/application/tier2-public/revoke-tier2-public", () => ({
  revokeTier2Public: async (pet: Record<string, unknown>, token: string) => {
    control.writes.push({ command: "revoke_tier2", input: { token, pet } });
  },
}));

// PARTIAL again: `readTier2State` is the query, `tier2StateDiffers` is the rule.
//
// THE COUNTER LIVES IN `control`, NOT IN THIS CLOSURE. A `let call = 0` here is
// module state that survives every test in the file, so the second test to send
// a Tier-2 command would get the AFTER snapshot for both reads and report
// `changed: false` no matter what — a mock that quietly answers the same thing
// forever while looking like it is sequencing two reads.
vi.mock("@/src/modules/pets/application/tier2-public/read-tier2-state", async (orig) => {
  const actual =
    await orig<typeof import("@/src/modules/pets/application/tier2-public/read-tier2-state")>();
  return {
    ...actual,
    readTier2State: async () => {
      control.tier2Reads += 1;
      return control.tier2Reads === 1 ? control.tier2Before : control.tier2After;
    },
  };
});

vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    createClientFromBearer: (header: string | null) =>
      header ? { ok: true, supabase: {}, token: "tok" } : { ok: false, reason: "MISSING" },
  };
});

import { GET, POST } from "@/app/api/v1/pets/[publicToken]/shares/route";

function petRow(over: Record<string, unknown> = {}) {
  return {
    id: PET_ID,
    publicToken: TOKEN,
    name: "Pampa",
    status: "active",
    tier2PublicEnabledUntil: null,
    tier2PublicPermanent: false,
    ...over,
  };
}

function shareRow(over: Record<string, unknown> = {}) {
  return {
    id: SHARE_ID,
    shareToken: "LBR-ABCD-EFGH",
    petId: PET_ID,
    createdByUserId: OWNER_ID,
    label: "Veterinaria Norte",
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    revokedAt: null,
    revokedByUserId: null,
    viewCountCached: 2,
    lastViewedAtCached: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...over,
  };
}

function read(headers: HeadersInit = { authorization: "Bearer t" }) {
  return GET(new Request("https://x.test/api/v1/pets/DIM-PAMP-0001/shares", { headers }), {
    params: Promise.resolve({ publicToken: TOKEN }),
  });
}

function send(body: unknown, headers: HeadersInit = { authorization: "Bearer t" }) {
  return POST(
    new Request("https://x.test/api/v1/pets/DIM-PAMP-0001/shares", {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers as Record<string, string>) },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ publicToken: TOKEN }) },
  );
}

const orgAccess = () => () => ({
  kind: "org",
  pet: petRow(),
  organization: { id: "org-1" },
  membership: {},
  eventAuthorship: {},
});

const caretakerAccess = () => () => ({
  kind: "owner",
  pet: petRow(),
  holderRole: "caretaker",
});

beforeEach(() => {
  control.live = null;
  control.access = null;
  control.shares = [];
  control.shareRow = { id: SHARE_ID, revokedAt: null };
  control.isAdmin = false;
  control.createResult = { shareToken: "LBR-NEW0-0001" };
  control.revokeResult = { ok: true, shareTokenRowId: SHARE_ID };
  control.tier2Before = { permanent: false, until: null };
  control.tier2After = { permanent: false, until: null };
  control.tier2Reads = 0;
  control.writes = [];
});

describe("GET — the sharing cockpit", () => {
  it("refuses without a bearer, and never says whether the pet exists", async () => {
    const response = await read({});
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "auth_required" });
  });

  it("answers 404 for a pet this caller may not reach — the same as one that does not exist", async () => {
    control.access = () => ({ kind: "none" });
    const response = await read();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("sets cache-control: no-store — this body carries bearer credentials", async () => {
    const response = await read();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("carries the token, the expiry and the view counters for each active link", async () => {
    control.shares = [shareRow()];
    const body = await (await read()).json();
    expect(body.libretaShares).toHaveLength(1);
    expect(body.libretaShares[0]).toMatchObject({
      id: SHARE_ID,
      shareToken: "LBR-ABCD-EFGH",
      label: "Veterinaria Norte",
      expired: false,
      canRevoke: true,
      viewCount: 2,
      lastViewedAt: null,
    });
  });

  it("decides `expired` on the SERVER's clock, not the client's", async () => {
    control.shares = [shareRow({ expiresAt: new Date("2000-01-01T00:00:00.000Z") })];
    const body = await (await read()).json();
    expect(body.libretaShares[0].expired).toBe(true);
  });

  it("reports canRevoke:false for a link this holder did not create", async () => {
    control.shares = [shareRow({ createdByUserId: OTHER_ID })];
    const body = await (await read()).json();
    expect(body.libretaShares[0].canRevoke).toBe(false);
  });

  it("lets a platform admin revoke somebody else's link — the writer's other half", async () => {
    control.shares = [shareRow({ createdByUserId: OTHER_ID })];
    control.isAdmin = true;
    const body = await (await read()).json();
    expect(body.libretaShares[0].canRevoke).toBe(true);
  });

  it("returns an EMPTY list on the org path, mirroring the web's early return", async () => {
    control.access = orgAccess();
    control.shares = [shareRow()];
    const body = await (await read()).json();
    expect(body.libretaShares).toEqual([]);
  });

  it("refuses a caretaker every titular-only capability, and still answers", async () => {
    control.access = caretakerAccess();
    const body = await (await read()).json();
    expect(body.capabilities).toMatchObject({
      canCreateLibretaShare: false,
      canEnableTier2: false,
      canRevokeTier2: false,
    });
  });

  it("admits a co-owner and a foster — requireTitularAccess is a DENY, not an allow-list", async () => {
    for (const role of ["co_owner", "foster"]) {
      control.access = () => ({ kind: "owner", pet: petRow(), holderRole: role });
      const body = await (await read()).json();
      expect(body.capabilities.canCreateLibretaShare).toBe(true);
      expect(body.capabilities.canEnableTier2).toBe(true);
    }
  });

  it("lets the ORG path open Tier-2 but not mint a link — the web's own asymmetry", async () => {
    control.access = orgAccess();
    const body = await (await read()).json();
    expect(body.capabilities.canEnableTier2).toBe(true);
    expect(body.capabilities.canCreateLibretaShare).toBe(false);
  });

  it("closes creation at the cap, and says how many slots are left", async () => {
    control.shares = [shareRow(), shareRow(), shareRow(), shareRow(), shareRow()];
    const body = await (await read()).json();
    expect(body.capabilities.remainingShareSlots).toBe(0);
    expect(body.capabilities.canCreateLibretaShare).toBe(false);
  });

  it("refuses to open a Tier-2 window on a deceased animal, and still allows closing one", async () => {
    control.access = () => ({
      kind: "owner",
      pet: petRow({ status: "deceased" }),
      holderRole: "owner",
    });
    const body = await (await read()).json();
    expect(body.capabilities.canEnableTier2).toBe(false);
    expect(body.capabilities.canRevokeTier2).toBe(true);
  });

  it("computes the Tier-2 window against the server clock and nulls activeUntil when permanent", async () => {
    control.access = () => ({
      kind: "owner",
      pet: petRow({ tier2PublicPermanent: true }),
      holderRole: "owner",
    });
    const body = await (await read()).json();
    expect(body.tier2).toEqual({ isActive: true, isPermanent: true, activeUntil: null });
  });

  it("treats a window that already closed as inactive", async () => {
    control.access = () => ({
      kind: "owner",
      pet: petRow({ tier2PublicEnabledUntil: new Date("2000-01-01T00:00:00.000Z") }),
      holderRole: "owner",
    });
    const body = await (await read()).json();
    expect(body.tier2).toMatchObject({ isActive: false, activeUntil: null });
  });
});

describe("POST — the guards", () => {
  it("refuses a caretaker every titular-only command, and writes NOTHING", async () => {
    control.access = caretakerAccess();
    for (const input of [
      { command: "create_libreta_share", expiresInDays: 7, label: null },
      { command: "enable_tier2", window: "24h" },
      { command: "revoke_tier2" },
    ]) {
      const response = await send(input);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "share_forbidden" });
    }
    expect(control.writes).toEqual([]);
  });

  it("refuses an ORG member the mint the web's writer would refuse them", async () => {
    control.access = orgAccess();
    const response = await send({ command: "create_libreta_share", expiresInDays: 7, label: null });
    expect(response.status).toBe(403);
    expect(control.writes).toEqual([]);
  });

  it("lets an ORG member open the Tier-2 window, because the web does", async () => {
    control.access = orgAccess();
    const response = await send({ command: "enable_tier2", window: "24h" });
    expect(response.status).toBe(200);
    expect(control.writes[0]?.command).toBe("enable_tier2");
  });

  it("answers 409 for the ANIMAL's situation, not 403 — a deceased Tier-2 open", async () => {
    control.access = () => ({
      kind: "owner",
      pet: petRow({ status: "deceased" }),
      holderRole: "owner",
    });
    const response = await send({ command: "enable_tier2", window: "24h" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "tier2_not_allowed" });
    expect(control.writes).toEqual([]);
  });

  it("still lets a deceased animal's Tier-2 window be CLOSED", async () => {
    control.access = () => ({
      kind: "owner",
      pet: petRow({ status: "deceased" }),
      holderRole: "owner",
    });
    const response = await send({ command: "revoke_tier2" });
    expect(response.status).toBe(200);
  });

  it("maps the writer's cap refusal to 409 when the caller is on the person path", async () => {
    control.createResult = { error: "Ya tenés 5 compartidos activos para esta mascota." };
    const response = await send({ command: "create_libreta_share", expiresInDays: 7, label: null });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "share_limit_reached" });
  });

  it("refuses a share id belonging to another animal with a plain 404", async () => {
    control.shareRow = null;
    const response = await send({ command: "revoke_libreta_share", shareId: SHARE_ID });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(control.writes).toEqual([]);
  });

  it("maps the writer's creator-or-admin refusal to 403", async () => {
    control.revokeResult = { error: "Sin permisos para revocar este compartido." };
    const response = await send({ command: "revoke_libreta_share", shareId: SHARE_ID });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "share_forbidden" });
  });
});

describe("POST — the request shape", () => {
  it("refuses a body that is not one of the four commands", async () => {
    const response = await send({ command: "delete_everything" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(control.writes).toEqual([]);
  });

  it("refuses a duration the web's picker cannot produce", async () => {
    const response = await send({
      command: "create_libreta_share",
      expiresInDays: 365,
      label: null,
    });
    expect(response.status).toBe(400);
    expect(control.writes).toEqual([]);
  });

  it("accepts the deliberate null — 'sin vencimiento' is a choice, not an omission", async () => {
    const response = await send({
      command: "create_libreta_share",
      expiresInDays: null,
      label: null,
    });
    expect(response.status).toBe(200);
    expect(control.writes[0]?.input.expiresInDays).toBeNull();
  });

  it("refuses an unknown Tier-2 window instead of silently giving it 24 hours", async () => {
    const response = await send({ command: "enable_tier2", window: "7days" });
    expect(response.status).toBe(400);
    expect(control.writes).toEqual([]);
  });

  it("refuses a share TOKEN in the shareId field — the credential is not a handle", async () => {
    const response = await send({ command: "revoke_libreta_share", shareId: "LBR-ABCD-EFGH" });
    expect(response.status).toBe(400);
    expect(control.writes).toEqual([]);
  });

  it("caps the label rather than letting the server store an arbitrary one", async () => {
    const response = await send({
      command: "create_libreta_share",
      expiresInDays: 7,
      label: "x".repeat(200),
    });
    expect(response.status).toBe(400);
    expect(control.writes).toEqual([]);
  });
});

describe("POST — `changed` is measured, not assumed", () => {
  it("reports a fresh mint as changed", async () => {
    control.shares = [];
    control.createResult = { shareToken: "LBR-NEW0-0001" };
    const body = await (
      await send({ command: "create_libreta_share", expiresInDays: 7, label: null })
    ).json();
    expect(body).toMatchObject({ command: "create_libreta_share", changed: true });
    expect(body.shareToken).toBe("LBR-NEW0-0001");
  });

  it("reports the writer's recognised duplicate as UNCHANGED, with a working token", async () => {
    // The writer answers with an EXISTING token rather than burning a slot. From
    // the outside that is indistinguishable from a fresh mint — unless the
    // endpoint looked first, which is exactly what it does.
    control.shares = [shareRow({ shareToken: "LBR-SAME-0001" })];
    control.createResult = { shareToken: "LBR-SAME-0001" };
    const body = await (
      await send({ command: "create_libreta_share", expiresInDays: 7, label: null })
    ).json();
    expect(body.changed).toBe(false);
    expect(body.shareToken).toBe("LBR-SAME-0001");
  });

  it("reports a revoke of an already-revoked row as unchanged", async () => {
    control.shareRow = { id: SHARE_ID, revokedAt: new Date("2026-08-01T00:00:00.000Z") };
    const body = await (await send({ command: "revoke_libreta_share", shareId: SHARE_ID })).json();
    expect(body.changed).toBe(false);
  });

  it("reports an equivalent Tier-2 re-open as unchanged, without re-deriving the writer's rule", async () => {
    const until = new Date("2026-09-01T00:00:00.000Z");
    control.tier2Before = { permanent: false, until };
    control.tier2After = { permanent: false, until };
    const body = await (await send({ command: "enable_tier2", window: "24h" })).json();
    expect(body).toMatchObject({ command: "enable_tier2", changed: false, tier2Window: "24h" });
  });

  it("reports a real Tier-2 change as changed", async () => {
    control.tier2Before = { permanent: false, until: null };
    control.tier2After = { permanent: true, until: null };
    const body = await (await send({ command: "enable_tier2", window: "siempre" })).json();
    expect(body.changed).toBe(true);
    expect(control.writes[0]?.input.duration).toBe("siempre");
  });
});

describe("POST — the ack carries no more than it must", () => {
  it("returns a token for a mint and null for everything else", async () => {
    const created = await (
      await send({ command: "create_libreta_share", expiresInDays: 7, label: null })
    ).json();
    expect(created.shareToken).toBe("LBR-NEW0-0001");
    expect(created.tier2Window).toBeNull();

    for (const input of [
      { command: "revoke_libreta_share", shareId: SHARE_ID },
      { command: "revoke_tier2" },
    ]) {
      const body = await (await send(input)).json();
      expect(body.shareToken).toBeNull();
      expect(body.tier2Window).toBeNull();
    }
  });

  it("is a BARE payload — no envelope on a write", async () => {
    const body = await (await send({ command: "revoke_tier2" })).json();
    expect(body).not.toHaveProperty("payloadVersion");
    expect(body).not.toHaveProperty("staleAfter");
  });

  it("ignores an Idempotency-Key rather than pretending to honour it", async () => {
    const response = await send(
      { command: "revoke_tier2" },
      { authorization: "Bearer t", "idempotency-key": "55555555-5555-4555-8555-555555555555" },
    );
    expect(response.status).toBe(200);
  });
});

describe("the Tier-2 writers get the WHOLE pet row", () => {
  // The bug this catches, caught in review before it shipped: passing a narrowed
  // `{ id, status }` typechecks, every assertion above still passes, and
  // `enableTier2Public` silently loses both of its desired-state guards — it
  // reads `undefined` for `tier2PublicPermanent` and for
  // `tier2PublicEnabledUntil`, so every request writes and the writer stops
  // recognising a duplicate submit. Nothing goes red. Only this does.
  it("hands enableTier2Public the fields its no-op guards are made of", async () => {
    const until = new Date("2026-09-01T00:00:00.000Z");
    control.access = () => ({
      kind: "owner",
      pet: petRow({ tier2PublicPermanent: false, tier2PublicEnabledUntil: until }),
      holderRole: "owner",
    });

    await send({ command: "enable_tier2", window: "24h" });

    const pet = control.writes[0]?.input.pet as Record<string, unknown>;
    expect(pet).toHaveProperty("tier2PublicPermanent", false);
    expect(pet).toHaveProperty("tier2PublicEnabledUntil", until);
  });

  it("hands revokeTier2Public the row too, not a synthesised id", async () => {
    await send({ command: "revoke_tier2" });
    const pet = control.writes[0]?.input.pet as Record<string, unknown>;
    expect(pet).toHaveProperty("id", PET_ID);
    expect(pet).toHaveProperty("publicToken", TOKEN);
  });
});
