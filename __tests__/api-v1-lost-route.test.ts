// `/api/v1/pets/{token}/lost` — the five owner commands of a search, and the
// read that says which of them this caller may send.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE GUARD IS THE WEB'S, AND IT IS WIDER HERE THAN ON THE EVENTS
//      ENDPOINT. `requirePetAccess` admits a caretaker, admits an org member
//      with NO capability, and accepts a non-alive animal at the door. An
//      endpoint that reused the clinical guard would silently take lost mode
//      away from a foster and from a shelter holding custody.
//   2. THE TWO NARROWINGS THE WEB PERFORMS ITSELF ARE MIRRORED EXACTLY: the
//      caretaker-contact preference is titular-only, and reactivation is refused
//      on the ORG path — alone on this surface.
//   3. IDEMPOTENCY IS NOT UNIFORM AND THE ENDPOINT DOES NOT PRETEND IT IS. The
//      one command that appends requires the header and honours it; the four
//      state commands neither require nor read one, because their writers are
//      idempotent on the state.
//   4. THE REFUSALS CARRY THE RIGHT STATUS PER WHOSE FACT THEY ARE: 403 for the
//      CALLER, 409 for the ANIMAL'S SITUATION, 400 for the request, 404 for
//      anything a caller may not see.
//   5. NOTHING IS WRITTEN when any gate refuses.
//   6. THE READ NEVER MINTS A SIGNED URL and never recomputes a capability the
//      server already decided.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  access: null as null | (() => unknown),
  /** The open `lost_pet_episode`, or null for a stale (auto-closed) search. */
  openCase: { id: "case-1" } as { id: string } | null,
  episode: null as null | Record<string, unknown>,
  scans: [] as Array<Record<string, unknown>>,
  /** Every writer call. Empty means nothing was written. */
  writes: [] as Array<{ command: string; input: Record<string, unknown> }>,
  markLostResult: { error: null } as { error: string | null },
  lastSeenResult: { error: null, wasDuplicate: false } as {
    error: string | null;
    wasDuplicate: boolean;
  },
  foundResult: { ok: true, alreadyActive: false } as { ok: true; alreadyActive: boolean },
  disclosureResult: true,
  reactivateResult: { ok: true, caseId: "case-2", alreadyOpen: false } as Record<string, unknown>,
  reportResult: { error: null, alreadyReported: false } as {
    error: string | null;
    alreadyReported: boolean;
  },
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
    enforceRateLimit: async (endpoint: string, identifier: string) => {
      control.limits.push({ endpoint, identifier });
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

vi.mock("@/lib/infra/case-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/case-helpers")>();
  return { ...actual, findOpenCaseForPetAndKind: async () => control.openCase };
});

vi.mock("@/lib/infra/lost-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/lost-mode")>();
  return {
    ...actual,
    fetchLostEpisodeForPet: async () => control.episode,
    fetchLostScanEvents: async () => control.scans,
  };
});

vi.mock("@/src/modules/events/application/lifecycle/set-pet-lost-use-case", () => ({
  setPetLostWriter: async (input: Record<string, unknown>) => {
    control.writes.push({ command: "mark_lost", input });
    return control.markLostResult;
  },
}));

vi.mock("@/src/modules/events/application/lifecycle/update-lost-last-seen-use-case", () => ({
  updateLostLastSeen: async (input: Record<string, unknown>) => {
    control.writes.push({ command: "report_last_seen", input });
    return control.lastSeenResult;
  },
}));

vi.mock("@/src/modules/events/application/lifecycle/set-pet-found-use-case", () => ({
  setPetFound: async (input: Record<string, unknown>) => {
    control.writes.push({ command: "mark_found", input });
    return control.foundResult;
  },
}));

vi.mock("@/src/modules/pets/application/lost-mode/set-pet-disclosure-prefs", () => ({
  setPetDisclosurePrefs: async (petId: string, token: string, key: string, value: boolean) => {
    control.writes.push({ command: "set_disclosure", input: { petId, token, key, value } });
    return control.disclosureResult;
  },
}));

vi.mock("@/src/modules/cases/application/reactivate-lost-search", () => ({
  reactivateLostSearch: async (input: Record<string, unknown>) => {
    control.writes.push({ command: "reactivate_search", input });
    return control.reactivateResult;
  },
}));

vi.mock("@/src/modules/events/application/lifecycle/report-lost-feed-item-use-case", () => ({
  reportLostFeedItem: async (input: Record<string, unknown>) => {
    control.writes.push({ command: "report_content", input });
    return control.reportResult;
  },
}));

vi.mock("@/src/modules/events/application/lifecycle/found-notification-audience", () => ({
  resolveFoundConfirmationRecipient: async () => TITULAR_ID,
  findBroadcastRecipientUserIds: async () => [],
}));

vi.mock("@/src/modules/events/application/writers", () => ({ flushNotifications: async () => {} }));

vi.mock("@/src/modules/events/infrastructure/events-repository", () => ({
  EventsRepository: class {},
}));

vi.mock("@/lib/infra/lost-pet-broadcast", () => ({ broadcastLostPet: async () => null }));

vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    createClientFromBearer: (header: string | null) =>
      header ? { ok: true, supabase: {}, token: "tok" } : { ok: false, reason: "MISSING" },
  };
});

import { GET, POST } from "@/app/api/v1/pets/[publicToken]/lost/route";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const TITULAR_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const PET_ID = "22222222-2222-4222-8222-222222222222";
const KEY = "55555555-5555-4555-8555-555555555555";
const TOKEN = "DIM-PAMP-0001";

function petRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PET_ID,
    publicToken: TOKEN,
    name: "Pampa",
    sex: "female",
    status: "active",
    species: "dog",
    breed: "Mestiza",
    color: "Marrón",
    jurisdictionProvince: "La Pampa",
    jurisdictionLocality: "Santa Rosa",
    discloseFirstNameWhenLost: false,
    disclosePhoneWhenLost: false,
    discloseEmailWhenLost: false,
    discloseLastLocationWhenLost: false,
    allowFinderFormWhenLost: true,
    discloseCaretakerContactWhenLost: false,
    ...overrides,
  };
}

function ownerAccess(overrides: Record<string, unknown> = {}, holderRole = "owner") {
  return () => ({ kind: "owner", pet: petRow(overrides), holderRole });
}

function orgAccess(overrides: Record<string, unknown> = {}) {
  return () => ({
    kind: "org",
    pet: petRow(overrides),
    organization: { id: "org-1" },
    membership: { id: "m-1" },
    eventAuthorship: {
      authorRole: "shelter",
      authorOrganizationId: "org-1",
      authorVerified: false,
    },
  });
}

function episodeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "case-1",
    publicCode: "LOS-00042",
    openedAt: new Date("2026-08-20T12:00:00Z"),
    jurisdictionLocality: "Santa Rosa",
    placeName: "Plaza San Martín",
    ownerNote: "Se escapó por el portón",
    sightingsCount: 3,
    lastSeenAt: new Date("2026-08-21T15:00:00Z"),
    lastSeenLat: "-36.6167",
    lastSeenLng: "-64.2833",
    ...overrides,
  };
}

const A_DISCLOSURE = {
  discloseFirstNameWhenLost: true,
  disclosePhoneWhenLost: true,
  discloseEmailWhenLost: false,
  discloseLastLocationWhenLost: true,
  allowFinderFormWhenLost: true,
};

const MARK_LOST = { command: "mark_lost", disclosure: A_DISCLOSURE };
const REPORT = { command: "report_last_seen", locationDescription: "Cerca de la plaza" };
const MARK_FOUND = { command: "mark_found" };
const REACTIVATE = { command: "reactivate_search" };
const TARGET_EVENT_ID = "77777777-7777-4777-8777-777777777777";
const REPORT_CONTENT = {
  command: "report_content",
  targetEventId: TARGET_EVENT_ID,
  category: "harassment",
  reason: "Me insulta cada vez que le escribo.",
};

async function post(
  body: unknown = MARK_LOST,
  init: { key?: string | null; authorization?: string | null } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = init.authorization === undefined ? "Bearer tok" : init.authorization;
  if (auth) headers.authorization = auth;
  const key = init.key === undefined ? KEY : init.key;
  if (key) headers["idempotency-key"] = key;
  return POST(
    new Request(`https://www.mimar.com.ar/api/v1/pets/${TOKEN}/lost`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ publicToken: TOKEN }) },
  );
}

async function get(init: { authorization?: string | null } = {}) {
  const headers: Record<string, string> = {};
  const auth = init.authorization === undefined ? "Bearer tok" : init.authorization;
  if (auth) headers.authorization = auth;
  return GET(new Request(`https://www.mimar.com.ar/api/v1/pets/${TOKEN}/lost`, { headers }), {
    params: Promise.resolve({ publicToken: TOKEN }),
  });
}

beforeEach(() => {
  control.live = null;
  control.limits = [];
  control.access = null;
  control.openCase = { id: "case-1" };
  control.episode = null;
  control.scans = [];
  control.writes = [];
  control.reportResult = { error: null, alreadyReported: false };
  control.markLostResult = { error: null };
  control.lastSeenResult = { error: null, wasDuplicate: false };
  control.foundResult = { ok: true, alreadyActive: false };
  control.disclosureResult = true;
  control.reactivateResult = { ok: true, caseId: "case-2", alreadyOpen: false };
});

describe("POST .../lost — the guard is requirePetAccess, which is WIDER than the clinical one", () => {
  it("admits a CARETAKER to mark an animal lost", async () => {
    // The person watching the animal day to day is the one who notices it is
    // gone. `setPetLostAction` guards with `requirePetAccess`, which never
    // narrows to the titular, and an endpoint that borrowed the clinical guard
    // would silence exactly the holder this command exists for.
    control.access = ownerAccess({}, "caretaker");
    const response = await post(MARK_LOST);
    expect(response.status).toBe(200);
    expect(control.writes.map((w) => w.command)).toEqual(["mark_lost"]);
  });

  it("admits an ORG member with NO capability check", async () => {
    // `event.write` belongs to `requireAlivePetAccess`, not to this guard. A
    // shelter holding custody marking an animal lost is the point of custody.
    control.access = orgAccess();
    const response = await post(MARK_LOST);
    expect(response.status).toBe(200);
  });

  it("answers 404 for a pet this caller may not see, exactly as a read does", async () => {
    control.access = () => ({ kind: "none" });
    const response = await post(MARK_LOST);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(control.writes).toEqual([]);
  });

  it("answers 401 without a bearer, and never writes a rate-limit counter for it", async () => {
    const response = await post(MARK_LOST, { authorization: null });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "auth_required" });
    expect(control.limits).toEqual([]);
  });
});

describe("POST .../lost — the two narrowings the web performs itself", () => {
  it("refuses a CARETAKER the caretaker-contact preference — key 1 of two", async () => {
    // `setPetDisclosurePrefsAction` swaps in `requireTitularAccess` for exactly
    // this key. A caretaker who could flip it would hold both keys of a two-key
    // model and the second would stop meaning anything.
    control.access = ownerAccess({}, "caretaker");
    const response = await post({
      command: "set_disclosure",
      key: "discloseCaretakerContactWhenLost",
      value: true,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "lost_forbidden" });
    expect(control.writes).toEqual([]);
  });

  it("ALLOWS a caretaker the other five preferences", async () => {
    // `requireTitularAccess` is a DENY on one key, not an allow-list. Copying it
    // as an allow-list would quietly take four toggles away from a foster too.
    control.access = ownerAccess({}, "caretaker");
    const response = await post({
      command: "set_disclosure",
      key: "disclosePhoneWhenLost",
      value: true,
    });
    expect(response.status).toBe(200);
    expect(control.writes.map((w) => w.command)).toEqual(["set_disclosure"]);
  });

  it("ALLOWS the titular the caretaker-contact preference", async () => {
    control.access = ownerAccess({}, "owner");
    const response = await post({
      command: "set_disclosure",
      key: "discloseCaretakerContactWhenLost",
      value: true,
    });
    expect(response.status).toBe(200);
  });

  it("refuses REACTIVATION on the org path — alone on this surface", async () => {
    // `reactivateLostSearchAction` guards with `requirePetAccess` and then
    // throws on `accessPath !== "owner"`. The same org member may mark this
    // animal lost and found; they may not reopen a search the cron closed.
    control.access = orgAccess({ status: "lost" });
    const response = await post(REACTIVATE);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "lost_forbidden" });
    expect(control.writes).toEqual([]);
  });

  it("ALLOWS reactivation on the person path, caretaker included", async () => {
    control.access = ownerAccess({ status: "lost" }, "caretaker");
    control.reactivateResult = { ok: true, caseId: "case-2", alreadyOpen: false };
    const response = await post(REACTIVATE);
    expect(response.status).toBe(200);
  });
});

describe("POST .../lost — the refusals about the ANIMAL'S SITUATION", () => {
  it("refuses marking lost an animal already lost, rather than succeeding quietly", async () => {
    // A person who pressed that button believes they just started something.
    control.access = ownerAccess({ status: "lost" });
    const response = await post(MARK_LOST);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "lost_already" });
    expect(control.writes).toEqual([]);
  });

  it("refuses marking lost a DECEASED animal, with the events endpoint's own code", async () => {
    // Same fact, same code: the ANIMAL refuses, whoever is asking.
    control.access = ownerAccess({ status: "deceased" });
    const response = await post(MARK_LOST);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "event_not_allowed" });
    expect(control.writes).toEqual([]);
  });

  it("refuses marking FOUND a deceased animal", async () => {
    control.access = ownerAccess({ status: "deceased" });
    const response = await post(MARK_FOUND);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "event_not_allowed" });
    expect(control.writes).toEqual([]);
  });

  it("SUCCEEDS marking found an animal that is already active, changing nothing", async () => {
    // "Make this animal not lost" already holds. A 409 would refuse somebody for
    // asking for a state that is true.
    control.access = ownerAccess({ status: "active" });
    control.foundResult = { ok: true, alreadyActive: true };
    const response = await post(MARK_FOUND);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      command: "mark_found",
      status: "active",
      changed: false,
    });
  });

  it("refuses an avistaje for an animal that is not lost", async () => {
    const response = await post(REPORT);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "pet_not_lost" });
    expect(control.writes).toEqual([]);
  });

  it("refuses an avistaje when the episode was auto-closed, with its OWN code", async () => {
    // A DIFFERENT fix from "not lost", which is the bar for a second code: the
    // animal IS lost and the search is not running, so the move is to reactivate
    // — and `pet_not_lost` would send somebody looking for a status that is
    // already correct.
    control.access = ownerAccess({ status: "lost" });
    control.openCase = null;
    const response = await post(REPORT);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "lost_episode_closed" });
    expect(control.writes).toEqual([]);
  });

  it("takes a disclosure change on an animal in ANY status, matching the web", async () => {
    // `setPetDisclosurePrefs` has no status check and its action accepts a
    // non-alive animal: an owner still gets to decide what a future search would
    // publish about them.
    control.access = ownerAccess({ status: "deceased" });
    const response = await post({
      command: "set_disclosure",
      key: "disclosePhoneWhenLost",
      value: false,
    });
    expect(response.status).toBe(200);
  });
});

describe("POST .../lost — the Idempotency-Key is required for ONE command", () => {
  it("refuses an avistaje with no key", async () => {
    control.access = ownerAccess({ status: "lost" });
    const response = await post(REPORT, { key: null });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "idempotency_key_required" });
    expect(control.writes).toEqual([]);
  });

  it("refuses an avistaje whose key is not a UUID, with the SAME code", async () => {
    // A non-UUID raises 22P02 INSIDE the write and surfaces as a
    // retryable-looking failure that reproduces forever.
    control.access = ownerAccess({ status: "lost" });
    const response = await post(REPORT, { key: "not-a-uuid" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "idempotency_key_required" });
  });

  it("passes the key THROUGH to the writer rather than demanding and dropping it", async () => {
    control.access = ownerAccess({ status: "lost" });
    await post(REPORT);
    expect(control.writes[0]?.input.clientIdempotencyKey).toBe(KEY);
  });

  it("reports a REPLAY as changed:false rather than as a second sighting", async () => {
    control.access = ownerAccess({ status: "lost" });
    control.lastSeenResult = { error: null, wasDuplicate: true };
    const response = await post(REPORT);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      command: "report_last_seen",
      status: "lost",
      changed: false,
    });
  });

  it("does NOT demand a key for the four state commands", async () => {
    // Their writers are idempotent on the STATE. Requiring a header they could
    // not honour would be a promise this endpoint cannot keep — the same call
    // the events endpoint makes about atestación PPP and embarazo.
    for (const body of [MARK_LOST, MARK_FOUND, REACTIVATE]) {
      control.writes = [];
      control.access = ownerAccess(
        body.command === "mark_lost" ? { status: "active" } : { status: "lost" },
      );
      const response = await post(body, { key: null });
      expect(response.status).toBe(200);
    }
  });
});

describe("POST .../lost — what marcar perdida puts on the spine, and what it may not", () => {
  it("sends the five disclosure toggles as stated, never inherited", async () => {
    // `parseDisclosurePrefsFromForm` FAILS CLOSED for a form with no disclosure
    // section, so the contract makes all five required rather than letting a
    // JSON client reach the same writer through a door that inherits silently.
    await post(MARK_LOST);
    expect(control.writes[0]?.input.disclosurePrefs).toEqual(A_DISCLOSURE);
  });

  it("refuses a body with the disclosure section missing", async () => {
    const response = await post({ command: "mark_lost" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(control.writes).toEqual([]);
  });

  it("refuses a HALF coordinate pair, where the web silently discards it", async () => {
    // A map widget cannot produce half a pin; a JSON client can. Narrower than
    // the web, in the direction where being wrong is visible.
    const response = await post({ ...MARK_LOST, locationLat: -36.6 });
    expect(response.status).toBe(400);
    expect(control.writes).toEqual([]);
  });

  it("refuses an out-of-range pin, which is the web's own STEP 3 hardening", async () => {
    const response = await post({ ...MARK_LOST, locationLat: 91, locationLng: 0 });
    expect(response.status).toBe(400);
    expect(control.writes).toEqual([]);
  });

  it("hands the coordinates to the writer as STRINGS, which is what writePoint parses", async () => {
    await post({ ...MARK_LOST, locationLat: -36.6167, locationLng: -64.2833 });
    expect(control.writes[0]?.input.locationLat).toBe("-36.6167");
    expect(control.writes[0]?.input.locationLng).toBe("-64.2833");
  });

  it("carries the animal's jurisdiction from the ACCESS query, never off the wire", async () => {
    // The broadcast fans out by jurisdiction. A client that could set it would
    // choose who gets woken up.
    await post(MARK_LOST);
    const input = control.writes[0]?.input as Record<string, unknown>;
    expect(input.petJurisdictionProvince).toBe("La Pampa");
    expect(input.petJurisdictionLocality).toBe("Santa Rosa");
    expect(input).not.toHaveProperty("recipients");
  });

  it("maps a malformed retroactive chip to its OWN code, not to invalid_request", async () => {
    // The format rule lives in `validateMicrochipId` against a country-code
    // table, so no wire schema can express it — and a client told "your body did
    // not parse" would go looking at the wrong field.
    control.markLostResult = { error: "INVALID_MICROCHIP_FORMAT" };
    const response = await post({
      ...MARK_LOST,
      enrichedDescription: { microchipId: "12345" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "lost_microchip_invalid" });
  });

  it("maps any other writer failure to one retryable code, without leaking its prose", async () => {
    control.markLostResult = { error: "constraint cases_x violated" };
    const response = await post(MARK_LOST);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "lost_failed" });
  });

  it("always answers changed:true on success — the writer refuses the alternative", async () => {
    const response = await post(MARK_LOST);
    expect(await response.json()).toEqual({ command: "mark_lost", status: "lost", changed: true });
  });
});

describe("POST .../lost — the avistaje is an APPEND, not a status change", () => {
  it("composes the web's own single note text out of the address and the note", async () => {
    // `note_added` has one required `text` field, and the address ALSO travels
    // separately as `location_description` because the read model overlays it as
    // the episode's place name.
    control.access = ownerAccess({ status: "lost" });
    await post({ ...REPORT, note: "La vio un vecino" });
    const input = control.writes[0]?.input as Record<string, unknown>;
    expect(input.text).toBe("Cerca de la plaza — La vio un vecino");
    expect(input.locationDescription).toBe("Cerca de la plaza");
  });

  it("accepts a text-only update with no pin at all", async () => {
    control.access = ownerAccess({ status: "lost" });
    const response = await post(REPORT);
    expect(response.status).toBe(200);
    const input = control.writes[0]?.input as Record<string, unknown>;
    expect(input.locationLat).toBeNull();
    expect(input.locationLng).toBeNull();
  });

  it("normalizes a pin through the web's own helper before writing it", async () => {
    control.access = ownerAccess({ status: "lost" });
    await post({ ...REPORT, locationLat: -36.6167, locationLng: -64.2833 });
    const input = control.writes[0]?.input as Record<string, unknown>;
    expect(input.locationLat).toBe("-36.6167");
    expect(input.locationLng).toBe("-64.2833");
  });
});

describe("POST .../lost — marcar encontrada and reactivar", () => {
  it("addresses the recovery confirmation to the TITULAR, not to whoever pressed it", async () => {
    // An org member marking a sponsored pet found must not send "Marcaste a Luna
    // como encontrada" to themselves while the family hears nothing.
    control.access = orgAccess({ status: "lost" });
    await post(MARK_FOUND);
    expect(control.writes[0]?.input.ownerUserId).toBe(TITULAR_ID);
    expect(control.writes[0]?.input.recordedByUserId).toBe(OWNER_ID);
  });

  it("reports a reactivation that found an episode already open as changed:false", async () => {
    // `lost_pet_episode` has no reopen path, so a duplicate open would fork the
    // search into two untracked cases. The writer returns the existing one.
    control.access = ownerAccess({ status: "lost" });
    control.reactivateResult = { ok: true, caseId: "case-1", alreadyOpen: true };
    const response = await post(REACTIVATE);
    expect(await response.json()).toEqual({
      command: "reactivate_search",
      status: "lost",
      changed: false,
    });
  });

  it("reports a disclosure no-op as changed:false", async () => {
    control.disclosureResult = false;
    const response = await post({
      command: "set_disclosure",
      key: "disclosePhoneWhenLost",
      value: false,
    });
    expect(await response.json()).toEqual({
      command: "set_disclosure",
      status: "active",
      changed: false,
    });
  });

  it("refuses a command name the contract does not know", async () => {
    const response = await post({ command: "delete_everything" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(control.writes).toEqual([]);
  });
});

describe("GET .../lost — the read", () => {
  it("answers for an animal that is NOT lost, without reading an episode", async () => {
    // The payload still carries the disclosure settings a FUTURE search would
    // use, and says the one command available is marcar perdida.
    const response = await get();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, never>;
    expect(body.payloadVersion).toBe(1);
    expect(body.status).toBe("active");
    expect(body.episode).toBeNull();
    expect(body.capabilities).toMatchObject({
      canMarkLost: true,
      canReportLastSeen: false,
      canMarkFound: false,
      canReactivateSearch: false,
    });
  });

  it("carries the envelope every read on this surface carries", async () => {
    const response = await get();
    const body = (await response.json()) as Record<string, string>;
    expect(typeof body.issuedAt).toBe("string");
    expect(typeof body.staleAfter).toBe("string");
    expect(new Date(body.staleAfter).getTime()).toBeGreaterThan(new Date(body.issuedAt).getTime());
  });

  it("parses the episode's coordinates into NUMBERS, so no client has to", async () => {
    control.access = ownerAccess({ status: "lost" });
    control.episode = episodeRow();
    const response = await get();
    const body = (await response.json()) as { episode: Record<string, unknown> };
    expect(body.episode.lastSeenLat).toBe(-36.6167);
    expect(body.episode.lastSeenLng).toBe(-64.2833);
    expect(body.episode.publicCode).toBe("LOS-00042");
    expect(body.episode.sightingsCount).toBe(3);
  });

  it("reports that a finder photo EXISTS and never mints a URL for it", async () => {
    // Minting a URL is equivalent to handing out the file, and a 200-row feed
    // would hand out 200.
    control.access = ownerAccess({ status: "lost" });
    control.episode = episodeRow();
    control.scans = [
      {
        kind: "finder",
        id: "e1",
        at: new Date("2026-08-22T10:00:00Z"),
        finderName: "Vecina",
        finderContact: "11-5555-5555",
        petCondition: "bien",
        localityLabel: "Santa Rosa",
        message: "La tengo en casa",
        availabilityLabel: "indefinido",
        photoStoragePath: "private/finder/e1.jpg",
        photoUrl: "https://signed.example/e1.jpg",
      },
    ];
    const response = await get();
    const body = (await response.json()) as { feed: { items: Array<Record<string, unknown>> } };
    expect(body.feed.items[0]).toMatchObject({ kind: "finder", hasPhoto: true });
    expect(body.feed.items[0]).not.toHaveProperty("photoUrl");
    expect(body.feed.items[0]).not.toHaveProperty("photoStoragePath");
  });

  it("counts scans as ROWS, the same figure the web's own LostCaseBlock computes", async () => {
    control.access = ownerAccess({ status: "lost" });
    control.episode = episodeRow({ sightingsCount: 2 });
    control.scans = [
      { kind: "scan", id: "s1", at: new Date(), count: 4, localityLabel: "Toay" },
      { kind: "scan", id: "s2", at: new Date(), count: 1, localityLabel: null },
      {
        kind: "sighting",
        id: "g1",
        at: new Date(),
        description: "La vi cruzando",
        localityLabel: null,
        lat: null,
        lng: null,
      },
    ];
    const response = await get();
    const body = (await response.json()) as { feed: Record<string, unknown> };
    // TWO rows, not five scans — a burst is one row on both surfaces.
    expect(body.feed.totalScans).toBe(2);
    expect(body.feed.totalSightings).toBe(2);
    expect(body.feed.truncated).toBe(false);
  });

  it("says the search is STALE rather than pretending it is running", async () => {
    // `status: "lost"` with no open episode is the auto-close state, and
    // reactivation is the way out of it.
    control.access = ownerAccess({ status: "lost" });
    control.episode = null;
    const response = await get();
    const body = (await response.json()) as { capabilities: Record<string, unknown> };
    expect(body.capabilities).toMatchObject({
      canReportLastSeen: false,
      canReactivateSearch: true,
      canMarkFound: true,
      canMarkLost: false,
    });
  });

  it("does NOT offer reactivation on the org path, matching the write guard", async () => {
    control.access = orgAccess({ status: "lost" });
    control.episode = null;
    const response = await get();
    const body = (await response.json()) as { capabilities: Record<string, unknown> };
    expect(body.capabilities.canReactivateSearch).toBe(false);
  });

  // A4-custodia-13 — the OTHER flag the org path alone decides.
  //
  // `commands.ts` refuses `report_content` and `reactivate_search` in ONE
  // condition, so the payload has to answer both. Without `canReportContent` the
  // app drew "Reportar" on every feed row for an org-path reader and the server
  // answered it with titular-only copy. Practically unreachable today (org
  // viewers cannot navigate to LostScreen), which is exactly why a flag is
  // cheaper than the bug being found later, from a hand-typed deep link.
  it("does NOT offer content reporting on the org path, matching the write guard", async () => {
    control.access = orgAccess({ status: "lost" });
    const response = await get();
    const body = (await response.json()) as { capabilities: Record<string, unknown> };
    expect(body.capabilities.canReportContent).toBe(false);
    // The two flags the guard refuses together are refused together here.
    expect(body.capabilities.canReactivateSearch).toBe(false);
  });

  it("offers content reporting to the owner path, lost or not", async () => {
    // NON-VACUITY, and the reason there is no status clause: reporting a message
    // is about the FEED, which is readable whether or not a search is running.
    control.access = ownerAccess({ status: "lost" });
    const lost = (await (await get()).json()) as { capabilities: Record<string, unknown> };
    expect(lost.capabilities.canReportContent).toBe(true);

    control.access = ownerAccess({ status: "active" });
    control.episode = null;
    const home = (await (await get()).json()) as { capabilities: Record<string, unknown> };
    expect(home.capabilities.canReportContent).toBe(true);
  });

  it("hides the caretaker-contact toggle from a caretaker, and only that one", async () => {
    control.access = ownerAccess({}, "caretaker");
    const response = await get();
    const body = (await response.json()) as { capabilities: { editableDisclosureKeys: string[] } };
    expect(body.capabilities.editableDisclosureKeys).not.toContain(
      "discloseCaretakerContactWhenLost",
    );
    expect(body.capabilities.editableDisclosureKeys).toHaveLength(5);
  });

  it("gives the titular all six", async () => {
    const response = await get();
    const body = (await response.json()) as { capabilities: { editableDisclosureKeys: string[] } };
    expect(body.capabilities.editableDisclosureKeys).toHaveLength(6);
  });

  it("answers 404 for a pet this caller may not read", async () => {
    control.access = () => ({ kind: "none" });
    const response = await get();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("spends its OWN limiter buckets, named for this surface and this method", async () => {
    await get();
    expect(control.limits.map((l) => l.endpoint)).toEqual([
      "api_v1_lost_read_ip",
      "api_v1_lost_read_user",
    ]);
    control.limits = [];
    await post(MARK_LOST);
    expect(control.limits.map((l) => l.endpoint)).toEqual([
      "api_v1_lost_write_ip",
      "api_v1_lost_write_user",
    ]);
  });
});

// ---------------------------------------------------------------------------
// report_content — the compliance command
// ---------------------------------------------------------------------------
//
// WHAT THIS BLOCK IS FOR. Google Play's IARC questionnaire declares this app as
// one where content CAN BE REPORTED. That is a statement about the app as
// published, so what matters here is not only that the command works but that it
// is REACHABLE by the people who actually read the feed — a caretaker looking
// after somebody's animal during the search, a shelter holding custody — and
// unreachable by anybody else.
//
// THE AUTHORIZATION PATH IS THE EXISTING ONE, and these tests exist to prove
// nobody invented a second: no titular check, no org refusal, no status gate.
// The two narrowings on this surface are mirrors of narrowings the WEB performs,
// and neither of them is about this command.

describe("POST /lost — report_content", () => {
  it("lets the titular report an item and answers changed: true", async () => {
    const response = await post(REPORT_CONTENT, { key: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      command: "report_content",
      status: "active",
      changed: true,
    });
    expect(control.writes).toHaveLength(1);
    expect(control.writes[0].input.targetEventId).toBe(TARGET_EVENT_ID);
    expect(control.writes[0].input.category).toBe("harassment");
  });

  it("lets a CARETAKER report — the person most likely to be reading the feed", async () => {
    // Not a titular-only command, and this is the assertion that keeps it that
    // way. A caretaker minding the animal during a search is exactly who reads
    // the abusive message; a narrowing invented here would take the safety
    // control away from them.
    control.access = ownerAccess({ status: "lost" }, "caretaker");
    const response = await post(REPORT_CONTENT, { key: null });
    expect(response.status).toBe(200);
    expect(control.writes).toHaveLength(1);
  });

  it("REFUSES the ORG path — the second command narrowed there, and why", async () => {
    // The hide is pet-global: a reported item leaves the record for every reader
    // of that animal. Combined with an org-path reporter that becomes a lever —
    // an organization holding `shelter_custody` could make a finder's "tengo a
    // tu perro, llamame" vanish from the OWNER's feed, counter and public
    // credential, silently and with no un-report, at the exact moment a search
    // is about to end. In a product with custody disputes as a first-class
    // concept that is not a hypothetical.
    //
    // Mirrors `reactivate_search`, refused on the org path for the same shape of
    // reason. A CARETAKER keeps the affordance — the titular invited them.
    control.access = orgAccess({ status: "lost" });
    const response = await post(REPORT_CONTENT, { key: null });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "lost_forbidden" });
    expect(control.writes).toEqual([]);
  });

  it("still lets the org path run the OTHER lost commands — the narrowing is one command wide", async () => {
    // NON-VACUITY for the refusal above: if the org guard had been widened to
    // the whole surface, this would 403 too and the test above would pass for
    // the wrong reason.
    control.access = orgAccess({ status: "lost" });
    const response = await post(MARK_FOUND, { key: null });
    expect(response.status).toBe(200);
  });

  it("answers 404 for a caller who may not touch this animal, and writes NOTHING", async () => {
    control.access = () => ({ kind: "none" });
    const response = await post(REPORT_CONTENT, { key: null });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(control.writes).toEqual([]);
  });

  it("does NOT require an Idempotency-Key — the writer is idempotent on the state", async () => {
    // The command APPENDS and still needs no header, which is the case that
    // proves the rule on this endpoint is about state and not about appending.
    const response = await post(REPORT_CONTENT, { key: null });
    expect(response.status).toBe(200);
  });

  it("answers changed: false when the item was already reported", async () => {
    control.reportResult = { error: null, alreadyReported: true };
    const response = await post(REPORT_CONTENT, { key: null });
    const body = (await response.json()) as { changed: boolean };
    expect(body.changed).toBe(false);
  });

  it("maps an unreportable target to 400 lost_report_target_invalid, never 404", async () => {
    // 404 on this surface means "this animal is not yours"; sending one here
    // would navigate somebody away from a search that is running fine.
    control.reportResult = { error: "TARGET_INVALID", alreadyReported: false };
    const response = await post(REPORT_CONTENT, { key: null });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "lost_report_target_invalid" });
  });

  it("refuses a malformed body before any writer runs", async () => {
    const response = await post(
      { command: "report_content", targetEventId: "not-a-uuid", category: "harassment" },
      { key: null },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(control.writes).toEqual([]);
  });

  it("refuses a category the contract does not name", async () => {
    const response = await post(
      { command: "report_content", targetEventId: TARGET_EVENT_ID, category: "denuncia" },
      { key: null },
    );
    expect(response.status).toBe(400);
    expect(control.writes).toEqual([]);
  });

  it("runs for an animal that is NOT lost — the report is about a message, not a status", async () => {
    // Every other command here asks something of the animal's state. This one
    // objects to a sentence, and an owner who marked their animal found must
    // still be able to take down what somebody wrote during the search.
    control.access = ownerAccess({ status: "active" });
    const response = await post(REPORT_CONTENT, { key: null });
    expect(response.status).toBe(200);
    expect(control.writes).toHaveLength(1);
  });

  it("spends the WRITE buckets, joining the existing lost-mode family", async () => {
    // No new bucket and no new route: the ceiling that already bounds an owner
    // flipping disclosure toggles during a search bounds this too.
    await post(REPORT_CONTENT, { key: null });
    expect(control.limits.map((l) => l.endpoint)).toEqual([
      "api_v1_lost_write_ip",
      "api_v1_lost_write_user",
    ]);
  });
});
