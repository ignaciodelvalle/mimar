// `sentry` — the two decisions worth pinning.
//
// Not "does the SDK work" (Sentry's problem) but: a DSN-less build must NEVER
// init (an SDK aimed at nothing retries uploads forever), and the init a real
// build runs must keep the privacy posture stated — no default PII, no
// tracing. Those are this product's decisions, and a dependency bump that
// flipped them would otherwise pass every other test.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockInit = jest.fn<(options: Record<string, unknown>) => void>();
let mockExtra: Record<string, unknown> | undefined;
let mockChannel: string | null = null;

jest.mock("@sentry/react-native", () => ({
  init: (options: Record<string, unknown>) => mockInit(options),
}));

// Same getter reasoning as `expoConfig` below: `sentryEnvironment` reads the
// property on every call, so each test can move the channel without a
// re-import.
jest.mock("expo-updates", () => ({
  __esModule: true,
  get channel() {
    return mockChannel;
  },
}));

// The getter sits on `expoConfig`, not on `default`: the ES-module interop
// reads `.default` ONCE at import time, so a getter there would freeze the
// value the first test happened to see.
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return { extra: mockExtra };
    },
  },
}));

import { initSentry, sentryDsnFromConfig, sentryEnvironment } from "./sentry";

beforeEach(() => {
  mockInit.mockReset();
  mockExtra = undefined;
  mockChannel = null;
});

describe("the DSN comes from the build's manifest, or init refuses", () => {
  it("initializes with the DSN the build carried, and says it did", () => {
    mockExtra = { sentryDsn: "https://key@o1.ingest.sentry.io/42" };
    expect(initSentry()).toBe(true);
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit.mock.calls[0]?.[0]?.dsn).toBe("https://key@o1.ingest.sentry.io/42");
  });

  it("does NOT init on a build with no DSN — null, empty, absent, or {}", () => {
    // `{}` is not hypothetical: Expo's config serialization turns the `null`
    // app.config.ts writes into an empty object by the time Constants reads
    // it (measured with `expo config --json`, 2026-09-01). The string check
    // is what keeps that shape from reaching Sentry.init as a DSN.
    for (const extra of [
      { sentryDsn: null },
      { sentryDsn: "" },
      { sentryDsn: {} },
      {},
      undefined,
    ]) {
      mockExtra = extra;
      expect(sentryDsnFromConfig()).toBeNull();
      expect(initSentry()).toBe(false);
    }
    expect(mockInit).not.toHaveBeenCalled();
  });
});

describe("the privacy posture is stated in the options, not assumed from defaults", () => {
  it("sends no default PII and runs no tracing", () => {
    // Invariant #5 hashes DNIs at the boundary; the crash reporter does not
    // get to be the surface that ships identifying data by accident. And the
    // pilot's question is "does it crash", not "is it fast".
    mockExtra = { sentryDsn: "https://key@o1.ingest.sentry.io/42" };
    initSentry();
    const options = mockInit.mock.calls[0]?.[0];
    expect(options?.sendDefaultPii).toBe(false);
    expect(options?.tracesSampleRate).toBe(0);
  });

  it("scrubs on the way out — BOTH hooks, wired to the redactor", () => {
    // `sendDefaultPii: false` above stops the SDK ATTACHING identifying data.
    // It says nothing about the strings this app throws, and those are where
    // the DNIs, e-mails, phone numbers and access tokens actually are. The two
    // hooks are the mechanism; `redact.test.ts` pins what they do.
    //
    // BOTH, because either alone leaves a channel open: `beforeBreadcrumb` is
    // the only one that runs for a breadcrumb the SDK synthesises before any
    // event exists, and `beforeSend` is the only one that runs for an event
    // assembled without passing through the breadcrumb buffer.
    mockExtra = { sentryDsn: "https://key@o1.ingest.sentry.io/42" };
    initSentry();
    const options = mockInit.mock.calls[0]?.[0];

    const beforeSend = options?.beforeSend as (e: unknown) => { message?: string };
    const beforeBreadcrumb = options?.beforeBreadcrumb as (b: unknown) => { message?: string };
    expect(typeof beforeSend).toBe("function");
    expect(typeof beforeBreadcrumb).toBe("function");

    // Not "a function is present" — what it does. A hook wired to the wrong
    // helper, or to an identity function, passes the two assertions above.
    expect(beforeSend({ message: "DNI 12345678 de ana@example.com" }).message).toBe(
      "DNI [redacted:digits] de [redacted:email]",
    );
    expect(beforeBreadcrumb({ message: "login ana@example.com" }).message).toBe(
      "login [redacted:email]",
    );
  });

  it("keeps the two attachment options OFF, and says so in the options (OBS-9)", () => {
    // Stated rather than left to the SDK's default, for the same reason
    // `sendDefaultPii` is stated: this app's crashing frame is a libreta with a
    // person's name on it. `redactEvent` scrubs strings; it cannot scrub a PNG,
    // and `attachViewHierarchy` is that PNG's data without its pixels. A
    // dependency bump that flipped either default would pass every other test.
    mockExtra = { sentryDsn: "https://key@o1.ingest.sentry.io/42" };
    initSentry();
    const options = mockInit.mock.calls[0]?.[0];
    expect(options?.attachScreenshot).toBe(false);
    expect(options?.attachViewHierarchy).toBe(false);
  });

  it("captures failed requests, which is the one thing turned ON (OBS-2)", () => {
    mockExtra = { sentryDsn: "https://key@o1.ingest.sentry.io/42" };
    initSentry();
    expect(mockInit.mock.calls[0]?.[0]?.enableCaptureFailedRequests).toBe(true);
  });

  it("scrubs the URL of the requests that flag captures (finding C2)", () => {
    // The flag above is the one NEW outbound channel this batch opened, and it
    // is the one `sendDefaultPii: false` does not close: the SDK's httpclient
    // integration writes `request: { url }` with the full url, and this app's
    // urls carry pet public tokens. Asserted through `beforeSend` rather than on
    // the redactor alone — `redact.test.ts` pins what the rule does; this pins
    // that the hook this init installs actually applies it to that field.
    mockExtra = { sentryDsn: "https://key@o1.ingest.sentry.io/42" };
    initSentry();
    const options = mockInit.mock.calls[0]?.[0];
    const beforeSend = options?.beforeSend as (e: unknown) => { request?: { url?: string } };

    const scrubbed = beforeSend({
      message: "HTTP Client Error with status code: 502",
      request: { url: "https://www.mimar.com.ar/api/v1/pets/DIM-PAMP-0001/libreta" },
    });
    expect(scrubbed.request?.url).toBe(
      "https://www.mimar.com.ar/api/v1/pets/[redacted:credential]/libreta",
    );
  });
});

describe("the environment is the release channel (OBS-10)", () => {
  it("is the channel this bundle is running on", () => {
    // Every OTA hotfix goes to `preview` first and to `production` only after a
    // device confirms it (ota-policy.md). Without this, the rehearsal's events
    // and the fleet's land in one undifferentiated list.
    mockChannel = "preview";
    expect(sentryEnvironment()).toBe("preview");

    mockExtra = { sentryDsn: "https://key@o1.ingest.sentry.io/42" };
    initSentry();
    expect(mockInit.mock.calls[0]?.[0]?.environment).toBe("preview");
  });

  it("says 'unknown' rather than inventing 'development' for a dev client", () => {
    // `Updates.channel` is null in a dev client AND in a build whose updates
    // module failed to load. This app cannot tell those apart, and labelling
    // the second one "development" would put a developer's tag on a tester's
    // phone.
    mockChannel = null;
    expect(sentryEnvironment()).toBe("unknown");
    mockChannel = "";
    expect(sentryEnvironment()).toBe("unknown");
  });
});

// DELIBERATELY LAST IN THE FILE, which is the point (nit N3, review
// 2026-09-07). `crashReportingActive` reads a module-level `let` that survives
// every `beforeEach` — jest resets mocks, not a module's own state — so this
// describe used to sit FIRST and carry a comment saying it had to. A test whose
// pass depends on nobody adding a describe above it is a test that fails on a
// day nobody was thinking about it, and the note explaining that is not a fence.
// `jest.isolateModules` gives the module a fresh registry for this block, so
// "false before any init" is a fact about the module rather than about the file.
describe("Ajustes can read whether reporting actually started (OBS-8)", () => {
  it("is false until an init with a real DSN has run, and true after", () => {
    // The MEASURED fact, not the intent. "The build has a DSN" and "the SDK is
    // running" came apart twice during the pilot prep, and the only symptom was
    // that no event ever arrived.
    jest.isolateModules(() => {
      const fresh = require("./sentry") as typeof import("./sentry");

      expect(fresh.crashReportingActive()).toBe(false);

      mockExtra = {};
      expect(fresh.initSentry()).toBe(false);
      expect(fresh.crashReportingActive()).toBe(false);

      mockExtra = { sentryDsn: "https://key@o1.ingest.sentry.io/42" };
      expect(fresh.initSentry()).toBe(true);
      expect(fresh.crashReportingActive()).toBe(true);
    });
  });
});
