// Tests for the telemetry transport seam (task #56b).

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ErrorSink,
  type RedactedErrorReport,
  consoleSink,
  getErrorSink,
  hasRemoteErrorSink,
  resetErrorSink,
  setErrorSink,
} from "@/lib/observability/sink";

const sampleReport: RedactedErrorReport = {
  message: "boom",
  context: {},
  ts: "2026-08-29T00:00:00.000Z",
};

afterEach(() => {
  resetErrorSink();
  vi.restoreAllMocks();
});

describe("the default sink is the console, and says so", () => {
  it("starts installed as consoleSink", () => {
    expect(getErrorSink()).toBe(consoleSink);
    expect(getErrorSink().name).toBe("console");
  });

  it("reports NO remote sink by default — the honest default", () => {
    // If this ever returns true without setErrorSink having been called, the
    // codebase is claiming telemetry coverage it does not have.
    expect(hasRemoteErrorSink()).toBe(false);
  });

  it("writes to console.error and makes no other call", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    consoleSink.send(sampleReport);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("[reportError]", sampleReport);
  });
});

describe("installing a provider is a config change", () => {
  it("routes reports to a newly installed sink", () => {
    const received: RedactedErrorReport[] = [];
    const fakeProvider: ErrorSink = {
      name: "fake-provider",
      send: (report) => received.push(report),
    };

    setErrorSink(fakeProvider);

    expect(getErrorSink()).toBe(fakeProvider);
    expect(hasRemoteErrorSink()).toBe(true);

    getErrorSink().send(sampleReport);
    expect(received).toEqual([sampleReport]);
  });

  it("returns the previous sink so it can be restored", () => {
    const first: ErrorSink = { name: "first", send: () => {} };
    const second: ErrorSink = { name: "second", send: () => {} };

    const replacedDefault = setErrorSink(first);
    expect(replacedDefault).toBe(consoleSink);

    const replacedFirst = setErrorSink(second);
    expect(replacedFirst).toBe(first);
  });

  it("resetErrorSink returns to the console default", () => {
    setErrorSink({ name: "temp", send: () => {} });
    expect(hasRemoteErrorSink()).toBe(true);

    resetErrorSink();

    expect(getErrorSink()).toBe(consoleSink);
    expect(hasRemoteErrorSink()).toBe(false);
  });
});
