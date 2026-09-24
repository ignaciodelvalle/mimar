// Offline guard for the CI ↔ verify parity fence
// (scripts/check-ci-lint-parity.ts). The fence reads two real files; these
// tests pin the two parts that decide its verdict — what it derives from
// `verify`, and what it accepts as proof a lint runs in CI.
//
// The second one carries the weight. The fence's whole job is to notice a lint
// that exists in prose but not in the pipeline, so a comment mentioning a lint
// must NOT count as running it.

import { describe, expect, it } from "vitest";

import {
  gatesInVerify,
  gatesInWorkflow,
  missingFromWorkflow,
} from "@/scripts/check-ci-lint-parity";

const VERIFY = "pnpm typecheck && pnpm lint && pnpm lint:tokens && pnpm lint:rls && pnpm build";

describe("gatesInVerify", () => {
  it("keeps only the lint:* links of the && chain", () => {
    expect(gatesInVerify(VERIFY)).toEqual(["lint:tokens", "lint:rls"]);
  });

  it("does not mistake bare `lint` (Biome) for a lint:* script", () => {
    expect(gatesInVerify("pnpm lint && pnpm lint:rls")).toEqual(["lint:rls"]);
  });

  it("returns nothing when the script has no gates — the caller treats that as a broken parse", () => {
    expect(gatesInVerify("pnpm typecheck && pnpm build")).toEqual([]);
  });

  // THE 2026-08-25 HOLE. `verify:mobile` runs the Expo client's typecheck and
  // Jest suite; it is not a `lint:`, so the old derivation could not see it and
  // it could have joined `verify` without ever joining CI — which is precisely
  // how the mobile program came to be checked on nobody's machine but the PO's.
  it("keeps verify:* links too — a gate that is not a lint is still a gate", () => {
    expect(gatesInVerify("pnpm typecheck && pnpm verify:mobile && pnpm lint:rls")).toEqual([
      "verify:mobile",
      "lint:rls",
    ]);
  });

  it("does not mistake bare `verify` for a verify:* script", () => {
    expect(gatesInVerify("pnpm verify && pnpm verify:mobile")).toEqual(["verify:mobile"]);
  });
});

describe("gatesInWorkflow", () => {
  it("collects a gate from any job, however the step is written", () => {
    const yaml = [
      "      - name: Lint",
      "        run: pnpm lint:tokens && pnpm lint:rls",
      "      - name: DB fences",
      "        run: >-",
      "          pnpm lint:spine &&",
      "          pnpm lint:locality",
      "      - name: Mobile",
      "        run: pnpm verify:mobile",
    ].join("\n");
    expect([...gatesInWorkflow(yaml)].sort()).toEqual([
      "lint:locality",
      "lint:rls",
      "lint:spine",
      "lint:tokens",
      "verify:mobile",
    ]);
  });

  it("does NOT count a gate that is only named in a comment", () => {
    const yaml = [
      "      - name: Lint",
      "        # lint:seed-ids is documented here but never invoked — this is",
      "        # exactly the false pass the fence exists to prevent.",
      "        run: pnpm lint:tokens",
    ].join("\n");
    const found = gatesInWorkflow(yaml);
    expect(found.has("lint:tokens")).toBe(true);
    expect(found.has("lint:seed-ids")).toBe(false);
  });

  it("does not count a verify:* gate named only in a comment either", () => {
    const yaml = [
      "      - name: Mobile",
      "        # verify:mobile belongs here one day",
      "        run: pnpm lint:tokens",
    ].join("\n");
    const found = gatesInWorkflow(yaml);
    expect(found.has("verify:mobile")).toBe(false);
  });

  it("does not count a trailing comment on an otherwise real run line", () => {
    const yaml = "        run: pnpm lint:tokens # and someday pnpm lint:brand";
    const found = gatesInWorkflow(yaml);
    expect(found.has("lint:tokens")).toBe(true);
    expect(found.has("lint:brand")).toBe(false);
  });
});

describe("missingFromWorkflow", () => {
  it("names every gate verify runs and CI does not", () => {
    expect(missingFromWorkflow(VERIFY, "run: pnpm lint:tokens")).toEqual(["lint:rls"]);
  });

  it("is empty when the workflow covers all of them", () => {
    expect(missingFromWorkflow(VERIFY, "run: pnpm lint:tokens && pnpm lint:rls")).toEqual([]);
  });

  it("ignores gates CI runs that verify does not — parity is one-directional", () => {
    expect(missingFromWorkflow("pnpm lint:rls", "pnpm lint:rls && pnpm lint:extra")).toEqual([]);
  });

  // RED CONTROL for the widening: the exact 2026-08-25 shape — the mobile gate
  // in `verify`, absent from the workflow — must be reported, not waved through.
  it("names a verify:* gate the workflow never invokes", () => {
    expect(
      missingFromWorkflow("pnpm lint:rls && pnpm verify:mobile", "run: pnpm lint:rls"),
    ).toEqual(["verify:mobile"]);
  });
});
