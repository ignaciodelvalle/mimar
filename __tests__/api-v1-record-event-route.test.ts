// `POST /api/v1/pets/{token}/events` — every owner writer behind one URL.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE GUARD IS NOT UNIFORM, and the asymmetry is the web's. Every kind
//      refuses an org-path caller without `event.write`; every kind but NOTA
//      also refuses a DECEASED animal. An endpoint that tidied them into one
//      rule would silently take a memorial note away from a grieving owner, and
//      no typechecker would notice.
//
//      THE CAPABILITY HALF USED TO BE ASYMMETRIC TOO and stopped being on
//      2026-08-26, by PO decision: `createNoteAction` guards with
//      `requirePetAccess`, which checks no capability, so a nota was the one
//      kind an org member could write without the permission the org ficha had
//      already refused them. The gate is the rule; both doors now ask.
//   2. THE SERVER OWNS THE CALENDAR AND THE SCHEDULE. `occurredAt` is anchored
//      and checked against the ANIMAL's record; a medication's dose times are
//      generated here, never taken off the wire.
//   3. `Idempotency-Key` IS HONOURED, not merely demanded — it reaches the
//      spine as `clientIdempotencyKey`, and a replay is a 201 that says so.
//   4. THE REFUSALS CARRY THE RIGHT STATUS PER WHOSE FACT THEY ARE: 403 for the
//      CALLER, 409 for the ANIMAL, 400 for the request, 404 for anything a
//      caller may not see.
//   5. NOTHING IS WRITTEN when any gate refuses.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  /** M17: does the bite's pin corroborate its (province, locality) trio? */
  pinAgrees: true,
  live: null as null | (() => unknown),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  access: null as null | (() => unknown),
  capabilities: new Set<string>(["event.write"]),
  /** Same-day probe result. `true` → an event of that type already exists today. */
  sameDay: false,
  /** The `medication_started` row a medication END resolves to. */
  medicationSource: { id: "med-1", eventType: "medication_started" } as {
    id: string;
    eventType: string;
  } | null,
  /** The pet's canonical `pet_identifications` chip code, or null for none. */
  canonicalChip: null as string | null,
  /** Every use-case call. Empty means nothing was written. */
  writes: [] as Array<{ kind: string; input: Record<string, unknown> }>,
  /**
   * Both pregnancy writers answer `RecordPregnancyResult` — their own shape,
   * with `notAllowed` as a DISCRIMINATOR rather than a flag. One override
   * serves both halves: the endpoint reads the same three refusals from either.
   */
  pregnancyResult: null as null | (() => unknown),
  writeResult: null as null | (() => unknown),
  /**
   * Síntoma answers in its OWN shape — `{symptomEventId, signalEventIds}`, not
   * `UseCaseResult<RecordedEvent>` — so it needs its own override rather than
   * sharing `writeResult`.
   */
  symptomResult: null as null | (() => unknown),
  /** Every dep object the symptom writer was handed. Proves the flush is wired. */
  symptomDeps: [] as Array<Record<string, unknown>>,
  /** Cada objeto de dependencias que recibio el escritor de mordedura. */
  biteDeps: [] as Array<Record<string, unknown>>,
  /**
   * `replaceMicrochipForUser`'s answer. It lives OUTSIDE the events module and
   * answers in its own shape — `{ok, eventId, caseId, wasDuplicate}` or
   * `{error, denied?}` — so it cannot share `writeResult`.
   */
  replaceResult: null as null | (() => unknown),
  /**
   * What `findExistingByKey` finds for this request's key. Non-null means the
   * key already wrote — the case a PURE REVOCATION's retry lands in, where the
   * animal has no chip left and the naive answer is 409 forever.
   */
  replayEvent: null as null | { id: string },
  /** A prior `clinical_info_logged` under this key — either pregnancy phase. */
  replayedPregnancy: null as null | { id: string },
  biteResult: null as null | (() => unknown),
  /** Every notification list handed to the post-tx flush. */
  flushed: [] as unknown[],
  /** Cada llamada al canonicalizador, con las OPCIONES — el modo es la afirmacion. */
  normalizeCalls: [] as Array<{ loc: unknown; opts: unknown }>,
  /** `null` makes the strict canonicalisation THROW, as an unknown pair does. */
  normalized: { province: "Cordoba", locality: "Villa Carlos Paz" } as null | {
    province: string;
    locality: string;
  },
  /** The attestation writer's answer. */
  attestResult: null as null | (() => unknown),
  /** Non-null → the jurisdiction does not name that registry. */
  registryError: null as string | null,
  /** Every `reportError` call. A refusal that pages an engineer is a defect. */
  reported: [] as string[],
  /** `createDeathRecord`'s answer — its own shape, not `UseCaseResult`. */
  deathResult: null as null | (() => unknown),
  /** The open custody-episode case the endpoint finds for the pet, or null. */
  custodyCase: null as null | { id: string },
  /** The event this request's key already wrote, or null for a first write. */
  replayedDeath: null as null | { id: string },
  /** Every titular-alert call a caretaker-filed death produced. */
  caretakerAlerts: [] as Array<Record<string, unknown>>,
  /**
   * `recordPostAdoptionCheckin`'s answer — its own shape, with `notAllowed`
   * as a three-way discriminator like the pregnancy's. The replay check lives
   * INSIDE that writer, so a replay here is the writer answering
   * `wasDuplicate: true`, not a ledger stub.
   */
  checkinResult: null as null | (() => unknown),
  /** `createTattooForUser`'s answer — its own shape, `wasNoop` and not `wasDuplicate`. */
  tattooResult: null as null | (() => unknown),
  /**
   * What the staged photo turns into, or the refusal. `photo_not_an_image` is
   * the FILE's fault (400) and `photo_failed` is the store's (500).
   */
  claimResult: null as null | (() => unknown),
  /** Every staged path the endpoint tried to claim. Empty means it never got there. */
  claims: [] as Array<{ petId: string; stagedPath: string }>,
  /** Every attachment the endpoint took back. The unwind, observable. */
  discarded: [] as string[],
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

vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/src/modules/organizations/infrastructure/authz-resolver")
    >();
  return { ...actual, getGrantedCapabilities: async () => control.capabilities };
});

vi.mock("@/src/modules/events/infrastructure/events-repository", () => ({
  EventsRepository: class {
    async findSameDayEventOfType() {
      return control.sameDay ? { id: "dup-1" } : null;
    }
    async findSourceMedicationEvent() {
      return control.medicationSource;
    }
  },
}));

/** One factory for all six use-case mocks — they share a call signature. */
function writerMock(kind: string) {
  return async (input: Record<string, unknown>) => {
    control.writes.push({ kind, input });
    return control.writeResult
      ? control.writeResult()
      : { ok: true, value: { eventId: EVENT_ID, wasDuplicate: false }, notifications: [] };
  };
}

vi.mock("@/src/modules/events/application/medical/vaccination-use-case", () => ({
  createVaccination: writerMock("vaccination"),
}));
vi.mock("@/src/modules/events/application/medical/weight-use-case", () => ({
  createWeight: writerMock("weight"),
}));
vi.mock("@/src/modules/events/application/medical/deworming-use-case", () => ({
  createDeworming: writerMock("deworming"),
}));
vi.mock("@/src/modules/events/application/medical/medication-start-use-case", () => ({
  createMedicationStart: writerMock("medication_start"),
}));
vi.mock("@/src/modules/events/application/medical/medication-end-use-case", () => ({
  createMedicationEnd: writerMock("medication_end"),
}));
vi.mock("@/src/modules/events/application/identity/note-use-case", () => ({
  createNote: writerMock("note"),
}));
vi.mock("@/src/modules/events/application/identity/microchip-use-case", () => ({
  createMicrochip: writerMock("microchip"),
}));
vi.mock("@/src/modules/events/application/medical/sterilization-use-case", () => ({
  createSterilization: writerMock("sterilization"),
}));
vi.mock("@/src/modules/events/application/clinical/vet-visit-use-case", () => ({
  createVetVisit: writerMock("vet_visit"),
}));
vi.mock("@/src/modules/events/application/clinical/clinical-info-use-case", () => ({
  createClinicalInfo: writerMock("clinical_info"),
}));

vi.mock("@/src/modules/events/application/surveillance/symptom-observed-use-case", () => ({
  createSymptomObservedWriter: async (
    input: Record<string, unknown>,
    deps: Record<string, unknown>,
  ) => {
    control.writes.push({ kind: "symptom", input });
    control.symptomDeps.push(deps);
    return control.symptomResult
      ? control.symptomResult()
      : { ok: true, symptomEventId: EVENT_ID, signalEventIds: [], wasDuplicate: false };
  },
}));

vi.mock("@/lib/infra/pet-identifiers", () => ({
  fetchActiveIdentifications: async () => ({
    microchip: control.canonicalChip ? { code: control.canonicalChip } : null,
  }),
}));

vi.mock("@/src/modules/pets/application/microchip/replace-microchip", () => ({
  replaceMicrochipForUser: async (userId: string, input: Record<string, unknown>) => {
    control.writes.push({ kind: "microchip_replace", input: { ...input, userId } });
    return control.replaceResult
      ? control.replaceResult()
      : { ok: true, eventId: EVENT_ID, caseId: null, wasDuplicate: false };
  },
}));

vi.mock("@/lib/events/event-idempotency", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/events/event-idempotency")>();
  return {
    ...actual,
    // Two kinds ask this question and they ask about different event types, so
    // the stub answers per type rather than with one value for both.
    // THREE kinds ask this question now and they ask about different event
    // types, so the stub answers per type rather than with one value for all.
    // Both pregnancy phases share `clinical_info_logged` — the spine has no
    // `pregnancy_started` type — so one control covers them.
    findExistingByKey: async (_petId: string, eventType: string) => {
      if (eventType === "death_recorded") return control.replayedDeath;
      if (eventType === "clinical_info_logged") return control.replayedPregnancy;
      return control.replayEvent;
    },
  };
});

vi.mock("@/lib/infra/caretaker-activity-alert", () => ({
  notifyTitularOfCaretakerDeath: async (input: Record<string, unknown>) => {
    control.caretakerAlerts.push(input);
    return { notified: [] };
  },
}));

vi.mock("@/src/modules/events/application/identity/dangerous-breed-attestation-use-case", () => ({
  createDangerousBreedAttestation: async (input: Record<string, unknown>) => {
    control.writes.push({ kind: "dangerous_breed_attestation", input });
    return control.attestResult
      ? control.attestResult()
      : { ok: true, value: { eventId: EVENT_ID, wasDuplicate: false }, notifications: [] };
  },
}));

vi.mock("@/src/modules/events/application/identity/validate-attestation-registry", () => ({
  validateAttestationRegistry: async () => control.registryError,
}));

vi.mock("@/src/modules/events/application/lifecycle/death-record-use-case", () => ({
  createDeathRecord: async (input: Record<string, unknown>) => {
    control.writes.push({ kind: "death", input });
    return control.deathResult
      ? control.deathResult()
      : {
          ok: true,
          eventId: EVENT_ID,
          wasDuplicate: false,
          insertedEventId: EVENT_ID,
          rabiesObservationClosed: false,
          diseaseCode: null,
          authoritySignal: null,
        };
  },
}));

vi.mock("@/src/modules/pets/application/pregnancy/record-pregnancy-started", () => ({
  recordPregnancyStartedWriter: async (input: Record<string, unknown>) => {
    control.writes.push({ kind: "pregnancy_start", input });
    return control.pregnancyResult
      ? control.pregnancyResult()
      : { ok: true, eventId: EVENT_ID, reminderCount: 4, wasDuplicate: false };
  },
}));

vi.mock("@/src/modules/pets/application/pregnancy/record-pregnancy-ended", () => ({
  recordPregnancyEndedWriter: async (input: Record<string, unknown>) => {
    control.writes.push({ kind: "pregnancy_end", input });
    return control.pregnancyResult
      ? control.pregnancyResult()
      : { ok: true, eventId: EVENT_ID, reminderCount: 0, wasDuplicate: false };
  },
}));

vi.mock("@/src/modules/pets/application/checkin/record-post-adoption-checkin", () => ({
  recordPostAdoptionCheckin: async (input: Record<string, unknown>) => {
    control.writes.push({ kind: "post_adoption_checkin", input });
    return control.checkinResult
      ? control.checkinResult()
      : { ok: true, eventId: EVENT_ID, wasDuplicate: false };
  },
}));

vi.mock("@/src/modules/pets/application/tattoo/create-tattoo", () => ({
  createTattooForUser: async (
    petId: string,
    userId: string,
    eventAuthorship: Record<string, unknown>,
    input: Record<string, unknown>,
  ) => {
    control.writes.push({ kind: "tattoo", input: { ...input, petId, userId, eventAuthorship } });
    return control.tattooResult ? control.tattooResult() : { ok: true, eventId: EVENT_ID };
  },
  VALID_LOCATIONS: ["inner_ear_left", "inner_ear_right", "inner_thigh", "belly", "other"],
}));

vi.mock("@/lib/infra/staged-event-attachment", () => ({
  claimStagedEventAttachment: async (params: { petId: string; stagedPath: string }) => {
    control.claims.push(params);
    return control.claimResult
      ? control.claimResult()
      : {
          ok: true,
          attachment: { path: `${PET_ID}/claimed.jpg`, mimeType: "image/jpeg", size: 4242 },
        };
  },
  discardClaimedAttachment: async (path: string) => {
    control.discarded.push(path);
  },
}));

vi.mock("@/lib/infra/case-helpers", () => ({
  findOpenCaseForPetAndKind: async () => control.custodyCase,
  // Una mordedura ABRE un caso, y el codigo publico que devuelve es lo que la
  // web pone en el recibo. El endpoint lo descarta a proposito — ver el
  // encabezado de `appendBite` — asi que este stub existe para que el escritor
  // corra, no para que el test lea el codigo.
  openCase: async () => ({ id: "case-1", publicCode: "CAS-TEST-0001" }),
}));

vi.mock("@/src/modules/surveillance/application/report-bite", () => ({
  reportBite: async (input: Record<string, unknown>, deps: Record<string, unknown>) => {
    control.writes.push({ kind: "bite", input });
    control.biteDeps.push(deps);
    return control.biteResult
      ? control.biteResult()
      : {
          ok: true,
          value: {
            petToken: TOKEN,
            casePublicCode: "CAS-TEST-0001",
            eventId: EVENT_ID,
            wasDuplicate: false,
          },
          // VACIO A PROPOSITO: `@/db` no esta mockeado en este archivo, asi que
          // una lista con filas haria que el flush post-transaccion escriba de
          // verdad. El cableado del fan-out se verifica por las dependencias.
          notifications: [],
        };
  },
}));

vi.mock("@/src/modules/surveillance/infrastructure/surveillance-repository", () => ({
  SurveillanceRepository: class {},
}));

vi.mock("@/lib/infra/approval-routing", () => ({
  findAuthoritiesForJurisdiction: async () => [],
}));

vi.mock("@/lib/infra/business-rules-resolver", () => ({
  resolveBusinessRule: async () => ({ payload: { days: 10 } }),
}));

// M17: the bite's pin is checked against its trio with the denuncia's own
// corroboration. `control.pinAgrees` is what that check answers.
vi.mock("@/lib/infra/jurisdiction-from-text", () => ({
  coordinatesCorroborateJurisdiction: async () => control.pinAgrees,
}));

vi.mock("@/lib/domain/location-normalize", () => {
  class JurisdictionValidationError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    normalizeLocationForWrite: async (loc: unknown, opts: unknown) => {
      control.normalizeCalls.push({ loc, opts });
      // `strict` LEVANTA sobre un par que el catalogo INDEC no tiene. Ese es el
      // caso que este stub reproduce con `normalized: null`.
      if (control.normalized === null) {
        throw new JurisdictionValidationError("INVALID_LOCALITY", "locality not in catalog");
      }
      return control.normalized;
    },
    CoordError: class extends Error {},
    JurisdictionValidationError,
  };
});

vi.mock("@/lib/infra/report-error", () => ({
  reportError: (scope: string) => {
    control.reported.push(scope);
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

import { POST } from "@/app/api/v1/pets/[publicToken]/events/route";
// The REAL export, for an identity check rather than a shape check. Safe to
// import here: the route above already pulls this module in (writers.ts imports
// `flushNotifications` from it), so this adds no module to the graph.
import { flushNotifications } from "@/src/modules/events/application/writers";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PET_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const MED_ID = "44444444-4444-4444-8444-444444444444";
const KEY = "55555555-5555-4555-8555-555555555555";
const TOKEN = "DIM-PAMP-0001";

/** A day in the past, comfortably after the fixture's date of birth. */
const A_PAST_DAY = "2026-08-20";

function petRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PET_ID,
    publicToken: TOKEN,
    name: "Pampa",
    status: "active",
    dateOfBirth: "2020-01-01",
    // The PPP regime's own precondition. Off by default: an attestation about a
    // regime nobody placed the animal under is the thing the endpoint refuses.
    potentiallyDangerousBreed: false,
    // The animal's SURVEILLANCE CONTEXT, which only síntoma reads: species and
    // jurisdiction decide which authorities a signal reaches, and the
    // observation status decides whether a rabies match is an ordinary report
    // or an escalation inside an open case.
    species: "dog",
    jurisdictionCountry: "AR",
    jurisdictionProvince: "La Pampa",
    jurisdictionLocality: "Santa Rosa",
    rabiesObservationStatus: null,
    ...overrides,
  };
}

function orgAccess(overrides: Record<string, unknown> = {}) {
  return () => ({
    kind: "org",
    pet: petRow(),
    organization: { id: "org-1" },
    membership: { id: "m-1" },
    eventAuthorship: {
      authorRole: "shelter",
      authorOrganizationId: "org-1",
      authorVerified: false,
    },
    ...overrides,
  });
}

const A_VACCINE = { kind: "vaccination", vaccineName: "Antirrábica", occurredAt: A_PAST_DAY };
const A_NOTE = { kind: "note", text: "Comió bien toda la semana.", occurredAt: A_PAST_DAY };
/** A PURE REVOCATION - no new chip - under one of the two motives that allow it. */
const A_REVOCATION = {
  kind: "microchip_replace",
  reason: "owner_request",
  newChipNumber: null,
  occurredAt: A_PAST_DAY,
};
const A_DEATH = { kind: "death", cause: "natural", occurredAt: A_PAST_DAY };
const AN_ATTESTATION = {
  kind: "dangerous_breed_attestation",
  registry: "caba_4078",
  occurredAt: A_PAST_DAY,
};

/**
 * The staged object a ticket minted. Its PREFIX is the pet's id, which is what
 * the server re-derives and refuses anything else against; the leaf is a fresh
 * uuid with an extension picked from a closed list.
 */
const A_STAGED_PATH = `${PET_ID}/66666666-6666-4666-8666-666666666666.jpg`;
const A_TATTOO = {
  kind: "tattoo",
  tattooCode: "ABC-1234",
  locationOnBody: "inner_ear_left",
  occurredAt: A_PAST_DAY,
  stagedPath: A_STAGED_PATH,
};
const A_CHECKIN = { kind: "post_adoption_checkin", notes: "Come bien y ya duerme en su cama." };

async function call(
  body: unknown = A_VACCINE,
  init: { key?: string | null; authorization?: string | null } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = init.authorization === undefined ? "Bearer tok" : init.authorization;
  if (auth) headers.authorization = auth;
  const key = init.key === undefined ? KEY : init.key;
  if (key) headers["idempotency-key"] = key;
  return POST(
    new Request(`https://www.mimar.com.ar/api/v1/pets/${TOKEN}/events`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ publicToken: TOKEN }) },
  );
}

beforeEach(() => {
  control.live = null;
  control.limits = [];
  control.access = null;
  control.capabilities = new Set(["event.write"]);
  control.sameDay = false;
  control.medicationSource = { id: "med-1", eventType: "medication_started" };
  control.canonicalChip = null;
  control.writes = [];
  control.writeResult = null;
  control.symptomResult = null;
  control.symptomDeps = [];
  control.biteDeps = [];
  control.replaceResult = null;
  control.replayEvent = null;
  control.attestResult = null;
  control.registryError = null;
  control.reported = [];
  control.deathResult = null;
  control.custodyCase = null;
  control.replayedDeath = null;
  control.caretakerAlerts = [];
  control.pregnancyResult = null;
  control.replayedPregnancy = null;
  control.checkinResult = null;
  control.biteResult = null;
  control.flushed = [];
  control.normalized = { province: "Cordoba", locality: "Villa Carlos Paz" };
  control.pinAgrees = true;
  control.normalizeCalls = [];
  control.tattooResult = null;
  control.claimResult = null;
  control.claims = [];
  control.discarded = [];
});

describe("POST .../events — the guard is the web's, and it is not uniform", () => {
  it("refuses a clinical event on a DECEASED animal, as a fact about the animal", async () => {
    control.access = () => ({
      kind: "owner",
      pet: petRow({ status: "deceased" }),
      holderRole: "owner",
    });
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "event_not_allowed" });
    expect(control.writes).toEqual([]);
  });

  it("ACCEPTS a nota on a deceased animal — the one thing a grieving owner may write", async () => {
    // `createNoteAction` guards with `requirePetAccess`, not the alive variant,
    // and its own source says so with a `PARITY:` comment. Mirroring the five
    // clinical writers here instead would remove a memorial note from the
    // libreta and nothing would report it.
    control.access = () => ({
      kind: "owner",
      pet: petRow({ status: "deceased" }),
      holderRole: "owner",
    });
    const response = await call(A_NOTE);
    expect(response.status).toBe(201);
    expect(control.writes.map((w) => w.kind)).toEqual(["note"]);
  });

  it("refuses a clinical event for an org member without event.write — about the CALLER", async () => {
    control.access = orgAccess();
    control.capabilities = new Set();
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "event_forbidden" });
    expect(control.writes).toEqual([]);
  });

  // FLIPPED 2026-08-26 (PO decision — a ratified behaviour change). This used
  // to read "ACCEPTS a nota from an org member without event.write — no
  // capability gate on the web", and it was an accurate description of a bug:
  // the org ficha gated the note form on `event.write`, and neither writer
  // behind it asked. The gate is the rule, so the acceptance became a refusal
  // on both doors in the same commit.
  it("refuses a nota for an org member without event.write — the ficha's gate IS the rule", async () => {
    control.access = orgAccess();
    control.capabilities = new Set();
    const response = await call(A_NOTE);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "event_forbidden" });
    expect(control.writes).toEqual([]);
  });

  it("ADMITS a nota from an org member WITH event.write", async () => {
    control.access = orgAccess();
    const response = await call(A_NOTE);
    expect(response.status).toBe(201);
    expect(control.writes.map((w) => w.kind)).toEqual(["note"]);
  });

  it("refuses a nota for an org member without event.write EVEN on a deceased animal", async () => {
    // The two halves of the guard are independent and answer different
    // questions. The animal's closed record still accepts a memorial note; this
    // caller is refused for who they are, and the 403 must not be swallowed by
    // the nota's deceased exemption sitting in front of it.
    control.access = orgAccess({ pet: petRow({ status: "deceased" }) });
    control.capabilities = new Set();
    const response = await call(A_NOTE);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "event_forbidden" });
    expect(control.writes).toEqual([]);
  });

  it("ACCEPTS a nota on a deceased animal from an org member WITH event.write", async () => {
    // The memorial note survives the capability change on the ORG path too: a
    // shelter that held the animal when it died may still write one.
    control.access = orgAccess({ pet: petRow({ status: "deceased" }) });
    const response = await call(A_NOTE);
    expect(response.status).toBe(201);
    expect(control.writes.map((w) => w.kind)).toEqual(["note"]);
  });

  it("still ACCEPTS a nota from a person-path CARETAKER — capabilities are an org vocabulary", async () => {
    // `requirePetAccess` is role-agnostic on the person path and the PO's
    // decision was about the ORG path. A caretaker holds no membership, so
    // there is no capability to hold; refusing them here would be a second,
    // unratified behaviour change.
    control.access = () => ({ kind: "owner", pet: petRow(), holderRole: "caretaker" });
    control.capabilities = new Set();
    const response = await call(A_NOTE);
    expect(response.status).toBe(201);
    expect(control.writes.map((w) => w.kind)).toEqual(["note"]);
  });

  it("ADMITS an org member WITH event.write, mirroring the web's own guard", async () => {
    control.access = orgAccess();
    const response = await call();
    expect(response.status).toBe(201);
  });

  it("admits any current holder on the person path, not just the titular", async () => {
    // `requireAlivePetAccess` never narrows to `owner`: a foster holding the
    // animal records its vaccines.
    control.access = () => ({ kind: "owner", pet: petRow(), holderRole: "foster" });
    const response = await call();
    expect(response.status).toBe(201);
  });

  it("answers 404 for a pet this caller may not see, exactly as a read does", async () => {
    control.access = () => ({ kind: "none" });
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(control.writes).toEqual([]);
  });
});

describe("POST .../events — the server owns the calendar", () => {
  it("refuses a day that has not happened yet", async () => {
    const response = await call({ ...A_VACCINE, occurredAt: "2099-01-01" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "event_date_future" });
    expect(control.writes).toEqual([]);
  });

  it("refuses a day before the animal was born, with its OWN code", async () => {
    // A DIFFERENT fix from the one above, which is why it is a different code:
    // either the date is wrong or the birth date on the record is, and only the
    // person can say which.
    const response = await call({ ...A_VACCINE, occurredAt: "2019-06-01" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "event_date_before_birth" });
  });

  it("refuses a well-shaped date that is not a real day", async () => {
    // "2026-02-31" gets past the wire regex and not past `Date`.
    const response = await call({ ...A_VACCINE, occurredAt: "2026-02-31" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("anchors the day the same way the web does, at noon UTC", async () => {
    await call();
    const occurredAt = control.writes[0]?.input.occurredAt as Date;
    expect(occurredAt.toISOString()).toBe("2026-08-20T12:00:00.000Z");
  });
});

describe("POST .../events — the same-day soft gate", () => {
  it("asks once when a vaccination of the same kind is already on that day", async () => {
    control.sameDay = true;
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "same_day_duplicate_suspected" });
    expect(control.writes).toEqual([]);
  });

  it("writes when the caller re-sends with the override — it is a prompt, not a rule", async () => {
    control.sameDay = true;
    const response = await call({ ...A_VACCINE, sameDayOverride: true });
    expect(response.status).toBe(201);
    expect(control.writes).toHaveLength(1);
  });

  it("does not probe for kinds the web never asks about", async () => {
    // Only vaccination and deworming carry the prompt on the web. A weight
    // recorded twice in a day is a re-weighing, not a suspected duplicate.
    control.sameDay = true;
    const response = await call({ kind: "weight", kg: 12.5, occurredAt: A_PAST_DAY });
    expect(response.status).toBe(201);
  });
});

describe("POST .../events — each writer's own shape", () => {
  it("normalizes a weight to two decimals, as the web does before its write", async () => {
    await call({ kind: "weight", kg: 12.345, occurredAt: A_PAST_DAY });
    expect(control.writes[0]?.input.kgStr).toBe("12.35");
  });

  it("refuses a weight over the shared ceiling at the schema, not at the ledger", async () => {
    const response = await call({ kind: "weight", kg: 500, occurredAt: A_PAST_DAY });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(control.writes).toEqual([]);
  });

  it("generates the dose schedule SERVER-side and reads the first dose as AR wall clock", async () => {
    const response = await call({
      kind: "medication_start",
      drugName: "Amoxicilina",
      dose: "250 mg",
      occurredAt: A_PAST_DAY,
      frequency: "twice_daily",
      durationDays: 2,
      firstDoseAt: "2026-08-20T08:00",
    });
    expect(response.status).toBe(201);
    const input = control.writes[0]?.input as Record<string, unknown>;
    // 08:00 in Argentina is 11:00Z — a dose at eight means eight where the
    // animal lives, and an offset-less parse on a UTC server fires it three
    // hours early.
    expect((input.firstDoseAt as Date).toISOString()).toBe("2026-08-20T11:00:00.000Z");
    // Twice daily for two days: ceil((2*24+1)/12) = 5 doses.
    expect((input.schedule as Date[]).length).toBe(5);
  });

  it("refuses a custom frequency with no interval", async () => {
    const response = await call({
      kind: "medication_start",
      drugName: "Amoxicilina",
      dose: "250 mg",
      occurredAt: A_PAST_DAY,
      frequency: "custom",
      firstDoseAt: "2026-08-20T08:00",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("refuses a medication END whose source is not a medication_started on THIS animal", async () => {
    // NOT 404: on this surface that code always means the PET, and answering it
    // here would tell a client its animal had vanished.
    control.medicationSource = null;
    const response = await call({
      kind: "medication_end",
      medicationStartedEventId: MED_ID,
      occurredAt: A_PAST_DAY,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "medication_source_invalid" });
    expect(control.writes).toEqual([]);
  });

  it("refuses a note category the owner-facing form does not offer", async () => {
    // NARROWER than the web, deliberately: the web's `<select>` cannot produce
    // a bad value, so its action drops one to `null`. A JSON client can, and a
    // typo filed as "no category" survives to the ledger.
    const response = await call({ ...A_NOTE, category: "comportamento" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("refuses the spine's `system` category, which no owner may sign", async () => {
    const response = await call({ ...A_NOTE, category: "system" });
    expect(response.status).toBe(400);
  });

  it("signs a person-path write as the owner, never as a verified professional", async () => {
    await call();
    expect(control.writes[0]?.input.eventAuthorship).toEqual({
      authorRole: "owner",
      authorOrganizationId: null,
      authorVerified: false,
    });
  });

  it("signs an org-path write with the membership's resolved authorship", async () => {
    control.access = orgAccess();
    await call();
    expect(control.writes[0]?.input.eventAuthorship).toEqual({
      authorRole: "shelter",
      authorOrganizationId: "org-1",
      authorVerified: false,
    });
  });

  it("carries no attachment on any path — there is no native upload yet", async () => {
    await call();
    const input = control.writes[0]?.input as Record<string, unknown>;
    expect(input.uploadedPath).toBeNull();
    expect(input.uploadedMimeType).toBeNull();
    expect(input.uploadedSize).toBeNull();
  });
});

describe("POST .../events — the envelope", () => {
  it("passes the caller's Idempotency-Key THROUGH, rather than demanding and dropping it", async () => {
    await call();
    expect(control.writes[0]?.input.clientIdempotencyKey).toBe(KEY);
  });

  it("refuses a missing key before it spends a rate-limit counter", async () => {
    const response = await call(A_VACCINE, { key: null });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "idempotency_key_required" });
    expect(control.limits).toEqual([]);
  });

  it("refuses a key that is not a UUID, with the SAME code as an absent one", async () => {
    // Joined deliberately: both mean "send a well-formed header". A non-UUID
    // would otherwise raise 22P02 inside the write and look retryable forever.
    const response = await call(A_VACCINE, { key: "not-a-uuid" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "idempotency_key_required" });
  });

  it("reports a REPLAY as a 201 that says so", async () => {
    control.writeResult = () => ({
      ok: true,
      value: { eventId: EVENT_ID, wasDuplicate: true },
      notifications: [],
    });
    const response = await call();
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ eventId: EVENT_ID, wasDuplicate: true });
  });

  it("maps a failed append to a retryable code, without leaking its prose", async () => {
    control.writeResult = () => ({ ok: false, error: "Error al guardar. Intentá de nuevo." });
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "event_failed" });
  });

  it("spends its own buckets, named for this surface", async () => {
    await call();
    expect(control.limits).toEqual([
      { endpoint: "api_v1_event_ip", identifier: expect.any(String) },
      { endpoint: "api_v1_event_user", identifier: OWNER_ID },
    ]);
  });

  it("answers 401 without a bearer, and never writes a counter for it", async () => {
    const response = await call(A_VACCINE, { authorization: null });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "auth_required" });
    expect(control.limits).toEqual([]);
  });

  it("refuses a body whose kind is not one the contract names", async () => {
    const response = await call({ kind: "death_recorded", occurredAt: A_PAST_DAY });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(control.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WU-L — the four that crossed next, and the boundary they did not cross.
// ---------------------------------------------------------------------------

const A_MICROCHIP = { kind: "microchip", chipNumber: "982000123456789", occurredAt: A_PAST_DAY };
const A_STERILIZATION = { kind: "sterilization", procedure: "castration", occurredAt: A_PAST_DAY };
const A_VET_VISIT = { kind: "vet_visit", reason: "Control anual", occurredAt: A_PAST_DAY };
const A_CLINICAL_INFO = {
  kind: "clinical_info",
  subKind: "lab_work",
  title: "Hemograma completo",
  occurredAt: A_PAST_DAY,
};

const WU_L_KINDS: Array<[string, Record<string, unknown>]> = [
  ["microchip", A_MICROCHIP],
  ["sterilization", A_STERILIZATION],
  ["vet_visit", A_VET_VISIT],
  ["clinical_info", A_CLINICAL_INFO],
];

describe("POST .../events — the four WU-L kinds carry the ALIVE guard, each half proved", () => {
  // Every one of the four is `requireAlivePetAccess` on the web
  // (actions.ts:108 / :361 / :448, actions-medical.ts:335). Both halves of that
  // guard are asserted PER KIND rather than once for the group: a switch that
  // fell through for one of them would pass a test written only for the first.
  for (const [kind, body] of WU_L_KINDS) {
    it(`refuses ${kind} on a DECEASED animal — 409, about the animal`, async () => {
      control.access = () => ({
        kind: "owner",
        pet: petRow({ status: "deceased" }),
        holderRole: "owner",
      });
      const response = await call(body);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "event_not_allowed" });
      expect(control.writes).toEqual([]);
    });

    it(`refuses ${kind} for an org member without event.write — 403, about the caller`, async () => {
      control.access = orgAccess();
      control.capabilities = new Set();
      const response = await call(body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "event_forbidden" });
      expect(control.writes).toEqual([]);
    });

    it(`accepts ${kind} from a CARETAKER — the web's guard is not titular-only`, async () => {
      // `requireAlivePetAccess` composes `requirePetAccess`, which is
      // role-agnostic on the person path; only `requireTitularAccess` denies a
      // caretaker, and none of these four call it. Narrowing here would be this
      // endpoint inventing a rule the web does not have.
      control.access = () => ({ kind: "owner", pet: petRow(), holderRole: "caretaker" });
      const response = await call(body);
      expect(response.status).toBe(201);
      expect(control.writes.map((w) => w.kind)).toEqual([kind]);
    });
  }
});

describe("POST .../events — what the four WU-L kinds put on the spine", () => {
  it("passes a microchip's CANONICAL chip number, not a boolean", async () => {
    // The use-case needs the number: a boolean collapses "re-submitted the same
    // chip" and "implanted a different one" into one branch, and that branch
    // wrote the event while skipping the canonical row.
    control.canonicalChip = "982000111111111";
    const response = await call(A_MICROCHIP);
    expect(response.status).toBe(201);
    expect(control.writes[0].input.pet).toEqual({
      id: PET_ID,
      canonicalChipNumber: "982000111111111",
    });
    expect(control.writes[0].input.chipNumber).toBe("982000123456789");
  });

  it("passes null for a pet that carries no chip yet", async () => {
    await call(A_MICROCHIP);
    expect(control.writes[0].input.pet).toEqual({ id: PET_ID, canonicalChipNumber: null });
  });

  it("sends the two location fields as null, which is what an untouched web form stores", async () => {
    // NOT a narrowing: `parseLocationFromFormData` over a form nobody touched
    // yields all-null, and `normalizeLocationForWrite` resolves that to this
    // same pair. The app has no location affordance to send.
    for (const body of [A_VET_VISIT, A_CLINICAL_INFO]) {
      control.writes = [];
      await call(body);
      expect(control.writes[0].input.eventJurisdictionProvince).toBeNull();
      expect(control.writes[0].input.eventJurisdictionLocality).toBeNull();
    }
  });

  it("anchors every one of the four at the SAME noon-UTC instant the web uses", async () => {
    for (const [, body] of WU_L_KINDS) {
      control.writes = [];
      await call(body);
      expect((control.writes[0].input.occurredAt as Date).toISOString()).toBe(
        `${A_PAST_DAY}T12:00:00.000Z`,
      );
    }
  });

  it("carries the Idempotency-Key onto all four, and reports a replay as 201", async () => {
    for (const [, body] of WU_L_KINDS) {
      control.writes = [];
      await call(body);
      expect(control.writes[0].input.clientIdempotencyKey).toBe(KEY);
    }

    control.writeResult = () => ({
      ok: true,
      value: { eventId: EVENT_ID, wasDuplicate: true },
      notifications: [],
    });
    const replay = await call(A_STERILIZATION);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({ eventId: EVENT_ID, wasDuplicate: true });
  });

  it("carries no attachment on any of the four", async () => {
    for (const [, body] of WU_L_KINDS) {
      control.writes = [];
      await call(body);
      expect(control.writes[0].input.uploadedPath).toBeNull();
    }
  });

  it("refuses a future date and a pre-birth date for all four, before writing", async () => {
    for (const [, body] of WU_L_KINDS) {
      control.writes = [];
      const future = await call({ ...body, occurredAt: "2099-01-01" });
      expect(future.status).toBe(400);
      expect(await future.json()).toEqual({ error: "event_date_future" });

      const beforeBirth = await call({ ...body, occurredAt: "2019-01-01" });
      expect(beforeBirth.status).toBe(400);
      expect(await beforeBirth.json()).toEqual({ error: "event_date_before_birth" });
      expect(control.writes).toEqual([]);
    }
  });

  it("never runs the same-day soft gate for the four — the web does not have one", async () => {
    // `findSameDayEventOfType` has exactly two callers on the web, vaccination
    // and deworming. Applying it here would be a refusal a web user never sees.
    control.sameDay = true;
    for (const [kind, body] of WU_L_KINDS) {
      control.writes = [];
      const response = await call(body);
      expect(response.status).toBe(201);
      expect(control.writes.map((w) => w.kind)).toEqual([kind]);
    }
  });

  it("refuses the vet-only clinical sub_kind, which is why the enum has five", async () => {
    // `disease_diagnosis` is a sixth `clinical_info_logged` sub_kind whose
    // writer does no ownership check at all — it authorizes on a verified
    // matrícula. An owner's bearer token must not be able to sign it.
    const response = await call({ ...A_CLINICAL_INFO, subKind: "disease_diagnosis" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(control.writes).toEqual([]);
  });

  it("refuses a sterilization procedure outside the web's two", async () => {
    const response = await call({ ...A_STERILIZATION, procedure: "neuter" });
    expect(response.status).toBe(400);
    expect(control.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WU-M — síntoma, the eleventh kind, and the only write here that leaves the
// animal's own record.
// ---------------------------------------------------------------------------

const A_SYMPTOM = { kind: "symptom", freeText: "Decaído, no come desde ayer" };

describe("POST .../events — síntoma carries the ALIVE guard, each half proved", () => {
  // `createSymptomObservedAction` guards with `requireAlivePetAccess`
  // (actions.ts:762) — the same rule the other ten clinical kinds carry, which
  // is why the switch needed no new guard branch. Asserted anyway, and per
  // half, because "it fell into the default branch" and "it was checked" look
  // identical from the outside until one of them stops being true.
  it("refuses síntoma on a DECEASED animal — 409, about the animal", async () => {
    control.access = () => ({
      kind: "owner",
      pet: petRow({ status: "deceased" }),
      holderRole: "owner",
    });
    const response = await call(A_SYMPTOM);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "event_not_allowed" });
    expect(control.writes).toEqual([]);
  });

  it("refuses síntoma for an org member without event.write — 403, about the caller", async () => {
    control.access = orgAccess();
    control.capabilities = new Set();
    const response = await call(A_SYMPTOM);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "event_forbidden" });
    expect(control.writes).toEqual([]);
  });

  it("accepts síntoma from a CARETAKER — the web's guard is not titular-only", async () => {
    // The person watching the animal day to day is the one who notices. A
    // titular-only rule invented here would silence exactly the reporter this
    // kind exists for.
    control.access = () => ({ kind: "owner", pet: petRow(), holderRole: "caretaker" });
    const response = await call(A_SYMPTOM);
    expect(response.status).toBe(201);
    expect(control.writes.map((w) => w.kind)).toEqual(["symptom"]);
  });
});

describe("POST .../events — what a síntoma puts on the spine, and what it may not", () => {
  it("sends the free text and NOTHING the server decides for itself", async () => {
    await call({ ...A_SYMPTOM, severity: "moderate" });
    const input = control.writes[0]?.input as Record<string, unknown>;
    expect(input.freeText).toBe("Decaído, no come desde ayer");
    expect(input.severity).toBe("moderate");
    // The matcher, the outbreak signals, the outbox row and the recipients are
    // all resolved INSIDE the writer, off this text. A wire that carried a
    // disease code would be a phone filing a claim; one that carried a
    // recipient would be a phone choosing who gets woken up.
    expect(input).not.toHaveProperty("alertedDiseaseCodes");
    expect(input).not.toHaveProperty("matchedSymptomCodes");
    expect(input).not.toHaveProperty("signalEventIds");
  });

  it("reads the animal's surveillance context off the ACCESS query, not off the wire", async () => {
    control.access = () => ({
      kind: "owner",
      pet: petRow({ rabiesObservationStatus: "in_progress" }),
      holderRole: "owner",
    });
    await call(A_SYMPTOM);
    const input = control.writes[0]?.input as Record<string, unknown>;
    expect(input.petSpecies).toBe("dog");
    expect(input.petJurisdictionCountry).toBe("AR");
    expect(input.petJurisdictionProvince).toBe("La Pampa");
    expect(input.petJurisdictionLocality).toBe("Santa Rosa");
    // The escalation switch. A client that could set it would be able to
    // declare an antirrabic observation nobody opened.
    expect(input.rabiesObservationStatus).toBe("in_progress");
  });

  it("WIRES THE NOTIFICATION FLUSH — the fan-out's last leg", async () => {
    // The quietest possible regression: every signal still written, every row
    // still on the spine, and nobody told. The writer builds its notifications
    // inside the transaction and hands them to this dep afterwards; an endpoint
    // that passed no flush would drop them without failing anything.
    //
    // ASSERTED BY IDENTITY, not by `typeof === "function"`. A shape check passes
    // for `() => {}`, which is precisely the regression it is here to catch: a
    // flush that is wired, callable, and tells nobody.
    await call(A_SYMPTOM);
    expect(control.symptomDeps[0]?.flushNotifications).toBe(flushNotifications);
  });

  it("signs with the org path's resolved authorship, never re-derived", async () => {
    control.access = orgAccess();
    await call(A_SYMPTOM);
    expect(control.writes[0]?.input.eventAuthorship).toEqual({
      authorRole: "shelter",
      authorOrganizationId: "org-1",
      authorVerified: false,
    });
  });

  it("takes a síntoma with NO date at all, where every other kind requires one", async () => {
    const response = await call(A_SYMPTOM);
    expect(response.status).toBe(201);
    expect(control.writes[0]?.input.onsetAt).toBeNull();
  });

  it("holds a STATED onset to the animal's own record, both ways", async () => {
    const future = await call({ ...A_SYMPTOM, onsetAt: "2099-01-01" });
    expect(future.status).toBe(400);
    expect(await future.json()).toEqual({ error: "event_date_future" });
    expect(control.writes).toEqual([]);

    const beforeBirth = await call({ ...A_SYMPTOM, onsetAt: "2019-06-01" });
    expect(beforeBirth.status).toBe(400);
    expect(await beforeBirth.json()).toEqual({ error: "event_date_before_birth" });
    expect(control.writes).toEqual([]);
  });

  it("passes a stated onset THROUGH as the day string, not as an instant", async () => {
    // The writer anchors it at noon UTC with the web's own `parseDateInput`. An
    // endpoint that converted it here would be a second anchor.
    await call({ ...A_SYMPTOM, onsetAt: A_PAST_DAY });
    expect(control.writes[0]?.input.onsetAt).toBe(A_PAST_DAY);
  });

  it("never runs the same-day soft gate for a síntoma — the web has no such gate", async () => {
    control.sameDay = true;
    const response = await call(A_SYMPTOM);
    expect(response.status).toBe(201);
  });

  it("carries the Idempotency-Key onto it, and reports a replay as 201", async () => {
    // THE WHOLE REASON THIS KIND COULD CROSS. The exclusion that kept it out for
    // two work units said this writer took no key; it has taken one since the
    // W-1 fix of 2026-06-07 and branches to `insertEventIdempotent` on it.
    await call(A_SYMPTOM);
    expect(control.writes[0]?.input.clientIdempotencyKey).toBe(KEY);

    control.symptomResult = () => ({
      ok: true,
      symptomEventId: EVENT_ID,
      signalEventIds: [],
      wasDuplicate: true,
    });
    const response = await call(A_SYMPTOM);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ eventId: EVENT_ID, wasDuplicate: true });
  });

  it("answers with the SYMPTOM's event id, never a signal's", async () => {
    // `signalEventIds` are system-authored rows about a DISEASE in a
    // jurisdiction. The asiento the owner wrote is the one they can open,
    // correct and see in their libreta; answering with a signal id would hand a
    // phone an identifier that resolves to somebody else's fact.
    control.symptomResult = () => ({
      ok: true,
      symptomEventId: EVENT_ID,
      signalEventIds: ["99999999-9999-4999-8999-999999999999"],
      wasDuplicate: false,
    });
    const response = await call(A_SYMPTOM);
    expect(await response.json()).toEqual({ eventId: EVENT_ID, wasDuplicate: false });
  });

  it("maps a failed síntoma to the same retryable code, without leaking its prose", async () => {
    control.symptomResult = () => ({ ok: false, error: "constraint pet_events_x violated" });
    const response = await call(A_SYMPTOM);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "event_failed" });
  });

  it("refuses a severity outside the web's three", async () => {
    const response = await call({ ...A_SYMPTOM, severity: "moderado" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(control.writes).toEqual([]);
  });

  it("refuses an empty description before it writes anything", async () => {
    const response = await call({ kind: "symptom", freeText: "   " });
    expect(response.status).toBe(400);
    expect(control.writes).toEqual([]);
  });
});

describe("POST .../events - reemplazo de microchip, whose web door is not the alive one", () => {
  const owner =
    (over: Record<string, unknown> = {}) =>
    () => ({ kind: "owner", pet: petRow(over), holderRole: "owner" });

  it("ACCEPTS a replacement on a DECEASED animal, because `requireOwnedPetByToken` does", async () => {
    // NOT A FAMILY RESEMBLANCE TO NOTA. The owner's own door
    // (microchip-reemplazo/action.ts:25) is `requireOwnedPetByToken`, which
    // checks life status no more than `requirePetAccess` does - and the act
    // that needs it most is exactly this one: a chip recovered from an animal
    // that died still has to stop pointing at it.
    control.access = owner({ status: "deceased" });
    control.canonicalChip = "982000111111111";
    const response = await call(A_REVOCATION);
    expect(response.status).toBe(201);
    expect(control.writes.map((w) => w.kind)).toEqual(["microchip_replace"]);
  });

  it("still REFUSES the PPP attestation on a deceased animal - its own page redirects one away", async () => {
    // THE NEAR MISS. Both kinds arrived the same day through the same
    // `requireOwnedPetByToken`, and exempting the cohort would have been wrong:
    // `atestar-raza-peligrosa/page.tsx:22` sends a deceased pet back, so here
    // the 409 IS the parity.
    control.access = owner({ status: "deceased", potentiallyDangerousBreed: true });
    const response = await call(AN_ATTESTATION);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "event_not_allowed" });
    expect(control.writes).toEqual([]);
  });

  it("REPLAYS a pure revocation instead of refusing the retry it exists for", async () => {
    // THE DEFECT THIS PAIRING WAS WRITTEN FOR. A revocation succeeds and leaves
    // the animal chipless; the client's retry - same key, as the endpoint
    // demands - arrives at a pet with no canonical chip, and a bare "nothing to
    // replace" would answer 409 forever to a write that already happened.
    control.access = owner();
    control.canonicalChip = null;
    control.replayEvent = { id: "ev-original" };
    const response = await call(A_REVOCATION);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ eventId: "ev-original", wasDuplicate: true });
    // NON-VACUITY: the replay is answered from the ledger, not by writing again.
    expect(control.writes).toEqual([]);
  });

  it("answers 409 when there is no chip AND the key wrote nothing", async () => {
    // The other half of the branch above, without which the replay check could
    // be swallowing a genuine refusal.
    control.access = owner();
    control.canonicalChip = null;
    control.replayEvent = null;
    const response = await call(A_REVOCATION);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "event_not_allowed" });
    expect(control.writes).toEqual([]);
  });

  it("answers 403 - not 500 - when the actor-pet gate refuses the caller", async () => {
    // A sanctuary that OWNS the animal resolves to `vet_in_org`, whose gate
    // demands `shelter_custody` or `foster`. That is a refusal the client can
    // read, not a server fault, and it must not page anyone at 3am.
    control.access = owner();
    control.canonicalChip = "982000111111111";
    control.replaceResult = () => ({
      error: "replaceMicrochipForUser failed: Organization does not hold custody.",
      denied: true,
    });
    const response = await call(A_REVOCATION);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "event_forbidden" });
    expect(control.reported).toEqual([]);
  });

  it("keeps 500 + a report for a genuine failure, so the two are not one answer", async () => {
    control.access = owner();
    control.canonicalChip = "982000111111111";
    control.replaceResult = () => ({ error: "constraint pet_events_x violated" });
    const response = await call(A_REVOCATION);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "event_failed" });
    expect(control.reported).toEqual(["api-v1-event"]);
  });

  it("carries the WRITER'S wasDuplicate rather than a flat false", async () => {
    // The writer resolves a replay by returning the original event id. Until
    // 2026-09-08 this endpoint printed `false` over that, telling a client to
    // draw "asiento creado" for a write that had not happened.
    control.access = owner();
    control.canonicalChip = "982000111111111";
    control.replaceResult = () => ({
      ok: true,
      eventId: "ev-original",
      caseId: null,
      wasDuplicate: true,
    });
    const response = await call(A_REVOCATION);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ eventId: "ev-original", wasDuplicate: true });
  });

  it("refuses an attestation for an animal nobody placed under the regime", async () => {
    control.access = owner({ potentiallyDangerousBreed: false });
    const response = await call(AN_ATTESTATION);
    expect(response.status).toBe(409);
    expect(control.writes).toEqual([]);
  });

  it("refuses a registry the pet's jurisdiction does not name", async () => {
    control.access = owner({ potentiallyDangerousBreed: true });
    control.registryError = "PPP_REGISTRY_NOT_ALLOWED";
    const response = await call(AN_ATTESTATION);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(control.writes).toEqual([]);
  });

  it("writes the attestation when the regime applies and the registry is named", async () => {
    control.access = owner({ potentiallyDangerousBreed: true });
    const response = await call(AN_ATTESTATION);
    expect(response.status).toBe(201);
    expect(control.writes.map((w) => w.kind)).toEqual(["dangerous_breed_attestation"]);
    // The key the endpoint demands reaches the writer, which is the whole
    // reason the kind stopped being excluded.
    expect(control.writes[0].input.clientIdempotencyKey).toBe(KEY);
  });

  // T4-I1 / #753. The PPP registries inscribe the PROPIETARIO (Ley CABA 4078
  // via APrA; Ley PBA 14.107 via the Registro Provincial), so a caretaker
  // asserting the inscription is asserting a legal fact about somebody else,
  // permanently, into an append-only ledger — and it is exactly the assertion
  // that moves a dog out of the non-compliant cohort `/gob` counts.
  //
  // This test and its web sibling ARE the enforcement, not a second layer over
  // one: `scripts/check-titular-gate.ts` does not reach this writer (its scan
  // needs the insert and the event-type literal in one body; they are three
  // files apart) and 0212 dropped the RLS policy that read
  // `titular_only_event_types()`. The deny-list row `ppp-attestation` in
  // lib/domain/titular-only.ts says so out loud.
  it("refuses a caretaker's attestation — titular-only (#753)", async () => {
    control.access = () => ({
      kind: "owner",
      pet: petRow({ potentiallyDangerousBreed: true }),
      holderRole: "caretaker",
    });
    const response = await call(AN_ATTESTATION);
    // 403 and not 404: the caller demonstrably holds this animal, so the
    // "pretend it does not exist" refusal every other denial on this surface
    // uses would be a lie with nothing on the other side of it.
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "event_forbidden" });
    expect(control.writes).toEqual([]);
  });

  it("still admits a foster and a co-owner — the gate denies exactly one role", async () => {
    for (const holderRole of ["foster", "co_owner"]) {
      control.writes.length = 0;
      control.access = () => ({
        kind: "owner",
        pet: petRow({ potentiallyDangerousBreed: true }),
        holderRole,
      });
      const response = await call(AN_ATTESTATION);
      expect([holderRole, response.status]).toEqual([holderRole, 201]);
    }
  });

  it("still admits the org path, where holderRole does not exist", async () => {
    control.access = orgAccess({ pet: petRow({ potentiallyDangerousBreed: true }) });
    const response = await call(AN_ATTESTATION);
    expect(response.status).toBe(201);
    expect(control.writes.map((w) => w.kind)).toEqual(["dangerous_breed_attestation"]);
  });
});

describe("POST .../events — fallecimiento, el asiento que cierra el registro", () => {
  const owner =
    (over: Record<string, unknown> = {}) =>
    () => ({
      kind: "owner",
      pet: petRow(over),
      holderRole: "owner",
    });

  it("REFUSES a death on an animal already recorded dead — and that IS the parity", async () => {
    // The web reaches this refusal by its own route: `createDeathRecordAction`
    // guards with `requirePetAccess`, which accepts a non-alive pet, and then
    // refuses at actions.ts:1172 with "Esta mascota ya está registrada como
    // fallecida." So the blanket 409 here is the same rule in a different
    // sentence — unlike nota and reemplazo de microchip, this kind gets NO
    // exemption, and asserting that is what stops a future reader from adding
    // one by family resemblance.
    control.access = owner({ status: "deceased" });
    const response = await call(A_DEATH);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "event_not_allowed" });
    expect(control.writes).toEqual([]);
  });

  it("DERIVES whether the death is reportable — a client may not assert it", async () => {
    // The wire has no `isReportable` field and this is why: that boolean decides
    // whether a health authority hears about a zoonosis. `resolveDeathReportable`
    // reads the catalog server-side, so a client naming rabies gets the
    // consequence and a client CLAIMING the consequence gets nothing.
    control.access = owner();
    await call({ ...A_DEATH, cause: "disease", diseaseCode: "rabies_confirmed" });
    expect(control.writes[0].input.isReportable).toBe(true);

    control.writes = [];
    await call({ ...A_DEATH, cause: "accident" });
    expect(control.writes[0].input.isReportable).toBe(false);
  });

  it("finds the pet's OPEN CUSTODY CASE itself and files the death against it", async () => {
    // A client naming a case id would be a client choosing which shelter
    // episode a death closes.
    control.access = owner();
    control.custodyCase = { id: "case-custodia-1" };
    await call(A_DEATH);
    expect(control.writes[0].input.custodyEpisodeCaseId).toBe("case-custodia-1");
  });

  it("passes null when the animal is in nobody's custody episode", async () => {
    control.access = owner();
    control.custodyCase = null;
    await call(A_DEATH);
    expect(control.writes[0].input.custodyEpisodeCaseId).toBeNull();
  });

  it("REPLAYS the retry of a death that already committed, on the DECEASED pet it left behind", async () => {
    // THE STATE THE FIRST VERSION OF THIS TEST COULD NOT REACH, and that is why
    // it proved nothing: it forged an ACTIVE pet carrying a `death_recorded`
    // row under this key — a combination this endpoint's own writer cannot
    // produce, because a death sets `status: "deceased"` in the same
    // transaction. So the field was green in the suite and unreachable on the
    // wire.
    //
    // The real sequence: the app's 10s abort fires while the five-way cascade
    // is still committing, the form returns to editing holding the SAME key,
    // the person taps again — and meets the animal their own write just marked
    // deceased. Answering 409 there tells a grieving person their record was
    // refused on the one write nobody can repeat, while it is in fact committed.
    control.access = owner({ status: "deceased" });
    control.replayedDeath = { id: "ev-original" };
    const response = await call(A_DEATH);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ eventId: "ev-original", wasDuplicate: true });
    // NON-VACUITY: answered from the ledger, not by running the cascade again.
    expect(control.writes).toEqual([]);
  });

  it("still refuses a SECOND death under a NEW key, which is the web's own refusal", async () => {
    // The other half of the branch above. Without this, the replay check could
    // be swallowing a refusal that must stand.
    control.access = owner({ status: "deceased" });
    control.replayedDeath = null;
    const response = await call(A_DEATH);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "event_not_allowed" });
    expect(control.writes).toEqual([]);
  });

  it("NULLS a disease code the cause did not ask for, whatever the client sent", async () => {
    // The native form clears it, but the form is not the authority. Any other
    // client could otherwise store `cause: "accident"` with
    // `disease_code: "rabies_confirmed"` and `is_reportable: false` — a
    // permanent claim of a confirmed rabies death that raised no authority
    // signal, in a row that is append-only and not amendable.
    control.access = owner();
    await call({ ...A_DEATH, cause: "accident", diseaseCode: "rabies_confirmed" });
    expect(control.writes[0].input.diseaseCode).toBeNull();
    expect(control.writes[0].input.isReportable).toBe(false);
  });

  it("TELLS THE TITULAR when a caretaker is the one who filed it", async () => {
    // The compensating control the web has and this door shipped without. A
    // caretaker holds the animal; the titular owns it — and `death_recorded` is
    // not amendable, so there is no correction path to discover it late.
    control.access = () => ({
      kind: "owner",
      pet: petRow(),
      holderRole: "caretaker",
    });
    const response = await call(A_DEATH);
    expect(response.status).toBe(201);
    expect(control.caretakerAlerts).toHaveLength(1);
    expect(control.caretakerAlerts[0]).toMatchObject({ eventId: EVENT_ID, petId: PET_ID });
  });

  it("does NOT tell the titular when the holder IS the titular", async () => {
    // NON-VACUITY: an alert that fired for everyone would pass the case above
    // and spam the owner about their own act.
    control.access = owner();
    await call(A_DEATH);
    expect(control.caretakerAlerts).toEqual([]);
  });

  it("does NOT re-tell the titular on a replay — nothing was inserted", async () => {
    // Guarded on `insertedEventId`, not `eventId`: that is what those two
    // fields are FOR. A titular told twice that their animal died is the exact
    // harm the distinction prevents.
    control.access = () => ({ kind: "owner", pet: petRow(), holderRole: "caretaker" });
    control.deathResult = () => ({
      ok: true,
      eventId: "ev-original",
      wasDuplicate: true,
      insertedEventId: null,
      rabiesObservationClosed: false,
      diseaseCode: null,
      authoritySignal: null,
    });
    await call(A_DEATH);
    expect(control.caretakerAlerts).toEqual([]);
  });

  it("refuses a cause outside the nine the web offers, before writing", async () => {
    control.access = owner();
    const response = await call({ ...A_DEATH, cause: "asesinato" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(control.writes).toEqual([]);
  });

  it("refuses a disease code the catalog does not know", async () => {
    // The catalog moved into the contract with this kind so the app can draw a
    // picker of the codes the server accepts; this is the other half of that.
    control.access = owner();
    const response = await call({
      ...A_DEATH,
      cause: "disease",
      diseaseCode: "gripe_de_pinguino",
    });
    expect(response.status).toBe(400);
    expect(control.writes).toEqual([]);
  });

  it("refuses 'el veterinario decidió solo' when the vet DID reach the owner", async () => {
    // The field a professional dispute would turn on. Under "sí" or "no aplica"
    // the claim is a contradiction, and this record is the one somebody may
    // later take to a colegio.
    control.access = owner();
    const response = await call({
      ...A_DEATH,
      deathAtClinic: true,
      vetContactedOwner: "yes",
      vetDecidedAlone: true,
    });
    expect(response.status).toBe(400);
    expect(control.writes).toEqual([]);
  });
});

describe("POST .../events — embarazo, y las tres negativas que no son la misma", () => {
  const A_START = { kind: "pregnancy_start", occurredAt: A_PAST_DAY, weeksAtDiagnosis: 4 };
  const AN_END = { kind: "pregnancy_end", occurredAt: A_PAST_DAY, outcome: "unknown" };

  it("appends the start and answers 201 with the event it wrote", async () => {
    const res = await call(A_START);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      eventId: EVENT_ID,
      wasDuplicate: false,
    });
    expect(control.writes).toHaveLength(1);
    expect(control.writes[0].kind).toBe("pregnancy_start");
  });

  it("hands the writer the SAME Idempotency-Key the caller sent", async () => {
    // THE FIELD THAT LETS THIS KIND EXIST ON THIS ENDPOINT AT ALL. Both writers
    // were excluded from it on the grounds that they could not honour a key;
    // dropping it here would silently restore that, and the endpoint would go
    // on promising idempotency it no longer delivers.
    await call(A_START);
    expect(control.writes[0].input.clientIdempotencyKey).toBe(KEY);
  });

  it("reports a replay as a duplicate rather than as a second asiento", async () => {
    control.pregnancyResult = () => ({
      ok: true,
      eventId: EVENT_ID,
      // 0 ON A REPLAY AND THAT IS HONEST: this call scheduled nothing, the
      // first one already did. The endpoint drops the number either way.
      reminderCount: 0,
      wasDuplicate: true,
    });
    const res = await call(A_START);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ wasDuplicate: true });
  });

  it("answers pregnancy_not_applicable — NOT event_not_allowed — for an animal that cannot carry one", async () => {
    // THE WHOLE REASON THESE THREE CODES EXIST. `event_not_allowed`'s client
    // copy reads "Esta mascota está registrada como fallecida…", so a male dog
    // routed to it would be told his life record is closed.
    control.pregnancyResult = () => ({
      ok: false,
      error: "Solo se pueden registrar embarazos en hembras.",
      notAllowed: "not_applicable",
    });
    const res = await call(A_START);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "pregnancy_not_applicable" });
  });

  it("answers pregnancy_already_open when a follow-up is running", async () => {
    control.pregnancyResult = () => ({
      ok: false,
      error: "Esta mascota ya tiene un embarazo en seguimiento.",
      notAllowed: "already_open",
    });
    const res = await call(A_START);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "pregnancy_already_open" });
  });

  it("answers pregnancy_none_open when the CLOSE has nothing to close", async () => {
    // THE OPPOSITE NEXT MOVE from the one above — record the start first — which
    // is exactly why it is not the same code.
    control.pregnancyResult = () => ({
      ok: false,
      error: "Esta mascota no tiene un embarazo activo para cerrar.",
      notAllowed: "none_open",
    });
    const res = await call(AN_END);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "pregnancy_none_open" });
  });

  it("reports an unflagged failure as the server's own, not as the animal's", async () => {
    // No `notAllowed` means the TRANSACTION failed. 500 and reported — telling a
    // caller "your animal cannot do this" would send them to fix a pet that is
    // fine.
    control.pregnancyResult = () => ({ ok: false, error: "connection terminated" });
    const res = await call(A_START);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "event_failed" });
    expect(control.reported).toHaveLength(1);
  });

  it("refuses a birth count under an outcome that is not a live birth, on the WIRE", async () => {
    // The contract's cross-field rule, before any writer runs: "nacieron 3"
    // alongside "se perdió el embarazo" is a record that contradicts itself, on
    // a spine that cannot be edited.
    const res = await call({ ...AN_END, outcome: "miscarriage", liveBirthsCount: 3 });
    expect(res.status).toBe(400);
    // NON-VACUITY: nothing reached a writer, so the refusal is the schema's.
    expect(control.writes).toHaveLength(0);
  });

  it("refuses a live birth with NO count, in the other direction", async () => {
    const res = await call({ ...AN_END, outcome: "live_birth" });
    expect(res.status).toBe(400);
    expect(control.writes).toHaveLength(0);
  });

  it("drops the count the client sent under a non-live outcome — it never reaches the writer", async () => {
    // The happy path of the same rule: a valid close carries no count, and the
    // writer is handed null rather than something it would have to re-judge.
    await call(AN_END);
    expect(control.writes[0].input.liveBirthsCount).toBeNull();
  });

  it("HONOURS THE KEY on a retry the animal's new state would otherwise refuse — the close", async () => {
    // THE TEST THAT WAS MISSING, and its absence is why the defect shipped past
    // a green gate. The other replay test injects `wasDuplicate: true` INTO the
    // writer's answer, so it proves the endpoint forwards a flag and nothing
    // about whether a replay can ever produce one.
    //
    // The scenario is the one the `Idempotency-Key` exists for. The close
    // committed; `rederivePregnancyStatus` moved the animal to
    // `completed_live_birth`; the phone never saw the 201 and re-sent the same
    // body with the same key. The writer's own guard is now CORRECT to refuse —
    // there is no open pregnancy — so the endpoint has to ask the ledger BEFORE
    // it asks the animal.
    control.replayedPregnancy = { id: "ev-original" };
    // The writer is armed to refuse. If the pre-check regresses, this is the
    // 409 the person gets, with copy telling them to append a spurious start.
    control.pregnancyResult = () => ({
      ok: false,
      error: "Esta mascota no tiene un embarazo activo para cerrar.",
      notAllowed: "none_open",
    });

    const res = await call(AN_END);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      eventId: "ev-original",
      wasDuplicate: true,
    });
    // NON-VACUITY WITH TEETH: the writer was never reached, so the 201 is the
    // ledger's answer and not a refusal that happened to look like success.
    expect(control.writes).toHaveLength(0);
  });

  it("HONOURS THE KEY on the mirror case — the start, refused as already_open", async () => {
    control.replayedPregnancy = { id: "ev-original" };
    control.pregnancyResult = () => ({
      ok: false,
      error: "Esta mascota ya tiene un embarazo en seguimiento.",
      notAllowed: "already_open",
    });

    const res = await call(A_START);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ wasDuplicate: true });
    expect(control.writes).toHaveLength(0);
  });

  it("reaches the writer when the key wrote nothing — so the check above is not a blanket 201", async () => {
    control.replayedPregnancy = null;
    const res = await call(A_START);
    expect(res.status).toBe(201);
    expect(control.writes).toHaveLength(1);
    await expect(res.json()).resolves.toMatchObject({ wasDuplicate: false });
  });

  it("refuses BOTH halves on a deceased animal, from the shared guard", async () => {
    // NOT exempt like nota, reemplazo and fallecimiento are: a closed life
    // record does not accept a gestation, and `checkWriteGuard` says so before
    // either writer is reached.
    control.access = () => ({
      kind: "owner",
      pet: petRow({ status: "deceased" }),
      holderRole: "owner",
    });
    for (const body of [A_START, AN_END]) {
      control.writes = [];
      const res = await call(body);
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ error: "event_not_allowed" });
      expect(control.writes).toHaveLength(0);
    }
  });
});

describe("POST .../events — seguimiento post-adopción, the eighteenth and last", () => {
  it("appends the check-in and answers 201 with the asiento it wrote", async () => {
    const res = await call(A_CHECKIN);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ eventId: EVENT_ID, wasDuplicate: false });
    expect(control.writes).toHaveLength(1);
    expect(control.writes[0].kind).toBe("post_adoption_checkin");
    expect(control.writes[0].input.notes).toBe("Come bien y ya duerme en su cama.");
  });

  it("hands the writer the SAME Idempotency-Key the caller sent", async () => {
    await call(A_CHECKIN);
    expect(control.writes[0].input.clientIdempotencyKey).toBe(KEY);
  });

  it("hands the writer NO attachment and NO location when none was staged — the app has no map yet", async () => {
    // THE LOCATION HALF IS STILL A FIXED SCOPE DECISION: no map on the phone,
    // so the writer always gets the two nulls, the same way every other kind on
    // this endpoint does. THE ATTACHMENT HALF STOPPED BEING FIXED IN D7 — see
    // the describe block below for what a STAGED photo hands the writer instead.
    await call(A_CHECKIN);
    const input = control.writes[0].input;
    expect(input.uploadedPath).toBeNull();
    expect(input.uploadedMimeType).toBeNull();
    expect(input.uploadedSize).toBeNull();
    expect(input.eventJurisdictionProvince).toBeNull();
    expect(input.eventJurisdictionLocality).toBeNull();
  });

  it("accepts the kind with no text at all, and hands the writer null notes", async () => {
    // "Estamos bien" with nothing typed is a real check-in; the web's form has
    // no required field either.
    const res = await call({ kind: "post_adoption_checkin" });
    expect(res.status).toBe(201);
    expect(control.writes[0].input.notes).toBeNull();
  });

  it("answers a replayed key as a duplicate, not as a second check-in", async () => {
    // The writer owns the replay — it asks the ledger BEFORE its window guard,
    // so a retry of the write that closed the last window comes back as the
    // original. The endpoint's half is to say so rather than draw "asiento
    // creado" over a write that did not happen twice.
    control.checkinResult = () => ({ ok: true, eventId: "ev-original", wasDuplicate: true });
    const res = await call(A_CHECKIN);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      eventId: "ev-original",
      wasDuplicate: true,
    });
  });

  it("answers checkin_not_adopted for an animal never adopted through the platform", async () => {
    control.checkinResult = () => ({
      ok: false,
      error: "No se encontró adopción registrada para esta mascota.",
      notAllowed: "not_adopted",
    });
    const res = await call(A_CHECKIN);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "checkin_not_adopted" });
    expect(control.reported).toHaveLength(0);
  });

  it("answers checkin_not_adopter — 403, about the CALLER — when the adoption names somebody else", async () => {
    // A co-owner or a caretaker holds the animal and is still not the adopter.
    // Not `event_forbidden`: that copy sends the person to ask an admin for a
    // capability that would not help.
    control.checkinResult = () => ({
      ok: false,
      error: "No sos el adoptante registrado para esta mascota.",
      notAllowed: "not_adopter",
    });
    const res = await call(A_CHECKIN);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "checkin_not_adopter" });
  });

  it("answers checkin_no_open_window when nothing is pending — wait, not fix", async () => {
    control.checkinResult = () => ({
      ok: false,
      error: "Pampa no tiene un check-in post-adopción pendiente en este momento.",
      notAllowed: "no_open_window",
    });
    const res = await call(A_CHECKIN);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "checkin_no_open_window" });
  });

  it("reports an unflagged failure as the server's own, not as the animal's", async () => {
    control.checkinResult = () => ({ ok: false, error: "connection terminated" });
    const res = await call(A_CHECKIN);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "event_failed" });
    expect(control.reported).toHaveLength(1);
  });

  it("refuses the ORG path at the door, in the web shim's own terms, before the writer runs", async () => {
    // `event.write` is granted, so the shared guard lets the member through;
    // this refusal is the check-in's own: an organization is never the adopter.
    control.access = orgAccess();
    const res = await call(A_CHECKIN);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "checkin_not_adopter" });
    expect(control.writes).toHaveLength(0);
  });

  it("ACCEPTS a check-in on a deceased animal — its web door is requirePetAccess, not the alive variant", async () => {
    // The parity this kind's guard exemption exists for. A refugio that asked
    // "¿cómo está?" is owed the answer even when the answer is that the animal
    // died, and the web accepts that check-in (app/actions/checkin.ts guards
    // with `requirePetAccess`, whose page gates on the adoption and the window
    // only). Refusing here would make this the one door that hides it.
    control.access = () => ({
      kind: "owner",
      pet: petRow({ status: "deceased" }),
      holderRole: "owner",
    });
    const res = await call(A_CHECKIN);
    expect(res.status).toBe(201);
    expect(control.writes.map((w) => w.kind)).toEqual(["post_adoption_checkin"]);
  });

  it("does not ask the writer for a day it has no field for", async () => {
    // No `occurredAt` on the wire and none in the writer's input: the writer
    // stamps the moment of reporting, as the web action does. A day sneaked
    // into the body is dropped by the schema, never forwarded.
    await call({ ...A_CHECKIN, occurredAt: A_PAST_DAY });
    expect("occurredAt" in control.writes[0].input).toBe(false);
  });
});

describe("POST .../events — seguimiento post-adopción, D7's optional photo", () => {
  const WITH_PHOTO = { ...A_CHECKIN, stagedPath: A_STAGED_PATH };

  it("claims the staged photo FIRST, then appends, and hands the writer what it claimed", async () => {
    const response = await call(WITH_PHOTO);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ eventId: EVENT_ID, wasDuplicate: false });

    expect(control.claims).toEqual([{ petId: PET_ID, stagedPath: A_STAGED_PATH }]);
    const write = control.writes.find((w) => w.kind === "post_adoption_checkin");
    expect(write?.input).toMatchObject({
      // FROM THE CLAIM AND NOT FROM THE WIRE, same rule as tattoo's: nothing a
      // client says about the bytes is believed.
      uploadedPath: `${PET_ID}/claimed.jpg`,
      uploadedMimeType: "image/jpeg",
      uploadedSize: 4242,
    });
    expect(control.discarded).toEqual([]);
  });

  it("claims NOTHING when no photo was staged — there is nothing a claim could delete", async () => {
    await call(A_CHECKIN);
    expect(control.claims).toEqual([]);
  });

  it("refuses a staged object that is not an image with 400, and writes NOTHING", async () => {
    control.claimResult = () => ({ ok: false, code: "photo_not_an_image" });
    const response = await call(WITH_PHOTO);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "photo_not_an_image" });
    expect(control.writes.filter((w) => w.kind === "post_adoption_checkin")).toEqual([]);
  });

  it("answers 500 when the object store fails, and still writes nothing", async () => {
    control.claimResult = () => ({ ok: false, code: "photo_failed" });
    const response = await call(WITH_PHOTO);
    expect(response.status).toBe(500);
    expect(control.writes.filter((w) => w.kind === "post_adoption_checkin")).toEqual([]);
  });

  it("TAKES THE ATTACHMENT BACK when the append fails", async () => {
    control.checkinResult = () => ({ ok: false, error: "no se pudo registrar el check-in" });
    const response = await call(WITH_PHOTO);
    expect(response.status).toBe(500);
    expect(control.discarded).toEqual([`${PET_ID}/claimed.jpg`]);
  });

  it("TAKES THE ATTACHMENT BACK on a refused precondition too, not only on a server failure", async () => {
    // `not_allowed` arms return before the generic 500 branch but still ran the
    // claim — a photo claimed for a check-in the writer then refuses is just as
    // orphaned as one behind a 500.
    control.checkinResult = () => ({
      ok: false,
      error: "No sos el adoptante registrado para esta mascota.",
      notAllowed: "not_adopter",
    });
    const response = await call(WITH_PHOTO);
    expect(response.status).toBe(403);
    expect(control.discarded).toEqual([`${PET_ID}/claimed.jpg`]);
  });

  it("ON A DUPLICATE FROM THE WRITER answers 201 and DISCARDS the redundant upload", async () => {
    // The race the ledger check below cannot catch: two requests under one key
    // in flight at once, both past the ledger read before either committed.
    control.checkinResult = () => ({ ok: true, eventId: EVENT_ID, wasDuplicate: true });
    const response = await call(WITH_PHOTO);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ eventId: EVENT_ID, wasDuplicate: true });
    expect(control.discarded).toEqual([`${PET_ID}/claimed.jpg`]);
  });
});

describe("POST .../events — seguimiento post-adopción, el replay que no puede volver a subir la foto", () => {
  const WITH_PHOTO = { ...A_CHECKIN, stagedPath: A_STAGED_PATH };

  it("ASKS THE LEDGER BEFORE THE CLAIM when a photo is staged, and answers the replay without touching Storage", async () => {
    // Same fix as tattoo's, same reason: a successful first request deletes the
    // staged object, so claiming first on a replay would 404 a checkin that
    // already exists.
    control.replayEvent = { id: EVENT_ID };

    const response = await call(WITH_PHOTO);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ eventId: EVENT_ID, wasDuplicate: true });
    expect(control.claims).toEqual([]);
    expect(control.discarded).toEqual([]);
    expect(control.writes.filter((w) => w.kind === "post_adoption_checkin")).toEqual([]);
  });

  it("does NOT ask the ledger up front when no photo was staged — the writer's own check is enough", async () => {
    // The check-in writer already asks the ledger itself when its window has
    // closed (`recordPostAdoptionCheckin`'s rule 3). Asking again here, for a
    // request with nothing a claim could delete, would just be a second read
    // for no reason.
    control.replayEvent = { id: EVENT_ID };

    const response = await call(A_CHECKIN);

    expect(response.status).toBe(201);
    // The write still ran — the endpoint's own pre-check only fires when
    // `stagedPath` is present.
    expect(control.writes.filter((w) => w.kind === "post_adoption_checkin")).toHaveLength(1);
  });

  it("does NOT short-circuit when the ledger has nothing under this key", async () => {
    control.replayEvent = null;

    const response = await call(WITH_PHOTO);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ eventId: EVENT_ID, wasDuplicate: false });
    expect(control.claims).toHaveLength(1);
    expect(control.writes.filter((w) => w.kind === "post_adoption_checkin")).toHaveLength(1);
  });
});

describe("POST .../events — mordedura, y la jurisdiccion es la del hecho", () => {
  const A_BITE = {
    kind: "bite",
    occurredAt: A_PAST_DAY,
    victimKind: "human",
    severity: "moderate",
  };
  const WITH_PLACE = {
    ...A_BITE,
    provinceCode: "AR-X",
    localityName: "Villa Carlos Paz",
    localityIndecId: "14014010",
  };

  it("appends the bite and answers 201 with the asiento it wrote", async () => {
    const res = await call(A_BITE);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      eventId: EVENT_ID,
      wasDuplicate: false,
    });
    expect(control.writes).toHaveLength(1);
    expect(control.writes[0].kind).toBe("bite");
  });

  it("hands the writer the SAME Idempotency-Key the caller sent", async () => {
    await call(A_BITE);
    expect(control.writes[0].input.clientIdempotencyKey).toBe(KEY);
  });

  it("routes the case to the INCIDENT jurisdiction when one is given", async () => {
    // La decision de producto: una mordedura en Cordoba de una mascota de CABA
    // es problema de la autoridad de Cordoba. El endpoint canonicaliza y pasa el
    // par ya resuelto; el escritor nunca ve el codigo ISO.
    await call(WITH_PLACE);
    expect(control.writes[0].input.eventJurisdictionProvince).toBe("Cordoba");
    expect(control.writes[0].input.eventJurisdictionLocality).toBe("Villa Carlos Paz");
    // Y EN MODO ESTRICTO, que es la afirmacion entera: la web canonicaliza con
    // `locality: "none"` porque geocodifica texto libre, y esta app elige del
    // catalogo, asi que el par se puede verificar. Sin esta linea el test
    // probaba que el endpoint llama al canonicalizador y nada sobre como.
    expect(control.normalizeCalls).toHaveLength(1);
    expect(control.normalizeCalls[0].opts).toMatchObject({ locality: "strict" });
    expect(control.normalizeCalls[0].loc).toMatchObject({
      provinceCode: "AR-X",
      localityIndecId: "14014010",
      // El codigo ISO es lo que un cliente puede afirmar; el nombre para mostrar
      // lo decide el catalogo.
      province: null,
    });
  });

  it("passes NULLS when no place was given, so the writer falls back to the animal's", async () => {
    // NO ES UN AGUJERO: "no se exactamente donde" es una respuesta real y el
    // respaldo del escritor es una conducta definida — la misma que toma la web
    // cuando el reportante no soltó un pin.
    await call(A_BITE);
    expect(control.writes[0].input.eventJurisdictionProvince).toBeNull();
    expect(control.writes[0].input.eventJurisdictionLocality).toBeNull();
  });

  it("refuses a locality the catalogue does not hold, WITHOUT writing", async () => {
    // El modo `strict` es mas firme que el camino de la web, que geocodifica
    // texto libre. 400 y no un 409: el problema es la peticion, no el animal.
    control.normalized = null;
    const res = await call(WITH_PLACE);
    expect(res.status).toBe(400);
    expect(control.writes).toHaveLength(0);
  });

  it("refuses a HALF jurisdiction on the wire, before any writer runs", async () => {
    // Una provincia sin localidad rutearia el caso a (provincia nueva, localidad
    // de la mascota) — un par que no nombra ningun lugar, adentro de la alerta
    // que recibe una autoridad.
    const res = await call({ ...A_BITE, provinceCode: "AR-X" });
    expect(res.status).toBe(400);
    expect(control.writes).toHaveLength(0);
  });

  it("sends no coordinates when no pin was placed, so the bite lands in the residual", async () => {
    // Nunca GPS: sin pin puesto por la persona, null es el valor honesto y el
    // cargador de puntos ya sabe que hacer con el.
    await call(WITH_PLACE);
    expect(control.writes[0].input.locationLat).toBeNull();
    expect(control.writes[0].input.locationLng).toBeNull();
    expect(control.writes[0].input.locationSource).toBeNull();
  });

  it("stores a pin as pin_manual even when the client CLAIMS geocodificada (M17 review)", async () => {
    // provenance.ts ranks "geocodificada" as verificado for officials; a phone
    // can claim it for a pin it moved by hand. The server stores what it can
    // stand behind: a point a person placed.
    control.pinAgrees = true;
    await call({
      ...WITH_PLACE,
      locationLat: -31.42,
      locationLng: -64.19,
      locationSource: "geocodificada",
    });
    expect(control.writes[0].input.locationLat).toBe(-31.42);
    expect(control.writes[0].input.locationSource).toBe("pin_manual");
  });

  it("refuses a pin the (province, locality) pair contradicts, WITHOUT writing (M17 review)", async () => {
    // Una mordedura cuenta donde ocurrio: un pin en Cordoba con codigos de
    // Buenos Aires no se archiva en ninguno de los dos — la persona elige.
    control.pinAgrees = false;
    const res = await call({ ...WITH_PLACE, locationLat: -31.42, locationLng: -64.19 });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: "bite_location_mismatch" });
    expect(control.writes).toHaveLength(0);
  });

  it("wires the authority fan-out and the per-jurisdiction observation window", async () => {
    // CABLEADO, NO EJECUCION, y el nombre lo dice: `@/db` no esta mockeado aca,
    // asi que un flush con filas escribiria de verdad. Lo que se puede afirmar
    // sin ensuciar la base es que las dos dependencias que la web le pasa a este
    // escritor tambien llegan por este camino — dejarlas afuera seria la
    // regresion mas silenciosa posible: todo escrito y nadie avisado.
    await call(A_BITE);
    expect(control.biteDeps).toHaveLength(1);
    expect(typeof control.biteDeps[0]?.findAuthoritiesForJurisdiction).toBe("function");
    expect(typeof control.biteDeps[0]?.resolveObservationWindow).toBe("function");
  });

  it("reports a replay as a duplicate rather than as a second incident", async () => {
    control.biteResult = () => ({
      ok: true,
      value: {
        petToken: TOKEN,
        casePublicCode: "CAS-TEST-0001",
        eventId: EVENT_ID,
        wasDuplicate: true,
      },
      notifications: [],
    });
    const res = await call(A_BITE);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ wasDuplicate: true });
  });

  it("refuses a victim kind and a severity the contract does not name", async () => {
    for (const body of [
      { ...A_BITE, victimKind: "alien" },
      { ...A_BITE, severity: "mild" },
    ]) {
      control.writes = [];
      const res = await call(body);
      expect(res.status).toBe(400);
      expect(control.writes).toHaveLength(0);
    }
  });

  it("refuses on a deceased animal, from the shared guard", async () => {
    control.access = () => ({
      kind: "owner",
      pet: petRow({ status: "deceased" }),
      holderRole: "owner",
    });
    const res = await call(A_BITE);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "event_not_allowed" });
    expect(control.writes).toHaveLength(0);
  });
});

describe("POST .../events — tatuaje, el unico asiento que exige una foto", () => {
  it("claims the staged photo FIRST, then appends, and hands the writer what it claimed", async () => {
    const response = await call(A_TATTOO);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      eventId: EVENT_ID,
      wasDuplicate: false,
    });

    // THE ORDER IS THE WEB'S ORDER — `createTattooAction` uploads before it
    // calls the writer, so a failed insert never leaks bytes it cannot see.
    expect(control.claims).toEqual([{ petId: PET_ID, stagedPath: A_STAGED_PATH }]);

    const write = control.writes.find((w) => w.kind === "tattoo");
    expect(write).toBeDefined();
    expect(write?.input).toMatchObject({
      petId: PET_ID,
      userId: OWNER_ID,
      code: "ABC-1234",
      location: "inner_ear_left",
      // FROM THE CLAIM AND NOT FROM THE WIRE. Nothing a client says about the
      // bytes is believed: the path, the type and the size are all what the
      // server decided after reading them.
      uploadedAttachment: { path: `${PET_ID}/claimed.jpg`, mimeType: "image/jpeg", size: 4242 },
      clientIdempotencyKey: KEY,
    });
    // Nothing was taken back — the append succeeded on the first attempt.
    expect(control.discarded).toEqual([]);
  });

  it("refuses a staged object that is not an image with 400, and writes NOTHING", async () => {
    // The FILE is the problem, not the body — a different instruction to the
    // person holding the phone than "re-read your request".
    control.claimResult = () => ({ ok: false, code: "photo_not_an_image" });
    const response = await call(A_TATTOO);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "photo_not_an_image" });
    expect(control.writes.filter((w) => w.kind === "tattoo")).toEqual([]);
  });

  it("answers 500 when the object store fails, and still writes nothing", async () => {
    control.claimResult = () => ({ ok: false, code: "photo_failed" });
    const response = await call(A_TATTOO);
    expect(response.status).toBe(500);
    expect(control.writes.filter((w) => w.kind === "tattoo")).toEqual([]);
  });

  it("TAKES THE ATTACHMENT BACK when the append fails", async () => {
    // The same cleanup `createTattooAction` performs. Without it the bytes sit
    // in `event-attachments` with no row pointing at them and nothing to
    // collect them.
    control.tattooResult = () => ({ error: "no se pudo registrar el tatuaje" });
    const response = await call(A_TATTOO);
    expect(response.status).toBe(500);
    expect(control.discarded).toEqual([`${PET_ID}/claimed.jpg`]);
    expect(control.reported).toContain("api-v1-event");
  });

  it("ON A REPLAY answers 201 wasDuplicate and DISCARDS the redundant upload", async () => {
    // `wasNoop` means the first attempt's event AND its attachment already
    // exist and are already linked. This request's bytes are a second copy
    // nothing points at — the identical condition the web action cleans up on.
    control.tattooResult = () => ({ ok: true, eventId: EVENT_ID, wasNoop: true });
    const response = await call(A_TATTOO);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ eventId: EVENT_ID, wasDuplicate: true });
    expect(control.discarded).toEqual([`${PET_ID}/claimed.jpg`]);
  });

  it("takes NO DAY at all, and passes the absence through as null", async () => {
    // A tattoo read off an adopted animal has no known date. The writer records
    // that as a fact (`tattoo_date_known: false`) rather than stamping today,
    // and the endpoint must not invent one on the way.
    const { occurredAt: _dropped, ...noDay } = A_TATTOO;
    const response = await call(noDay);
    expect(response.status).toBe(201);
    expect(control.writes.find((w) => w.kind === "tattoo")?.input).toMatchObject({
      recordedAt: null,
    });
  });

  it("anchors a stated day the way every other kind's is anchored", async () => {
    await call(A_TATTOO);
    const recordedAt = control.writes.find((w) => w.kind === "tattoo")?.input.recordedAt;
    expect(recordedAt).toBeInstanceOf(Date);
    expect((recordedAt as Date).toISOString().slice(0, 10)).toBe(A_PAST_DAY);
  });

  it("refuses it on a DECEASED animal, and never touches the staged object", async () => {
    // NOT among the four kinds exempt from the animal's half of the guard. A
    // closed life record accepts no new identification act, and the refusal
    // lands BEFORE the claim so a refused request costs no Storage round trip.
    control.access = () => ({
      kind: "owner",
      pet: petRow({ status: "deceased" }),
      holderRole: "owner",
    });
    const response = await call(A_TATTOO);
    expect(response.status).toBe(409);
    expect(control.claims).toEqual([]);
    expect(control.writes.filter((w) => w.kind === "tattoo")).toEqual([]);
  });

  it("refuses an org caller without event.write, before the claim", async () => {
    control.access = orgAccess();
    control.capabilities = new Set();
    const response = await call(A_TATTOO);
    expect(response.status).toBe(403);
    expect(control.claims).toEqual([]);
  });

  it("signs an ORG write with the member's resolved authorship, never re-derived", async () => {
    control.access = orgAccess();
    await call(A_TATTOO);
    expect(control.writes.find((w) => w.kind === "tattoo")?.input.eventAuthorship).toEqual({
      authorRole: "shelter",
      authorOrganizationId: "org-1",
      authorVerified: false,
    });
  });
});

describe("POST .../events — tatuaje, el replay que no puede volver a subir la foto", () => {
  it("ASKS THE LEDGER BEFORE THE CLAIM, and answers the replay without touching Storage", async () => {
    // THE ORDER IS THE FIX. A successful first request DELETES the staged
    // object on its way out, so a claim-first replay downloads a key that is
    // gone, 404s, and tells the person their photo is not an image — about a
    // tattoo that exists. With the app's 10s abort that is not theoretical.
    control.replayEvent = { id: EVENT_ID };

    const response = await call(A_TATTOO);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ eventId: EVENT_ID, wasDuplicate: true });
    // NEVER REACHED THE OBJECT STORE. This is the assertion that pins the
    // ORDER rather than the outcome: claiming first would answer the same 201
    // only when the bytes happened to still be there.
    expect(control.claims).toEqual([]);
    expect(control.discarded).toEqual([]);
    // And nothing was appended a second time.
    expect(control.writes.filter((w) => w.kind === "tattoo")).toEqual([]);
  });

  it("hands back the FIRST attempt's event id, not a new one", async () => {
    // The caller asked for an asiento to exist and one exists. Answering with a
    // fresh id would point them at a row that is not the one on the spine.
    const firstEventId = "99999999-9999-4999-8999-999999999999";
    control.replayEvent = { id: firstEventId };

    const response = await call(A_TATTOO);

    await expect(response.json()).resolves.toEqual({
      eventId: firstEventId,
      wasDuplicate: true,
    });
  });

  it("does NOT short-circuit when the ledger has nothing under this key", async () => {
    // The other half of the branch: a first attempt still claims and appends.
    // Without this, a mutation that always short-circuited would pass above.
    control.replayEvent = null;

    const response = await call(A_TATTOO);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ eventId: EVENT_ID, wasDuplicate: false });
    expect(control.claims).toHaveLength(1);
    expect(control.writes.filter((w) => w.kind === "tattoo")).toHaveLength(1);
  });

  it("still discards the redundant upload when the WRITER reports the duplicate", async () => {
    // The race the ledger check cannot catch: two requests under one key in
    // flight at once, both past the ledger read before either committed, and
    // the partial unique index decides. The loser's bytes are a second copy
    // nothing points at.
    control.replayEvent = null;
    control.tattooResult = () => ({ ok: true, eventId: EVENT_ID, wasNoop: true });

    const response = await call(A_TATTOO);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ eventId: EVENT_ID, wasDuplicate: true });
    expect(control.discarded).toEqual([`${PET_ID}/claimed.jpg`]);
  });
});
