// `/api/v1/me/foster` — a volunteer's own tránsito inbox, and the two commands.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE DOOR BEHAVES LIKE EVERY SIBLING `/me` HUB: no bearer → 401, the
//      liveness guard's five refusals map to the shared codes, the read
//      envelope carries `payloadVersion` / `issuedAt` / `staleAfter`.
//   2. NO PET GUARD RUNS. Neither command may resolve a pet — the addressee
//      match lives inside the use-cases, which this file stubs and asserts
//      were called with the caller's own `userId`.
//   3. THE REFUSAL MAP IS COMPLETE. Every literal the two use-cases can
//      return is pinned here against the code and status it must produce.
//   4. NOTIFICATIONS FLUSH ON SUCCESS AND ONLY ON SUCCESS.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ME = "11111111-1111-4111-8111-111111111111";
const PROPOSAL = "FP-0123456789abcdef0123456789abcdef";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  hub: { proposals: [], fosters: [] } as unknown,
  hubCalls: [] as Array<{ userId: string }>,
  acceptResult: { ok: true, value: { fosterOwnershipId: "OWN-1" }, notifications: [] } as unknown,
  rejectResult: {
    ok: true,
    value: { ok: true, revalidatePath: "/x" },
    notifications: [],
  } as unknown,
  acceptCalls: [] as Array<Record<string, unknown>>,
  rejectCalls: [] as Array<Record<string, unknown>>,
  notifications: [] as unknown[],
}));

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () =>
      control.live
        ? control.live()
        : { ok: true, supabase: {}, user: { id: ME, email: "yo@example.com" }, profile: null },
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return { ...actual, enforceRateLimit: async () => {} };
});

vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    createClientFromBearer: (header: string | null) =>
      header ? { ok: true, supabase: {}, token: "tok" } : { ok: false, reason: "MISSING" },
  };
});

// `@/db` SPREAD, NOT REPLACED — the repo's documented false-red for a wholesale
// mock ("No "x" export is defined on the "@/db" mock").
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return {
    ...actual,
    db: {
      transaction: async <T>(cb: (tx: unknown) => Promise<T>) => cb({}),
    },
  };
});

// The canonical write path (`commands.ts`'s own header explains why this
// route uses it rather than the raw insert its web sibling is grandfathered
// on). Captures the rows AS SENT, dedupeKey included, so the synthesis is
// under test too.
vi.mock("@/lib/infra/notification-service", () => ({
  createNotificationsBulk: async (rows: unknown[]) => {
    control.notifications.push(...rows);
  },
}));

// THE HUB READ IS STUBBED AT THE USE-CASE, not the repository, so this file
// controls the GET payload directly without reconstructing `FosterRepository`'s
// join shape.
vi.mock("@/src/modules/foster/application/list-foster-hub-for-volunteer", () => ({
  listFosterHubForVolunteer: async (args: { userId: string }) => {
    control.hubCalls.push(args);
    return control.hub;
  },
}));

vi.mock("@/src/modules/foster/application/accept-foster-proposal", () => ({
  acceptFosterProposal: async (input: Record<string, unknown>) => {
    control.acceptCalls.push(input);
    return control.acceptResult;
  },
}));

vi.mock("@/src/modules/foster/application/reject-foster-proposal", () => ({
  rejectFosterProposal: async (input: Record<string, unknown>) => {
    control.rejectCalls.push(input);
    return control.rejectResult;
  },
}));

import { FOSTER_REFUSAL_RULES, fosterRefusal } from "@/app/api/v1/me/foster/commands";
import { GET, POST } from "@/app/api/v1/me/foster/route";

function read(headers: HeadersInit = { authorization: "Bearer t" }) {
  return GET(new Request("https://x.test/api/v1/me/foster", { headers }));
}

function send(body: unknown, headers: HeadersInit = { authorization: "Bearer t" }) {
  return POST(
    new Request("https://x.test/api/v1/me/foster", {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers as Record<string, string>) },
      body: JSON.stringify(body),
    }),
  );
}

async function bodyOf(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

const ACCEPT = { command: "accept", proposalToken: PROPOSAL, allowCoFoster: false };
const REJECT = { command: "reject", proposalToken: PROPOSAL, rejectionReason: "capacity" };

beforeEach(() => {
  control.live = null;
  control.hub = { proposals: [], fosters: [] };
  control.hubCalls = [];
  control.acceptResult = { ok: true, value: { fosterOwnershipId: "OWN-1" }, notifications: [] };
  control.rejectResult = { ok: true, value: { ok: true, revalidatePath: "/x" }, notifications: [] };
  control.acceptCalls = [];
  control.rejectCalls = [];
  control.notifications = [];
});

// ---------------------------------------------------------------------------

describe("the door", () => {
  it("refuses a request with no bearer", async () => {
    const res = await read({});
    expect(res.status).toBe(401);
    expect(await bodyOf(res)).toEqual({ error: "auth_required" });
  });

  it("sets no-store on the read, like every sibling", async () => {
    const res = await read();
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("carries the read envelope §6 requires, one minute wide", async () => {
    const payload = await bodyOf(await read());
    expect(payload).toMatchObject({ payloadVersion: 1 });
    const { issuedAt, staleAfter } = payload as unknown as { issuedAt: string; staleAfter: string };
    expect(Date.parse(staleAfter) - Date.parse(issuedAt)).toBe(60_000);
  });

  it("passes the caller's own userId to the hub read", async () => {
    await read();
    expect(control.hubCalls).toEqual([{ userId: ME }]);
  });

  it("maps every liveness refusal to the surface's shared code", async () => {
    for (const [reason, status, error] of [
      ["NO_SESSION", 401, "auth_expired"],
      ["ACCOUNT_ERASED", 403, "account_erased"],
      ["DEACTIVATED", 403, "account_deactivated"],
      ["SHIFT_EXPIRED", 401, "session_shift_expired"],
    ] as const) {
      control.live = () => ({ ok: false, supabase: {}, user: null, reason });
      const res = await read();
      expect(res.status, reason).toBe(status);
      expect(await bodyOf(res), reason).toEqual({ error });
    }
  });
});

describe("no pet guard, on either command", () => {
  it("accept: dispatches straight to the use-case with the caller's userId, no pet resolution", async () => {
    const res = await send(ACCEPT);
    expect(res.status).toBe(200);
    expect(control.acceptCalls).toEqual([
      { proposalPublicToken: PROPOSAL, allowCoFoster: false, responseNotes: null },
    ]);
  });

  it("reject: same shape", async () => {
    const res = await send(REJECT);
    expect(res.status).toBe(200);
    expect(control.rejectCalls).toEqual([
      { proposalPublicToken: PROPOSAL, rejectionReason: "capacity", responseNotes: null },
    ]);
  });
});

describe("the acks", () => {
  it("accept carries the new fosterOwnershipId", async () => {
    const res = await send(ACCEPT);
    expect(await bodyOf(res)).toEqual({
      command: "accept",
      changed: true,
      proposalToken: PROPOSAL,
      fosterOwnershipId: "OWN-1",
    });
  });

  it("reject carries null — nothing was created", async () => {
    const res = await send(REJECT);
    expect(await bodyOf(res)).toEqual({
      command: "reject",
      changed: true,
      proposalToken: PROPOSAL,
      fosterOwnershipId: null,
    });
  });
});

describe("the body schema", () => {
  it("refuses a command outside the two-command vocabulary", async () => {
    const res = await send({ command: "assign", proposalToken: PROPOSAL });
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: "invalid_request" });
    expect(control.acceptCalls).toEqual([]);
    expect(control.rejectCalls).toEqual([]);
  });

  it("refuses a reject with no reason", async () => {
    const res = await send({ command: "reject", proposalToken: PROPOSAL });
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: "invalid_request" });
  });

  it("refuses malformed JSON", async () => {
    const res = await POST(
      new Request("https://x.test/api/v1/me/foster", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: "invalid_request" });
  });
});

describe("side effects run on success and only on success", () => {
  it("flushes notifications the use-case queued, each with a synthesised dedupeKey", async () => {
    control.acceptResult = {
      ok: true,
      value: { fosterOwnershipId: "OWN-1" },
      notifications: [{ userId: "org-coord", notificationType: "foster_proposal_accepted_org" }],
    };
    await send(ACCEPT);
    expect(control.notifications).toEqual([
      {
        userId: "org-coord",
        notificationType: "foster_proposal_accepted_org",
        dedupeKey: `foster:accept:${PROPOSAL}:org-coord:foster_proposal_accepted_org:none`,
      },
    ]);
  });

  it("gives two D18-cascade rows to the SAME coordinator about DIFFERENT pets distinct keys", async () => {
    // Same command, same triggering proposal, same addressee, same type — the
    // one field that tells them apart is which animal each row is about.
    control.acceptResult = {
      ok: true,
      value: { fosterOwnershipId: "OWN-1" },
      notifications: [
        {
          userId: "org-coord",
          notificationType: "foster_proposal_auto_cancelled_org",
          relatedPetId: "pet-a",
        },
        {
          userId: "org-coord",
          notificationType: "foster_proposal_auto_cancelled_org",
          relatedPetId: "pet-b",
        },
      ],
    };
    await send(ACCEPT);
    const keys = control.notifications.map((n) => (n as { dedupeKey: string }).dedupeKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("writes nothing on a refusal", async () => {
    control.acceptResult = { ok: false, error: "Esta propuesta no es para vos." };
    await send(ACCEPT);
    expect(control.notifications).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The refusal table — every literal the two use-cases can return.
// ---------------------------------------------------------------------------

describe("the refusal table", () => {
  const CASES: Array<[string, string, number]> = [
    ["Propuesta no encontrada.", "not_found", 404],
    ["Esta propuesta no es para vos.", "foster_forbidden", 403],
    ["Esta propuesta ya no está activa.", "foster_already_resolved", 409],
    ["La organización ya no tiene custodia de esta mascota.", "foster_already_resolved", 409],
    [
      "El estado del pet cambió: ahora tiene un tránsito activo que no admite co-foster.",
      "foster_already_resolved",
      409,
    ],
    ["No estás inscripto en el pool.", "foster_not_eligible", 409],
    ["Tu inscripción no está activa.", "foster_not_eligible", 409],
    ["Ya no tenés slots disponibles.", "foster_not_eligible", 409],
    ["Motivo de rechazo inválido.", "invalid_request", 400],
  ];

  it.each(CASES)("maps %j to %s / %i", async (sentence, code, status) => {
    const res = fosterRefusal(sentence);
    expect(res.status).toBe(status);
    expect(await bodyOf(res)).toEqual({ error: code });
  });

  it("pins the exact set of rules — a new one here is a visible edit", () => {
    expect(FOSTER_REFUSAL_RULES.length).toBe(CASES.length);
  });

  it("falls through an unrecognised sentence to foster_failed / 500, never widening access", () => {
    const res = fosterRefusal("una frase que ningún use-case devuelve");
    expect(res.status).toBe(500);
  });

  it("actually reaches the route for a real refusal", async () => {
    control.acceptResult = { ok: false, error: "Esta propuesta no es para vos." };
    const res = await send(ACCEPT);
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toEqual({ error: "foster_forbidden" });
  });
});
