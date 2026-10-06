// Unit tests for the notification-kind fence's readers. The live scan runs as
// `pnpm lint:notification-kinds`; these pin what it must catch and what it
// must let through, with sources small enough to read.

import { describe, expect, it } from "vitest";

import type { NotificationKindSpec } from "@dim/contract/notifications";

import {
  checkNotificationKinds,
  classifyExpression,
  findWriterSites,
} from "./check-notification-kinds";

const SECTION: NotificationKindSpec = {
  subject: "account",
  primaryDestination: "section",
  pendingActor: "none",
  category: null,
};

const WELCOME_SQL =
  "insert into public.notifications (user_id, notification_type) values (x, 'welcome');";

function run(files: Record<string, string>, registry: Record<string, NotificationKindSpec>) {
  return checkNotificationKinds(new Map(Object.entries(files)), [WELCOME_SQL], {
    welcome: SECTION,
    ...registry,
  });
}

describe("check-notification-kinds", () => {
  it("accepts a writer whose literal is registered", () => {
    const result = run(
      { "src/a.ts": `push({ notificationType: "known_kind", title: "t" });` },
      {
        known_kind: SECTION,
      },
    );
    expect(result.violations).toEqual([]);
    expect(result.emitted.has("known_kind")).toBe(true);
  });

  it("refuses a literal the registry does not name", () => {
    const result = run({ "src/a.ts": `push({ notificationType: "brand_new_kind" });` }, {});
    expect(result.violations.map((v) => v.reason).join("\n")).toMatch(/brand_new_kind/);
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

  it("skips pass-through sites and type annotations", () => {
    expect(classifyExpression("input.notificationType", new Map())).toEqual({
      kind: "pass-through",
    });
    expect(classifyExpression("String(n.notificationType)", new Map())).toEqual({
      kind: "pass-through",
    });
    expect(classifyExpression("string", new Map())).toEqual({ kind: "pass-through" });
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
    const reasons = result.violations.map((v) => v.reason).join("\n");
    expect(reasons).toMatch(/orphan_kind: no writer emits/);
    expect(reasons).toMatch(/asks_recipient: says the recipient must act/);
  });
});
