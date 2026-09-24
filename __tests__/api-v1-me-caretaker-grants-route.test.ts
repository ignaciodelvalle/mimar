// `/api/v1/me/caretaker-grants` — the cuidador-temporal hub, and the five commands.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. TWO GUARDS, NOT ONE, AND NEITHER LEAKS INTO THE OTHER'S COMMANDS. The
//      three titular commands run the web's `requireTitularAccess` shape — a DENY
//      of the `caretaker` role over `resolvePetHolderAccess` — and the two
//      invitee commands run NO pet guard at all, because the caller holds no
//      ownership row on the animal. This is where a widening bug on this surface
//      would live, in either direction: a pet guard on `accept` would refuse the
//      one caller it exists for; an allow-list instead of a deny on `designate`
//      would silently lock out the co-owner, foster and org callers the web
//      admits.
//   2. THE ADDRESSEE RULE IS AN ID-OR-E-MAIL MATCH, and the REAL
//      `listCaretakerGrantsForUser` runs it over a stubbed REPOSITORY, so what is
//      under test is the rule and not the SQL. An id, when set, beats an e-mail.
//   3. `callerEmail` COMES FROM THE VERIFIED SESSION. A body that could name it
//      would be a way to claim any open invitation whose address you can guess.
//   4. THE REFUSAL MAP IS COMPLETE. Every literal the five use-cases can return
//      is pinned here against the code and status it must produce — the fence for
//      the one part of `commands.ts` that cannot be derived from an import.
//   5. THE ASYMMETRIES ARE THE USE-CASES'. `accept` refuses a lapsed period;
//      `reject` deliberately does not. `cancel` needs `pending`, `revoke` needs
//      `accepted`, and the state machine refuses to blur them.
//   6. FIVE COMMANDS, NOT SEVEN. `withdraw` and `return` are refused at the door,
//      because neither is reachable from the web.
//   7. THE SIDE EFFECTS RUN ON SUCCESS AND ONLY ON SUCCESS, and the audit row
//      carries the WEB'S OWN action name, so an arrangement made from a phone is
//      indistinguishable in `audit_log` from one made in a browser.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const PET_ID = "22222222-2222-4222-8222-222222222222";
const MY_EMAIL = "yo@example.com";
const GRANT = "CG-0123456789abcdef0123456789abcdef";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  /** Rows the repository answers the list query with. */
  rows: [] as Array<Record<string, unknown>>,
  /** Every argument set the list query was asked with. */
  listArgs: [] as Array<{ userId: string; callerEmail: string }>,
  /** What `resolvePetHolderAccess` answers. */
  access: { kind: "owner", holderRole: "owner" } as Record<string, unknown>,
  /** Every call the pet guard made — empty is what the invitee commands must produce. */
  accessCalls: [] as Array<{ token: string; userId: string }>,
  /** What each write use-case returns. Keyed by command. */
  results: {} as Record<string, unknown>,
  /** Every use-case call, with the arguments it actually received. */
  calls: [] as Array<{ command: string; input: Record<string, unknown> }>,
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

vi.mock("@/lib/infra/pet-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/pet-access")>();
  return {
    ...actual,
    resolvePetHolderAccess: async (token: string, userId: string) => {
      control.accessCalls.push({ token, userId });
      return control.access.kind === "none"
        ? { kind: "none" }
        : { ...control.access, pet: { id: PET_ID, name: "Pampa" } };
    },
  };
});

vi.mock("@/lib/infra/notification-service", () => ({
  createNotificationsBulk: async (values: unknown[]) => {
    control.notifications.push(...values);
  },
}));

// `@/db` SPREAD, NOT REPLACED. The commands file needs the real `auditLog` table
// object (it is passed to `.values()` and typed against the schema) and a `db`
// that writes nowhere. A wholesale replacement is the repo's documented
// false-red: `No "x" export is defined on the "@/db" mock` reads like a policy
// failure and is a missing export.
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return {
    ...actual,
    db: {
      insert: () => ({
        values: async (entry: {
          actorUserId: string;
          action: string;
          payload: Record<string, unknown>;
        }) => {
          control.audits.push(entry);
        },
      }),
      transaction: async <T>(cb: (tx: unknown) => Promise<T>) => cb({}),
    },
  };
});

// THE REPOSITORY IS STUBBED, THE READ USE-CASE IS NOT. `listCaretakerGrantsForUser`
// is what decides which side of a row the caller is on and which controls they
// get, so mocking it would delete the subject of half this file.
vi.mock("@/src/modules/caretakers/infrastructure/caretakers-repository", () => ({
  CaretakersRepository: {
    listGrantsForUser: async (args: { userId: string; callerEmail: string }) => {
      control.listArgs.push(args);
      return control.rows;
    },
  },
}));

function stubWriter(command: string) {
  return async (input: Record<string, unknown>) => {
    control.calls.push({ command, input });
    return control.results[command] ?? { ok: true, value: {}, notifications: [] };
  };
}

vi.mock("@/src/modules/caretakers/application/designate-caretaker", () => ({
  designateCaretaker: stubWriter("designate"),
}));
vi.mock("@/src/modules/caretakers/application/accept-caretaker-grant", () => ({
  acceptCaretakerGrant: stubWriter("accept"),
}));
vi.mock("@/src/modules/caretakers/application/reject-caretaker-grant", () => ({
  rejectCaretakerGrant: stubWriter("reject"),
}));
vi.mock("@/src/modules/caretakers/application/cancel-caretaker-grant", () => ({
  cancelCaretakerGrant: stubWriter("cancel"),
}));
vi.mock("@/src/modules/caretakers/application/end-caretaker-grant", () => ({
  endCaretakerGrant: stubWriter("revoke"),
}));

import { caretakerRefusal } from "@/app/api/v1/me/caretaker-grants/commands";
import { GET, POST } from "@/app/api/v1/me/caretaker-grants/route";
import { MAX_GRANT_DURATION_DAYS } from "@/src/modules/caretakers/domain/types";
import { CARETAKER_MAX_DURATION_DAYS } from "@dim/contract/input";

const IN_A_MONTH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const LAST_MONTH = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

const BASE_GRANT = {
  id: "row-1",
  publicToken: GRANT,
  petId: PET_ID,
  grantedByUserId: OTHER,
  caretakerUserId: ME as string | null,
  caretakerEmail: MY_EMAIL,
  status: "pending",
  startsAt: new Date("2026-08-20T03:00:00.000Z"),
  endsAt: IN_A_MONTH,
  note: null,
  ownershipId: null,
  reminderSentAt: null,
  publicContactConsentAt: null,
};

function row(over: { grant?: Record<string, unknown> } & Record<string, unknown> = {}) {
  const { grant: grantOver, ...rest } = over;
  return {
    grant: { ...BASE_GRANT, ...grantOver },
    petName: "Pampa",
    petToken: "DIM-PAMP-0001",
    petSpecies: "dog",
    grantedByDisplayName: "Vecina",
    caretakerDisplayName: null,
    ...rest,
  };
}

function read(headers: HeadersInit = { authorization: "Bearer t" }) {
  return GET(new Request("https://x.test/api/v1/me/caretaker-grants", { headers }));
}

function send(body: unknown, headers: HeadersInit = { authorization: "Bearer t" }) {
  return POST(
    new Request("https://x.test/api/v1/me/caretaker-grants", {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers as Record<string, string>) },
      body: JSON.stringify(body),
    }),
  );
}

async function bodyOf(res: Response) {
  return (await res.json()) as Record<string, never>;
}

const DESIGNATE = {
  command: "designate",
  petPublicToken: "DIM-PAMP-0001",
  inviteeEmail: "vecina@example.com",
  startsAt: "2026-09-01",
  endsAt: "2026-09-15",
};

beforeEach(() => {
  control.live = null;
  control.rows = [];
  control.listArgs = [];
  control.access = { kind: "owner", holderRole: "owner" };
  control.accessCalls = [];
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
    // One minute, because the rows move without the caller doing anything: the
    // invitee answers, the titular withdraws, the nightly sweep expires one.
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

describe("five commands, not seven", () => {
  it("refuses withdraw and return at the schema, before any guard runs", async () => {
    // Neither is reachable from a browser: `withdrawCaretakerGrantAction` has no
    // caller in `app/**`, and `return` has no action wrapper at all. Accepting
    // either here would be a native-only way to end somebody else's arrangement.
    for (const command of ["withdraw", "return"]) {
      const res = await send({ command, grantToken: GRANT });
      expect(res.status, command).toBe(400);
      expect(await bodyOf(res), command).toEqual({ error: "invalid_request" });
    }
    expect(control.calls).toEqual([]);
    expect(control.accessCalls).toEqual([]);
  });

  it("refuses the cron actions too", async () => {
    for (const command of ["expire_invitation", "expire_grant"]) {
      const res = await send({ command, grantToken: GRANT });
      expect(res.status, command).toBe(400);
    }
    expect(control.calls).toEqual([]);
  });
});

describe("the titular guard is a DENY, exactly as requireTitularAccess is", () => {
  const TITULAR_COMMANDS = [
    DESIGNATE,
    { command: "cancel", petPublicToken: "DIM-PAMP-0001", grantToken: GRANT },
    { command: "revoke", petPublicToken: "DIM-PAMP-0001", grantToken: GRANT },
  ];

  it("answers 404 for a pet the caller may not touch, same as one that does not exist", async () => {
    // A permission denial and a nonexistent pet must be indistinguishable, or
    // this endpoint becomes a probe over the pet table.
    control.access = { kind: "none" };
    for (const body of TITULAR_COMMANDS) {
      const res = await send(body);
      expect(res.status, body.command).toBe(404);
      expect(await bodyOf(res), body.command).toEqual({ error: "not_found" });
    }
    expect(control.calls).toEqual([]);
  });

  it("denies a person-path holder whose role is caretaker, and nobody else", async () => {
    control.access = { kind: "owner", holderRole: "caretaker" };
    for (const body of TITULAR_COMMANDS) {
      const res = await send(body);
      expect(res.status, body.command).toBe(403);
      expect(await bodyOf(res), body.command).toEqual({ error: "caretaker_forbidden" });
    }
    expect(control.calls).toEqual([]);
  });

  it("ADMITS a co-owner, a foster and the org path — all three pass on the web", async () => {
    // The single most important assertion in this block. `requireTitularAccess`
    // denies exactly ONE role; an allow-list here would have quietly narrowed
    // three kinds of caller the browser accepts, and nothing would have gone red.
    for (const access of [
      { kind: "owner", holderRole: "co_owner" },
      { kind: "owner", holderRole: "foster" },
      { kind: "org" },
    ]) {
      control.access = access;
      control.calls = [];
      const res = await send(DESIGNATE);
      expect(res.status, JSON.stringify(access)).toBe(200);
      expect(control.calls.map((c) => c.command)).toEqual(["designate"]);
    }
  });

  it("never runs a pet guard for accept or reject", async () => {
    // The accepting user holds NO ownership row on the animal — that is what an
    // invitation is — so there is nothing for a pet guard to resolve, and one
    // here would refuse the only caller these two commands exist for.
    await send({ command: "accept", grantToken: GRANT });
    await send({ command: "reject", grantToken: GRANT });
    expect(control.accessCalls).toEqual([]);
    expect(control.calls.map((c) => c.command)).toEqual(["accept", "reject"]);
  });
});

describe("the addressee rule, run by the real read use-case", () => {
  it("lists an invitation addressed to me by id as incoming, with the two answers", async () => {
    control.rows = [row()];
    const payload = await bodyOf(await read());

    expect(payload).toMatchObject({
      incoming: [
        {
          grantToken: GRANT,
          status: "pending",
          direction: "incoming",
          counterpartyName: "Vecina",
          caretakerEmail: MY_EMAIL,
          pet: { publicToken: "DIM-PAMP-0001", name: "Pampa", species: "dog" },
          expired: false,
          capabilities: { canAccept: true, canReject: true, canCancel: false, canRevoke: false },
        },
      ],
      outgoing: [],
    });
  });

  it("matches an OPEN invitation by e-mail when no account resolved yet", async () => {
    control.rows = [row({ grant: { caretakerUserId: null, caretakerEmail: MY_EMAIL } })];
    const payload = await bodyOf(await read());
    expect(payload).toMatchObject({
      incoming: [{ direction: "incoming", capabilities: { canAccept: true } }],
    });
  });

  it("lets an ID BEAT AN E-MAIL — a stranger's address is not the addressee", async () => {
    // When `caretaker_user_id` resolved, the match is by id ONLY. A fallback that
    // tried the address anyway would hand somebody else's animal to a person who
    // merely shares an e-mail with the row.
    control.rows = [row({ grant: { caretakerUserId: OTHER, caretakerEmail: MY_EMAIL } })];
    const payload = await bodyOf(await read());
    expect(payload).toMatchObject({
      incoming: [{ capabilities: { canAccept: false, canReject: false } }],
    });
  });

  it("puts a grant I made in outgoing, with the titular's controls and no answers", async () => {
    control.rows = [
      row({ grant: { grantedByUserId: ME, caretakerUserId: OTHER }, caretakerDisplayName: "Ana" }),
    ];
    const payload = await bodyOf(await read());
    expect(payload).toMatchObject({
      incoming: [],
      outgoing: [
        {
          direction: "outgoing",
          counterpartyName: "Ana",
          capabilities: { canAccept: false, canReject: false, canCancel: true, canRevoke: false },
        },
      ],
    });
  });

  it("swaps cancel for revoke once the arrangement is accepted", async () => {
    // The state machine draws the line and refuses to blur it: cancelling touches
    // a row with no ownership and no spine event; revoking ends a real one.
    control.rows = [
      row({ grant: { grantedByUserId: ME, caretakerUserId: OTHER, status: "accepted" } }),
    ];
    const payload = await bodyOf(await read());
    expect(payload).toMatchObject({
      outgoing: [{ capabilities: { canCancel: false, canRevoke: true } }],
    });
  });

  it("carries the scope sentence, both halves, on every row", async () => {
    // It is the copy the invitee reads at the moment of consent, and a client
    // that rendered only the permissions would be recruiting on a half-truth.
    control.rows = [row()];
    const payload = await bodyOf(await read());
    const { scopeSentence } = (payload as unknown as { incoming: Array<{ scopeSentence: string }> })
      .incoming[0];
    expect(scopeSentence).toContain("Podés cargar eventos médicos");
    expect(scopeSentence).toContain("No podés transferir");
  });
});

describe("the asymmetry between accept and reject", () => {
  it("drops canAccept on a lapsed period and KEEPS canReject", async () => {
    // `acceptCaretakerGrant` refuses `endsAt <= now`; `rejectCaretakerGrant` has
    // no expiry term at all. Taking the control away would leave a row sitting in
    // somebody's list with no way to clear it.
    control.rows = [row({ grant: { endsAt: LAST_MONTH } })];
    const payload = await bodyOf(await read());
    expect(payload).toMatchObject({
      incoming: [{ expired: true, capabilities: { canAccept: false, canReject: true } }],
    });
  });

  it("refuses to let the granter accept their own invitation", async () => {
    // Reachable when the address is one of the granter's that resolved to no
    // account, so `validateDesignation`'s id check could not catch it.
    control.rows = [row({ grant: { grantedByUserId: ME, caretakerUserId: null } })];
    const payload = await bodyOf(await read());
    expect(payload).toMatchObject({
      outgoing: [{ direction: "outgoing", capabilities: { canAccept: false } }],
    });
  });
});

describe("callerEmail comes from the verified session", () => {
  it("hands the session address to accept, and ignores anything the body says", async () => {
    await send({ command: "accept", grantToken: GRANT, callerEmail: "otra@example.com" });
    expect(control.calls[0].input).toMatchObject({ callerUserId: ME, callerEmail: MY_EMAIL });
  });

  it("degrades to the id predicate alone when the session carries no address", async () => {
    control.live = () => ({
      ok: true,
      supabase: {},
      user: { id: ME, email: null, emailConfirmed: true },
      profile: null,
    });
    control.rows = [row({ grant: { caretakerUserId: null, caretakerEmail: MY_EMAIL } })];
    const payload = await bodyOf(await read());
    // An empty address cannot be the addressee of an open invitation, so the row
    // is shown without the answers rather than with them.
    expect(payload).toMatchObject({
      incoming: [{ capabilities: { canAccept: false, canReject: false } }],
    });
  });

  // A09-1: an UNPROVED address is not addressee proof, on the read as well as
  // the write. This read is what hands out `grantToken`.
  it("A09-1: an UNCONFIRMED session asks the repository with an EMPTY e-mail", async () => {
    control.live = () => ({
      ok: true,
      supabase: {},
      user: { id: ME, email: MY_EMAIL, emailConfirmed: false },
      profile: null,
    });
    control.rows = [];
    await read();
    expect(control.listArgs).toEqual([{ userId: ME, callerEmail: "" }]);
  });

  it("A09-1: a CONFIRMED session still asks with the address (non-vacuity control)", async () => {
    control.rows = [];
    await read();
    expect(control.listArgs).toEqual([{ userId: ME, callerEmail: MY_EMAIL }]);
  });

  it("A09-1: the accept command carries the confirmation bit into the use-case", async () => {
    control.live = () => ({
      ok: true,
      supabase: {},
      user: { id: ME, email: MY_EMAIL, emailConfirmed: false },
      profile: null,
    });
    await send({ command: "accept", grantToken: GRANT });
    expect(control.calls[0].input).toMatchObject({
      callerUserId: ME,
      callerEmail: MY_EMAIL,
      callerEmailConfirmed: false,
    });
  });
});

describe("the refusal map", () => {
  const CASES: ReadonlyArray<[string, string, number]> = [
    // designate — the five domain refusals plus the two concurrency ones
    ["No podés designarte a vos mismo/a como cuidador/a.", "caretaker_self", 400],
    ["Indicá a quién querés designar como cuidador/a.", "invalid_request", 400],
    ["La fecha de fin tiene que ser posterior a la de inicio.", "caretaker_period_invalid", 400],
    [
      `El período máximo de cuidado es de ${MAX_GRANT_DURATION_DAYS} días.`,
      "caretaker_period_invalid",
      400,
    ],
    ["La fecha de fin ya pasó. Elegí una fecha futura.", "caretaker_period_invalid", 400],
    ["Indicá hasta qué fecha va el cuidado.", "caretaker_period_invalid", 400],
    ["Pampa ya tiene un cuidador/a temporal activo.", "caretaker_grant_exists", 409],
    [
      "Ya hay una invitación de cuidado pendiente para esta mascota.",
      "caretaker_grant_exists",
      409,
    ],
    // accept / reject
    ["Invitación no encontrada.", "not_found", 404],
    ["No podés aceptar tu propia invitación.", "caretaker_self", 400],
    ["Esta invitación no es para tu cuenta.", "caretaker_forbidden", 403],
    // A09-1. The address matched and the ACCOUNT did not prove it. Written as
    // the literal rather than as the imported constant on purpose: the map is
    // built from the same constant, so a symbol compared against itself would
    // stay green through any rewording — and an unmapped sentence here answers
    // 500 with "volvé a intentarlo en unos minutos" to somebody whose only
    // problem is an unconfirmed mailbox.
    ["Confirmá tu correo electrónico para aceptar esta invitación.", "caretaker_forbidden", 403],
    ["Esta invitación ya no está disponible.", "caretaker_already_resolved", 409],
    [
      "El período de cuidado ya terminó. Pedile al titular que te invite de nuevo.",
      "caretaker_expired",
      409,
    ],
    [
      "Quien te invitó ya no es titular de esta mascota. Pedile al titular actual que te invite de nuevo.",
      "caretaker_granter_not_titular",
      409,
    ],
    [
      "No pudimos aceptar la invitación. Volvé a intentarlo en unos minutos.",
      "caretaker_failed",
      500,
    ],
    // cancel
    ["Esta invitación no es tuya.", "caretaker_forbidden", 403],
    ["Esta invitación ya no está pendiente.", "caretaker_already_resolved", 409],
    [
      "El cuidado ya está activo. Usá «Finalizar ahora» para terminarlo.",
      "caretaker_already_resolved",
      409,
    ],
    // revoke
    ["Cuidado no encontrado.", "not_found", 404],
    ["Este cuidado ya no está activo.", "caretaker_already_resolved", 409],
    ["Solo el titular puede finalizar el cuidado.", "caretaker_forbidden", 403],
    ["Solo el cuidador/a puede dar de baja su cuidado.", "caretaker_forbidden", 403],
    ["Solo el titular puede registrar la devolución.", "caretaker_forbidden", 403],
    ["Acción no válida para este cuidado.", "caretaker_failed", 500],
    ["No pudimos finalizar el cuidado. Volvé a intentarlo.", "caretaker_failed", 500],
  ];

  it.each(CASES)("maps %s", async (sentence, code, status) => {
    const res = caretakerRefusal(sentence);
    expect(res.status).toBe(status);
    expect(await bodyOf(res)).toEqual({ error: code });
  });

  it("falls through to caretaker_failed for a sentence it does not recognise", async () => {
    // The honest answer for a mapping out of step with a use-case, and the SAFE
    // direction: an unmapped refusal is still a refusal, and nothing is granted.
    const res = caretakerRefusal("una frase que nadie escribió");
    expect(res.status).toBe(500);
    expect(await bodyOf(res)).toEqual({ error: "caretaker_failed" });
  });

  it("reaches the map through the route, not only through the export", async () => {
    control.results.revoke = { ok: false, error: "Este cuidado ya no está activo." };
    const res = await send({
      command: "revoke",
      petPublicToken: "DIM-PAMP-0001",
      grantToken: GRANT,
    });
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual({ error: "caretaker_already_resolved" });
  });
});

describe("designate turns Argentine days into boundary instants", () => {
  it("opens at the first instant of the first day and closes at the last of the last", async () => {
    // "hasta el 15/09" promises the WHOLE 15th. A period that ended at midnight
    // UTC would cut a caretaker's access at 21:00 on the 14th, on a day the
    // titular promised them.
    await send(DESIGNATE);
    const { startsAt, endsAt } = control.calls[0].input as { startsAt: Date; endsAt: Date };
    expect(startsAt.toISOString()).toBe("2026-09-01T03:00:00.000Z");
    expect(endsAt.toISOString()).toBe("2026-09-16T02:59:59.999Z");
  });

  it("refuses a well-shaped impossible day, on BOTH ends, before any writer runs", async () => {
    // THE REGRESSION TEST FOR A MEASURED DEFECT (2026-08-26), not a hypothetical.
    // The wire regex passes `2026-02-31`, and `parseArDateEndOfDay` does NOT
    // refuse it — the ECMAScript parser rolls it over, so without the schema's
    // `isRealArDay` this endpoint would have written a period ending on the 3rd of
    // March: three days of somebody else's access to an animal nobody asked for.
    // The web never meets it because `<input type="date">` cannot emit such a day.
    //
    // `invalid_request` and not `caretaker_period_invalid`, deliberately: the
    // SHAPE of a date is the schema's business, so the client already had the
    // field code `DATE_INVALID` locally and reaching this door means it ignored it.
    for (const over of [{ endsAt: "2026-02-31" }, { startsAt: "2027-02-29" }]) {
      control.calls = [];
      control.accessCalls = [];
      const res = await send({ ...DESIGNATE, ...over });
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(await bodyOf(res), JSON.stringify(over)).toEqual({ error: "invalid_request" });
      expect(control.calls, JSON.stringify(over)).toEqual([]);
      // Refused before the pet is even resolved — a malformed body must not cost
      // an access query.
      expect(control.accessCalls, JSON.stringify(over)).toEqual([]);
    }
  });

  it("still accepts a REAL leap day", async () => {
    // The other half of the guard: 2028 is a leap year, so the 29th exists and
    // must go through. A check that refused it would be a second, wrong copy of
    // the calendar rather than a reuse of the module's own.
    await send({ ...DESIGNATE, startsAt: "2028-02-29", endsAt: "2028-03-10" });
    expect(control.calls.map((c) => c.command)).toEqual(["designate"]);
  });
});

describe("the acknowledgement", () => {
  it("returns the new grant token and whether anybody was actually told", async () => {
    // `inviteeNeedsAccount: true` means NOBODY has been told: no invitation mail
    // is sent from this endpoint, and `designateCaretaker` builds an in-app
    // notification only when the address resolved to an account.
    control.results.designate = {
      ok: true,
      value: { grantPublicToken: GRANT, inviteeNeedsAccount: true, inviteeEmail: "a@b.com" },
      notifications: [],
    };
    const payload = await bodyOf(await send(DESIGNATE));
    expect(payload).toEqual({
      command: "designate",
      changed: true,
      grantToken: GRANT,
      petPublicToken: null,
      inviteeNeedsAccount: true,
    });
  });

  it("hands back the pet after an accept, which is where the web navigates too", async () => {
    control.results.accept = {
      ok: true,
      value: { petPublicToken: "DIM-PAMP-0001", petName: "Pampa" },
      notifications: [],
    };
    const payload = await bodyOf(await send({ command: "accept", grantToken: GRANT }));
    expect(payload).toMatchObject({
      command: "accept",
      petPublicToken: "DIM-PAMP-0001",
      inviteeNeedsAccount: null,
    });
  });
});

describe("the side effects", () => {
  it("writes the WEB'S OWN audit action for each command", async () => {
    // A row written from a phone must be indistinguishable in `audit_log` from
    // one written in a browser — that is the entire point of writing it here.
    control.results.designate = {
      ok: true,
      value: { grantPublicToken: GRANT, inviteeNeedsAccount: false, inviteeEmail: "a@b.com" },
      notifications: [],
    };
    control.results.accept = { ok: true, value: { petPublicToken: null }, notifications: [] };
    control.results.reject = { ok: true, value: { petId: PET_ID }, notifications: [] };
    control.results.cancel = { ok: true, value: { petId: PET_ID }, notifications: [] };
    control.results.revoke = { ok: true, value: { petId: PET_ID }, notifications: [] };

    await send(DESIGNATE);
    await send({ command: "accept", grantToken: GRANT });
    await send({ command: "reject", grantToken: GRANT });
    await send({ command: "cancel", petPublicToken: "DIM-PAMP-0001", grantToken: GRANT });
    await send({ command: "revoke", petPublicToken: "DIM-PAMP-0001", grantToken: GRANT });

    expect(control.audits.map((a) => a.action)).toEqual([
      "caretaker_designated",
      "caretaker_grant_accepted",
      "caretaker_grant_rejected",
      "caretaker_grant_cancelled",
      "caretaker_grant_revoked",
    ]);
    expect(control.audits.every((a) => a.actorUserId === ME)).toBe(true);
  });

  it("records the animal the write actually touched, from the use-case's own result", async () => {
    control.results.revoke = { ok: true, value: { petId: "other-pet" }, notifications: [] };
    await send({ command: "revoke", petPublicToken: "DIM-PAMP-0001", grantToken: GRANT });
    expect(control.audits[0].payload).toMatchObject({ pet_id: "other-pet" });
  });

  it("runs NOTHING on a refusal", async () => {
    control.results.cancel = { ok: false, error: "Esta invitación no es tuya." };
    await send({ command: "cancel", petPublicToken: "DIM-PAMP-0001", grantToken: GRANT });
    expect(control.audits).toEqual([]);
    expect(control.notifications).toEqual([]);
  });

  it("flushes notifications through the service, never a raw insert", async () => {
    // The module is deliberately NOT in `scripts/notifications-service-baseline.json`
    // and must never be added: the service buys dedupe-key idempotency and a
    // dead-letter, which the sibling modules' raw inserts do not have.
    control.results.reject = {
      ok: true,
      value: { petId: PET_ID },
      notifications: [{ userId: OTHER, dedupeKey: "caretaker:invitation_rejected:row-1:x" }],
    };
    await send({ command: "reject", grantToken: GRANT });
    expect(control.notifications).toHaveLength(1);
  });
});

describe("no idempotency key is promised", () => {
  it("ignores an Idempotency-Key header rather than pretending to honour it", async () => {
    // None of the five use-cases takes a `clientIdempotencyKey`. What they have —
    // two partial unique indexes and three status guards — REFUSES a replay
    // instead of absorbing one, which is not the same guarantee.
    const res = await send(
      { command: "accept", grantToken: GRANT },
      { authorization: "Bearer t", "idempotency-key": "b0a4f0e2-0000-4000-8000-000000000000" },
    );
    expect(res.status).toBe(200);
    expect(control.calls[0].input).not.toHaveProperty("clientIdempotencyKey");
  });
});

describe("the mirrored constant", () => {
  it("agrees with the domain rule it was copied from", async () => {
    // The contract carries the number so a native picker can be bounded before
    // the round trip. A drift would offer a date the server then refuses.
    expect(CARETAKER_MAX_DURATION_DAYS).toBe(MAX_GRANT_DURATION_DAYS);
  });
});
