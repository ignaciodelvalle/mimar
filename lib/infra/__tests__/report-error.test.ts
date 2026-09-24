// Locks the structured single-line JSON contract of the server-side error
// reporter (lib/infra/report-error.ts). Vercel log queries depend on this
// shape (level / context / message), so the payload is a contract, not an
// implementation detail.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reportError } from "@/lib/infra/report-error";

describe("reportError (server, structured line)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  function loggedLine(): string {
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const args = consoleErrorSpy.mock.calls[0];
    // ONE argument, one line — the whole point (queryable in Vercel logs).
    expect(args).toHaveLength(1);
    expect(typeof args[0]).toBe("string");
    return args[0] as string;
  }

  it("emits a single parseable JSON line with level, context, message, ts", () => {
    reportError("public-credential/pet-row", new Error("db exploded"), {
      publicToken: "DIM-ABCD-1234",
    });

    const line = loggedLine();
    expect(line).not.toContain("\n");
    const payload = JSON.parse(line);
    expect(payload).toMatchObject({
      level: "error",
      context: "public-credential/pet-row",
      message: "db exploded",
      meta: { publicToken: "DIM-ABCD-1234" },
    });
    expect(typeof payload.ts).toBe("string");
    expect(Number.isNaN(Date.parse(payload.ts))).toBe(false);
  });

  it("trims the stack to a bounded number of lines", () => {
    const err = new Error("deep");
    err.stack = ["Error: deep", ...Array.from({ length: 40 }, (_, i) => `    at frame${i}`)].join(
      "\n",
    );

    reportError("ctx", err);

    const payload = JSON.parse(loggedLine());
    expect(payload.stack.split("\n").length).toBeLessThanOrEqual(7);
    expect(payload.stack).toContain("Error: deep");
  });

  it("carries a non-default error name", () => {
    class TimeoutError extends Error {
      constructor() {
        super("too slow");
        this.name = "TimeoutError";
      }
    }
    reportError("ctx", new TimeoutError());

    const payload = JSON.parse(loggedLine());
    expect(payload.name).toBe("TimeoutError");
    expect(payload.message).toBe("too slow");
  });

  it("stringifies non-Error throwables", () => {
    reportError("ctx", "raw string failure");

    const payload = JSON.parse(loggedLine());
    expect(payload.message).toBe("raw string failure");
    expect(payload.stack).toBeUndefined();
  });

  it("never throws on circular meta", () => {
    const meta: Record<string, unknown> = {};
    meta.self = meta;

    expect(() => reportError("ctx", new Error("boom"), meta)).not.toThrow();

    const payload = JSON.parse(loggedLine());
    expect(payload.meta).toBe("[unserializable]");
    expect(payload.message).toBe("boom");
  });
});
