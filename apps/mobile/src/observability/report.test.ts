// `report` — the three properties that make it safe to leave on.
//
// Not "does Sentry receive it" (Sentry's problem) but: a TAG may never carry
// anything free-form, a path may never carry a token, and an observability call
// may never take down the screen it is observing. Those are this product's
// decisions, and each of them is invisible until the day it is not.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

type CapturedEvent = { error: unknown; context: { tags: Record<string, string> } };
type CapturedCrumb = { category?: string; level?: string; message?: string };

const captured: CapturedEvent[] = [];
const crumbs: CapturedCrumb[] = [];
let mockSentryThrows = false;

jest.mock("@sentry/react-native", () => ({
  captureException: (error: unknown, context: { tags: Record<string, string> }) => {
    if (mockSentryThrows) throw new Error("SDK not initialized");
    captured.push({ error, context });
  },
  addBreadcrumb: (crumb: CapturedCrumb) => {
    if (mockSentryThrows) throw new Error("SDK not initialized");
    crumbs.push(crumb);
  },
}));

import {
  AUTH_EVENTS,
  addAuthBreadcrumb,
  addNavigationBreadcrumb,
  isCorrelationId,
  newCorrelationId,
  reportHandledFailure,
  telemetryPath,
} from "./report";

beforeEach(() => {
  captured.length = 0;
  crumbs.length = 0;
  mockSentryThrows = false;
});

describe("telemetryPath — no identifier survives", () => {
  it("strips the pet's public token out of the route", () => {
    // The token is what the public credential page resolves; a tag carrying it
    // turns Sentry into a searchable index of which animals broke.
    expect(telemetryPath("/api/v1/pets/DIM-PAMP-0001/document")).toBe("/api/v1/pets/:id/document");
  });

  it("keeps the parts that are not identifiers, including the API version", () => {
    expect(telemetryPath("/api/v1/me/pets")).toBe("/api/v1/me/pets");
    expect(telemetryPath("/api/v1/welfare-reports")).toBe("/api/v1/welfare-reports");
  });

  it("strips a UUID, a numeric id and a share token alike", () => {
    expect(telemetryPath("/api/v1/turnos/9f3c1a77-0000-4000-8000-000000000000")).toBe(
      "/api/v1/turnos/:id",
    );
    expect(telemetryPath("/api/v1/pets/42")).toBe("/api/v1/pets/:id");
    // No digit anywhere, and it must STILL go: an uppercase segment is not
    // something this API's own routes contain.
    expect(telemetryPath("/api/v1/shares/ABCDEFGH")).toBe("/api/v1/shares/:id");
  });

  it("drops the query string, where a token is just as likely to be", () => {
    expect(telemetryPath("/api/v1/adopcion/catalogo?cursor=eyJhIjoxfQ")).toBe(
      "/api/v1/adopcion/catalogo",
    );
  });
});

describe("the correlation id", () => {
  it("is eight lowercase hex characters — short enough to read out loud", () => {
    const id = newCorrelationId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(isCorrelationId(id)).toBe(true);
  });

  it("is different per failure, which is the only thing it is for", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newCorrelationId()));
    expect(ids.size).toBeGreaterThan(45);
  });

  it("refuses a shape it did not mint", () => {
    expect(isCorrelationId("ABCDEF12")).toBe(false);
    expect(isCorrelationId("abc")).toBe(false);
    expect(isCorrelationId("g1234567")).toBe(false);
  });
});

describe("reportHandledFailure", () => {
  it("returns the id it tagged the event with", () => {
    const id = reportHandledFailure({ surface: "api", failure: "malformed" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.context.tags.correlation_id).toBe(id);
    expect(isCorrelationId(id)).toBe(true);
  });

  it("writes NOTHING free-form into the tags", () => {
    // The load-bearing assertion of this file. `redactEvent` scrubs the
    // message, the exception values, the extra bag and the breadcrumbs — it
    // does not scrub tags, and Sentry INDEXES tags. So every value here has to
    // come from a closed union or from this module's own id.
    const id = reportHandledFailure({
      surface: "api",
      failure: "api-error",
      code: "invalid_request",
      route: telemetryPath("/api/v1/pets/DIM-PAMP-0001"),
    });
    expect(captured[0]?.context.tags).toEqual({
      surface: "api",
      failure: "api-error",
      api_error_code: "invalid_request",
      route: "/api/v1/pets/:id",
      correlation_id: id,
    });
  });

  it("says 'none' rather than omitting a tag nobody could then group on", () => {
    reportHandledFailure({ surface: "update", failure: "update-check-failed" });
    expect(captured[0]?.context.tags.api_error_code).toBe("none");
    expect(captured[0]?.context.tags.route).toBe("none");
  });

  it("still answers when the SDK throws — observability may not break the screen", () => {
    mockSentryThrows = true;
    const id = reportHandledFailure({ surface: "auth", failure: "refresh-refused" });
    expect(isCorrelationId(id)).toBe(true);
    expect(captured).toHaveLength(0);
  });
});

describe("the breadcrumbs", () => {
  it("records each auth event under the auth category", () => {
    for (const event of AUTH_EVENTS) addAuthBreadcrumb(event);
    expect(crumbs.map((crumb) => crumb.message)).toEqual([...AUTH_EVENTS]);
    expect(new Set(crumbs.map((crumb) => crumb.category))).toEqual(new Set(["auth"]));
  });

  it("strips the identifier out of a navigation crumb too", () => {
    // The trail ships with every crash. A screen path is exactly as identifying
    // as an API path and was the easier one to forget.
    addNavigationBreadcrumb("/mascotas/DIM-PAMP-0001/credencial");
    expect(crumbs[0]).toMatchObject({
      category: "navigation",
      message: "/mascotas/:id/credencial",
    });
  });

  it("swallows an SDK failure on both crumb kinds", () => {
    mockSentryThrows = true;
    expect(() => addAuthBreadcrumb("sign-out")).not.toThrow();
    expect(() => addNavigationBreadcrumb("/ajustes")).not.toThrow();
  });
});
