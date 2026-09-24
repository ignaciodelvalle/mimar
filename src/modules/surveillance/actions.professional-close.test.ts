// The State's close of a rabies observation (Ley 22.953), at the ACTION edge.
//
// Found 2026-09-18: this action sent its notifications through the module's
// flushNotifications, which keys on the bite CASE and DROPS any row without
// one. A close with no open bite case therefore lost the owner's result AND the
// urgent confirmed-rabies alert to the health authority, while the operator saw
// success. It also told one owner (`role = 'owner'`, `limit(1)`), never the
// co-owners.
//
// This file runs the action with the REAL use case and the REAL notification
// service, and fakes only the edges: the guard, the repository, routing, and
// the database client underneath the service. So what it pins is what lands in
// `notifications` (or `notification_dead_letter`), not what a stub was handed:
//
//   · no open bite case → the owners' notices and the authority alert still land;
//   · every active owner and co-owner gets one;
//   · the dedupe key is anchored on the ended event, not on the case;
//   · a transient insert failure dead-letters the rows instead of dropping them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { notificationDeadLetter, notifications } from "@/db";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

type InsertedRow = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  requireAdminOrGovtOrRedirect: vi.fn(),
  transaction: vi.fn(),
  insert: vi.fn(),
  sendPushForNotifications: vi.fn(),
  closeCase: vi.fn(),
  findAuthoritiesForJurisdiction: vi.fn(),
  revalidatePath: vi.fn(),
  repo: {
    findPetByToken: vi.fn(),
    findLatestObservationStarted: vi.fn(),
    findOpenBiteCase: vi.fn(),
    insertObservationEnded: vi.fn(),
    closeObservationIfOpen: vi.fn(),
    findActiveOwnerUserIds: vi.fn(),
    insertObservationCloseAuditLog: vi.fn(),
  },
}));

// The real schema (the service inserts into the real table objects), a fake
// client: `transaction` is the close's, `insert` is the notification service's.
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual, db: { transaction: mocks.transaction, insert: mocks.insert } };
});

vi.mock("@/lib/infra/web-push", () => ({
  sendPushForNotifications: mocks.sendPushForNotifications,
}));

vi.mock("@/lib/infra/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/infra/auth-guards")>()),
  requireAdminOrGovtOrRedirect: mocks.requireAdminOrGovtOrRedirect,
}));

vi.mock("@/src/modules/surveillance/infrastructure/surveillance-repository", () => ({
  SurveillanceRepository: class {
    findPetByToken = mocks.repo.findPetByToken;
    findLatestObservationStarted = mocks.repo.findLatestObservationStarted;
    findOpenBiteCase = mocks.repo.findOpenBiteCase;
    insertObservationEnded = mocks.repo.insertObservationEnded;
    closeObservationIfOpen = mocks.repo.closeObservationIfOpen;
    findActiveOwnerUserIds = mocks.repo.findActiveOwnerUserIds;
    insertObservationCloseAuditLog = mocks.repo.insertObservationCloseAuditLog;
  },
}));

vi.mock("@/lib/infra/case-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/infra/case-helpers")>()),
  closeCase: mocks.closeCase,
}));

vi.mock("@/lib/infra/approval-routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/infra/approval-routing")>()),
  findAuthoritiesForJurisdiction: mocks.findAuthoritiesForJurisdiction,
}));

vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  revalidatePath: mocks.revalidatePath,
}));

// ---------------------------------------------------------------------------
// The fake client under the notification service
// ---------------------------------------------------------------------------

const PET_ID = "c0000000-0000-4000-8000-000000000001";
const STARTED_EVENT_ID = "c0000000-0000-4000-8000-000000000003";
const ENDED_EVENT_ID = "c0000000-0000-4000-8000-000000000004";

/** Rows the service landed in `notifications`. */
let landed: InsertedRow[] = [];
/** Rows the service dead-lettered. */
let deadLettered: InsertedRow[] = [];
/** When true, every insert into `notifications` fails like a transient blip. */
let notificationsInsertFails = false;

function installFakeClient() {
  mocks.insert.mockImplementation((table: unknown) => {
    if (table === notifications) {
      return {
        values: (rows: InsertedRow[]) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              if (notificationsInsertFails) throw new Error("connection reset by peer");
              landed.push(...rows);
              return rows.map((_, i) => ({ id: `n-${landed.length + i}` }));
            },
          }),
        }),
      };
    }
    if (table === notificationDeadLetter) {
      return {
        values: async (row: InsertedRow) => {
          deadLettered.push(row);
        },
      };
    }
    throw new Error("unexpected insert target in this test");
  });
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

type Actions = typeof import("./actions");
let actions: Actions;

function close(outcome: string) {
  return actions.professionalCloseRabiesObservationAction(
    "DIM-TEST-0002",
    formData({ outcome, closureNotes: "" }),
  );
}

const OWNER_TYPE = "rabies_observation_completed_professional_owner";
const AUTHORITY_TYPE = "rabies_observation_positive_authority";

beforeEach(async () => {
  vi.clearAllMocks();
  landed = [];
  deadLettered = [];
  notificationsInsertFails = false;
  installFakeClient();

  mocks.requireAdminOrGovtOrRedirect.mockResolvedValue({
    user: { id: "admin-1" },
    profile: { id: "admin-1", role: "admin" },
    jurisdictions: [],
  });
  mocks.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb("fake-tx"),
  );
  mocks.sendPushForNotifications.mockResolvedValue(undefined);
  mocks.closeCase.mockResolvedValue(undefined);
  mocks.findAuthoritiesForJurisdiction.mockResolvedValue(["authority-1", "authority-2"]);

  mocks.repo.findPetByToken.mockResolvedValue({
    id: PET_ID,
    publicToken: "DIM-TEST-0002",
    name: "Tango",
    species: "dog",
    status: "active",
    rabiesObservationStatus: "window_expired_unclosed",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
  });
  mocks.repo.findLatestObservationStarted.mockResolvedValue({
    id: STARTED_EVENT_ID,
    occurredAt: new Date("2026-09-01T12:00:00.000Z"),
    payload: { bite_event_id: null, observation_until: "2026-09-11T12:00:00.000Z" },
  });
  // THE CASE THIS FILE IS ABOUT: the observation has no open bite case.
  mocks.repo.findOpenBiteCase.mockResolvedValue(null);
  mocks.repo.insertObservationEnded.mockResolvedValue({ id: ENDED_EVENT_ID });
  mocks.repo.closeObservationIfOpen.mockResolvedValue(true);
  mocks.repo.findActiveOwnerUserIds.mockResolvedValue(["owner-1", "co-owner-2"]);
  mocks.repo.insertObservationCloseAuditLog.mockResolvedValue(undefined);

  actions = await import("./actions");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("professionalCloseRabiesObservationAction — notifications", () => {
  it("with NO open bite case, a positive still reaches every owner AND the authority", async () => {
    const res = await close("positive_rabies");
    expect(res).toEqual({ error: null, redirectTo: "/admin/observaciones" });

    const owners = landed.filter((r) => r.notificationType === OWNER_TYPE);
    expect(owners.map((r) => r.userId).sort()).toEqual(["co-owner-2", "owner-1"]);
    for (const r of owners) {
      expect(r.severity).toBe("urgent");
      expect(r.relatedCaseId).toBeNull();
      expect(r.relatedEventId).toBe(ENDED_EVENT_ID);
    }

    const authorities = landed.filter((r) => r.notificationType === AUTHORITY_TYPE);
    expect(authorities.map((r) => r.userId).sort()).toEqual(["authority-1", "authority-2"]);
    for (const r of authorities) expect(r.severity).toBe("urgent");

    expect(landed).toHaveLength(4);
    expect(deadLettered).toEqual([]);
  });

  it("keys every row on the ended event, one key per recipient and type", async () => {
    await close("positive_rabies");
    expect(landed.map((r) => r.dedupeKey).sort()).toEqual([
      `event:${ENDED_EVENT_ID}:authority-1:${AUTHORITY_TYPE}`,
      `event:${ENDED_EVENT_ID}:authority-2:${AUTHORITY_TYPE}`,
      `event:${ENDED_EVENT_ID}:co-owner-2:${OWNER_TYPE}`,
      `event:${ENDED_EVENT_ID}:owner-1:${OWNER_TYPE}`,
    ]);
  });

  it("a negative with no case still tells both owners, and alerts no authority", async () => {
    await close("negative");
    expect(landed.map((r) => `${r.notificationType}:${r.userId}`).sort()).toEqual([
      `${OWNER_TYPE}:co-owner-2`,
      `${OWNER_TYPE}:owner-1`,
    ]);
    for (const r of landed) expect(r.severity).toBe("info");
  });

  it("a transient insert failure dead-letters every row instead of dropping it", async () => {
    notificationsInsertFails = true;
    const res = await close("positive_rabies");
    // The close committed; the operator is not lied to about it.
    expect(res.error).toBeNull();

    expect(landed).toEqual([]);
    expect(deadLettered.map((r) => r.dedupeKey).sort()).toEqual([
      `event:${ENDED_EVENT_ID}:authority-1:${AUTHORITY_TYPE}`,
      `event:${ENDED_EVENT_ID}:authority-2:${AUTHORITY_TYPE}`,
      `event:${ENDED_EVENT_ID}:co-owner-2:${OWNER_TYPE}`,
      `event:${ENDED_EVENT_ID}:owner-1:${OWNER_TYPE}`,
    ]);
    // Stored as the sanitized summary (name + first line), never the raw
    // message — a Drizzle error's raw message carries the query's params.
    for (const r of deadLettered) expect(r.errorMessage).toBe("Error: connection reset by peer");
  });
});
