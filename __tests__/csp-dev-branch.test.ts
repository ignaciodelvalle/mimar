// The CSP's dev branch — and the production it must never leak into.
//
// WALKTHROUGH 2026-08-31 §1 (open-work row 7), measured A/B on one commit:
// `next dev` needs eval() for React Refresh, and the middleware's nonce'd
// policy without 'unsafe-eval' serves a dev web app whose client never boots —
// flight payload present, zero `__reactFiber` on any node, while Server
// Actions keep the login working without JS and disguise the corpse as "my
// machine is broken". Nothing else could catch it: every path this repo has
// for looking at the web skips `next dev`.
//
// BOTH DIRECTIONS ARE THE FENCE. The dev half exists so local debugging of a
// tester report is possible during the pilot; the production half is the one
// that guards the actual security posture — a refactor that flipped the
// default, or keyed the branch off the wrong variable, must fail here before
// it ships an eval-permitting CSP to the world.

import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy } from "@/middleware";

const NONCE = "dGVzdC1ub25jZQ==";

describe("buildContentSecurityPolicy — the dev branch and its containment", () => {
  it("DEV carries 'unsafe-eval' so React Refresh can boot the client at all", () => {
    const scriptSrc = buildContentSecurityPolicy(NONCE, true)
      .split("; ")
      .find((d) => d.startsWith("script-src "));
    expect(scriptSrc).toContain("'unsafe-eval'");
    // The rest of the directive is NOT loosened with it — the nonce and
    // strict-dynamic stay, and inline stays banned.
    expect(scriptSrc).toContain(`'nonce-${NONCE}'`);
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("PRODUCTION never carries 'unsafe-eval', anywhere in the policy", () => {
    const policy = buildContentSecurityPolicy(NONCE, false);
    expect(policy).not.toContain("unsafe-eval");
    // And the production script-src is byte-identical to what shipped before
    // the branch existed — the fix added a mode, not a loosening.
    expect(policy).toContain(`script-src 'self' 'nonce-${NONCE}' 'strict-dynamic';`);
  });

  it("the DEFAULT resolves from the build mode, not from a flag someone must remember", () => {
    // Under vitest NODE_ENV is "test", which must read as NOT-dev: any
    // environment that is not literally `next dev` gets the production policy.
    expect(buildContentSecurityPolicy(NONCE)).not.toContain("unsafe-eval");
  });
});
