// Tests for the `/api/v1` envelope fence (scripts/check-api-v1-envelope.ts).
//
// The fence lands GREEN on today's tree — one endpoint, already compliant.
// That is exactly the condition under which a fence rots into decoration, so
// every rule here has a synthetic offender that proves it can still fail, a
// clean fixture it must NOT flag, and a floor that fails when the glob stops
// finding routes.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MIN_V1_ROUTE_FILES,
  findEnvelopeViolations,
  listV1RouteFiles,
} from "@/scripts/check-api-v1-envelope";

const FILE = "app/api/v1/things/[id]/route.ts";

/** A handler that does everything right — the baseline every RED control mutates. */
const CLEAN = `
import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { publicTokenThrottle } from "@/lib/infra/public-token-throttle";
import { lookupPublicCredential } from "@/src/modules/pets/application/read/lookup-public-credential";

export const dynamic = "force-dynamic";

// @no-auth-required: public by design — the pet is the credential.
export async function GET(request: Request) {
  const lookup = await lookupPublicCredential({
    publicToken: "x",
    throttle: publicTokenThrottle("public_token_api_credential", {
      perLookup: { bucket: "public_token_api_credential_lookup", key: "k", limit: LIMIT },
    }),
  });
  if (lookup.status === "not_found") return apiV1Error("not_found", 404);
  return apiV1Json(lookup, { status: 200 });
}
`;

describe("findEnvelopeViolations — the rules", () => {
  it("passes a clean handler (the rule is not vacuous the other way)", () => {
    expect(findEnvelopeViolations(FILE, CLEAN)).toEqual([]);
  });

  it("flags a route that calls NextResponse.json directly — THE RED CONTROL", () => {
    const src = CLEAN.replace(
      'return apiV1Error("not_found", 404);',
      'return NextResponse.json({ error: "not_found" }, { status: 404 });',
    );
    const problems = findEnvelopeViolations(FILE, src);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("NextResponse.json(");
  });

  it("flags every other way of building a response by hand — the SUBJECT, not one spelling", () => {
    for (const hand of [
      'new NextResponse("x", { status: 200 })',
      'new Response("x", { status: 200 })',
      "Response.json({ a: 1 })",
    ]) {
      const src = CLEAN.replace("return apiV1Json(lookup, { status: 200 });", `return ${hand};`);
      expect(findEnvelopeViolations(FILE, src), hand).toHaveLength(1);
    }
  });

  it("flags a route that imports NEITHER helper", () => {
    const src = CLEAN.replace('import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";', "")
      .replace('return apiV1Error("not_found", 404);', "return notFound();")
      .replace("return apiV1Json(lookup, { status: 200 });", "return ok(lookup);");
    const problems = findEnvelopeViolations(FILE, src);
    expect(problems.some((p) => p.includes("@/lib/infra/api-v1"))).toBe(true);
  });

  it("flags a COMPUTED surface bucket — the second RED control", () => {
    const src = CLEAN.replace(
      'publicTokenThrottle("public_token_api_credential", {',
      "publicTokenThrottle(bucket, {",
    );
    const problems = findEnvelopeViolations(FILE, src);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("`bucket`");
  });

  it("flags a COMPUTED perLookup bucket too (G4)", () => {
    const src = CLEAN.replace(
      'perLookup: { bucket: "public_token_api_credential_lookup",',
      "perLookup: { bucket: LOOKUP_BUCKET,",
    );
    const problems = findEnvelopeViolations(FILE, src);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("perLookup");
    expect(problems[0]).toContain("LOOKUP_BUCKET");
  });

  it("flags a handler with neither a guard nor a justified opt-out (reuses check-authz-guards)", () => {
    const src = CLEAN.replace(
      "// @no-auth-required: public by design — the pet is the credential.\n",
      "",
    );
    const problems = findEnvelopeViolations(FILE, src);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("GET");
  });

  it("accepts a guarded handler in place of the opt-out", () => {
    const src = CLEAN.replace(
      "// @no-auth-required: public by design — the pet is the credential.\n",
      "",
    ).replace(
      "export async function GET(request: Request) {",
      [
        "export async function GET(request: Request) {",
        "  const live = await requireLiveUser();",
        '  if (!live.ok) return apiV1Error("not_found", 404);',
      ].join("\n"),
    );
    expect(findEnvelopeViolations(FILE, src)).toEqual([]);
  });

  it("does NOT read a banned call out of a comment", () => {
    const src = `${CLEAN}\n// NextResponse.json( used to live here; new Response( too.\n`;
    expect(findEnvelopeViolations(FILE, src)).toEqual([]);
  });

  it("ignores a route that resolves no public token (no throttle rule to apply)", () => {
    const src = `
import { apiV1Json } from "@/lib/infra/api-v1";
// @no-auth-required: a public constant.
export async function GET() {
  return apiV1Json({ version: 1 }, { status: 200 });
}
`;
    expect(findEnvelopeViolations("app/api/v1/version/route.ts", src)).toEqual([]);
  });
});

describe("the real tree", () => {
  const files = listV1RouteFiles();

  it("finds at least one /api/v1 route (non-vacuity floor)", () => {
    expect(MIN_V1_ROUTE_FILES).toBeGreaterThanOrEqual(1);
    expect(files.length).toBeGreaterThanOrEqual(MIN_V1_ROUTE_FILES);
    expect(files).toContain("app/api/v1/pets/[publicToken]/credential/route.ts");
  });

  it("is clean", () => {
    const problems = files.flatMap((f) => findEnvelopeViolations(f, readFileSync(f, "utf8")));
    expect(problems).toEqual([]);
  });
});
