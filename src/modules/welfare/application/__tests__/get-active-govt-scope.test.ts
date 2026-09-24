// Unit tests for getActiveGovtScopeForUser.
// Verifies that the application layer delegates to WelfareRepository.findGovtScopeForUser
// instead of reaching into @/db directly (W2 — hexagonal purity).

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the repository so the test never touches Drizzle or @/db.
// vi.hoisted ensures the spy is created before vi.mock's factory runs.
const { mockFindGovtScopeForUser } = vi.hoisted(() => ({
  mockFindGovtScopeForUser: vi.fn(),
}));

vi.mock("../../infrastructure/welfare-repository", () => {
  class WelfareRepository {
    findGovtScopeForUser = mockFindGovtScopeForUser;
  }
  return { WelfareRepository };
});

// Import AFTER vi.mock so the module uses the mocked constructor.
import { getActiveGovtScopeForUser } from "../get-active-govt-scope";

describe("getActiveGovtScopeForUser — delegates to WelfareRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls repo.findGovtScopeForUser with the provided userId", async () => {
    const expected = [
      { province: "Buenos Aires", locality: "CABA" },
      { province: "Buenos Aires", locality: "La Plata" },
    ];
    mockFindGovtScopeForUser.mockResolvedValue(expected);

    const result = await getActiveGovtScopeForUser("user-abc");

    expect(mockFindGovtScopeForUser).toHaveBeenCalledOnce();
    expect(mockFindGovtScopeForUser).toHaveBeenCalledWith("user-abc");
    expect(result).toEqual(expected);
  });

  it("returns an empty array when the user has no active assignments", async () => {
    mockFindGovtScopeForUser.mockResolvedValue([]);

    const result = await getActiveGovtScopeForUser("user-no-scope");

    expect(result).toEqual([]);
  });

  it("propagates errors from the repository", async () => {
    mockFindGovtScopeForUser.mockRejectedValue(new Error("db connection lost"));

    await expect(getActiveGovtScopeForUser("user-xyz")).rejects.toThrow("db connection lost");
  });
});
