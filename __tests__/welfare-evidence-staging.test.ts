// The single-use claim on staged denuncia evidence (M12 security review).
//
// Two filings racing with one staged key must not both attach the photo. The
// module claims each key with a Storage MOVE before reading it; a move is one
// conditional rename, so the second one finds no source. This fakes the bucket
// with exactly that property and races two loads.

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ objects: new Map<string, Uint8Array>() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        move: async (from: string, to: string) => {
          const bytes = store.objects.get(from);
          if (bytes === undefined) return { data: null, error: { message: "Object not found" } };
          store.objects.delete(from);
          store.objects.set(to, bytes);
          return { data: {}, error: null };
        },
        download: async (path: string) => {
          const bytes = store.objects.get(path);
          if (bytes === undefined) return { data: null, error: { message: "Object not found" } };
          return { data: new Blob([bytes]), error: null };
        },
        remove: async (paths: string[]) => {
          for (const path of paths) store.objects.delete(path);
          return { data: [], error: null };
        },
      }),
    },
  }),
}));

import {
  loadStagedWelfareEvidence,
  removeStagedWelfareEvidence,
} from "@/lib/infra/welfare-evidence-staging";

const KEY = "welfare/0b6f1c1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b.jpg";

beforeEach(() => {
  store.objects.clear();
  store.objects.set(KEY, new Uint8Array([0xff, 0xd8, 0xff]));
});

describe("staged evidence is single-use", () => {
  it("claims the key: the staged name is gone and the bytes live under a fresh claimed name", async () => {
    const loaded = await loadStagedWelfareEvidence([KEY]);

    expect(loaded.ok).toBe(true);
    expect(store.objects.has(KEY)).toBe(false);
    expect(loaded.claimed).toHaveLength(1);
    expect(loaded.claimed[0]).toMatch(/^welfare-claimed\/[0-9a-f-]{36}\.jpg$/);
    expect(loaded.ok && loaded.files[0]?.name).toBe("evidencia-1.jpg");

    await removeStagedWelfareEvidence(loaded.claimed);
    expect(store.objects.size).toBe(0);
  });

  it("lets exactly ONE of two concurrent loads have the photo", async () => {
    const [a, b] = await Promise.all([
      loadStagedWelfareEvidence([KEY]),
      loadStagedWelfareEvidence([KEY]),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it("refuses a key that was never staged, and a key of the wrong shape", async () => {
    expect(
      (await loadStagedWelfareEvidence(["welfare/0b6f1c1e-2c3d-4e5f-8a9b-000000000000.jpg"])).ok,
    ).toBe(false);
    expect((await loadStagedWelfareEvidence(["../other/x.jpg"])).ok).toBe(false);
    // The good key was not touched by either refusal.
    expect(store.objects.has(KEY)).toBe(true);
  });
});
