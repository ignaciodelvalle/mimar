// Fitness test for public/sw.js — cheap source-scan honesty check.
//
// The service worker runs in a browser context Vitest cannot execute, so this
// suite asserts the CONTRACT of the file as source: the push and
// notificationclick handlers exist, the payload fields the send path emits
// (lib/infra/web-push.ts: title/body/url/tag) are consumed, and the version
// constant used for cache-busting is present. If someone guts or renames the
// handlers, this fails before QA does.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const swSource = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8");

describe("public/sw.js push contract", () => {
  it("registers a push handler that shows a notification", () => {
    expect(swSource).toMatch(/addEventListener\(\s*["']push["']/);
    expect(swSource).toContain("showNotification");
  });

  it("registers a notificationclick handler that focuses or opens the target url", () => {
    expect(swSource).toMatch(/addEventListener\(\s*["']notificationclick["']/);
    expect(swSource).toContain("openWindow");
    expect(swSource).toContain("focus");
  });

  it("consumes the payload contract emitted by lib/infra/web-push.ts", () => {
    // title/body/url/tag — the JSON shape sendWebPush stringifies.
    expect(swSource).toContain("payload.title");
    expect(swSource).toContain("payload.body");
    expect(swSource).toContain("payload.url");
    expect(swSource).toContain("payload.tag");
  });

  it("carries a version constant for cache-busting", () => {
    expect(swSource).toMatch(/const SW_VERSION = ["']\d+["']/);
  });

  it("stays push-only — no fetch/caching layer sneaks in unaudited", () => {
    // v1 deliberately ships no offline cache. If a fetch handler or Cache API
    // usage appears, that is a design change that must update this test AND
    // the header comment in sw.js.
    expect(swSource).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    expect(swSource).not.toContain("caches.open");
  });
});
