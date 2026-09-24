// Offline guard for the CSP × prerender fence (scripts/check-csp-prerender.ts).
//
// The predicate is the whole fence: if it fails to recognise this app's policy,
// the check reports itself inert and passes forever. That is exactly what
// happened on the first write — a character class that excluded quotes stopped
// at `'self'` and never reached the nonce.

import { describe, expect, it } from "vitest";

import { cspBreaksPrerenders, routeFromHtmlPath } from "@/scripts/check-csp-prerender";

describe("cspBreaksPrerenders", () => {
  it("recognises this app's real policy line", () => {
    const real = "`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,";
    expect(cspBreaksPrerenders(real)).toBe(true);
  });

  it("is false without strict-dynamic — 'self' then still serves static chunks", () => {
    expect(cspBreaksPrerenders("`script-src 'self' 'nonce-${nonce}'`,")).toBe(false);
  });

  it("is false without a per-request nonce", () => {
    expect(cspBreaksPrerenders("`script-src 'self' 'strict-dynamic'`,")).toBe(false);
  });

  it("does not match a nonce mentioned outside script-src", () => {
    expect(cspBreaksPrerenders("`style-src 'nonce-${nonce}'`,\n`script-src 'self'`,")).toBe(false);
  });
});

describe("routeFromHtmlPath", () => {
  it("names the route the way the build log does", () => {
    expect(routeFromHtmlPath(".next/server/app/recuperar.html")).toBe("/recuperar");
    expect(routeFromHtmlPath(".next/server/app/_not-found.html")).toBe("/_not-found");
  });

  it("handles Windows separators", () => {
    // Built from a char rather than an escape so no shell or editor between
    // here and the file can eat the separators — which is how this test first
    // shipped asserting ".nextserverapp\recuperar.html".
    const BS = String.fromCharCode(92);
    expect(routeFromHtmlPath([".next", "server", "app", "recuperar.html"].join(BS))).toBe(
      "/recuperar",
    );
  });
});
