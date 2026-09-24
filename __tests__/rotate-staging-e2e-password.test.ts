// Pins the order of operations in scripts/ops/_rotate-e2e-password.ts — the
// core of rotate-staging-e2e-password.ts (security review of C4b,
// 2026-09-23). Every side effect is a fake; nothing here touches a Supabase
// project or a GitHub repo.

import { describe, expect, it } from "vitest";

import {
  E2E_ACCOUNTS,
  type GhCheck,
  type RotationDeps,
  SECRET_NAME,
  STAGING_PROJECT_REF,
  parseCliArgs,
  projectRefFromSupabaseUrl,
  revokeSessionsSql,
  runRotation,
  scrub,
  stagingTargetProblem,
} from "@/scripts/ops/_rotate-e2e-password";

const PASSWORD = "generated-secret-value-0123456789abcdef";
const REPO = "owner/repo";

type Fake = RotationDeps & {
  calls: string[];
  logs: string[];
  setPasswordCalls: Array<[string, string]>;
  secretCalls: Array<[string, string, string]>;
  revokeCalls: string[];
};

function fake(
  over: Partial<{
    gh: GhCheck;
    missing: string[];
    failPasswordOn: string;
    failPasswordMessage: string;
    secretExit: number;
    secretStderr: string;
    failRevokeOn: string;
  }> = {},
): Fake {
  const f: Fake = {
    calls: [],
    logs: [],
    setPasswordCalls: [],
    secretCalls: [],
    revokeCalls: [],
    async checkGh(repo) {
      f.calls.push(`checkGh:${repo}`);
      return over.gh ?? { ok: true };
    },
    async findUserId(email) {
      f.calls.push(`find:${email}`);
      return over.missing?.includes(email) ? null : `id-${email}`;
    },
    async setPassword(userId, password) {
      f.calls.push(`setPassword:${userId}`);
      f.setPasswordCalls.push([userId, password]);
      if (over.failPasswordOn && userId === `id-${over.failPasswordOn}`) {
        throw new Error(over.failPasswordMessage ?? "boom");
      }
    },
    async setSecret(repo, name, password) {
      f.calls.push(`setSecret:${repo}:${name}`);
      f.secretCalls.push([repo, name, password]);
      return { exitCode: over.secretExit ?? 0, stderr: over.secretStderr ?? "" };
    },
    async revokeSessions(email) {
      f.calls.push(`revoke:${email}`);
      f.revokeCalls.push(email);
      if (over.failRevokeOn === email) throw new Error("signOut failed");
    },
    generatePassword: () => PASSWORD,
    log: (m) => {
      f.logs.push(m);
    },
  };
  return f;
}

const touchesAccounts = (f: Fake) => f.calls.some((c) => c.startsWith("setPassword:"));

describe("runRotation — ordering", () => {
  it("gh unavailable → no account is read or touched, no secret", async () => {
    const f = fake({ gh: { ok: false, reason: "not authenticated" } });
    const out = await runRotation(f, { apply: true, repo: REPO });
    expect(out).toEqual({ status: "gh-unavailable", reason: "not authenticated" });
    expect(f.calls).toEqual([`checkGh:${REPO}`]);
    expect(f.secretCalls).toEqual([]);
  });

  it("a missing account → nothing changed", async () => {
    const f = fake({ missing: ["vet@dim.test"] });
    const out = await runRotation(f, { apply: true, repo: REPO });
    expect(out).toEqual({ status: "account-missing", missing: ["vet@dim.test"] });
    expect(touchesAccounts(f)).toBe(false);
    expect(f.secretCalls).toEqual([]);
  });

  it("dry run → gh checked and accounts resolved, but no write of any kind", async () => {
    const f = fake();
    const out = await runRotation(f, { apply: false, repo: REPO });
    expect(out).toEqual({ status: "dry-run" });
    expect(touchesAccounts(f)).toBe(false);
    expect(f.secretCalls).toEqual([]);
    expect(f.revokeCalls).toEqual([]);
  });

  it("failure on account 3 → stops there, reports the 2 already rotated, sets NO secret", async () => {
    const third = E2E_ACCOUNTS[2];
    const f = fake({ failPasswordOn: third });
    const out = await runRotation(f, { apply: true, repo: REPO });
    expect(out.status).toBe("rotation-failed");
    if (out.status !== "rotation-failed") return;
    expect(out.failedAt).toBe(third);
    expect(out.rotated).toEqual([E2E_ACCOUNTS[0], E2E_ACCOUNTS[1]]);
    expect(f.setPasswordCalls).toHaveLength(3);
    expect(f.secretCalls).toEqual([]);
    expect(f.revokeCalls).toEqual([]);
  });

  it("success → all 8 rotated with ONE password, secret set ONCE with exactly it, then sessions revoked", async () => {
    const f = fake();
    const out = await runRotation(f, { apply: true, repo: REPO });
    expect(out).toEqual({ status: "done" });
    expect(f.setPasswordCalls.map(([id]) => id)).toEqual(E2E_ACCOUNTS.map((e) => `id-${e}`));
    expect(new Set(f.setPasswordCalls.map(([, pw]) => pw))).toEqual(new Set([PASSWORD]));
    expect(f.secretCalls).toEqual([[REPO, SECRET_NAME, PASSWORD]]);
    expect(f.revokeCalls).toEqual([...E2E_ACCOUNTS]);

    // Strict order: gh → finds → 8 writes → secret → 8 revokes.
    const kinds = f.calls.map((c) => c.split(":")[0]);
    const firstSet = kinds.indexOf("setPassword");
    const lastSet = kinds.lastIndexOf("setPassword");
    const secretAt = kinds.indexOf("setSecret");
    const firstRevoke = kinds.indexOf("revoke");
    expect(kinds[0]).toBe("checkGh");
    expect(kinds.lastIndexOf("find")).toBeLessThan(firstSet);
    expect(lastSet).toBeLessThan(secretAt);
    expect(secretAt).toBeLessThan(firstRevoke);
  });

  it("gh secret set fails → reports its exit code, does not revoke", async () => {
    const f = fake({ secretExit: 1, secretStderr: "HTTP 403" });
    const out = await runRotation(f, { apply: true, repo: REPO });
    expect(out).toEqual({ status: "secret-failed", exitCode: 1, reason: "HTTP 403" });
    expect(f.revokeCalls).toEqual([]);
  });

  it("a revoke failure is reported with the fallback SQL, after the secret is set", async () => {
    const f = fake({ failRevokeOn: "carla@dim.test" });
    const out = await runRotation(f, { apply: true, repo: REPO });
    expect(out).toEqual({ status: "revoke-failed", failed: ["carla@dim.test"] });
    expect(f.secretCalls).toHaveLength(1);
    expect(f.logs.join("\n")).toContain("delete from auth.sessions");
  });
});

describe("runRotation — the password never reaches a log", () => {
  it.each([
    ["success", {}],
    [
      "rotation failure echoing the password",
      { failPasswordOn: "vet@dim.test", failPasswordMessage: `bad ${PASSWORD}` },
    ],
    ["gh failure echoing the password", { secretExit: 1, secretStderr: `rejected ${PASSWORD}` }],
    ["revoke failure", { failRevokeOn: "owner@dim.test" }],
  ] as const)("%s", async (_label, over) => {
    const f = fake(over);
    await runRotation(f, { apply: true, repo: REPO });
    expect(f.logs.length).toBeGreaterThan(0);
    for (const line of f.logs) expect(line).not.toContain(PASSWORD);
  });

  it("scrub redacts every occurrence", () => {
    expect(scrub(`a ${PASSWORD} b ${PASSWORD}`, PASSWORD)).toBe("a [redacted] b [redacted]");
    expect(scrub("nothing", "")).toBe("nothing");
  });
});

describe("parseCliArgs", () => {
  it("requires --repo", () => {
    expect(parseCliArgs(["--apply"])).toHaveProperty("error");
    expect(parseCliArgs([])).toHaveProperty("error");
  });

  it("accepts both --repo forms and defaults to dry run", () => {
    expect(parseCliArgs(["--repo", "a/b"])).toEqual({ apply: false, repo: "a/b" });
    expect(parseCliArgs(["--repo=a/b", "--apply"])).toEqual({ apply: true, repo: "a/b" });
  });

  it.each([["--repo", "not-a-repo"], ["--repo", "a/b; rm -rf /"], ["--bogus"]])(
    "rejects %s %s",
    (...argv) => {
      expect(parseCliArgs(argv)).toHaveProperty("error");
    },
  );
});

describe("staging-only target", () => {
  it("reads the project ref from the API url", () => {
    expect(projectRefFromSupabaseUrl(`https://${STAGING_PROJECT_REF}.supabase.co`)).toBe(
      STAGING_PROJECT_REF,
    );
    expect(projectRefFromSupabaseUrl("http://127.0.0.1:54321")).toBeNull();
    expect(projectRefFromSupabaseUrl(`http://${STAGING_PROJECT_REF}.supabase.co`)).toBeNull();
    expect(
      projectRefFromSupabaseUrl(`https://${STAGING_PROJECT_REF}.supabase.co.evil.example`),
    ).toBeNull();
  });

  it("accepts staging and refuses everything else", () => {
    expect(stagingTargetProblem(`https://${STAGING_PROJECT_REF}.supabase.co`)).toBeNull();
    expect(stagingTargetProblem("https://abcdefghijklmnopqrst.supabase.co")).toMatch(/not staging/);
    expect(stagingTargetProblem("http://127.0.0.1:54321")).not.toBeNull();
    expect(stagingTargetProblem("")).not.toBeNull();
  });
});

describe("revokeSessionsSql", () => {
  it("names the accounts and quotes them", () => {
    expect(revokeSessionsSql(["a@dim.test", "o'b@dim.test"])).toBe(
      "delete from auth.sessions where user_id in (select id from auth.users where email in ('a@dim.test', 'o''b@dim.test'));",
    );
  });
});
