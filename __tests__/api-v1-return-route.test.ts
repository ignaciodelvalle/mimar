// `GET|POST /api/v1/pets/{token}/return` — DEVOLUCIÓN, the bearer door.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE READ AND THE WRITE AGREE, because they share one derivation. A
//      capability the GET reports false is a command the POST refuses, and the
//      pairing is asserted case by case rather than described.
//   2. THE PERSON PATH ONLY. An ORG-path holder 404s exactly as the web's page
//      `notFound()`s them — and identically to a stranger and to an erased
//      animal, so this URL is no oracle for which tokens are real.
//   3. A REFUSED COMMAND WRITES NOTHING, and the STATUS says whose fact it is:
//      403 for the caller, 409 for the animal's situation, and never one
//      standing in for the other.
//   4. `autoCancelled` SURVIVES TO THE WIRE. `ownerAcceptReturnUseCase` has a
//      success arm in which the animal did NOT come back; a client that rendered
//      it as "listo" would tell somebody their pet is home.
//   5. THE LIMITER FAILS OPEN AND THE GUARD STILL FAILS CLOSED, asserted as a
//      pair — a fail-open limiter that carried the guard open with it would be
//      one line doing two jobs.
//   6. EVERY LIVENESS ARM IS A REAL PATH ON BOTH METHODS, including the
//      DEACTIVATED refusal that is deliberately stricter than the web.

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PET_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "DIM-PAMP-0001";

type WriteCall = { command: string; args: Record<string, unknown> };

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  access: null as null | (() => unknown),
  /** What `readPetReturnState` answers. */
  state: { kind: "can_propose", callerRole: "owner", orgDisplayName: "Refugio Sur" } as Record<
    string,
    unknown
  >,
  /** Every writer call. Empty means nothing was written. */
  writes: [] as WriteCall[],
  /** What each writer answers. */
  acceptResult: { ok: true } as Record<string, unknown>,
  rejectResult: { ok: true } as Record<string, unknown>,
  proposeResult: { ok: true, eventId: "evt-1" } as Record<string, unknown>,
  limiterThrows: false,
  limiterRefuses: false,
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
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string) => {
      if (control.limiterRefuses) {
        throw new actual.RateLimitError(new Date("2026-08-30T15:05:00.000Z"), endpoint);
      }
      if (control.limiterThrows) {
        // PRODUCTION'S OWN MESSAGE SHAPE, not a tidier one — the defect the
        // denuncia lane found one file over: a stub that throws something
        // prettier makes the whole file assert that the message does not matter.
        throw new Error(`UPSERT returned no rows for key "${endpoint}:${OWNER_ID}:hour:0"`);
      }
    },
  };
});

vi.mock("@/lib/infra/pet-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/pet-access")>();
  return {
    ...actual,
    resolvePetHolderAccess: async () =>
      control.access ? control.access() : { kind: "owner", pet: petRow(), holderRole: "owner" },
  };
});

vi.mock("@/src/modules/return-to-owner/application/read-return-state", () => ({
  readPetReturnState: async () => control.state,
}));

vi.mock("@/src/modules/return-to-owner/application/writers", () => ({
  ownerAcceptReturnWriter: async (args: Record<string, unknown>) => {
    control.writes.push({ command: "accept_return", args });
    return control.acceptResult;
  },
  ownerRejectReturnWriter: async (args: Record<string, unknown>) => {
    control.writes.push({ command: "reject_return", args });
    return control.rejectResult;
  },
  ownerProposeReturnToOrgWriter: async (args: Record<string, unknown>) => {
    control.writes.push({ command: "propose_return", args });
    return control.proposeResult;
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

import { GET, POST } from "@/app/api/v1/pets/[publicToken]/return/route";

function petRow(over: Record<string, unknown> = {}) {
  return { id: PET_ID, publicToken: TOKEN, name: "Pampa", status: "lost", ...over };
}

const INBOUND = {
  kind: "inbound_pending",
  actorName: "Ana",
  proposedAt: "2026-08-20T12:00:00.000Z",
  notes: "La tengo yo",
};

function read(headers: HeadersInit = { authorization: "Bearer t" }) {
  return GET(new Request("https://x.test/api/v1/pets/DIM-PAMP-0001/return", { headers }), {
    params: Promise.resolve({ publicToken: TOKEN }),
  });
}

function send(body: unknown, headers: HeadersInit = { authorization: "Bearer t" }) {
  return POST(
    new Request("https://x.test/api/v1/pets/DIM-PAMP-0001/return", {
      method: "POST",
      headers: { ...(headers as Record<string, string>), "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ publicToken: TOKEN }) },
  );
}

async function statusAndCode(res: Response) {
  const body = (await res.json()) as { error?: string };
  return { status: res.status, code: body.error };
}

beforeEach(() => {
  control.live = null;
  control.access = null;
  control.state = { kind: "can_propose", callerRole: "owner", orgDisplayName: "Refugio Sur" };
  control.writes = [];
  control.acceptResult = { ok: true };
  control.rejectResult = { ok: true };
  control.proposeResult = { ok: true, eventId: "evt-1" };
  control.limiterThrows = false;
  control.limiterRefuses = false;
});

describe("GET /pets/{token}/return — the state and the capabilities", () => {
  it("reports can_propose with exactly one capability true", async () => {
    const res = await read();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toEqual({
      kind: "can_propose",
      callerRole: "owner",
      orgDisplayName: "Refugio Sur",
    });
    expect(body.capabilities).toEqual({ canAccept: false, canReject: false, canPropose: true });
    expect(body.petName).toBe("Pampa");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("reports BOTH answer capabilities for an inbound proposal", async () => {
    control.state = INBOUND;
    const body = await (await read()).json();
    expect(body.state).toEqual(INBOUND);
    expect(body.capabilities).toEqual({ canAccept: true, canReject: true, canPropose: false });
  });

  it("reports NO capability at all for the caller's own outgoing proposal", async () => {
    // THE CORRECTION OVER THE WEB'S PAGE, on the wire. That page draws
    // "Aceptar" here and the writer refuses it.
    // MUTATION APPLIED: `canAccept: state.kind !== "can_propose"` in
    // `petReturnCapabilities`. Red.
    control.state = { kind: "awaiting_org" };
    const body = await (await read()).json();
    expect(body.capabilities).toEqual({ canAccept: false, canReject: false, canPropose: false });
  });

  it.each([
    [{ kind: "not_titular", holderRole: "co_owner" }],
    [{ kind: "no_source_org", callerRole: "owner" }],
    [{ kind: "not_the_adopter" }],
  ])("reports no capability for %j", async (state) => {
    control.state = state;
    const body = await (await read()).json();
    expect(body.capabilities).toEqual({ canAccept: false, canReject: false, canPropose: false });
  });

  it("404s an ORG-path holder, exactly as the web's page notFound()s them", async () => {
    // The devolución page resolves access with `eq(ownerships.ownerUserId,
    // user.id)` alone. An organisation member holding this animal through a
    // membership does not reach it, and must not reach this door either — the
    // org side of a return is `custody.transfer` behind `/org/{token}`.
    // MUTATION APPLIED: `if (access.kind === "none")` instead of
    // `access.kind !== "owner"`. Red.
    control.access = () => ({
      kind: "org",
      pet: petRow(),
      organization: { id: ORG_ID },
      membership: { id: "m-1" },
      eventAuthorship: {
        authorRole: "shelter",
        authorOrganizationId: ORG_ID,
        authorVerified: false,
      },
    });
    expect(await statusAndCode(await read())).toEqual({ status: 404, code: "not_found" });
  });

  it("404s an erased animal and a stranger's token identically", async () => {
    // `{ kind: "none" }` is what `resolvePetHolderAccess` answers for BOTH,
    // because both of its paths filter `isNull(pets.deletedAt)`. This route opens
    // no second read of `pets`, so there is no second place for that predicate
    // to be forgotten.
    control.access = () => ({ kind: "none" });
    expect(await statusAndCode(await read())).toEqual({ status: 404, code: "not_found" });
  });
});

describe("POST /pets/{token}/return — the capability gate is the read's own", () => {
  it("accepts when the state says an inbound proposal is addressed to the caller", async () => {
    control.state = INBOUND;
    const res = await send({ command: "accept_return" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      command: "accept_return",
      autoCancelled: false,
      reason: null,
    });
    expect(control.writes).toEqual([
      { command: "accept_return", args: { userId: OWNER_ID, petPublicToken: TOKEN } },
    ]);
  });

  it("REFUSES an accept on the caller's own outgoing proposal, and writes nothing", async () => {
    // The web page's defect, refused rather than reproduced. 409 and not 403:
    // nothing is wrong with the caller — the proposal is simply not one they can
    // answer, and re-reading is the move.
    // MUTATION APPLIED: answer 403 `return_forbidden` for `awaiting_org`. Red.
    control.state = { kind: "awaiting_org" };
    expect(await statusAndCode(await send({ command: "accept_return" }))).toEqual({
      status: 409,
      code: "return_no_proposal",
    });
    expect(control.writes).toEqual([]);
  });

  it("REFUSES an accept with 403 when the caller holds a role this feature refuses", async () => {
    // 403 and not 409, and the pairing with the case above is the point: a
    // co-owner is told it is not their action, and an owner with nothing to
    // answer is told to look again. Collapsing the two would send somebody
    // hunting for a permission when the proposal had simply been cancelled.
    // MUTATION APPLIED: return `return_no_proposal` 409 for `not_titular`. Red.
    control.state = { kind: "not_titular", holderRole: "co_owner" };
    expect(await statusAndCode(await send({ command: "accept_return" }))).toEqual({
      status: 403,
      code: "return_forbidden",
    });
    expect(control.writes).toEqual([]);
  });

  it("REFUSES a propose while a proposal is already in flight", async () => {
    control.state = INBOUND;
    expect(
      await statusAndCode(await send({ command: "propose_return", reason: "other", notes: null })),
    ).toEqual({ status: 409, code: "return_already_pending" });
    expect(control.writes).toEqual([]);
  });

  it("REFUSES a propose with return_no_source_org when nothing names an organisation", async () => {
    // STRUCTURAL, not transient — its own code so a client can say "contactá al
    // refugio" instead of offering the button again.
    control.state = { kind: "no_source_org", callerRole: "owner" };
    expect(
      await statusAndCode(await send({ command: "propose_return", reason: "other", notes: null })),
    ).toEqual({ status: 409, code: "return_no_source_org" });
    expect(control.writes).toEqual([]);
  });

  it("REFUSES a propose with 403 when an adoption names somebody else", async () => {
    control.state = { kind: "not_the_adopter" };
    expect(
      await statusAndCode(await send({ command: "propose_return", reason: "other", notes: null })),
    ).toEqual({ status: 403, code: "return_forbidden" });
    expect(control.writes).toEqual([]);
  });

  it("REFUSES an accept when there is nothing to answer", async () => {
    expect(await statusAndCode(await send({ command: "accept_return" }))).toEqual({
      status: 409,
      code: "return_no_proposal",
    });
    expect(control.writes).toEqual([]);
  });
});

describe("POST /pets/{token}/return — what each command does", () => {
  it("carries `autoCancelled` and its REASON through to the wire", async () => {
    // THE SUCCESS THAT IS NOT A SUCCESS. `ownerAcceptReturnUseCase` answers
    // `{ ok: true, autoCancelled: true, reason }` when the proposal's
    // preconditions no longer hold — it cancels instead of transferring. A
    // client that rendered a plain 200 as "listo, la tenés" would tell somebody
    // their animal came back when it did not.
    //
    // MUTATION APPLIED: `autoCancelled: false` unconditionally in the ack. Red.
    // MUTATION APPLIED: `reason: null` unconditionally. Red — the sentence is
    // the only thing that says WHICH precondition failed.
    control.state = INBOUND;
    control.acceptResult = {
      ok: true,
      autoCancelled: true,
      reason: "La propuesta se canceló automáticamente porque Pampa ya no figura como perdida.",
    };
    const body = await (await send({ command: "accept_return" })).json();
    expect(body).toEqual({
      command: "accept_return",
      autoCancelled: true,
      reason: "La propuesta se canceló automáticamente porque Pampa ya no figura como perdida.",
    });
  });

  it("passes the rejection MOTIVE to the writer, trimmed by the schema", async () => {
    control.state = INBOUND;
    await send({ command: "reject_return", reason: "  Ya la tengo conmigo  " });
    expect(control.writes[0]).toEqual({
      command: "reject_return",
      args: { userId: OWNER_ID, petPublicToken: TOKEN, reason: "Ya la tengo conmigo" },
    });
  });

  it("proposes with the SERVER's clock and the guard's role, never the client's", async () => {
    // `proposedAt` is not a request field — the web offers a date input and a
    // phone that back-dated a proposal would be describing a conversation as
    // having happened when it did not. And `callerRole` comes from the ACCESS
    // GUARD, which ranks roles explicitly, rather than from the unordered
    // `.limit(1)` the web's action re-queries with.
    //
    // MUTATION APPLIED: `callerRole: "owner"` hardcoded. Red on the foster case
    // below.
    control.access = () => ({ kind: "owner", pet: petRow(), holderRole: "foster" });
    control.state = { kind: "can_propose", callerRole: "foster", orgDisplayName: "Refugio Sur" };
    const before = Date.now();
    await send({ command: "propose_return", reason: "space_constraint", notes: "  " });
    const args = control.writes[0].args;
    expect(args.callerRole).toBe("foster");
    expect(args.reason).toBe("space_constraint");
    // A blank note is `null`, not `""` — the contract's own transform.
    expect(args.notes).toBeNull();
    expect(Date.parse(args.proposedAt as string)).toBeGreaterThanOrEqual(before);
  });

  it("answers 500 without echoing the writer's sentence", async () => {
    control.state = INBOUND;
    control.acceptResult = { error: "No se pudo completar la devolución: connection terminated" };
    const res = await send({ command: "accept_return" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "return_failed" });
  });
});

describe("POST /pets/{token}/return — the request envelope", () => {
  it.each([
    [{ command: "reject_return" }],
    [{ command: "reject_return", reason: "   " }],
    [{ command: "reject_return", reason: "x".repeat(501) }],
    [{ command: "propose_return", reason: "cualquier_cosa", notes: null }],
    [{ command: "propose_return", notes: null }],
    [{ command: "propose_return", reason: "other", notes: "x".repeat(1001) }],
    [{ command: "cancel_return" }],
    [{}],
  ])("answers 400 invalid_request for %j and writes nothing", async (body) => {
    // THE REASON ENUM IS THE LOAD-BEARING ROW. `custody_transfer_proposed`
    // accepts more `reason` values than this flow does — they are valid for an
    // ORG-initiated proposal — and `ownerProposeReturnToOrgFormAction` narrows
    // to exactly four with its own `OWNER_RETURN_REASONS` set. A phone that
    // could post one of the others would be writing a payload the browser
    // cannot.
    // MUTATION APPLIED: `z.string()` instead of `z.enum(OWNER_RETURN_REASONS)`.
    // Red on the fourth row.
    control.state = INBOUND;
    expect(await statusAndCode(await send(body))).toEqual({
      status: 400,
      code: "invalid_request",
    });
    expect(control.writes).toEqual([]);
  });

  it("answers 400 for a body that is not JSON at all", async () => {
    expect(await statusAndCode(await send("{not json"))).toEqual({
      status: 400,
      code: "invalid_request",
    });
  });

  it("answers 401 auth_required with no Authorization header on BOTH methods", async () => {
    expect(await statusAndCode(await read({}))).toEqual({ status: 401, code: "auth_required" });
    expect(await statusAndCode(await send({ command: "accept_return" }, {}))).toEqual({
      status: 401,
      code: "auth_required",
    });
    expect(control.writes).toEqual([]);
  });
});

describe("POST /pets/{token}/return — liveness, and the limiter's two directions", () => {
  it.each([
    ["NO_SESSION", 401, "auth_expired"],
    ["ACCOUNT_ERASED", 403, "account_erased"],
    ["DEACTIVATED", 403, "account_deactivated"],
    ["SHIFT_EXPIRED", 401, "session_shift_expired"],
    ["MAINTENANCE", 503, "temporarily_unavailable"],
  ])("refuses %s with %i on both methods and writes nothing", async (reason, status, code) => {
    // DEACTIVATED IS THE ONE THAT IS A DECISION. `requireUserOrRedirect` passes a
    // deactivated account on purpose, so the browser's devolución page serves
    // one and this door does not. Pinned so it stays a decision rather than
    // becoming drift — the same divergence `me/pet-claims` records.
    control.live = () => ({ ok: false, reason, supabase: {}, user: null, error: "no" });
    control.state = INBOUND;
    expect(await statusAndCode(await read())).toEqual({ status, code });
    expect(await statusAndCode(await send({ command: "accept_return" }))).toEqual({ status, code });
    expect(control.writes).toEqual([]);
  });

  it("answers 429 when the limiter genuinely refuses", async () => {
    control.limiterRefuses = true;
    control.state = INBOUND;
    expect(await statusAndCode(await send({ command: "accept_return" }))).toEqual({
      status: 429,
      code: "rate_limited",
    });
    expect(control.writes).toEqual([]);
  });

  it("FAILS OPEN when the limiter's own storage is broken", async () => {
    // MUTATION APPLIED: `return false` in `spendBudget`'s catch. Red — a limiter
    // outage would then stand between somebody and the animal being handed back
    // to them.
    control.limiterThrows = true;
    control.state = INBOUND;
    expect((await send({ command: "accept_return" })).status).toBe(200);
    expect(control.writes).toHaveLength(1);
  });

  it("keeps the CAPABILITY gate CLOSED while the limiter is broken", async () => {
    // THE PAIR, and the argument only works as one. A fail-open limiter that
    // carried the gate open with it would be a single line doing two jobs, and
    // the first half would look correct on its own.
    control.limiterThrows = true;
    control.state = { kind: "not_titular", holderRole: "co_owner" };
    expect(await statusAndCode(await send({ command: "accept_return" }))).toEqual({
      status: 403,
      code: "return_forbidden",
    });
    expect(control.writes).toEqual([]);
  });
});
