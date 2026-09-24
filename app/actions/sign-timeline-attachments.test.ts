// Unit tests for signTimelineAttachments server action.
//
// Uses vi.hoisted + vi.mock to isolate DB queries, requirePetAccess, and
// Supabase storage signing. No live DB or storage required.
//
// The storage mock sits on the SERVICE-ROLE client (migration 0172): the
// event-attachments bucket has no authenticated SELECT policy, so a signer that
// used the caller's client would fail closed in production. Mocking the same
// door the code uses is the point — the previous mock on @/lib/supabase/server
// would have kept passing after the signer moved.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockSelect, mockRequirePetAccess, mockCreateAdminClient, mockCreateSignedUrl } = vi.hoisted(
  () => ({
    mockSelect: vi.fn(),
    mockRequirePetAccess: vi.fn(),
    mockCreateAdminClient: vi.fn(),
    mockCreateSignedUrl: vi.fn(),
  }),
);

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return {
    ...actual,
    db: {
      select: mockSelect,
    },
  };
});

vi.mock("@/lib/infra/pet-access", () => ({
  requirePetAccess: mockRequirePetAccess,
}));

// Signing runs as service role since migration 0172 — the event-attachments
// bucket no longer has an authenticated SELECT policy to read through.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mockCreateAdminClient,
}));

import { PgDialect } from "drizzle-orm/pg-core";
// Import AFTER mocks.
import {
  signTimelineAttachments,
  signTimelineAttachmentsForPet,
} from "./sign-timeline-attachments";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOwnerAccess(userId = "user-1", petId = "pet-1") {
  return {
    ok: true as const,
    accessPath: "owner" as const,
    user: { id: userId },
    pet: { id: petId, publicToken: "token-abc" },
  };
}

function makeOrgAccess(userId = "user-1", petId = "pet-1") {
  return {
    ok: true as const,
    accessPath: "org" as const,
    user: { id: userId },
    pet: { id: petId, publicToken: "token-abc" },
    organization: { id: "org-1", publicToken: "org-token" },
    ownershipRole: "foster" as const,
    organizationRole: "coordinator" as const,
    eventAuthorship: {},
  };
}

function makeAttachment(eventId: string, storagePath: string) {
  return { eventId, storagePath };
}

// Chain helper: mocks the drizzle select().from().where() chain.
function chainReturning(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  // biome-ignore lint/suspicious/noThenProperty: intentional thenable — mimics drizzle chain that resolves on await
  chain.then = (resolve: (v: unknown) => void) => resolve(rows);
  return chain;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  mockCreateSignedUrl.mockResolvedValue({ data: { signedUrl: null }, error: null });
  mockCreateAdminClient.mockReturnValue({
    storage: {
      from: () => ({
        createSignedUrl: mockCreateSignedUrl,
      }),
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("signTimelineAttachments", () => {
  describe("authorization", () => {
    it("returns error when pet access check fails", async () => {
      mockRequirePetAccess.mockResolvedValue({ ok: false });

      const result = await signTimelineAttachments("bad-token", ["event-1"]);

      expect(result).toEqual({ error: "Pet not found or access denied" });
    });

    it("allows owner access", async () => {
      mockRequirePetAccess.mockResolvedValue(makeOwnerAccess());
      mockSelect.mockReturnValue(chainReturning([]));

      const result = await signTimelineAttachments("token-abc", ["event-1"]);

      expect(result).not.toHaveProperty("error");
    });

    it("allows org (non-owner) access — timeline is viewable by custody holders", async () => {
      mockRequirePetAccess.mockResolvedValue(makeOrgAccess());
      mockSelect.mockReturnValue(chainReturning([]));

      const result = await signTimelineAttachments("token-abc", ["event-1"]);

      expect(result).not.toHaveProperty("error");
    });
  });

  describe("tenant isolation (IDOR fence)", () => {
    it("scopes the attachments query to the accessed pet's pet_id — not just eventIds", async () => {
      // Cross-tenant IDOR guard: requirePetAccess authorizes the caller for
      // `pet`, but eventIds are caller-supplied — the query MUST fence on
      // attachments.pet_id so caller-of-pet-A can't sign pet-B's via B's eventIds.
      mockRequirePetAccess.mockResolvedValue(makeOwnerAccess("user-1", "pet-1"));
      const chain = chainReturning([]);
      mockSelect.mockReturnValue(chain);

      await signTimelineAttachments("token-abc", ["event-from-another-pet"]);

      // The compiled WHERE must reference pet_id (the fence), not only event_id.
      const whereArg = (chain.where as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const compiled = new PgDialect().sqlToQuery(whereArg).sql;
      expect(compiled).toContain('"pet_id"');
      expect(compiled).toContain('"event_id"');
    });
  });

  describe("input validation", () => {
    it("returns error when petPublicToken is empty string", async () => {
      const result = await signTimelineAttachments("", ["event-1"]);
      expect(result).toEqual({ error: "Invalid input" });
    });

    it("returns empty map for empty eventIds array", async () => {
      mockRequirePetAccess.mockResolvedValue(makeOwnerAccess());

      const result = await signTimelineAttachments("token-abc", []);

      expect(result).toEqual({});
    });

    it("returns error when eventIds is not an array", async () => {
      // @ts-expect-error — intentional runtime type violation test
      const result = await signTimelineAttachments("token-abc", null);
      expect(result).toEqual({ error: "Invalid input" });
    });
  });

  describe("signing", () => {
    it("returns empty map when no attachments found for the given event ids", async () => {
      mockRequirePetAccess.mockResolvedValue(makeOwnerAccess());
      mockSelect.mockReturnValue(chainReturning([]));

      const result = await signTimelineAttachments("token-abc", ["event-1", "event-2"]);

      expect(result).toEqual({});
    });

    it("signs URLs and returns map keyed by eventId", async () => {
      mockRequirePetAccess.mockResolvedValue(makeOwnerAccess());
      mockSelect.mockReturnValue(
        chainReturning([
          makeAttachment("event-1", "pet-1/event-1/photo.jpg"),
          makeAttachment("event-2", "pet-1/event-2/doc.pdf"),
        ]),
      );
      // Keyed by PATH, not by call order. The two signers run concurrently, so
      // call order is not a contract — but "each event gets the URL of its own
      // attachment" is, and only a path-keyed mock can catch a cross-wiring bug.
      const urlByPath: Record<string, string> = {
        "pet-1/event-1/photo.jpg": "https://signed.url/photo.jpg",
        "pet-1/event-2/doc.pdf": "https://signed.url/doc.pdf",
      };
      mockCreateSignedUrl.mockImplementation(async (path: string) => ({
        data: { signedUrl: urlByPath[path] ?? null },
        error: null,
      }));

      const result = await signTimelineAttachments("token-abc", ["event-1", "event-2"]);

      expect(result).toEqual({
        "event-1": "https://signed.url/photo.jpg",
        "event-2": "https://signed.url/doc.pdf",
      });
    });

    it("skips attachments where signing returns null (storage error)", async () => {
      mockRequirePetAccess.mockResolvedValue(makeOwnerAccess());
      mockSelect.mockReturnValue(
        chainReturning([makeAttachment("event-1", "pet-1/event-1/photo.jpg")]),
      );
      // Simulates a storage error — createSignedUrl returns null signedUrl.
      mockCreateSignedUrl.mockResolvedValue({
        data: { signedUrl: null },
        error: { message: "not found" },
      });

      const result = await signTimelineAttachments("token-abc", ["event-1"]);

      expect(result).toEqual({});
    });

    it("uses the event-attachments bucket (NOT pet-photos — known gotcha from tattoo work)", async () => {
      mockRequirePetAccess.mockResolvedValue(makeOwnerAccess());
      const fromSpy = vi.fn().mockReturnValue({ createSignedUrl: mockCreateSignedUrl });
      mockCreateAdminClient.mockReturnValue({ storage: { from: fromSpy } });
      mockSelect.mockReturnValue(
        chainReturning([makeAttachment("event-1", "pet-1/event-1/photo.jpg")]),
      );
      mockCreateSignedUrl.mockResolvedValue({
        data: { signedUrl: "https://signed.url/x" },
        error: null,
      });

      await signTimelineAttachments("token-abc", ["event-1"]);

      expect(fromSpy).toHaveBeenCalledWith("event-attachments");
    });
  });

  describe("signTimelineAttachmentsForPet (page.tsx bound wrapper)", () => {
    it("returns an empty map when inner action returns an error (graceful degradation)", async () => {
      mockRequirePetAccess.mockResolvedValue({ ok: false });

      const result = await signTimelineAttachmentsForPet("bad-token", ["event-1"]);

      expect(result).toEqual({});
    });

    it("passes through signed urls from inner action", async () => {
      mockRequirePetAccess.mockResolvedValue(makeOwnerAccess());
      mockSelect.mockReturnValue(
        chainReturning([makeAttachment("event-1", "pet-1/event-1/photo.jpg")]),
      );
      mockCreateSignedUrl.mockResolvedValue({
        data: { signedUrl: "https://signed.url/photo.jpg" },
        error: null,
      });

      const result = await signTimelineAttachmentsForPet("token-abc", ["event-1"]);

      expect(result).toEqual({ "event-1": "https://signed.url/photo.jpg" });
    });
  });
});
