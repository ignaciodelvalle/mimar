// A flag read that FAILS serves the name path (stage D verify W1).
//
// Anything unexpected about place_read_flags — a missing row, an unknown mode,
// or the read itself failing (a missing table, a dropped connection) — must
// answer 'name': the name path is what production served before the change.

import { describe, expect, it, vi } from "vitest";

import { readPlaceFlag } from "./flags";

describe("readPlaceFlag", () => {
  it("a failing read answers 'name', never throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      select: () => {
        throw new Error('relation "place_read_flags" does not exist');
      },
    };
    await expect(readPlaceFlag("scope", failing as never)).resolves.toBe("name");
    await expect(readPlaceFlag("routing", failing as never)).resolves.toBe("name");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("an unknown mode in the table answers 'name'", async () => {
    const odd = {
      select: () => ({ from: async () => [{ consumer: "rules", mode: "sideways" }] }),
    };
    await expect(readPlaceFlag("rules", odd as never)).resolves.toBe("name");
  });
});
