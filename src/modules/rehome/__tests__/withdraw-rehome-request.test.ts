// withdrawRehomeRequest — the use-case against a FAKE port (unit project).
// Layer: Unit. The real-Postgres proof of the cancel lives in
// __tests__/rehome-withdraw-flow.test.ts (serial `db` project); this file pins
// the REPLAY rule the bearer door added on 2026-09-10:
//
//   THE LEDGER IS ASKED BEFORE THE STATE GUARD. A cancel's success is what
//   makes "no pending request" true, so a retry of that very cancel — a phone
//   that never saw the 200 — would be refused forever if the state were asked
//   first. With a client key, the `case_closed` entry the first attempt wrote
//   is found first and the answer is the first attempt's answer.

import { describe, expect, it, vi } from "vitest";

import type { RehomeWithdrawPort } from "../application/ports";
import { withdrawRehomeRequest } from "../application/withdraw-rehome-request";
import { NOT_TITULAR_ERROR, NO_PENDING_REQUEST_ERROR } from "../domain/rehome-rules";

const PET = {
  id: "pet-1",
  publicToken: "DIM-TEST-0001",
  name: "Tango",
  status: "active",
  jurisdictionProvince: "Buenos Aires",
  jurisdictionLocality: "La Plata",
  localityId: null,
  inCustodyDispute: false,
  rabiesObservationStatus: null,
  adoptionIneligibleUntil: null,
};

const ORG = {
  id: "org-1",
  displayName: "Refugio Padrino",
  publicToken: "DIM-ORG-0001",
  orgType: "shelter",
  verified: true,
};

const OPEN_REQUEST = {
  id: "case-req-1",
  publicCode: "CAS-0001",
  caseKind: "rehome_request",
  status: "open",
  primaryPetId: PET.id,
  receiverOrganizationId: ORG.id,
  openedByUserId: "titular-1",
};

function makePort(): RehomeWithdrawPort {
  return {
    findPetByToken: vi.fn().mockResolvedValue(PET),
    findLiveOwnerRow: vi.fn().mockResolvedValue({ id: "own-owner-1" }),
    lockLiveOwnerRow: vi.fn().mockResolvedValue({ id: "own-owner-1" }),
    acquirePetAdvisoryLock: vi.fn().mockResolvedValue(undefined),
    findOrgById: vi.fn().mockResolvedValue(ORG),
    orgAdminAndCoordinatorUserIds: vi.fn().mockResolvedValue(["coord-1"]),
    findDisplayName: vi.fn().mockResolvedValue("Ana Titular"),
    findSponsorshipEndedByKey: vi.fn().mockResolvedValue(null),
    findRequestWithdrawnByKey: vi.fn().mockResolvedValue(null),
    findOpenSponsorshipForPet: vi.fn().mockResolvedValue(null),
    endCustodyRow: vi.fn().mockResolvedValue({ ended: true }),
    unpublishListing: vi.fn().mockResolvedValue(undefined),
    endSponsorshipByTitular: vi.fn().mockResolvedValue(undefined),
    findOpenListingCase: vi.fn().mockResolvedValue(null),
    closeListingCase: vi.fn().mockResolvedValue({ won: true }),
    findApplicationsOnListing: vi.fn().mockResolvedValue([]),
    closeApplicationByTitular: vi.fn().mockResolvedValue(undefined),
    findOpenRequestForPet: vi.fn().mockResolvedValue(OPEN_REQUEST),
    lockRequestCase: vi.fn().mockResolvedValue(OPEN_REQUEST),
    closeRequestCase: vi.fn().mockResolvedValue(undefined),
  };
}

const transaction = async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb("fake-tx");
const deps = (repo: RehomeWithdrawPort) => ({ repo, now: () => new Date(), transaction });
const input = { petPublicToken: PET.publicToken, titularUserId: "titular-1" };
const KEY = "7a1c2d3e-4f50-4a6b-9c7d-8e9f0a1b2c3d";

describe("withdrawRehomeRequest — the ordinary cancel", () => {
  it("closes the case as withdrawn by the titular, stamping the key, and tells the org once", async () => {
    const repo = makePort();
    const r = await withdrawRehomeRequest({ ...input, clientIdempotencyKey: KEY }, deps(repo));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      caseId: OPEN_REQUEST.id,
      casePublicCode: OPEN_REQUEST.publicCode,
      receiverOrganizationId: ORG.id,
      replayed: false,
    });
    expect(repo.closeRequestCase).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: OPEN_REQUEST.id,
        reason: "cancelled",
        decision: "withdrawn",
        closedByUserId: "titular-1",
        clientIdempotencyKey: KEY,
      }),
      "fake-tx",
    );
    expect(r.notifications.map((n) => n.userId)).toEqual(["coord-1"]);
    expect(r.notifications[0].notificationType).toBe("rehome_request_withdrawn");
  });

  it("refuses a non-titular before touching the ledger or the case", async () => {
    const repo = makePort();
    (repo.findLiveOwnerRow as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await withdrawRehomeRequest({ ...input, clientIdempotencyKey: KEY }, deps(repo));
    expect(r).toEqual({ ok: false, error: NOT_TITULAR_ERROR });
    expect(repo.findRequestWithdrawnByKey).not.toHaveBeenCalled();
    expect(repo.closeRequestCase).not.toHaveBeenCalled();
  });

  it("with nothing pending and a key the ledger does not know, refuses on the state", async () => {
    const repo = makePort();
    (repo.findOpenRequestForPet as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await withdrawRehomeRequest({ ...input, clientIdempotencyKey: KEY }, deps(repo));
    expect(r).toEqual({ ok: false, error: NO_PENDING_REQUEST_ERROR });
  });
});

describe("withdrawRehomeRequest — the ledger is asked before the state guard", () => {
  it("a key the ledger knows answers ok + replayed with the SAME case, writes nothing, tells nobody again", async () => {
    const repo = makePort();
    (repo.findRequestWithdrawnByKey as ReturnType<typeof vi.fn>).mockResolvedValue({
      caseId: OPEN_REQUEST.id,
      casePublicCode: OPEN_REQUEST.publicCode,
      receiverOrganizationId: ORG.id,
    });
    // THE STATE GUARD WOULD REFUSE: the first attempt closed the request.
    (repo.findOpenRequestForPet as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const r = await withdrawRehomeRequest({ ...input, clientIdempotencyKey: KEY }, deps(repo));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      caseId: OPEN_REQUEST.id,
      casePublicCode: OPEN_REQUEST.publicCode,
      petId: PET.id,
      petPublicToken: PET.publicToken,
      receiverOrganizationId: ORG.id,
      replayed: true,
    });
    expect(r.notifications).toEqual([]);
    // MUTATION APPLIED: move the ledger lookup after `findOpenRequestForPet`.
    // Red — a lost-response retry would be told "no hay una solicitud pendiente"
    // about the cancel it had already made.
    expect(repo.findRequestWithdrawnByKey).toHaveBeenCalledWith(
      PET.id,
      "titular-1",
      KEY,
      "fake-tx",
    );
    expect(repo.lockRequestCase).not.toHaveBeenCalled();
    expect(repo.closeRequestCase).not.toHaveBeenCalled();
  });

  it("the ledger is read under the pet lock, after it", async () => {
    const repo = makePort();
    const order: string[] = [];
    (repo.acquirePetAdvisoryLock as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("advisory");
    });
    (repo.findRequestWithdrawnByKey as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("ledger");
      return null;
    });
    (repo.findOpenRequestForPet as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("state");
      return OPEN_REQUEST;
    });
    const r = await withdrawRehomeRequest({ ...input, clientIdempotencyKey: KEY }, deps(repo));
    expect(r.ok).toBe(true);
    expect(order).toEqual(["advisory", "ledger", "state"]);
  });

  it("no key — the web's door — never asks the ledger and stamps null on the close", async () => {
    const repo = makePort();
    const r = await withdrawRehomeRequest(input, deps(repo));
    expect(r.ok).toBe(true);
    expect(repo.findRequestWithdrawnByKey).not.toHaveBeenCalled();
    expect(repo.closeRequestCase).toHaveBeenCalledWith(
      expect.objectContaining({ clientIdempotencyKey: null }),
      "fake-tx",
    );
  });
});
