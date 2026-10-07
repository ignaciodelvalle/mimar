// The /api/v1 wiring of the legal re-acceptance gate (2026-10-07; security
// review of textos-legales-v14, finding 1). The DECISION is tested in
// live-user-legal-gate.test.ts; this file pins the two things every route has
// to get right around it, by reading the route sources:
//   · each route that maps liveness refusals answers LEGAL_ACCEPTANCE_REQUIRED
//     with 403 `legal_acceptance_required` and CLIENT_UPGRADE_REQUIRED with 426
//     `client_upgrade_required` — never a session-ending code, which would sign
//     the person out instead of showing them the screen;
//   · exactly the exempt routes opt out: `GET /me`, the acceptance itself, the
//     data export / account deletion, and sign-out everywhere.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "app", "api", "v1");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });
}

const ROUTES = routeFiles(ROOT).map((file) => ({
  rel: relative(ROOT, file).replace(/\\/g, "/"),
  src: readFileSync(file, "utf8"),
}));

/** Written out: adding a route here is a decision, not a side effect. */
const EXEMPT = [
  "me/route.ts",
  "me/legal-acceptance/route.ts",
  "me/privacy/route.ts",
  // Only for the sign-out `revoke` command; pinned by its own case below.
  "me/push-targets/route.ts",
  "me/revoke-sessions/route.ts",
].sort();

describe("/api/v1 — the legal re-acceptance refusal on the wire", () => {
  it("every liveness switch answers both new reasons with their own code and status", () => {
    const switches = ROUTES.filter((r) => r.src.includes('case "SHIFT_EXPIRED"'));
    expect(switches.length).toBeGreaterThan(30);
    const wrong = switches
      .filter(
        (r) =>
          !/case "LEGAL_ACCEPTANCE_REQUIRED":\s*return apiV1Error\("legal_acceptance_required", 403\);/.test(
            r.src,
          ) ||
          !/case "CLIENT_UPGRADE_REQUIRED":\s*return apiV1Error\("client_upgrade_required", 426\);/.test(
            r.src,
          ),
      )
      .map((r) => r.rel);
    expect(wrong).toEqual([]);
  });

  it("push-targets opts out for the sign-out `revoke` ONLY, never for `register`", () => {
    const route = ROUTES.find((r) => r.rel === "me/push-targets/route.ts");
    expect(route).toBeDefined();
    const src = route?.src ?? "";
    expect(src).toContain('const isRevoke = parsed.success && parsed.data.command === "revoke";');
    expect(src).toContain("...(isRevoke ? { allowPendingLegal: true } : {})");
  });

  it("only the exempt routes opt out of the gate", () => {
    const optedOut = ROUTES.filter((r) => r.src.includes("allowPendingLegal: true"))
      .map((r) => r.rel)
      .sort();
    expect(optedOut).toEqual(EXEMPT);
  });
});
