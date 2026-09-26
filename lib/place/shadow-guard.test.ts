// Shadow mode must never break the request it watches (stage D verify W3).
//
// In `shadow` a consumer serves the name path and computes the id path only
// to compare. A failure of the id path is a finding for the operators, not an
// error for the person whose bite report, rule lookup or lost-pet broadcast
// is being served: it is reported and the caller carries on with the name
// result. It runs in its own savepoint so a failed statement never poisons
// the caller's transaction.

import { describe, expect, it, vi } from "vitest";

const reportError = vi.fn();
vi.mock("@/lib/infra/report-error", () => ({
  reportError: (...a: unknown[]) => reportError(...a),
}));

import { shadowIdPath } from "./shadow-guard";

function fakeExec() {
  const savepoints: string[] = [];
  return {
    savepoints,
    exec: {
      transaction: async <T>(run: (sp: unknown) => Promise<T>) => {
        savepoints.push("sp");
        return run("sp-executor");
      },
    },
  };
}

describe("shadowIdPath", () => {
  it("returns the id-path answer, computed inside its own savepoint", async () => {
    const { exec, savepoints } = fakeExec();
    const r = await shadowIdPath("routing", exec as never, async (sp) => {
      expect(sp).toBe("sp-executor");
      return ["a"];
    });
    expect(r).toEqual({ ok: true, value: ["a"] });
    expect(savepoints).toHaveLength(1);
  });

  it("a failing id path is reported and never thrown", async () => {
    const { exec } = fakeExec();
    const r = await shadowIdPath("rules", exec as never, async () => {
      throw new Error("relation authority_units_for_place does not exist");
    });
    expect(r).toEqual({ ok: false });
    expect(reportError).toHaveBeenCalledWith(
      "place-shadow/rules",
      expect.any(Error),
      expect.anything(),
    );
  });
});
