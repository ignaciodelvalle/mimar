// Unit tests for the notification-kind fence's readers. The live scan runs as
// `pnpm lint:notification-kinds`; these pin what it must catch and what it
// must let through, with sources small enough to read.

import { describe, expect, it } from "vitest";

import type { NotificationKindSpec } from "@dim/contract/notifications";

import {
  SCAN_DIRS,
  checkNotificationKinds,
  classifyExpression,
  collectConstants,
  findWriterSites,
  sqlNotificationKinds,
} from "./check-notification-kinds";

const SECTION: NotificationKindSpec = {
  subject: "account",
  primaryDestination: "section",
  pendingActor: "none",
  category: null,
};

const WELCOME_SQL =
  "insert into public.notifications (user_id, notification_type, title) values (new.id, 'welcome', 'Hola ' || x);";

function run(files: Record<string, string>, registry: Record<string, NotificationKindSpec>) {
  return checkNotificationKinds(
    new Map(Object.entries(files)),
    new Map([["db/triggers.sql", WELCOME_SQL]]),
    { welcome: SECTION, ...registry },
  );
}

const reasons = (result: ReturnType<typeof run>) =>
  result.violations.map((v) => v.reason).join("\n");

describe("check-notification-kinds", () => {
  it("accepts a writer whose literal is registered", () => {
    const result = run(
      { "src/a.ts": `push({ notificationType: "known_kind", title: "t" });` },
      { known_kind: SECTION },
    );
    expect(result.violations).toEqual([]);
    expect(result.emitted.has("known_kind")).toBe(true);
  });

  it("refuses a literal the registry does not name", () => {
    const result = run({ "src/a.ts": `push({ notificationType: "brand_new_kind" });` }, {});
    expect(reasons(result)).toMatch(/brand_new_kind/);
  });

  it("reads both arms of a ternary and a resolved constant map", () => {
    const files = {
      "src/a.ts": `x({ notificationType:\n  a === b ? ("left_kind" as const) : ("right_kind" as const),\n});`,
      "src/b.ts": `const MAP = { y: "mapped_kind" } as const;\nx({ notificationType: MAP[d] });`,
    };
    const result = run(files, { left_kind: SECTION, right_kind: SECTION, mapped_kind: SECTION });
    expect(result.violations).toEqual([]);
  });

  it("refuses a computed type it cannot read", () => {
    const result = run({ "src/a.ts": "x({ notificationType: `cap_${decision}` });" }, {});
    expect(result.violations[0]?.reason).toMatch(/computed notificationType/);
  });

  // Review R8 — a ternary is only as readable as its WORST arm.
  it("refuses a mixed ternary whose other arm is a call", () => {
    const result = run(
      { "src/a.ts": `x({ notificationType: c ? "left_kind" : computeKind() });` },
      { left_kind: SECTION },
    );
    expect(reasons(result)).toMatch(/computed notificationType: .*computeKind/);
  });

  // Review R8 — only a member access ending in `.notificationType` (optionally in
  // String(...)) is a pass-through; anything wrapped otherwise is computed.
  it("lets only x.notificationType and String(x.notificationType) through", () => {
    const constants = collectConstants(new Map());
    expect(classifyExpression("input.notificationType", constants)).toEqual({
      kind: "pass-through",
    });
    expect(classifyExpression("String(n.notificationType)", constants)).toEqual({
      kind: "pass-through",
    });
    expect(classifyExpression("String(kindFor(row))", constants).kind).toBe("computed");
    expect(classifyExpression("normalise(x.notificationType)", constants).kind).toBe("computed");
    expect(classifyExpression("x.notificationType ?? fallback", constants).kind).toBe("computed");
    expect(classifyExpression("string | null | undefined", constants)).toEqual({
      kind: "pass-through",
    });
  });

  // Review R8 — two files' constants of the same name are two constants.
  it("resolves a constant from its own file, and refuses an ambiguous one", () => {
    const own = run(
      {
        "src/a.ts": `const KIND_X = "kind_a";\nx({ notificationType: KIND_X });`,
        "src/b.ts": `const KIND_X = "kind_b";\nx({ notificationType: KIND_X });`,
      },
      { kind_a: SECTION, kind_b: SECTION },
    );
    expect(own.violations).toEqual([]);

    const ambiguous = run(
      {
        "src/a.ts": `const KIND_X = "kind_a";`,
        "src/b.ts": `const KIND_X = "kind_b";`,
        "src/c.ts": `x({ notificationType: KIND_X });`,
      },
      { kind_a: SECTION, kind_b: SECTION },
    );
    expect(reasons(ambiguous)).toMatch(/defined in 2 files/);
  });

  it("reads the notification_type a SQL insert writes, and refuses a computed one", () => {
    expect(sqlNotificationKinds(WELCOME_SQL)).toEqual({ kinds: ["welcome"], computed: [] });
    const computed = sqlNotificationKinds(
      "insert into public.notifications (user_id, notification_type) values (x, kind_for(y));",
    );
    expect(computed.kinds).toEqual([]);
    expect(computed.computed).toEqual(["kind_for(y)"]);
  });

  it("scans scripts/ as well as the app", () => {
    expect(SCAN_DIRS).toContain("scripts");
    const result = run(
      { "scripts/seed-x.ts": `push({ notificationType: "seed_only_kind" });` },
      {},
    );
    expect(reasons(result)).toMatch(/seed_only_kind/);
  });

  it("skips type annotations", () => {
    const constants = collectConstants(new Map());
    expect(classifyExpression("string", constants)).toEqual({ kind: "pass-through" });
  });

  it("ignores a type named only inside a comment", () => {
    expect(findWriterSites("src/a.ts", `// notificationType: "ghost_kind"\nconst a = 1;`)).toEqual(
      [],
    );
  });

  it("refuses a registry entry nobody emits, and one missing its copy", () => {
    const result = run(
      { "src/a.ts": `x({ notificationType: "asks_recipient" });` },
      {
        orphan_kind: SECTION,
        asks_recipient: { ...SECTION, pendingActor: "recipient" },
      },
    );
    expect(reasons(result)).toMatch(/orphan_kind: no writer emits/);
    expect(reasons(result)).toMatch(/asks_recipient: says the recipient must act/);
  });
});
