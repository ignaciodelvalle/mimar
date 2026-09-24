// `/api/v1/me/transfers` — the transfer hub, and the four commands.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE ADDRESSEE RULE IS `validateRecipientMatch`, NOT A CUSTODY CHECK, and
//      it is the REAL function rather than a mock. This is the one place a
//      widening bug on this surface would live: the caller who accepts a
//      transfer holds no `ownerships` row for the animal, so any guard shaped
//      like the sibling endpoints' would refuse exactly them. The list read runs
//      the genuine `listTransfersForUser` over a stubbed REPOSITORY, so what is
//      under test is the rule and not the SQL.
//   2. AN ID BEATS AN E-MAIL. When `to_owner_id` is set, the match is by id
//      ONLY — a stranger whose address happens to equal `to_owner_email` is not
//      the addressee. A fallback that tried the e-mail anyway would hand an
//      animal to the wrong person, and nothing else in the stack would notice.
//   3. `callerEmail` COMES FROM THE VERIFIED SESSION. A body that could name it
//      would be a way to claim any open invitation whose address you can guess.
//   4. THE REFUSAL MAP IS COMPLETE. Every literal the four use-cases can return
//      is pinned here against the code and status it must produce — the fence
//      for the one part of `commands.ts` that cannot be derived from an import.
//   5. THE ASYMMETRIES ARE THE WEB'S. `accept` refuses an expired proposal;
//      `reject` deliberately does not. `cancel` is the sender's, never a
//      co-owner's.
//   6. THE SIDE EFFECTS RUN ON SUCCESS AND ONLY ON SUCCESS — the audit row
//      carries the web's own action name, so a transfer performed from a phone
//      is indistinguishable in `audit_log` from one performed in a browser.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const PET_ID = "22222222-2222-4222-8222-222222222222";
const MY_EMAIL = "yo@example.com";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  /** Rows the repository answers the list query with. */
  rows: [] as Array<Record<string, unknown>>,
  /** Every argument set the list query was asked with. */
  listArgs: [] as Array<{ userId: string; callerEmail: string }>,
  /** What each write use-case returns. Keyed by command. */
  results: {} as Record<string, unknown>,
  /** Every use-case call, with the arguments it actually received. */
  calls: [] as Array<{ command: string; input: Record<string, unknown> }>,
  /** Every side effect that reached the repository. */
  notifications: [] as unknown[],
  audits: [] as Array<{ actorUserId: string; action: string; payload: Record<string, unknown> }>,
}));

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () =>
      control.live
        ? control.live()
        : {
            ok: true,
            supabase: {},
            // `emailConfirmed` is what the real guard folds out of GoTrue's
            // `email_confirmed_at` (A09-1). The default is the ordinary account.
            user: { id: ME, email: MY_EMAIL, emailConfirmed: true },
            profile: null,
          },
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

// THE REPOSITORY IS STUBBED, THE USE-CASE IS NOT. `listTransfersForUser` is what
// calls `validateRecipientMatch`, so mocking it would delete the subject of half
// this file.
vi.mock("@/src/modules/transfers/infrastructure/transfers-repository", () => ({
  TransfersRepository: {
    listTransfersForUser: async (args: { userId: string; callerEmail: string }) => {
      control.listArgs.push(args);
      return control.rows;
    },
    insertNotifications: async (values: unknown[]) => {
      control.notifications.push(...values);
    },
    insertAuditLog: async (entry: {
      actorUserId: string;
      action: string;
      payload: Record<string, unknown>;
    }) => {
      control.audits.push(entry);
    },
    transaction: async <T>(cb: (tx: unknown) => Promise<T>) => cb({}),
  },
}));

function stubWriter(command: string) {
  return async (input: Record<string, unknown>) => {
    control.calls.push({ command, input });
    return control.results[command] ?? { ok: true, value: {}, notifications: [] };
  };
}

vi.mock("@/src/modules/transfers/application/initiate-pet-transfer", () => ({
  initiatePetTransfer: stubWriter("initiate"),
}));
vi.mock("@/src/modules/transfers/application/accept-pet-transfer", () => ({
  acceptPetTransfer: stubWriter("accept"),
}));
vi.mock("@/src/modules/transfers/application/reject-pet-transfer", () => ({
  rejectPetTransfer: stubWriter("reject"),
}));
vi.mock("@/src/modules/transfers/application/cancel-pet-transfer", () => ({
  cancelPetTransfer: stubWriter("cancel"),
}));

import { GET, POST } from "@/app/api/v1/me/transfers/route";

const IN_A_WEEK = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
const LAST_WEEK = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);

const BASE_TRANSFER = {
  id: "row-1",
  publicToken: "PTR-ABCD-2345",
  petId: PET_ID,
  fromOwnerId: OTHER,
  toOwnerId: ME as string | null,
  toOwnerEmail: MY_EMAIL,
  status: "pending",
  reason: "gift",
  note: null,
  rejectionReason: null,
  initiatedAt: new Date("2026-08-20T10:00:00.000Z"),
  respondedAt: null as Date | null,
  expiresAt: IN_A_WEEK,
};

function row(over: { transfer?: Record<string, unknown> } & Record<string, unknown> = {}) {
  const { transfer: transferOver, ...rest } = over;
  return {
    transfer: { ...BASE_TRANSFER, ...transferOver },
    petName: "Pampa",
    petToken: "DIM-PAMP-0001",
    petSpecies: "dog",
    fromDisplayName: "Vecina",
    toDisplayName: null,
    ...rest,
  };
}

function read(headers: HeadersInit = { authorization: "Bearer t" }) {
  return GET(new Request("https://x.test/api/v1/me/transfers", { headers }));
}

function send(body: unknown, headers: HeadersInit = { authorization: "Bearer t" }) {
  return POST(
    new Request("https://x.test/api/v1/me/transfers", {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers as Record<string, string>) },
      body: JSON.stringify(body),
    }),
  );
}

async function bodyOf(res: Response) {
  return (await res.json()) as Record<string, never>;
}

beforeEach(() => {
  control.live = null;
  control.rows = [];
  control.listArgs = [];
  control.results = {};
  control.calls = [];
  control.notifications = [];
  control.audits = [];
});

// ---------------------------------------------------------------------------

describe("the door", () => {
  it("refuses a request with no bearer, and says which kind of refusal it is", async () => {
    const res = await read({});
    expect(res.status).toBe(401);
    expect(await bodyOf(res)).toEqual({ error: "auth_required" });
  });

  it("sets no-store on the read, like every sibling", async () => {
    const res = await read();
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("carries the read envelope §6 requires, built by the shared helper", async () => {
    // `staleAfter` is what a native client shows next to "esto es lo que el
    // servidor sabía a las 14:32". It matters more here than on most screens:
    // the rows move without the caller doing anything (the other party answers,
    // the cron expires one), so a stale list offers "Aceptar" on something gone.
    const payload = await bodyOf(await read());
    expect(payload).toMatchObject({ payloadVersion: 1 });
    const { issuedAt, staleAfter } = payload as unknown as {
      issuedAt: string;
      staleAfter: string;
    };
    expect(Date.parse(staleAfter) - Date.parse(issuedAt)).toBe(60_000);
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

describe("the addressee rule is validateRecipientMatch, not a custody check", () => {
  it("lists a proposal addressed to me by id as incoming, and offers all three answers", async () => {
    control.rows = [row()];
    const payload = await bodyOf(await read());

    expect(payload).toMatchObject({
      incoming: {
        pending: [
          {
            transferToken: "PTR-ABCD-2345",
            direction: "incoming",
            counterpartyName: "Vecina",
            capabilities: { canAccept: true, canReject: true, canCancel: false },
          },
        ],
      },
    });
  });

  it("matches an OPEN invitation by e-mail — the caller holds no ownership row at all", async () => {
    // This is the case the whole feature exists for: somebody was offered an
    // animal at an address that had no account when the offer was made.
    control.rows = [row({ transfer: { toOwnerId: null, toOwnerEmail: MY_EMAIL } })];
    const payload = await bodyOf(await read());
    expect(payload).toMatchObject({
      incoming: { pending: [{ capabilities: { canAccept: true } }] },
    });
  });

  // A09-1: the e-mail arm needs a PROVED address, on the READ as well as the
  // write. This read is what hands out `transferToken`, and a token is the only
  // thing the accept door asks for besides the addressee match — so gating only
  // `canAccept` would still show a stranger somebody else's proposal and the
  // credential to answer it with.
  it("A09-1: an UNCONFIRMED session asks the repository with an EMPTY e-mail", async () => {
    control.live = () => ({
      ok: true,
      supabase: {},
      user: { id: ME, email: MY_EMAIL, emailConfirmed: false },
      profile: null,
    });
    control.rows = [];
    await read();

    // Empty is the documented degradation: the repository predicate falls back
    // to `to_owner_id = me`, so an open e-mail invitation cannot be selected at
    // all and its token never leaves the database.
    expect(control.listArgs).toEqual([{ userId: ME, callerEmail: "" }]);
  });

  it("A09-1: a CONFIRMED session still asks with the address (non-vacuity control)", async () => {
    control.rows = [];
    await read();
    expect(control.listArgs).toEqual([{ userId: ME, callerEmail: MY_EMAIL }]);
  });

  it("A09-1: an UNCONFIRMED session cannot accept an open e-mail invitation", async () => {
    control.live = () => ({
      ok: true,
      supabase: {},
      user: { id: ME, email: MY_EMAIL, emailConfirmed: false },
      profile: null,
    });
    control.rows = [row({ transfer: { toOwnerId: null, toOwnerEmail: MY_EMAIL } })];
    const payload = await bodyOf(await read());
    expect(payload).toMatchObject({
      incoming: { pending: [{ capabilities: { canAccept: false, canReject: false } }] },
    });
  });

  it("does NOT fall back to the e-mail when to_owner_id names somebody else", async () => {
    // THE WIDENING BUG THIS FILE EXISTS FOR. `to_owner_id` is set to another
    // account and `to_owner_email` happens to be mine — a resolved recipient who
    // later changed their address, or a collision. `validateRecipientMatch`
    // matches by ID ONLY in that case, and a fallback would hand this animal to
    // the wrong person.
    control.rows = [row({ transfer: { toOwnerId: OTHER, toOwnerEmail: MY_EMAIL } })];
    const payload = await bodyOf(await read());
    expect(payload).toMatchObject({
      incoming: { pending: [{ capabilities: { canAccept: false, canReject: false } }] },
    });
  });

  it("puts a proposal I sent in outgoing, cancellable, never acceptable", async () => {
    control.rows = [
      row({ transfer: { fromOwnerId: ME, toOwnerId: OTHER, toOwnerEmail: "x@y.com" } }),
    ];
    const payload = await bodyOf(await read());
    expect(payload).toMatchObject({
      incoming: { pending: [] },
      outgoing: [
        {
          direction: "outgoing",
          toEmail: "x@y.com",
          capabilities: { canAccept: false, canReject: false, canCancel: true },
        },
      ],
    });
  });

  it("keeps the sender's own e-mail off an incoming row entirely", async () => {
    control.rows = [row()];
    const payload = await bodyOf(await read());
    // `toEmail` is MY address — the one the proposal was sent to. Nothing in the
    // payload names the sender's, and nothing can: `profiles` has no email
    // column, so this read has no source for one.
    expect(JSON.stringify(payload)).not.toContain("vecina@");
    expect(payload).toMatchObject({ incoming: { pending: [{ toEmail: MY_EMAIL }] } });
  });
});

describe("the capabilities are the writers' asymmetries, not a tidy function of status", () => {
  it("refuses accept on an expired proposal but still offers reject", async () => {
    // `acceptPetTransfer` checks expiry (accept-pet-transfer.ts:67-69);
    // `rejectPetTransfer` deliberately does not (reject-pet-transfer.ts:53-66).
    // Taking the reject control away would leave a row nobody can clear.
    control.rows = [row({ transfer: { expiresAt: LAST_WEEK } })];
    const payload = await bodyOf(await read());
    expect(payload).toMatchObject({
      incoming: {
        pending: [{ expired: true, capabilities: { canAccept: false, canReject: true } }],
      },
    });
  });

  it("reports `expired` separately from the `expired` STATUS", async () => {
    // The nightly cron writes the status; the flag is true the instant the
    // deadline passes. Between them a row reads `pending` and cannot be accepted.
    control.rows = [row({ transfer: { expiresAt: LAST_WEEK } })];
    const payload = await bodyOf(await read());
    expect(payload).toMatchObject({
      incoming: { pending: [{ status: "pending", expired: true }] },
    });
  });

  it("sections a resolved incoming proposal into history with nothing on offer", async () => {
    control.rows = [
      row({
        transfer: {
          status: "rejected",
          respondedAt: new Date("2026-08-21T10:00:00.000Z"),
          rejectionReason: "no puedo",
        },
      }),
    ];
    const payload = await bodyOf(await read());
    expect(payload).toMatchObject({
      incoming: {
        pending: [],
        history: [
          {
            status: "rejected",
            rejectionReason: "no puedo",
            capabilities: { canAccept: false, canReject: false, canCancel: false },
          },
        ],
      },
    });
  });
});

describe("callerEmail comes from the session and nowhere else", () => {
  it("hands the use-case the verified address, ignoring anything in the body", async () => {
    control.results.accept = {
      ok: true,
      value: { petId: PET_ID, fromOwnerId: OTHER, petPublicToken: "DIM-PAMP-0001" },
      notifications: [],
    };
    await send({
      command: "accept",
      transferToken: "PTR-ABCD-2345",
      callerEmail: "victima@example.com",
    });
    expect(control.calls).toEqual([
      {
        command: "accept",
        input: {
          transferToken: "PTR-ABCD-2345",
          callerEmail: MY_EMAIL,
          // From the session too, and for the same reason: a body that could
          // name it would be a way to declare your own address proved (A09-1).
          callerEmailConfirmed: true,
        },
      },
    ]);
  });

  it("A09-1: an UNCONFIRMED session reaches the accept use-case as such", async () => {
    control.live = () => ({
      ok: true,
      supabase: {},
      user: { id: ME, email: MY_EMAIL, emailConfirmed: false },
      profile: null,
    });
    control.results.accept = {
      ok: true,
      value: { petId: PET_ID, fromOwnerId: OTHER, petPublicToken: "DIM-PAMP-0001" },
      notifications: [],
    };
    await send({ command: "accept", transferToken: "PTR-ABCD-2345" });
    expect(control.calls[0].input).toMatchObject({
      callerEmail: MY_EMAIL,
      callerEmailConfirmed: false,
    });
  });

  it("does not pass an e-mail to cancel at all — that command's party is the sender", async () => {
    control.results.cancel = { ok: true, value: { petId: PET_ID }, notifications: [] };
    await send({ command: "cancel", transferToken: "PTR-ABCD-2345" });
    expect(control.calls[0]?.input).toEqual({ transferToken: "PTR-ABCD-2345" });
  });
});

describe("the refusal map", () => {
  /** Every literal the four P2P use-cases can return, and the code it must become. */
  const REFUSALS: ReadonlyArray<[string, string, number]> = [
    // the ANIMAL refuses — initiate-pet-transfer.ts / owner-transfer-rules.ts
    ["No podés transferir una mascota fallecida.", "transfer_not_allowed", 409],
    [
      "Esta mascota está reportada como perdida. Resolvé el episodio primero.",
      "transfer_not_allowed",
      409,
    ],
    [
      "Hay una disputa de custodia en curso. La transferencia se bloquea.",
      "transfer_not_allowed",
      409,
    ],
    [
      "Un refugio está acompañando la adopción de esta mascota. Antes de transferir la titularidad tenés que dar de baja el acompañamiento.",
      "transfer_not_allowed",
      409,
    ],
    // one account on both sides
    ["No podés transferirte la mascota a vos mismo/a.", "transfer_self", 400],
    ["No podés aceptar tu propia transferencia.", "transfer_self", 400],
    // the CALLER is not this command's party
    ["Solo el dueño actual puede iniciar una transferencia.", "transfer_forbidden", 403],
    ["Solo el emisor puede cancelar la propuesta.", "transfer_forbidden", 403],
    ["Esta propuesta no es para tu cuenta.", "transfer_forbidden", 403],
    ["Esta propuesta no es accesible desde tu cuenta.", "transfer_forbidden", 403],
    // A09-1. The address matched and the ACCOUNT did not prove it. The literal
    // rather than the imported constant on purpose: commands.ts builds the rule
    // from that same constant, so a symbol compared against itself would stay
    // green through any rewording — and an unmapped sentence here answers 500,
    // which the mobile client renders as "volvé a intentarlo en unos minutos" to
    // somebody whose only problem is an unconfirmed mailbox.
    ["Confirmá tu correo electrónico para aceptar esta transferencia.", "transfer_forbidden", 403],
    // time, and answers already given
    ["La transferencia expiró. Pedile al dueño que la inicie de nuevo.", "transfer_expired", 409],
    ["La transferencia ya está accepted.", "transfer_already_resolved", 409],
    ["La transferencia ya está cancelled.", "transfer_already_resolved", 409],
    ["La transferencia ya no está pendiente.", "transfer_already_resolved", 409],
    ["La transferencia ya no es válida: la titularidad cambió.", "transfer_already_resolved", 409],
    ["Ya hay una transferencia pendiente para esta mascota.", "transfer_pending_exists", 409],
    // nothing to act on
    ["Transferencia no encontrada.", "not_found", 404],
    ["No encontramos la mascota.", "not_found", 404],
    ["La mascota ya no existe. La transferencia no es válida.", "not_found", 404],
    // a client out of step with the contract
    ["Motivo inválido.", "invalid_request", 400],
    ["Email inválido.", "invalid_request", 400],
  ];

  it.each(REFUSALS)("maps %s", async (error, code, status) => {
    control.results.accept = { ok: false, error };
    const res = await send({ command: "accept", transferToken: "PTR-ABCD-2345" });
    expect(res.status).toBe(status);
    expect(await bodyOf(res)).toEqual({ error: code });
  });

  it("puts an unrecognised sentence on 500 rather than guessing", async () => {
    // The stated failure mode: a reworded use-case sentence degrades to a server
    // error. It never widens access — a refusal is still a refusal — and this is
    // the assertion that makes the degradation deliberate rather than silent.
    control.results.accept = { ok: false, error: "algo raro pasó" };
    const res = await send({ command: "accept", transferToken: "PTR-ABCD-2345" });
    expect(res.status).toBe(500);
    expect(await bodyOf(res)).toEqual({ error: "transfer_failed" });
  });

  it("does not distinguish an expired proposal from an answered one by accident", async () => {
    // Both sentences begin "La transferencia". If the `ya está` rule were tested
    // first it would still not match "expiró" — but if either were loosened to a
    // bare `includes("La transferencia")` the order would start to matter, and
    // this is the assertion that would go red.
    control.results.accept = {
      ok: false,
      error: "La transferencia expiró. Pedile al dueño que la inicie de nuevo.",
    };
    expect(await bodyOf(await send({ command: "accept", transferToken: "PTR-A" }))).toEqual({
      error: "transfer_expired",
    });
  });

  it("writes nothing when a command is refused", async () => {
    control.results.initiate = {
      ok: false,
      error: "Solo el dueño actual puede iniciar una transferencia.",
    };
    await send({
      command: "initiate",
      petPublicToken: "DIM-PAMP-0001",
      toEmail: "vecina@example.com",
      reason: "gift",
    });
    expect(control.notifications).toEqual([]);
    expect(control.audits).toEqual([]);
  });
});

describe("the acks and the side effects", () => {
  it("tells the client when the address had no account, so it can say so", async () => {
    control.results.initiate = {
      ok: true,
      value: {
        transferToken: "PTR-NEW0-0001",
        petId: PET_ID,
        recipientNeedsInvite: true,
        petName: "Pampa",
      },
      notifications: [{ userId: ME, notificationType: "pet_transfer_initiated" }],
    };
    const res = await send({
      command: "initiate",
      petPublicToken: "DIM-PAMP-0001",
      toEmail: "vecina@example.com",
      reason: "gift",
    });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({
      command: "initiate",
      changed: true,
      transferToken: "PTR-NEW0-0001",
      petPublicToken: null,
      recipientNeedsInvite: true,
    });
  });

  it("hands back the pet token on accept, so the client can land on the credential", async () => {
    control.results.accept = {
      ok: true,
      value: { petId: PET_ID, fromOwnerId: OTHER, petPublicToken: "DIM-PAMP-0001" },
      notifications: [],
    };
    expect(await bodyOf(await send({ command: "accept", transferToken: "PTR-ABCD-2345" }))).toEqual(
      {
        command: "accept",
        changed: true,
        transferToken: "PTR-ABCD-2345",
        petPublicToken: "DIM-PAMP-0001",
        recipientNeedsInvite: null,
      },
    );
  });

  it("writes the audit row under the WEB's action name", async () => {
    // The whole reason the audit write moved into the repository: a transfer
    // performed from a phone has to be indistinguishable in `audit_log` from one
    // performed in a browser, or the row stops being evidence of anything.
    control.results.accept = {
      ok: true,
      value: { petId: PET_ID, fromOwnerId: OTHER, petPublicToken: null },
      notifications: [],
    };
    await send({ command: "accept", transferToken: "PTR-ABCD-2345" });
    expect(control.audits).toEqual([
      {
        actorUserId: ME,
        action: "pet_transfer_accepted",
        payload: {
          transfer_public_token: "PTR-ABCD-2345",
          pet_id: PET_ID,
          from_user_id: OTHER,
        },
      },
    ]);
  });

  it("flushes the use-case's notifications rather than composing its own", async () => {
    const queued = [{ userId: OTHER, notificationType: "pet_transfer_rejected" }];
    control.results.reject = { ok: true, value: { petId: PET_ID }, notifications: queued };
    await send({ command: "reject", transferToken: "PTR-ABCD-2345", reason: "no puedo" });
    expect(control.notifications).toEqual(queued);
    expect(control.calls[0]?.input).toMatchObject({ reason: "no puedo" });
  });
});

describe("the body is validated against the contract", () => {
  it("refuses an unknown command without reaching a use-case", async () => {
    const res = await send({ command: "expire", transferToken: "PTR-ABCD-2345" });
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: "invalid_request" });
    expect(control.calls).toEqual([]);
  });

  it("refuses a malformed body", async () => {
    const res = await POST(
      new Request("https://x.test/api/v1/me/transfers", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toEqual({ error: "invalid_request" });
  });
});
