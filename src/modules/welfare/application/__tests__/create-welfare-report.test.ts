// Unit tests for createWelfareReport use-case.
// Spec R1 — anon+auth create: rate-limit branch, ref-code retry, flag heuristics,
// pet-event bridge, openCase linkage, audit_log absence, redirect targets.
//
// All DB/repo/library calls are mocked. No Postgres required.
// Rate-limit path is exercised via the action tests (actions-create-parity.test.ts).

import { describe, expect, it, vi } from "vitest";

import type { OpenedReason } from "@/src/modules/cases/domain/opened-reason";
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
> {
  return {
    insertAttachments: vi.fn().mockResolvedValue(undefined),
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
  >;
}

function makeDeps(repoOverrides: Partial<WelfareRepository> = {}) {
  const repo = makeRepo(repoOverrides);
  const openCase: OpenCaseFn = vi.fn().mockResolvedValue({ id: "case-001", publicCode: "C-001" });
  const computeFlagReasons: ComputeFlagReasonsFn = vi.fn().mockResolvedValue([]);
  const signal: SignalFn = vi.fn().mockResolvedValue(undefined);
  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
    await cb({});
  });

  return { repo, openCase, computeFlagReasons, signal, transaction };
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
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(openCase).toHaveBeenCalledOnce();
    expect(repo.linkCase).toHaveBeenCalledWith(RPT_ID, "case-001", expect.anything());
    expect(signal).toHaveBeenCalledOnce();
    expect(result.redirectTo).toBe("/denuncias/codigo/DEN-ABCD-12?nueva=1");
  });

  it("authenticated user: redirect goes to /denuncias/mias", async () => {
    const { repo, openCase, computeFlagReasons, signal, transaction } = makeDeps();

    const result = await createWelfareReport(
      { ...BASE_INPUT, reporterUserId: "user-123" },
      { repo, openCase, computeFlagReasons, signal, transaction },
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
    });

    expect(result.ok).toBe(true);
    expect(repo.insertAudit).not.toHaveBeenCalled();
  });

  it("does NOT call insertAudit for an authenticated public create", async () => {
    const { repo, openCase, computeFlagReasons, signal, transaction } = makeDeps();

    const result = await createWelfareReport(
      { ...BASE_INPUT, reporterUserId: "user-123" },
      { repo, openCase, computeFlagReasons, signal, transaction },
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
      { repo, openCase, computeFlagReasons, signal, transaction },
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
      { repo, openCase, computeFlagReasons, signal, transaction },
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
    });

    // linkCase must use our pre-inserted reportId
    expect(repo.linkCase).toHaveBeenCalledWith(RPT_ID, expect.any(String), expect.anything());
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
      { repo, openCase, computeFlagReasons, signal, transaction },
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
      { repo, openCase, computeFlagReasons, signal, transaction },
    );

    expect(result.ok).toBe(true);
    expect(repo.insertPetEventIdempotent).toHaveBeenCalledOnce();
    const call = (repo.insertPetEventIdempotent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toMatchObject({ eventType: "maltreatment_reported" });
  });

  it("observedSymptoms: emits symptom_observed with matched_symptom_codes=[]", async () => {
    const { repo, openCase, computeFlagReasons, signal, transaction } = makeDeps();

    await createWelfareReport(
      {
        ...BASE_INPUT,
        kind: "neglect",
        subjectKind: "registered_pet",
        subjectPetId: PET_ID,
        isOwnerOfSubjectPet: false,
        subjectDescription: null,
        observedSymptoms: "Costillas visibles, pelaje opaco",
      },
      { repo, openCase, computeFlagReasons, signal, transaction },
    );

    // 2 events: maltreatment_reported + symptom_observed
    expect(repo.insertPetEventIdempotent).toHaveBeenCalledTimes(2);
    const symptomCall = (repo.insertPetEventIdempotent as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => (call[0] as { eventType: string }).eventType === "symptom_observed",
    );
    expect(symptomCall).toBeDefined();
    // payload must have matched_symptom_codes: []
    expect(symptomCall?.[0].payload).toMatchObject({ matched_symptom_codes: [] });
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
      { repo, openCase, computeFlagReasons, signal, transaction },
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
      { repo, openCase, computeFlagReasons, signal, transaction },
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
      { repo, openCase, computeFlagReasons, signal, transaction },
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
    });

    expect(repo.insertAttachments).not.toHaveBeenCalled();
  });
});
