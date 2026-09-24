// Regression tests for PERF-4 N+1 replacement.
//
// Verifies that:
//   1. fetchOpenWorkflows returns the correct WorkflowItem shapes after the
//      10 → 7 query consolidation (merged sub-fetchers produce identical items).
//   2. The fetchOpenCasesSweep correctly maps bite_incident to
//      "bite_observation_open" and other kinds to "case_generic_open".
//
// All DB calls are mocked so no local Postgres instance is required.

import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

const { mockExecute, mockSelect } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return {
    ...actual,
    db: {
      select: mockSelect,
      selectDistinct: mockSelect, // fetchOpenCasesSweep uses selectDistinct
      execute: mockExecute,
    },
  };
});

import type { WorkflowItem } from "@/lib/analytics/owner-dashboard";
import { fetchOpenWorkflows } from "@/lib/analytics/owner-dashboard";

// ---------------------------------------------------------------------------
// Helper: make a chainable Drizzle-style builder that resolves to `rows`
// ---------------------------------------------------------------------------

function chainReturning(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const methods = ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit", "selectDistinct"];
  for (const m of methods) chain[m] = () => chain;
  // biome-ignore lint/suspicious/noThenProperty: thenable on purpose — emulates drizzle's awaitable query builder
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  return chain;
}

// Execute mock returns the rows directly (no builder chain needed).
function executeReturning(rows: unknown[]) {
  return Promise.resolve(rows);
}

afterEach(() => {
  vi.clearAllMocks();
});

const USER_ID = "user-uuid-1234";

describe("fetchOpenWorkflows — consolidated sub-fetchers produce correct shapes", () => {
  it("returns an empty array when all sub-queries return nothing", async () => {
    // Every Drizzle .select() call returns [].
    mockSelect.mockReturnValue(chainReturning([]));
    // Every db.execute() call returns [].
    mockExecute.mockResolvedValue([]);

    const result = await fetchOpenWorkflows(USER_ID);
    expect(result).toEqual([]);
  });

  it("fetchPetAlerts — lost pet is mapped to 'pet_lost'", async () => {
    // fetchPetAlerts uses db.execute() returning a UNION result.
    mockExecute.mockImplementation(() =>
      executeReturning([
        {
          kind: "pet_lost",
          pet_id: "pet-1",
          pet_name: "Luna",
          pet_sex: "female",
          pet_public_token: "TKN-LUNA",
          since_ts: new Date("2024-06-01").toISOString(),
        },
      ]),
    );
    // All Drizzle select() calls (fosterProposals, welfareReports,
    // approvalRequests, custodyDisputes, cases sweep) return [].
    mockSelect.mockReturnValue(chainReturning([]));

    const result = await fetchOpenWorkflows(USER_ID);
    const lostItem = result.find((r) => r.kind === "pet_lost");
    expect(lostItem).toBeDefined();
    // Sex-flexed title (ciclo-perdido sweep): agrees with the pet's sex.
    expect(lostItem?.title).toBe("Luna está reportada como perdida");
    expect(lostItem?.severity).toBe("urgent");
    expect(lostItem?.ctaUrl).toContain("TKN-LUNA");
  });

  it("fetchPetAlerts — PPP attestation is mapped to 'dangerous_breed_pending_attestation'", async () => {
    mockExecute.mockImplementation(() =>
      executeReturning([
        {
          kind: "dangerous_breed_pending_attestation",
          pet_id: "pet-2",
          pet_name: "Rex",
          pet_public_token: "TKN-REX",
          since_ts: new Date("2024-01-15").toISOString(),
        },
      ]),
    );
    mockSelect.mockReturnValue(chainReturning([]));

    const result = await fetchOpenWorkflows(USER_ID);
    const pppItem = result.find((r) => r.kind === "dangerous_breed_pending_attestation");
    expect(pppItem).toBeDefined();
    expect(pppItem?.title).toContain("Rex");
    expect(pppItem?.ctaUrl).toContain("atestar-raza-peligrosa");
    // T4-I1 / #753: this item now reaches TWO kinds of owner — one with
    // nothing on record, and one whose attestation is on record but cites no
    // inscription number (the query's NOT EXISTS reads the shared
    // PPP_ATTESTED_EVIDENCE fragment). The subtitle has to speak to the second
    // one too, or it tells somebody who already attested to attest again.
    expect(pppItem?.subtitle).toContain("número de inscripción");
  });

  it("fetchPendingPetEventWorkflows — adoption application is mapped correctly", async () => {
    mockExecute
      // First execute call is fetchPetAlerts — returns empty.
      .mockResolvedValueOnce([])
      // Second execute call is fetchPendingPetEventWorkflows.
      .mockResolvedValueOnce([
        {
          kind: "adoption_application_pending",
          item_id: "evt-1",
          pet_id: "pet-3",
          pet_name: "Mochi",
          pet_public_token: "TKN-MOCHI",
          since_ts: new Date("2024-05-10").toISOString(),
        },
      ]);
    mockSelect.mockReturnValue(chainReturning([]));

    const result = await fetchOpenWorkflows(USER_ID);
    const adoptionItem = result.find((r) => r.kind === "adoption_application_pending");
    expect(adoptionItem).toBeDefined();
    expect(adoptionItem?.title).toContain("Mochi");
    expect(adoptionItem?.ctaUrl).toBe("/mis-mascotas/postulaciones");
  });

  it("fetchPendingPetEventWorkflows — custody transfer is mapped correctly", async () => {
    mockExecute.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        kind: "custody_transfer_pending",
        item_id: "pet-4",
        pet_id: "pet-4",
        pet_name: "Bruno",
        pet_public_token: "TKN-BRUNO",
        since_ts: new Date("2024-04-20").toISOString(),
      },
    ]);
    mockSelect.mockReturnValue(chainReturning([]));

    const result = await fetchOpenWorkflows(USER_ID);
    const transferItem = result.find((r) => r.kind === "custody_transfer_pending");
    expect(transferItem).toBeDefined();
    expect(transferItem?.title).toContain("Bruno");
    expect(transferItem?.ctaUrl).toContain("TKN-BRUNO");
    expect(transferItem?.ctaUrl).toContain("devolucion");
  });

  it("fetchOpenCasesSweep — bite_incident maps to 'bite_observation_open'", async () => {
    // db.execute calls return empty; Drizzle select returns cases.
    mockExecute.mockResolvedValue([]);
    // The last selectDistinct call (fetchOpenCasesSweep) returns a bite case.
    mockSelect
      // 1st call: fetchPendingFosterProposals
      .mockReturnValueOnce(chainReturning([]))
      // 2nd call: fetchOpenWelfareReports
      .mockReturnValueOnce(chainReturning([]))
      // 3rd call: fetchPendingApprovalRequests
      .mockReturnValueOnce(chainReturning([]))
      // 4th call: fetchOpenCustodyDisputes
      .mockReturnValueOnce(chainReturning([]))
      // 5th call: fetchOpenCasesSweep (selectDistinct)
      .mockReturnValueOnce(
        chainReturning([
          {
            caseId: "case-1",
            publicCode: "CASE-001",
            caseKind: "bite_incident",
            openedAt: new Date("2024-06-05"),
            petName: "Coco",
            petPublicToken: "TKN-COCO",
          },
        ]),
      );

    const result = await fetchOpenWorkflows(USER_ID);
    const biteItem = result.find((r) => r.kind === "bite_observation_open");
    expect(biteItem).toBeDefined();
    expect(biteItem?.title).toContain("Coco");
    expect(biteItem?.severity).toBe("warning");
    expect(biteItem?.ctaUrl).toContain("TKN-COCO");
  });

  it("fetchOpenCasesSweep — non-bite kind maps to 'case_generic_open'", async () => {
    mockExecute.mockResolvedValue([]);
    mockSelect
      .mockReturnValueOnce(chainReturning([]))
      .mockReturnValueOnce(chainReturning([]))
      .mockReturnValueOnce(chainReturning([]))
      .mockReturnValueOnce(chainReturning([]))
      .mockReturnValueOnce(
        chainReturning([
          {
            caseId: "case-2",
            publicCode: "CASE-002",
            caseKind: "microchip_remediation",
            openedAt: new Date("2024-06-07"),
            petName: "Max",
            petPublicToken: "TKN-MAX",
          },
        ]),
      );

    const result = await fetchOpenWorkflows(USER_ID);
    const genericItem = result.find((r) => r.kind === "case_generic_open");
    expect(genericItem).toBeDefined();
    expect(genericItem?.title).toContain("CASE-002");
    expect(genericItem?.ctaUrl).toBe("/casos/CASE-002");
  });

  it("sorts all workflow items by since desc", async () => {
    const earlier = new Date("2024-01-01");
    const later = new Date("2024-06-01");

    mockExecute
      .mockResolvedValueOnce([
        {
          kind: "pet_lost",
          pet_id: "p1",
          pet_name: "Older",
          pet_public_token: "T1",
          since_ts: earlier.toISOString(),
        },
      ])
      .mockResolvedValue([]);
    mockSelect
      .mockReturnValueOnce(
        chainReturning([
          {
            id: "fp-1",
            publicToken: "FP1",
            proposedAt: later,
            petName: "Newer",
            orgName: "Org",
          },
        ]),
      )
      .mockReturnValue(chainReturning([]));

    const result: WorkflowItem[] = await fetchOpenWorkflows(USER_ID);
    // Sort is desc; newer item should come first.
    const newerIdx = result.findIndex((r) => r.title.includes("Newer"));
    const olderIdx = result.findIndex((r) => r.title.includes("Older"));
    if (newerIdx !== -1 && olderIdx !== -1) {
      expect(newerIdx).toBeLessThan(olderIdx);
    }
  });
});
