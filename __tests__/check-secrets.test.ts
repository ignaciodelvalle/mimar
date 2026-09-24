// Offline guard for the secret-scanning fence (scripts/check-secrets.ts, L-24).
//
// THE NON-VACUITY FLOOR. A secret scanner that matches nothing passes on every
// repo, including one full of credentials, and nothing about a green run says
// which of the two you have. So every kind the fence declares must FIRE on a
// synthetic sample here, and every exemption (the local demo values, the
// placeholders, the config/docs scope) must be shown not to swallow a near-miss
// that differs from it by one detail.
//
// Every synthetic secret below is ASSEMBLED AT RUNTIME from fragments (`cat`),
// so this file never contains a match itself — the last test proves it by
// scanning this file and the fence with the fence.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ALLOWLIST,
  DEMO_PASSWORD,
  LOCAL_DEMO_JWT_ISSUER,
  LOCAL_DEMO_SECRET_KEY,
  SECRET_KINDS,
  type SecretKind,
  applyAllowlist,
  findSecrets,
  isConfigOrDoc,
  isPlaceholder,
} from "@/scripts/check-secrets";

const cat = (...parts: string[]) => parts.join("");

function jwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return [enc({ alg: "HS256", typ: "JWT" }), enc(payload), "c2lnbmF0dXJlLW5vdC1jaGVja2Vk"].join(
    ".",
  );
}

function kinds(path: string, text: string): SecretKind[] {
  return findSecrets(path, text).map((f) => f.kind);
}

/** One synthetic sample per kind, with the path it is scanned under. */
const SAMPLES: Record<SecretKind, { path: string; text: string }> = {
  postgres_url_password: {
    path: "lib/x.ts",
    text: cat('const url = "postgresql://', "app_user:Zq8", 'vT2mLp@db.example.org:5432/app";'),
  },
  service_role_jwt: {
    path: "lib/x.ts",
    text: `key = "${jwt({ iss: "supabase", ref: "abcdefghijkl", role: "service_role" })}"`,
  },
  supabase_secret_key: {
    path: "lib/x.ts",
    text: cat("KEY=", "sb_secret_", "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8"),
  },
  stripe_live_key: {
    path: "lib/x.ts",
    text: cat("token: ", "sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"),
  },
  resend_api_key: {
    path: "lib/x.ts",
    text: cat("RESEND=", "re_", "123abcDE", "_", "9fKq2LmNpR7sT4vWxY"),
  },
  aws_access_key_id: { path: "lib/x.ts", text: cat("aws = ", "AKIA", "IOSFODNN7EXAMPLE") },
  private_key_block: { path: "keys/id.txt", text: cat("-----BEGIN ", "RSA PRIVATE KEY", "-----") },
  password_assignment: {
    path: "config/app.yml",
    text: cat("password", ': "', "Sup3rS3cret!", '"'),
  },
  env_secret_assignment: {
    path: ".env.example",
    text: cat("CRON_", "SECRET=", "9f3a1c7e", "b2d44e6f", "8a0b1c2d3e4f5a6b"),
  },
  demo_password: { path: "docs/runbook.md", text: `Log in with ${DEMO_PASSWORD}` },
};

describe("non-vacuity floor — every declared kind fires on a synthetic sample", () => {
  it("has a sample for every kind (a new kind without one fails here)", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...SECRET_KINDS].sort());
  });

  for (const kind of SECRET_KINDS) {
    it(`${kind} fires`, () => {
      const { path, text } = SAMPLES[kind];
      expect(kinds(path, text)).toContain(kind);
    });
  }

  it("reports the line number and never the secret itself", () => {
    const text = ["line one", SAMPLES.stripe_live_key.text].join("\n");
    const [f] = findSecrets("lib/x.ts", text);
    expect(f.line).toBe(2);
    expect(f.preview).not.toContain("4eC39HqLyjWDarjtT1zdp7dc");
  });
});

describe("postgres_url_password — the local demo exemption is exact", () => {
  const url = (user: string, pw: string, host: string) =>
    cat("postgresql://", user, ":", pw, "@", host, ":54322/postgres");

  it("exempts postgres:postgres on a loopback host", () => {
    expect(kinds("x.ts", url("postgres", "postgres", "127.0.0.1"))).toEqual([]);
    expect(kinds("x.ts", url("postgres", "postgres", "localhost"))).toEqual([]);
  });

  it("flags the demo password on a REMOTE host", () => {
    expect(kinds("x.ts", url("postgres", "postgres", "db.abcdefg.supabase.co"))).toEqual([
      "postgres_url_password",
    ]);
  });

  it("flags a non-demo password on a loopback host", () => {
    expect(kinds("x.ts", url("postgres", "n0tTheDemo", "127.0.0.1"))).toEqual([
      "postgres_url_password",
    ]);
  });

  it("flags a non-demo user with the demo password", () => {
    expect(kinds("x.ts", url("admin", "postgres", "localhost"))).toEqual(["postgres_url_password"]);
  });

  it("skips placeholders in the password slot", () => {
    for (const pw of ["[YOUR-PASSWORD]", "<password>", "${PGPASSWORD}", "PASSWORD", "***", "p"]) {
      expect(kinds("x.ts", url("postgres", pw, "db.example.org"))).toEqual([]);
    }
  });
});

describe("service_role_jwt — only a non-demo service_role key", () => {
  it("exempts the local stack's demo service_role key", () => {
    const demo = jwt({ iss: LOCAL_DEMO_JWT_ISSUER, role: "service_role", exp: 1983812996 });
    expect(kinds("x.ts", demo)).toEqual([]);
  });

  it("does not flag an anon key (public by design)", () => {
    expect(kinds("x.ts", jwt({ iss: "supabase", role: "anon" }))).toEqual([]);
  });

  it("flags a service_role key from any other issuer", () => {
    expect(kinds("x.ts", jwt({ iss: "supabase-demo-not", role: "service_role" }))).toEqual([
      "service_role_jwt",
    ]);
  });
});

describe("supabase_secret_key — only the local demo value is exempt", () => {
  it("exempts the local CLI key", () => {
    expect(kinds("x.ts", `KEY=${LOCAL_DEMO_SECRET_KEY}`)).toEqual([]);
  });

  it("flags the demo key with one character changed", () => {
    const near = `${LOCAL_DEMO_SECRET_KEY.slice(0, -1)}Q`;
    expect(kinds("x.ts", `KEY=${near}`)).toEqual(["supabase_secret_key"]);
  });
});

describe("resend_api_key — random tail required", () => {
  it("does not flag a snake_case identifier that starts with re_", () => {
    // Shape-matches the pattern (8-char id, 16+ tail) but the tail is not random.
    expect(kinds("x.ts", cat("re_", "download", "_", "attachmentsforreport"))).toEqual([]);
  });
});

describe("password_assignment — config and docs only, placeholders skipped", () => {
  const line = cat("password", ' = "', "Sup3rS3cret!", '"');

  it("fires in config and docs", () => {
    for (const path of ["a.md", "a.yml", "a.yaml", "a.toml", "a.json", ".env.example", "x/.env"]) {
      expect(kinds(path, line), path).toContain("password_assignment");
    }
  });

  it("does not fire in source, where the shape is form-field plumbing", () => {
    expect(isConfigOrDoc("lib/x.ts")).toBe(false);
    expect(kinds("lib/x.ts", line)).toEqual([]);
  });

  it("skips placeholder values", () => {
    for (const v of ["<password>", "${DB_PASSWORD}", "DB_PASSWORD", "changeme", "hunter2"]) {
      expect(kinds("a.yml", cat('password: "', v, '"')), v).toEqual([]);
    }
    expect(kinds("supabase/config.toml", cat('secret = "', "env(SOME_SECRET)", '"'))).toEqual([]);
  });

  it("reports the demo password once, under its own kind", () => {
    expect(kinds("a.md", cat('password: "', DEMO_PASSWORD, '"'))).toEqual(["demo_password"]);
  });
});

describe("env_secret_assignment — env-var names, quoted or bare, high-entropy values only", () => {
  // Every value assembled at runtime so this file never matches itself.
  const HEX = cat("9f3a1c7e", "b2d44e6f", "8a0b1c2d3e4f5a6b");
  const B64 = cat("Zq8vT2mL", "pX4nR7sK", "w1Yb");

  it("fires on bare YAML, bare .env, quoted, and exported assignments", () => {
    const cases: [string, string][] = [
      [".github/workflows/x.yml", cat("      CRON_", "SECRET: ", HEX)],
      [".env.example", cat("RESEND_", "API_KEY=", B64)],
      ["docs/ops/runbook.md", cat("export VERCEL_", 'TOKEN="', B64, '"')],
      ["config/app.toml", cat("SMTP_", "PASSWORD = '", B64, "'")],
      ["a.json", cat('"WEBHOOK_', 'SECRET": "', HEX, '"')],
    ];
    for (const [path, line] of cases) {
      expect(kinds(path, line), `${path}: ${line.slice(0, 14)}`).toEqual(["env_secret_assignment"]);
    }
  });

  it("does not fire in source (same scope rule as password_assignment)", () => {
    expect(kinds("lib/x.ts", cat("CRON_", "SECRET=", HEX))).toEqual([]);
  });

  it("requires the credential word at the END of the name", () => {
    expect(kinds("a.env", cat("SECRET_", "PATH=", HEX))).toEqual([]);
    expect(kinds("a.env", cat("TOKEN_", "SALT_FILE=", B64))).toEqual([]);
  });

  it("skips placeholders, low-entropy labels and short values", () => {
    for (const v of [
      "${{ secrets.CRON_SECRET }}",
      "<your-token>",
      "test-cron-secret-value",
      "a1b2c3d4",
      "CRON_SECRET_VALUE_GOES_HERE",
      "****************",
    ]) {
      expect(kinds("a.yml", cat("CRON_", "SECRET: ", v)), v).toEqual([]);
    }
  });

  it("leaves URLs and JWTs to the kinds that understand them", () => {
    expect(kinds("a.yml", cat("AUTH_", "TOKEN: https://example.org/", HEX))).toEqual([]);
    const anon = jwt({ iss: "supabase", role: "anon" });
    expect(kinds("a.yml", cat("ANON_", "TOKEN: ", anon))).toEqual([]);
  });

  it('reports DB_PASSWORD="…" once, under password_assignment', () => {
    expect(kinds("a.env", cat("DB_", 'PASSWORD="', B64, '"'))).toEqual(["password_assignment"]);
  });
});

describe("isPlaceholder", () => {
  it("accepts a real-looking value as NOT a placeholder", () => {
    expect(isPlaceholder("Zq8vT2mLp")).toBe(false);
  });
});

describe("allowlist", () => {
  const f = (kind: SecretKind) => ({ line: 1, kind, preview: "x" });

  it("an exact entry covers only that path and that kind", () => {
    const list = [{ path: "a/b.ts", kind: "demo_password" as const, reason: "r" }];
    const r = applyAllowlist(
      [
        { path: "a/b.ts", findings: [f("demo_password"), f("stripe_live_key")] },
        { path: "a/b.tsx", findings: [f("demo_password")] },
      ],
      list,
    );
    expect(r.allowlisted).toBe(1);
    expect(r.findings.map((x) => `${x.path}:${x.finding.kind}`)).toEqual([
      "a/b.ts:stripe_live_key",
      "a/b.tsx:demo_password",
    ]);
  });

  it("a prefix entry covers the family", () => {
    const list = [{ path: "e2e/", prefix: true, kind: "demo_password" as const, reason: "r" }];
    const r = applyAllowlist([{ path: "e2e/x/y.ts", findings: [f("demo_password")] }], list);
    expect(r.findings).toEqual([]);
  });

  it("reports an entry that matched nothing as stale", () => {
    const list = [{ path: "gone.ts", kind: "demo_password" as const, reason: "r" }];
    expect(applyAllowlist([], list).unusedEntries).toEqual(list);
  });

  it("every real entry names a declared kind and carries a reason", () => {
    for (const e of ALLOWLIST) {
      expect(SECRET_KINDS).toContain(e.kind);
      expect(e.reason.trim().length, e.path).toBeGreaterThan(20);
    }
  });

  it("no entry allowlists prose: docs never carry the demo password", () => {
    for (const e of ALLOWLIST) {
      expect(e.path.startsWith("docs/"), e.path).toBe(false);
    }
  });
});

describe("self-scan", () => {
  it("the fence and this test contain nothing the fence would report", () => {
    for (const path of ["scripts/check-secrets.ts", "__tests__/check-secrets.test.ts"]) {
      expect(findSecrets(path, readFileSync(path, "utf8")), path).toEqual([]);
    }
  });
});
