// Unit tests for createWelfareReport use-case.
// Spec R1 — anon+auth create: rate-limit branch, ref-code retry, flag heuristics,
// pet-event bridge, openCase linkage, audit_log absence, redirect targets.
//
// All DB/repo/library calls are mocked. No Postgres required.
// Rate-limit path is exercised via the action tests (actions-create-parity.test.ts).

import { describe, expect, it, vi } from "vitest";

import type { OpenedReason } from "@/src/modules/cases/domain/opened-reason";
import { reportKeyDigest } from "../../domain/report-key-digest";
import type { WelfareRepository } from "../../infrastructure/welfare-repository";
import { createWelfareReport } from "../create-welfare-report";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type OpenCaseFn = (input: {
  kind: string;
  primarySubjectKind: string;
  primaryPetId: string | null;
  locationLat: string | null;
  locationLng: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  openedByUserId: string | null;
  openedReason: OpenedReason;
  welfareReportId: string;
}) => Promise<{ id: string; publicCode: string }>;

type ComputeFlagReasonsFn = (opts: {
  reportId: string;
  description: string;
  severity: string;
  subjectKind: string;
  attachmentCount: number;
  dwellTimeMs?: number;
  honeypotValue?: string;
}) => Promise<string[]>;

type SignalFn = (opts: {
  reportId: string;
  kind: string;
  severity: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  hasContact: boolean;
}) => Promise<void>;

// Use valid RFC 4122 v4 UUIDs — validateEventPayload schema uses z.string().uuid().
const RPT_ID = "a1b2c3d4-e5f6-4111-8abc-111111111111";
const PET_ID = "b2c3d4e5-f6a7-4222-9bcd-222222222222";

function makeRepo(
  overrides: Partial<WelfareRepository> = {},
): Pick<
  WelfareRepository,
  | "insertAttachments"
  | "linkCase"
  | "insertPetEvent"
  | "insertPetEventIdempotent"
  | "setFlagged"
  | "insertAudit"
  | "lockAndFindBridgedReportReplay"
  | "lockAndFindReportByKeyDigest"
> {
  return {
    insertAttachments: vi.fn().mockResolvedValue(undefined),
    lockAndFindBridgedReportReplay: vi.fn().mockResolvedValue(null),
    lockAndFindReportByKeyDigest: vi.fn().mockResolvedValue(null),
    linkCase: vi.fn().mockResolvedValue(undefined),
    insertPetEvent: vi.fn().mockResolvedValue(undefined),
    insertPetEventIdempotent: vi.fn().mockResolvedValue({ wasNoop: false }),
    setFlagged: vi.fn().mockResolvedValue(undefined),
    insertAudit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Pick<
    WelfareRepository,
    | "insertAttachments"
    | "linkCase"
    | "insertPetEvent"
    | "insertPetEventIdempotent"
    | "setFlagged"
    | "insertAudit"
    | "lockAndFindBridgedReportReplay"
    | "lockAndFindReportByKeyDigest"
  >;
}

/** The surveillance port: no matches unless a test says otherwise (PO S7). */
function makeSurveillance(
  match: {
    matchedSymptomCodes: string[];
    alertedDiseaseCodes: string[];
    alerts: unknown[];
  } = { matchedSymptomCodes: [], alertedDiseaseCodes: [], alerts: [] },
) {
  const flush = vi.fn().mockResolvedValue(undefined);
  return {
    match: vi.fn().mockResolvedValue(match),
    emitSignals: vi.fn().mockResolvedValue(flush),
    flush,
  };
}

function makeDeps(repoOverrides: Partial<WelfareRepository> = {}) {
  const repo = makeRepo(repoOverrides);
  const openCase: OpenCaseFn = vi.fn().mockResolvedValue({ id: "case-001", publicCode: "C-001" });
  const computeFlagReasons: ComputeFlagReasonsFn = vi.fn().mockResolvedValue([]);
  const signal: SignalFn = vi.fn().mockResolvedValue(undefined);
  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
    await cb({});
  });

  const surveillance = makeSurveillance();
  return { repo, openCase, computeFlagReasons, signal, transaction, surveillance };
}

const BASE_INPUT = {
  reportId: RPT_ID,
  referenceCode: "DEN-ABCD-12",
  kind: "neglect" as const,
  severity: "medium" as const,
  description: "El animal parece estar desnutrido y sin agua.",
  subjectKind: "unowned_animal" as const,
  subjectPetId: null as string | null,
  isOwnerOfSubjectPet: false as boolean,
  subjectDescription: "Perro callejero en el parque.",
  locationAddress: null,
  jurisdictionProvince: "Buenos Aires" as string | null,
  jurisdictionLocality: "CABA" as string | null,
  locationLat: null as string | null,
  locationLng: null as string | null,
  occurredAt: null as Date | null,
  reporterContactEmail: null as string | null,
  reporterContactPhone: null as string | null,
  observedSymptoms: null as string | null,
  attachments: [] as Array<{
    storagePath: string;
    mimeType: string;
    fileSize: number;
    originalFilename: string | null;
  }>,
  uploadedPaths: [] as string[],
  reporterUserId: null as string | null,
  dwellTimeMs: undefined as number | undefined,
  honeypotValue: "" as string,
  clientIdempotencyKey: null as string | null,
};

// ---------------------------------------------------------------------------
// Tests — core create flow
// ---------------------------------------------------------------------------

describe("createWelfareReport — successful create (anon)", () => {
  it("inserts report + opens case + links case + emits signal, returns redirect to code page", async () => {
    const { repo, openCase, computeFlagReasons, signal, transaction } = makeDeps();

    const result = await createWelfareReport(BASE_INPUT, {
      repo,
      openCase,
      computeFlagReasons,
      signal,
      transaction,
      surveillance: makeSurveillance(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(openCase).toHaveBeenCalledOnce();
    expect(repo.linkCase).toHaveBeenCalledWith(RPT_ID, "case-001", expect.anything(), null);
    expect(signal).toHaveBeenCalledOnce();
    expect(result.redirectTo).toBe("/denuncias/codigo/DEN-ABCD-12?nueva=1");
  });

  it("authenticated user: redirect goes to /denuncias/mias", async () => {
    const { repo, openCase, computeFlagReasons, signal, transaction } = makeDeps();

    const result = await createWelfareReport(
      { ...BASE_INPUT, reporterUserId: "user-123" },
      { repo, openCase, computeFlagReasons, signal, transaction, surveillance: makeSurveillance() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.redirectTo).toBe("/denuncias/mias");
  });
});

describe("createWelfareReport — audit_log absence (spec: public create writes NONE)", () => {
  it("does NOT call insertAudit for a public (anon) create", async () => {
    const { repo, openCase, computeFlagReasons, signal, transaction } = makeDeps();

    const result = await createWelfareReport(BASE_INPUT, {
      repo,
      openCase,
      computeFlagReasons,
      signal,
      transaction,
      surveillance: makeSurveillance(),
    });

    expect(result.ok).toBe(true);
    expect(repo.insertAudit).not.toHaveBeenCalled();
  });

  it("does NOT call insertAudit for an authenticated public create", async () => {
    const { repo, openCase, computeFlagReasons, signal, transaction } = makeDeps();

    const result = await createWelfareReport(
      { ...BASE_INPUT, reporterUserId: "user-123" },
      { repo, openCase, computeFlagReasons, signal, transaction, surveillance: makeSurveillance() },
    );

    expect(result.ok).toBe(true);
    expect(repo.insertAudit).not.toHaveBeenCalled();
  });
});

describe("createWelfareReport — post-commit flag heuristics (anon only)", () => {
  it("anon: calls computeFlagReasons + sets flagged when reasons returned", async () => {
    const { repo, openCase, signal, transaction } = makeDeps();
    const computeFlagReasons: ComputeFlagReasonsFn = vi
      .fn()
      .mockResolvedValue(["trivial_description"]);

    const result = await createWelfareReport(BASE_INPUT, {
      repo,
      openCase,
      computeFlagReasons,
      signal,
      transaction,
      surveillance: makeSurveillance(),
    });

    expect(result.ok).toBe(true);
    expect(computeFlagReasons).toHaveBeenCalledOnce();
    expect(repo.setFlagged).toHaveBeenCalledWith(RPT_ID, {
      flaggedAt: expect.any(Date),
      flagReasons: ["trivial_description"],
    });
  });

  it("anon: computeFlagReasons returns empty — setFlagged NOT called", async () => {
    const { repo, openCase, signal, transaction } = makeDeps();
    const computeFlagReasons: ComputeFlagReasonsFn = vi.fn().mockResolvedValue([]);

    await createWelfareReport(BASE_INPUT, {
      repo,
      openCase,
      computeFlagReasons,
      signal,
      transaction,
      surveillance: makeSurveillance(),
    });

    expect(repo.setFlagged).not.toHaveBeenCalled();
  });

  it("anon: computeFlagReasons throwing does NOT propagate (best-effort)", async () => {
    const { repo, openCase, signal, transaction } = makeDeps();
    const computeFlagReasons: ComputeFlagReasonsFn = vi
      .fn()
      .mockRejectedValue(new Error("flag service down"));

    const result = await createWelfareReport(BASE_INPUT, {
      repo,
      openCase,
      computeFlagReasons,
      signal,
      transaction,
      surveillance: makeSurveillance(),
    });

    // Report still succeeds despite flag failure
    expect(result.ok).toBe(true);
    expect(repo.setFlagged).not.toHaveBeenCalled();
  });

  it("authenticated: computeFlagReasons NOT called (flag heuristics skipped)", async () => {
    const { repo, openCase, signal, transaction } = makeDeps();
    const computeFlagReasons: ComputeFlagReasonsFn = vi.fn().mockResolvedValue([]);

    await createWelfareReport(
      { ...BASE_INPUT, reporterUserId: "user-123" },
      { repo, openCase, computeFlagReasons, signal, transaction, surveillance: makeSurveillance() },
    );

    expect(computeFlagReasons).not.toHaveBeenCalled();
  });
});

describe("createWelfareReport — reference-code retry (spec: 5 attempts on 23505)", () => {
  // The retry loop lives in WelfareRepository.insertReportWithRetry (repo concern).
  // The use-case receives a pre-inserted reportId; retry is tested in the repo layer.
  // Here we just verify the use-case correctly uses the pre-inserted reportId/referenceCode.

  it("uses the pre-inserted reportId for openCase and returns matching referenceCode in redirect", async () => {
    const { repo, openCase, computeFlagReasons, signal, transaction } = makeDeps();

    const result = await createWelfareReport(
      { ...BASE_INPUT, reportId: RPT_ID, referenceCode: "DEN-CUSTOM-99" },
      { repo, openCase, computeFlagReasons, signal, transaction, surveillance: makeSurveillance() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Redirect must use the referenceCode we passed (anon path)
    expect(result.redirectTo).toBe("/denuncias/codigo/DEN-CUSTOM-99?nueva=1");
  });

  it("linkCase is called with the pre-inserted reportId", async () => {
    const { repo, openCase, computeFlagReasons, signal, transaction } = makeDeps();

    await createWelfareReport(BASE_INPUT, {
      repo,
      openCase,
      computeFlagReasons,
      signal,
      transaction,
      surveillance: makeSurveillance(),
    });

    // linkCase must use our pre-inserted reportId
    expect(repo.linkCase).toHaveBeenCalledWith(RPT_ID, expect.any(String), expect.anything(), null);
  });
});

describe("createWelfareReport — pet-event bridge (registered_pet)", () => {
  // Pet resolution happens in the ACTION (pre-insert + pre-upload phase).
  // The use-case receives pre-resolved subjectPetId + isOwnerOfSubjectPet.

  it("abandonment: emits abandonment_reported pet event in tx", async () => {
    const { repo, openCase, computeFlagReasons, signal, transaction } = makeDeps();

    const result = await createWelfareReport(
      {
        ...BASE_INPUT,
        kind: "abandonment",
        subjectKind: "registered_pet",
        subjectPetId: PET_ID,
        isOwnerOfSubjectPet: false, // witness
        subjectDescription: null,
      },
      { repo, openCase, computeFlagReasons, signal, transaction, surveillance: makeSurveillance() },
    );

    expect(result.ok).toBe(true);
    expect(repo.insertPetEventIdempotent).toHaveBeenCalledOnce();
    const call = (repo.insertPetEventIdempotent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toMatchObject({ eventType: "abandonment_reported", petId: PET_ID });
  });

  it("neglect (maltreatment): emits maltreatment_reported pet event", async () => {
    const { repo, openCase, computeFlagReasons, signal, transaction } = makeDeps();

    const result = await createWelfareReport(
      {
        ...BASE_INPUT,
        kind: "neglect",
        subjectKind: "registered_pet",
        subjectPetId: PET_ID,
        isOwnerOfSubjectPet: false,
        subjectDescription: null,
      },
      { repo, openCase, computeFlagReasons, signal, transaction, surveillance: makeSurveillance() },
    );

    expect(result.ok).toBe(true);
    expect(repo.insertPetEventIdempotent).toHaveBeenCalledOnce();
    const call = (repo.insertPetEventIdempotent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toMatchObject({ eventType: "maltreatment_reported" });
  });

  // PO S7 (2026-09-26): a denuncia's symptoms run the matcher and raise a
  // SIGNAL — the codes land on the symptom event, one signal per alert is
  // emitted in the same transaction where the report says it happened, and
  // the authority notices go out after COMMIT. No ENO row, no owner alert
  // (neither is the use case's to write).
  it("observedSymptoms: runs the matcher, records its codes and emits the signals (S7)", async () => {
    const deps = makeDeps();
    const match = {
      matchedSymptomCodes: ["hypersalivation", "aggression"],
      alertedDiseaseCodes: ["rabies_suspected"],
      alerts: [{ disease_code: "rabies_suspected" }],
    };
    deps.surveillance = makeSurveillance(match);
    (deps.repo.insertPetEventIdempotent as ReturnType<typeof vi.fn>).mockResolvedValue({
      wasNoop: false,
      eventId: "sym-evt-1",
    });
    const place = {
      entered: { province: "Santa Fe", locality: "Rosario", indec_id: null },
      resolved: null,
    };

    await createWelfareReport(
      {
        ...BASE_INPUT,
        kind: "neglect",
        subjectKind: "registered_pet",
        subjectPetId: PET_ID,
        isOwnerOfSubjectPet: false,
        subjectDescription: null,
        observedSymptoms: "Tiene espuma en la boca y muerde todo",
        eventPlace: place,
      },
      deps,
    );

    expect(deps.surveillance.match).toHaveBeenCalledWith(
      PET_ID,
      "Tiene espuma en la boca y muerde todo",
      expect.anything(),
    );
    const symptomCall = (
      deps.repo.insertPetEventIdempotent as ReturnType<typeof vi.fn>
    ).mock.calls.find(
      (call: unknown[]) => (call[0] as { eventType: string }).eventType === "symptom_observed",
    );
    expect(symptomCall?.[0].payload).toMatchObject({
      matched_symptom_codes: ["hypersalivation", "aggression"],
      alerted_disease_codes: ["rabies_suspected"],
    });
    expect(deps.surveillance.emitSignals).toHaveBeenCalledWith(
      expect.objectContaining({ petId: PET_ID, symptomEventId: "sym-evt-1", match, place }),
      expect.anything(),
    );
    expect(deps.surveillance.flush).toHaveBeenCalledOnce();
  });

  it("a replayed denuncia (idempotent no-op) emits no second signal", async () => {
    const deps = makeDeps();
    (deps.repo.insertPetEventIdempotent as ReturnType<typeof vi.fn>).mockResolvedValue({
      wasNoop: true,
      eventId: "sym-evt-1",
    });
    await createWelfareReport(
      {
        ...BASE_INPUT,
        kind: "neglect",
        subjectKind: "registered_pet",
        subjectPetId: PET_ID,
        isOwnerOfSubjectPet: false,
        subjectDescription: null,
        observedSymptoms: "babea mucho",
      },
      deps,
    );
    expect(deps.surveillance.emitSignals).not.toHaveBeenCalled();
  });

  it("kind=other: no bridge pet event emitted", async () => {
    const { repo, openCase, computeFlagReasons, signal, transaction } = makeDeps();

    await createWelfareReport(
      {
        ...BASE_INPUT,
        kind: "other",
        subjectKind: "registered_pet",
        subjectPetId: PET_ID,
        isOwnerOfSubjectPet: false,
        subjectDescription: null,
      },
      { repo, openCase, computeFlagReasons, signal, transaction, surveillance: makeSurveillance() },
    );

    expect(repo.insertPetEventIdempotent).not.toHaveBeenCalled();
  });

  it("owner reporter: authorRole=owner in event payload", async () => {
    const { repo, openCase, computeFlagReasons, signal, transaction } = makeDeps();

    await createWelfareReport(
      {
        ...BASE_INPUT,
        kind: "abandonment",
        subjectKind: "registered_pet",
        subjectPetId: PET_ID,
        isOwnerOfSubjectPet: true, // owner
        subjectDescription: null,
        reporterUserId: "user-owner",
      },
      { repo, openCase, computeFlagReasons, signal, transaction, surveillance: makeSurveillance() },
    );

    const call = (repo.insertPetEventIdempotent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toMatchObject({ authorRole: "owner" });
  });
});

describe("createWelfareReport — attachments", () => {
  it("calls insertAttachments in tx when attachments provided", async () => {
    const { repo, openCase, computeFlagReasons, signal, transaction } = makeDeps();
    const attachments = [
      {
        storagePath: "welfare-evidence/rpt-001/file.jpg",
        mimeType: "image/jpeg",
        fileSize: 1024,
        originalFilename: "foto.jpg",
      },
    ];

    await createWelfareReport(
      { ...BASE_INPUT, attachments, reporterUserId: "user-123" },
      { repo, openCase, computeFlagReasons, signal, transaction, surveillance: makeSurveillance() },
    );

    expect(repo.insertAttachments).toHaveBeenCalledOnce();
  });

  it("skips insertAttachments when no attachments", async () => {
    const { repo, openCase, computeFlagReasons, signal, transaction } = makeDeps();

    await createWelfareReport(BASE_INPUT, {
      repo,
      openCase,
      computeFlagReasons,
      signal,
      transaction,
      surveillance: makeSurveillance(),
    });

    expect(repo.insertAttachments).not.toHaveBeenCalled();
  });
});

// Stage A review (P2 — the place of origin is never lost): the locality the
// person typed rides the denuncia's event record, as entered, even when it
// resolved to no row (a homonym here).
const ENTERED_HOMONYM = {
  entered: { province: "Buenos Aires", locality: "Mechita", indec_id: null },
  resolved: null,
};

describe("createWelfareReport — the entered place rides the bridge event", () => {
  it.each([
    ["abandonment", "abandonment_reported"],
    ["neglect", "maltreatment_reported"],
  ])("%s: the %s payload carries the place as entered", async (kind, eventType) => {
    const { repo, openCase, computeFlagReasons, signal, transaction } = makeDeps();
    await createWelfareReport(
      {
        ...BASE_INPUT,
        kind,
        subjectKind: "registered_pet",
        subjectPetId: PET_ID,
        isOwnerOfSubjectPet: false,
        subjectDescription: null,
        eventPlace: ENTERED_HOMONYM,
      },
      { repo, openCase, computeFlagReasons, signal, transaction, surveillance: makeSurveillance() },
    );
    const call = (repo.insertPetEventIdempotent as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { eventType: string }).eventType === eventType,
    );
    expect((call?.[0] as { payload: Record<string, unknown> }).payload.place).toEqual(
      ENTERED_HOMONYM,
    );
  });
});

// localidades-por-id: the denuncia's CASE is keyed to the place the door
// resolved, so the id-path gates (canReadCase, scope, RLS by govt_scope) see
// its catalogue row instead of treating it as unresolved.
const RESOLVED_BRAGADO = {
  entered: { province: "Buenos Aires", locality: "Mechita", indec_id: "06112080" },
  resolved: {
    locality_id: "22222222-2222-4222-8222-222222222222",
    province_code: "AR-B",
    method: "indec_id" as const,
  },
};

describe("createWelfareReport — the case carries the resolved place", () => {
  it("a resolved place keys the case to its row; an unresolved one is recorded as such", async () => {
    const a = makeDeps();
    await createWelfareReport(
      { ...BASE_INPUT, eventPlace: RESOLVED_BRAGADO },
      {
        repo: a.repo,
        openCase: a.openCase,
        computeFlagReasons: a.computeFlagReasons,
        signal: a.signal,
        transaction: a.transaction,
        surveillance: makeSurveillance(),
      },
    );
    expect(a.openCase).toHaveBeenCalledWith(
      expect.objectContaining({
        localityId: RESOLVED_BRAGADO.resolved.locality_id,
        placeMethod: "indec_id",
      }),
      expect.anything(),
    );

    const b = makeDeps();
    await createWelfareReport(
      { ...BASE_INPUT, eventPlace: ENTERED_HOMONYM },
      {
        repo: b.repo,
        openCase: b.openCase,
        computeFlagReasons: b.computeFlagReasons,
        signal: b.signal,
        transaction: b.transaction,
        surveillance: makeSurveillance(),
      },
    );
    expect(b.openCase).toHaveBeenCalledWith(
      expect.objectContaining({ localityId: null, placeMethod: "unresolved" }),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Two copies of one submit in flight at once (plan A5c). The action's pre-check
// cannot see a twin that has not committed; the claim inside the transaction
// can, and the second copy then writes nothing.
// ---------------------------------------------------------------------------

describe("createWelfareReport — a concurrent twin already filed it", () => {
  const PET_INPUT = {
    ...BASE_INPUT,
    kind: "physical_abuse" as const,
    subjectKind: "registered_pet" as const,
    subjectPetId: "pet-001" as string | null,
    reporterUserId: "user-001" as string | null,
    clientIdempotencyKey: "key-twin" as string | null,
    // One file, so "nothing written" covers the attachment rows too.
    attachments: [
      {
        storagePath: "welfare-evidence/twin/evidence.jpg",
        mimeType: "image/jpeg",
        fileSize: 1024,
        originalFilename: "evidencia.jpg",
      },
    ],
  };

  it("claims the key FIRST in the transaction and, on a hit, writes nothing and answers the original", async () => {
    const deps = makeDeps({
      lockAndFindBridgedReportReplay: vi
        .fn()
        .mockResolvedValue({ reportId: "rpt-original", referenceCode: "DEN-ORIG-01" }),
    } as Partial<WelfareRepository>);

    const result = await createWelfareReport(PET_INPUT, deps);

    expect(result).toEqual({
      ok: true,
      reportId: "rpt-original",
      referenceCode: "DEN-ORIG-01",
      redirectTo: "/denuncias/mias",
      discardInserted: true,
    });
    expect(deps.repo.lockAndFindBridgedReportReplay).toHaveBeenCalledWith(
      "pet-001",
      "key-twin",
      "user-001",
      {},
    );
    expect(deps.openCase).not.toHaveBeenCalled();
    expect(deps.repo.insertAttachments).not.toHaveBeenCalled();
    expect(deps.repo.insertPetEventIdempotent).not.toHaveBeenCalled();
    expect(deps.signal).not.toHaveBeenCalled();
  });

  it("no twin: files normally, with no discard flag", async () => {
    const deps = makeDeps();
    const result = await createWelfareReport(PET_INPUT, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.discardInserted).toBeUndefined();
    expect(deps.openCase).toHaveBeenCalledOnce();
  });

  it("an anonymous report has no reporter to scope the key to: no claim", async () => {
    const deps = makeDeps();
    await createWelfareReport({ ...PET_INPUT, reporterUserId: null }, deps);
    expect(deps.repo.lockAndFindBridgedReportReplay).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The report-level ledger (plan A5f, migration 0289): every submit whose key is
// long enough — anonymous ones and kinds with no bridge event included.
// ---------------------------------------------------------------------------

describe("reportKeyDigest — the stored and replayed form of a client key", () => {
  const KEY = "3f1c2b9e-7a4d-4c1e-9b2a-5d6e7f8a9b0c";

  it("is a 64-hex sha256, never the key itself", () => {
    const digest = reportKeyDigest(KEY, null);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(KEY);
  });

  it("is deterministic per (scope, key) — the retry reaches the same slot", () => {
    expect(reportKeyDigest(KEY, null)).toBe(reportKeyDigest(KEY, null));
    expect(reportKeyDigest(KEY, "user-1")).toBe(reportKeyDigest(KEY, "user-1"));
  });

  it("scopes the slot: anonymous, one account and another account never share it", () => {
    const anon = reportKeyDigest(KEY, null);
    const userA = reportKeyDigest(KEY, "user-a");
    const userB = reportKeyDigest(KEY, "user-b");
    expect(new Set([anon, userA, userB]).size).toBe(3);
  });

  it("an org member's slot is per org, and never the member's citizen slot", () => {
    const citizen = reportKeyDigest(KEY, "user-a");
    const orgOne = reportKeyDigest(KEY, "user-a", "org-1");
    const orgTwo = reportKeyDigest(KEY, "user-a", "org-2");
    expect(new Set([citizen, orgOne, orgTwo]).size).toBe(3);
    // An org never scopes an anonymous submit.
    expect(reportKeyDigest(KEY, null, "org-1")).toBe(reportKeyDigest(KEY, null));
  });

  it("only a UUID claims a slot — a constant or guessable key never swallows later reports", () => {
    // A buggy client sending one fixed string (long or short) must not turn
    // every later anonymous report into a "ya la recibimos".
    expect(reportKeyDigest("k".repeat(36), null)).toBeNull();
    expect(reportKeyDigest("constant-client-key-that-is-long-enough", null)).toBeNull();
    expect(reportKeyDigest("key-twin", "user-1")).toBeNull();
    expect(reportKeyDigest(`${KEY}x`, null)).toBeNull();
    expect(reportKeyDigest(KEY, null)).not.toBeNull();
    expect(reportKeyDigest(null, null)).toBeNull();
    expect(reportKeyDigest("", "user-1")).toBeNull();
  });
});

describe("createWelfareReport — an anonymous report's raw key stays off the pet's events (0289)", () => {
  const KEY = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  const PET_REPORT = {
    ...BASE_INPUT,
    subjectKind: "registered_pet" as const,
    subjectPetId: PET_ID as string | null,
    subjectDescription: null,
    clientIdempotencyKey: KEY as string | null,
  };

  // ALL THREE bridge call sites, one case each: reverting any one of them to
  // the raw key fails exactly its own case. `other` writes no abandonment or
  // maltreatment event, so its observed symptoms are the only bridge row.
  const BRIDGES = [
    { eventType: "abandonment_reported", kind: "abandonment", observedSymptoms: null },
    { eventType: "maltreatment_reported", kind: "physical_abuse", observedSymptoms: null },
    { eventType: "symptom_observed", kind: "other", observedSymptoms: "Tose y no come hace días." },
  ] as const;

  function bridgeEvent(deps: ReturnType<typeof makeDeps>, eventType: string) {
    const calls = vi.mocked(deps.repo.insertPetEventIdempotent).mock.calls;
    const hits = calls.filter(([event]) => event.eventType === eventType);
    expect(hits, `exactly one ${eventType} bridge row`).toHaveLength(1);
    return { event: hits[0][0], calls };
  }

  it.each(BRIDGES)(
    "anonymous $eventType: the bridge carries NO key — the report-level digest dedupes it",
    async ({ eventType, kind, observedSymptoms }) => {
      const deps = makeDeps();
      await createWelfareReport(
        { ...PET_REPORT, kind, observedSymptoms, reporterUserId: null },
        deps,
      );

      const { event, calls } = bridgeEvent(deps, eventType);
      expect(event.clientIdempotencyKey).toBeNull();
      expect(JSON.stringify(calls)).not.toContain(KEY);
      // …and the digest still claims the report's slot.
      expect(deps.repo.linkCase).toHaveBeenCalledWith(
        RPT_ID,
        "case-001",
        {},
        reportKeyDigest(KEY, null),
      );
    },
  );

  it.each(BRIDGES)(
    "identified $eventType: the bridge keeps the reporter's key, as A5c's ledger needs",
    async ({ eventType, kind, observedSymptoms }) => {
      const deps = makeDeps();
      await createWelfareReport(
        { ...PET_REPORT, kind, observedSymptoms, reporterUserId: "user-001" },
        deps,
      );

      expect(bridgeEvent(deps, eventType).event.clientIdempotencyKey).toBe(KEY);
    },
  );
});

describe("createWelfareReport — the report-level replay (A5f)", () => {
  const KEY = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
  // An anonymous report about an unowned animal: no pet, no bridge event —
  // exactly what A5c could not replay.
  const ANON_INPUT = { ...BASE_INPUT, clientIdempotencyKey: KEY as string | null };

  it("no twin: claims the digest FIRST and stamps it with the case", async () => {
    const deps = makeDeps();
    const result = await createWelfareReport(ANON_INPUT, deps);

    expect(result).toMatchObject({ ok: true, referenceCode: "DEN-ABCD-12" });
    const digest = reportKeyDigest(KEY, null);
    expect(deps.repo.lockAndFindReportByKeyDigest).toHaveBeenCalledWith(digest, {});
    expect(deps.repo.linkCase).toHaveBeenCalledWith(RPT_ID, "case-001", {}, digest);
  });

  it("anonymous twin already filed it: writes nothing and answers NOTHING about the original", async () => {
    const deps = makeDeps({
      lockAndFindReportByKeyDigest: vi
        .fn()
        .mockResolvedValue({ reportId: "rpt-someone", referenceCode: "DEN-SECRET-01" }),
    } as Partial<WelfareRepository>);

    const result = await createWelfareReport(ANON_INPUT, deps);

    expect(result).toEqual({ ok: true, anonymousReplay: true, discardInserted: true });
    // Neither the original's id nor its reference code leaves the use-case.
    expect(JSON.stringify(result)).not.toContain("rpt-someone");
    expect(JSON.stringify(result)).not.toContain("DEN-SECRET-01");
    expect(deps.openCase).not.toHaveBeenCalled();
    expect(deps.repo.linkCase).not.toHaveBeenCalled();
    expect(deps.signal).not.toHaveBeenCalled();
    // The post-commit auto-flag does not run over a row that is about to go.
    expect(deps.computeFlagReasons).not.toHaveBeenCalled();
  });

  it("identified twin already filed it (no bridge event kind): answers the original", async () => {
    const deps = makeDeps({
      lockAndFindReportByKeyDigest: vi
        .fn()
        .mockResolvedValue({ reportId: "rpt-mine", referenceCode: "DEN-MINE-01" }),
    } as Partial<WelfareRepository>);

    const result = await createWelfareReport({ ...ANON_INPUT, reporterUserId: "user-001" }, deps);

    expect(result).toEqual({
      ok: true,
      reportId: "rpt-mine",
      referenceCode: "DEN-MINE-01",
      redirectTo: "/denuncias/mias",
      discardInserted: true,
    });
    expect(deps.repo.lockAndFindReportByKeyDigest).toHaveBeenCalledWith(
      reportKeyDigest(KEY, "user-001"),
      {},
    );
    expect(deps.openCase).not.toHaveBeenCalled();
  });

  it("a short key claims no slot: files as before, stamps no digest", async () => {
    const deps = makeDeps();
    await createWelfareReport({ ...ANON_INPUT, clientIdempotencyKey: "short-key" }, deps);
    expect(deps.repo.lockAndFindReportByKeyDigest).not.toHaveBeenCalled();
    expect(deps.repo.linkCase).toHaveBeenCalledWith(RPT_ID, "case-001", {}, null);
  });
});
