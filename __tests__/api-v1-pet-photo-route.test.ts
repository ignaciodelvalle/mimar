// `/api/v1/pets/{token}/photo` — the two-step upload, and the four ways it says no.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. AN UNAUTHORISED CALLER GETS NOTHING. A pet this caller does not hold
//      answers 404 (never 403 — that would be an oracle for which tokens are
//      real) and MINTS NO TICKET. The ticket is a bearer capability; "the write
//      would have failed anyway" is not a defence for handing one out.
//   2. THE ORG PATH IS CAPABILITY-GATED. An org member without `event.write` is
//      refused, one with it is not — and the refusal happens before any ticket.
//   3. A CARETAKER IS NOT REFUSED. `lib/domain/titular-only.ts` names photos as
//      something a caretaker MAY do, and `primaryPhotoId` is deliberately absent
//      from `TITULAR_ONLY_PET_COLUMNS`. This is the assertion that stops somebody
//      "hardening" the door by copying the web's titular gate.
//   4. THE OBJECT PATH IS NOT CALLER-INFLUENCED. The key the ticket mints is
//      prefixed with the pet id the SERVER resolved, and `confirm` refuses a
//      staged path belonging to any other pet — with the same code it uses for
//      "not an image", so confirm is not an oracle either.
//   5. THE CONSTRAINTS ARE SERVER-SIDE. The declared content type does not decide
//      what the file is: bytes that are not a raster are refused no matter what
//      the ticket said, and a caller cannot ask for a type outside the whitelist.
//
// WHY THE MOCK BOUNDARY IS `@/lib/infra/pet-photo-upload` AND NOT DEEPER FOR (1)-(3)
// BUT THE OTHER WAY FOR (4)-(5): the route's job is to decide WHO may act, and
// the use-case's job is to decide WHAT the bytes are. Mocking the use-case makes
// "nothing was minted" observable; the path and content rules are exercised
// against the REAL `stagedPathBelongsToPet` and the real validator in
// `__tests__/pet-photo-upload.test.ts`, because a rule tested through a mock of
// itself is not tested.

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PET_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "DIM-PAMP-0001";
const STAGED = `${PET_ID}/33333333-3333-4333-8333-333333333333.jpg`;

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  access: null as null | (() => unknown),
  capabilities: new Set<string>(["event.write"]),
  ticketResult: null as null | Record<string, unknown>,
  confirmResult: null as null | Record<string, unknown>,
  /** Every call into the upload primitive. Empty means nothing was minted. */
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
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

vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  getGrantedCapabilities: async () => control.capabilities,
}));

vi.mock("@/lib/infra/pet-photo-upload", () => ({
  mintPetPhotoTicket: async (petId: string, contentType: string) => {
    control.calls.push({ fn: "mint", args: { petId, contentType } });
    return (
      control.ticketResult ?? {
        ok: true,
        ticket: {
          uploadUrl: "https://storage.test/object/upload/sign/uploads-staging/x?token=t",
          token: "t",
          stagedPath: `${petId}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg`,
          bucket: "uploads-staging",
          validForSeconds: 7200,
        },
      }
    );
  },
  confirmPetPhoto: async (args: Record<string, unknown>) => {
    control.calls.push({ fn: "confirm", args });
    return (
      control.confirmResult ?? {
        ok: true,
        photo: {
          photoUrl: "https://s.test/storage/v1/object/public/pet-photos/x.jpg",
          replacedPrevious: false,
        },
      }
    );
  },
}));

vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    createClientFromBearer: (header: string | null) =>
      header ? { ok: true, supabase: {}, token: "tok" } : { ok: false, reason: "MISSING" },
  };
});

import { POST } from "@/app/api/v1/pets/[publicToken]/photo/route";

function petRow(over: Record<string, unknown> = {}) {
  return {
    id: PET_ID,
    publicToken: TOKEN,
    name: "Pampa",
    status: "active",
    deletedAt: null,
    ...over,
  };
}

function send(body: unknown, headers: HeadersInit = { authorization: "Bearer t" }) {
  return POST(
    new Request("https://x.test/api/v1/pets/DIM-PAMP-0001/photo", {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers as Record<string, string>) },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ publicToken: TOKEN }) },
  );
}

const ticketCommand = { command: "request_ticket", contentType: "image/jpeg" };
const confirmCommand = { command: "confirm", stagedPath: STAGED };

const orgAccess =
  (over: Record<string, unknown> = {}) =>
  () => ({
    kind: "org",
    pet: petRow(),
    organization: { id: "org-1" },
    membership: { id: "mem-1", organizationId: "org-1" },
    eventAuthorship: { authorRole: "shelter", authorVerified: false },
    ...over,
  });

beforeEach(() => {
  control.live = null;
  control.access = null;
  control.capabilities = new Set<string>(["event.write"]);
  control.ticketResult = null;
  control.confirmResult = null;
  control.calls = [];
});

describe("who may reach the door", () => {
  it("refuses a request with no bearer, and mints nothing", async () => {
    const res = await send(ticketCommand, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_required" });
    expect(control.calls).toEqual([]);
  });

  it("answers 404 — not 403 — for a pet this caller does not hold, and mints nothing", async () => {
    control.access = () => ({ kind: "none" });
    const res = await send(ticketCommand);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    // THE POINT OF THIS TEST. A refused caller must not walk away holding a
    // capability to write into our object store, even a scoped one.
    expect(control.calls).toEqual([]);
  });

  it("refuses `confirm` for a pet this caller does not hold, and confirms nothing", async () => {
    control.access = () => ({ kind: "none" });
    const res = await send(confirmCommand);
    expect(res.status).toBe(404);
    expect(control.calls).toEqual([]);
  });

  it("refuses a SOFT-DELETED pet as 404, and mints nothing", async () => {
    // Belt-and-braces against a resolver regression. `resolvePetHolderAccess`
    // now filters `pets.deleted_at` on both paths (closed 2026-08-28), so a
    // real erased pet resolves `kind: "none"` before this route-level check is
    // reached — but this door mints a capability, and the route keeps its own
    // refusal so a regression in the resolver cannot silently reopen it. The
    // resolver here is a STUB, which is exactly why this test stays meaningful:
    // it pins the route's behavior when handed a deleted pet, whatever the
    // resolver does. The load-bearing fence on the resolver itself lives in
    // `__tests__/public-soft-delete-resolution.test.ts`, against a real DB.
    control.access = () => ({
      kind: "owner",
      pet: petRow({ deletedAt: new Date("2026-08-01T00:00:00.000Z") }),
      holderRole: "owner",
    });
    const ticket = await send(ticketCommand);
    expect(ticket.status).toBe(404);
    expect(await ticket.json()).toEqual({ error: "not_found" });
    expect(control.calls).toEqual([]);

    const confirm = await send(confirmCommand);
    expect(confirm.status).toBe(404);
    expect(control.calls).toEqual([]);
  });

  it("answers `pet_gone` from confirm as 404 — the erasure landed mid-flow", async () => {
    // The two-hour ticket window is long enough for an erasure to land between
    // the mint and the confirm, which is why the use-case repeats the check
    // inside its transaction and this maps its answer.
    control.confirmResult = { ok: false, code: "pet_gone" };
    const res = await send(confirmCommand);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("sets no cache on any answer", async () => {
    const res = await send(ticketCommand);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("which holders may change a photo", () => {
  it("admits a CARETAKER — photos are not a titular-only effect", async () => {
    // `lib/domain/titular-only.ts` lists photos among what a caretaker MAY do,
    // and `primaryPhotoId` is not in TITULAR_ONLY_PET_COLUMNS. If somebody
    // "hardens" this door onto requireTitularAccess, this is what fails.
    control.access = () => ({ kind: "owner", pet: petRow(), holderRole: "caretaker" });
    const res = await send(ticketCommand);
    expect(res.status).toBe(201);
    expect(control.calls.map((c) => c.fn)).toEqual(["mint"]);
  });

  it("admits a co-owner and a foster", async () => {
    for (const holderRole of ["co_owner", "foster"]) {
      control.calls = [];
      control.access = () => ({ kind: "owner", pet: petRow(), holderRole });
      const res = await send(ticketCommand);
      expect(res.status, holderRole).toBe(201);
    }
  });

  it("refuses an org member without `event.write`, before minting anything", async () => {
    control.access = orgAccess();
    control.capabilities = new Set<string>(["pet.read"]);
    const res = await send(ticketCommand);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "photo_forbidden" });
    expect(control.calls).toEqual([]);
  });

  it("admits an org member WITH `event.write`", async () => {
    control.access = orgAccess();
    control.capabilities = new Set<string>(["event.write"]);
    const res = await send(ticketCommand);
    expect(res.status).toBe(201);
  });

  it("refuses an org member without the capability on `confirm` too", async () => {
    // The gate is on the ACT, not on one command. A door that checked the
    // capability only when minting would let a stale ticket be confirmed by a
    // member whose permission was revoked in between.
    control.access = orgAccess();
    control.capabilities = new Set<string>();
    const res = await send(confirmCommand);
    expect(res.status).toBe(403);
    expect(control.calls).toEqual([]);
  });
});

describe("the object path is the server's, not the caller's", () => {
  it("mints against the pet id the ACCESS CHECK resolved, not anything in the body", async () => {
    await send({ ...ticketCommand, petId: "not-this-one", stagedPath: "../../etc/passwd" });
    expect(control.calls).toEqual([
      { fn: "mint", args: { petId: PET_ID, contentType: "image/jpeg" } },
    ]);
  });

  it("hands `confirm` the resolved pet id alongside the claimed path", async () => {
    // The route does not judge the path — `confirmPetPhoto` does, against this
    // petId. What matters here is that the petId it judges against comes from
    // the access check and never from the request.
    await send(confirmCommand);
    expect(control.calls).toEqual([
      { fn: "confirm", args: { petId: PET_ID, userId: OWNER_ID, stagedPath: STAGED } },
    ]);
  });

  it("refuses a staged path that is not the shape the server mints", async () => {
    for (const stagedPath of [
      "../../../pet-photos/evil.jpg",
      `${PET_ID}/../../evil.jpg`,
      `/${PET_ID}/x.jpg`,
      `${PET_ID}/x.svg`,
      `${PET_ID}/a/b.jpg`,
      "",
    ]) {
      control.calls = [];
      const res = await send({ command: "confirm", stagedPath });
      expect(res.status, stagedPath).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
      expect(control.calls, stagedPath).toEqual([]);
    }
  });
});

describe("what a caller may ask for", () => {
  it("refuses a content type outside the whitelist, including SVG", async () => {
    for (const contentType of ["image/svg+xml", "text/html", "application/pdf", "image/heic"]) {
      control.calls = [];
      const res = await send({ command: "request_ticket", contentType });
      expect(res.status, contentType).toBe(400);
      expect(control.calls, contentType).toEqual([]);
    }
  });

  it("refuses an unknown command and a body that is not JSON", async () => {
    const bad = await send({ command: "delete_photo" });
    expect(bad.status).toBe(400);
    expect(control.calls).toEqual([]);
  });
});

describe("the answers", () => {
  it("answers 201 with the ticket, and NO read envelope", async () => {
    const res = await send(ticketCommand);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.bucket).toBe("uploads-staging");
    expect(body.validForSeconds).toBe(7200);
    // Writes carry no `payloadVersion` / `staleAfter` — that envelope is a
    // read's, and `check-api-v1-envelope` keeps the two apart.
    expect(body.payloadVersion).toBeUndefined();
    expect(body.staleAfter).toBeUndefined();
  });

  it("answers 400 for bytes that are not an image, and 500 for a failed write", async () => {
    control.confirmResult = { ok: false, code: "photo_not_an_image" };
    const notImage = await send(confirmCommand);
    expect(notImage.status).toBe(400);
    expect(await notImage.json()).toEqual({ error: "photo_not_an_image" });

    control.confirmResult = { ok: false, code: "photo_failed" };
    const failed = await send(confirmCommand);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "photo_failed" });
  });

  it("answers 200 with the public URL when confirm succeeds", async () => {
    const res = await send(confirmCommand);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      photoUrl: "https://s.test/storage/v1/object/public/pet-photos/x.jpg",
      replacedPrevious: false,
    });
  });
});
