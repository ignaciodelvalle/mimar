// Unit test for __tests__/_helpers/fresh-test-user.ts — no network, no DB.
import { describe, expect, it, vi } from "vitest";

import { type AdminAuthClient, createFreshTestUser } from "./_helpers/fresh-test-user";

const TAKEN = {
  data: { user: null },
  error: {
    message: "A user with this email address has already been registered",
    code: "email_exists",
  },
};

function fakeClient(overrides: Partial<AdminAuthClient["auth"]["admin"]> = {}) {
  const admin = {
    createUser: vi.fn(async () => ({ data: { user: { id: "new-id" } }, error: null })),
    deleteUser: vi.fn(async () => ({ data: { user: null }, error: null })),
    listUsers: vi.fn(async () => ({ data: { users: [] }, error: null })),
    ...overrides,
  };
  return { client: { auth: { admin } } as unknown as AdminAuthClient, admin };
}

describe("createFreshTestUser", () => {
  it.each([
    "admin@dim.test",
    "someone@gmail.com",
    "x@dim-test.local.evil.com",
    "dim-test.local",
    undefined,
  ])("refuses %s before any network call", async (email) => {
    const { client, admin } = fakeClient();
    await expect(createFreshTestUser(client, { email, password: "x" })).rejects.toThrow(/refuses/);
    expect(admin.createUser).not.toHaveBeenCalled();
    expect(admin.listUsers).not.toHaveBeenCalled();
    expect(admin.deleteUser).not.toHaveBeenCalled();
  });

  it("passes a clean create straight through", async () => {
    const { client, admin } = fakeClient();
    const res = await createFreshTestUser(client, { email: "a@dim-test.local" });
    expect(res.data.user?.id).toBe("new-id");
    expect(admin.listUsers).not.toHaveBeenCalled();
    expect(admin.deleteUser).not.toHaveBeenCalled();
  });

  it("deletes a stale user found past the first page and creates again", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      id: `u${i}`,
      email: `u${i}@dim.test`,
    }));
    const createUser = vi
      .fn()
      .mockResolvedValueOnce(TAKEN)
      .mockResolvedValueOnce({ data: { user: { id: "fresh" } }, error: null });
    const listUsers = vi
      .fn()
      .mockResolvedValueOnce({ data: { users: page1 }, error: null })
      .mockResolvedValueOnce({
        data: { users: [{ id: "stale", email: "a@dim-test.local" }] },
        error: null,
      });
    const { client, admin } = fakeClient({ createUser, listUsers });

    const res = await createFreshTestUser(client, { email: "A@dim-test.local" });

    expect(res.data.user?.id).toBe("fresh");
    expect(listUsers).toHaveBeenCalledTimes(2);
    expect(admin.deleteUser).toHaveBeenCalledExactlyOnceWith("stale");
    expect(createUser).toHaveBeenCalledTimes(2);
  });

  it("throws, naming the blocker, when the stale user cannot be deleted", async () => {
    const { client } = fakeClient({
      createUser: vi.fn(async () => TAKEN) as never,
      listUsers: vi.fn(async () => ({
        data: { users: [{ id: "stale", email: "a@dim-test.local" }] },
        error: null,
      })) as never,
      deleteUser: vi.fn(async () => ({
        data: { user: null },
        error: { message: "fk violation" },
      })) as never,
    });
    await expect(createFreshTestUser(client, { email: "a@dim-test.local" })).rejects.toThrow(
      /could not be deleted: fk violation/,
    );
  });

  it("returns other create errors untouched", async () => {
    const weak = {
      data: { user: null },
      error: { message: "Password is too weak", code: "weak_password" },
    };
    const { client, admin } = fakeClient({ createUser: vi.fn(async () => weak) as never });
    const res = await createFreshTestUser(client, { email: "a@dim-test.local" });
    expect(res).toBe(weak);
    expect(admin.listUsers).not.toHaveBeenCalled();
  });
});
