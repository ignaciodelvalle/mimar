// Offline guard for the public/private boundary fence
// (scripts/check-public-boundary.ts; policy: docs/agents/public-private-boundary.md).
//
// RED CONTROLS. A boundary fence that matches nothing passes on every tree,
// including one full of handoffs and pasted logins, and a green run cannot
// tell the two apart. So every kind the fence declares must FIRE on a
// synthetic violation here, and every scoping decision (code vs documents,
// placeholders, local-stack defaults) must be shown not to swallow a
// near-miss one detail away from it.
//
// The personal mailboxes are known to the fence only by digest, so the red
// controls here use FAKE local parts whose digests are injected; the real
// ones appear nowhere in this repository. The credential samples are
// ASSEMBLED AT RUNTIME from fragments (`cat`), so this file never contains a
// match itself — the last test proves it by scanning this file and the fence
// with the fence.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BOUNDARY_KINDS,
  type BoundaryKind,
  EXCEPTIONS,
  PERSONAL_MAILBOXES,
  PUBLIC_DOC_CATEGORIES,
  type PersonalMailbox,
  envKeysWithValues,
  findContent,
  findPath,
  isPlaceholderValue,
  localPartDigest,
  looksLikePasswordLiteral,
  normalizeLocalPart,
  privatePathShape,
  scanBoundary,
} from "@/scripts/check-public-boundary";

const cat = (...parts: string[]) => parts.join("");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Stand-ins for the real mailboxes: fictional local parts, digests computed here. */
const FAKE_MAILBOXES: PersonalMailbox[] = [
  { kind: "maintainer_email", sha256: sha256("fixture.maintainer"), detail: "fake maintainer" },
  { kind: "test_gmail", sha256: sha256("fixture.tester"), detail: "fake tester" },
];

function kindsOf(path: string, src: string | null): BoundaryKind[] {
  return scanBoundary([{ path, src }], PUBLIC_DOC_CATEGORIES, [], FAKE_MAILBOXES).findings.map(
    (f) => f.kind,
  );
}

/** One synthetic violation per kind, with the path it is scanned under. */
const RED: Record<BoundaryKind, { path: string; src: string | null }> = {
  undeclared_doc_category: { path: "docs/deploy/cutover-checklist-v2.txt", src: null },
  private_path_shape: { path: "notes/handoff/siguiente-sesion.md", src: "" },
  maintainer_email: {
    path: "lib/contact.ts",
    src: 'const to = "Fixture.Maintainer+alertas@mail.example";',
  },
  test_gmail: {
    path: "e2e/x.spec.ts",
    src: "// signs up as fixture.tester@mail.example",
  },
  credential_pair: {
    path: "docs/ops/local-dev-runbook.md",
    src: cat("Log in as `admin@dim.test` / `", "Zq8vT", "2mLp!`"),
  },
  env_file_value: {
    path: "apps/mobile/.env.production",
    src: cat("EXPO_PUBLIC_API_URL=https://", "api.example.org", "\n"),
  },
};

describe("red controls — every declared kind fires on a synthetic violation", () => {
  it("has a red control for every kind (a new kind without one fails here)", () => {
    expect(Object.keys(RED).sort()).toEqual([...BOUNDARY_KINDS].sort());
  });

  it.each(BOUNDARY_KINDS.map((k) => [k]))("%s fires", (kind) => {
    const { path, src } = RED[kind];
    expect(kindsOf(path, src)).toContain(kind);
  });
});

describe("personal mailboxes — matched by digest, never by plaintext", () => {
  it("normalizes case and cuts a +alias before hashing", () => {
    expect(normalizeLocalPart("Fixture.Maintainer+alertas")).toBe("fixture.maintainer");
    expect(localPartDigest("FIXTURE.maintainer+x")).toBe(sha256("fixture.maintainer"));
  });

  it("the real list carries two well-formed digests and nothing else", () => {
    expect(PERSONAL_MAILBOXES.map((m) => m.kind).sort()).toEqual([
      "maintainer_email",
      "test_gmail",
    ]);
    for (const m of PERSONAL_MAILBOXES) expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a near-miss local part, or the local part without an @, stays green", () => {
    for (const line of [
      "write to fixture.maintainer2@mail.example",
      "fixture.maintainer is the handle",
      "x-fixture.tester@mail.example",
    ]) {
      expect(findContent("lib/x.ts", line, FAKE_MAILBOXES), line).toEqual([]);
    }
  });

  it("with the digest list empty nothing fires (the list is the only source)", () => {
    expect(findContent("lib/x.ts", "fixture.tester@mail.example", [])).toEqual([]);
  });
});

describe("docs are allowlisted, not denylisted", () => {
  it("a new top-level docs category is a finding until declared", () => {
    const f = findPath("docs/presentaciones-2026/deck.md", PUBLIC_DOC_CATEGORIES);
    expect(f.map((x) => x.kind)).toEqual(["undeclared_doc_category"]);
    expect(f[0].detail).toContain("docs/presentaciones-2026/");
  });

  it("a new file at docs/ root is a finding until declared by name", () => {
    expect(findPath("docs/notas-sueltas.md", PUBLIC_DOC_CATEGORIES).map((x) => x.kind)).toEqual([
      "undeclared_doc_category",
    ]);
  });

  it("docs/ops is declared file by file: a new ops runbook is a finding", () => {
    expect(
      findPath("docs/ops/deploy-playbook.md", PUBLIC_DOC_CATEGORIES).map((x) => x.kind),
    ).toEqual(["undeclared_doc_category"]);
    expect(findPath("docs/ops/local-dev-runbook.md", PUBLIC_DOC_CATEGORIES)).toEqual([]);
  });

  it("a declared directory covers its subtree", () => {
    expect(findPath("docs/superpowers/specs/archive/x.md", PUBLIC_DOC_CATEGORIES)).toEqual([]);
  });

  it("every category and exception carries a reason", () => {
    for (const c of PUBLIC_DOC_CATEGORIES) {
      expect(c.path.startsWith("docs/"), c.path).toBe(true);
      expect(c.reason.trim().length, c.path).toBeGreaterThan(10);
    }
    for (const e of EXCEPTIONS) {
      expect(BOUNDARY_KINDS).toContain(e.kind);
      expect(e.reason.trim().length, e.path).toBeGreaterThan(20);
    }
  });
});

describe("private path shapes — documents, not code", () => {
  it.each([
    "docs/reviews/2026-09-20-security.md",
    "reports/reviews/r8.json",
    "x/pilotos/municipio-a/acta.pdf",
    "x/outreach/municipios.csv",
    "x/presentation/deck.pptx",
    "db/cutover-2026-10.sql",
    "notes/2026-09-01-incident-login.md",
    "ops/storage-remediation.txt",
    "docs/superpowers/specs/2026-07-01-reviews-hardening-handoff.md",
    "docs/superpowers/plans/2026-06-23-CONSOLIDATED-demo-panorama-cc.md",
    "docs/superpowers/plans/2026-06-22-unified-cc-backlog.md",
    "notes/2026-06-24-frontend-critique.md",
    "notes/acta_piloto_municipio.pdf",
    "x/demo/guion.md",
    "x/pilots/municipio.csv",
    "x/backlog/items.txt",
    "x/critique/2026-06-23.md",
    "docs/x/2026-09-01-pitch-municipios.md",
    "notes/sell-sheet.pdf",
    "docs/x/guion_venta.md",
    "notes/ventas-q3.txt",
    "ops/cutover-notes.md",
  ])("flags %s", (path) => {
    expect(privatePathShape(path)).not.toBeNull();
  });

  it.each([
    "src/modules/cases/domain/lifecycles/bite-incident.ts",
    "src/modules/cases/domain/lifecycles/microchip-remediation.ts",
    "app/admin/reviews/page.tsx",
    "components/handoff/HandoffCard.tsx",
    "public/icons/incident.svg",
    "src/modules/decomiso/application/accept-decomiso-handoff.ts",
    "app/(app)/mis-mascotas/[publicToken]/anotar/handoff.ts",
    "e2e/demo/walkthrough.spec.ts",
    "e2e/demo/fixture.json",
    "docs/x/democracia.md",
    "docs/x/pilotaje-de-drones.md",
    "docs/x/ventanilla-unica.md",
    "docs/x/pitchfork.md",
    "scripts/ops/rotate-incident-password.ts",
    "scripts/ops/storage-remediation.ts",
    "db/migrations/0150_incident_remediation_log.sql",
    "db/migrations/0151_cutover-flags.sql",
  ])("spares code, assets and near-miss words: %s", (path) => {
    expect(privatePathShape(path)).toBeNull();
  });
});

describe("content — near misses stay green", () => {
  it("a role address is not a personal mailbox", () => {
    expect(findContent("README.md", "Contact: seguridad@example.org")).toEqual([]);
  });

  it("an email next to a placeholder or an env-var name is not a credential pair", () => {
    for (const line of [
      "Sign in as **`ignacio@dim.test` / `SHARED_PASSWORD`** — owner, 17 pets.",
      "owner@dim.test, password <password>",
      "owner@dim.test (password from SEED_DEMO_PASSWORD)",
      "the test DB only has `owner@dim.test`). Noted as an axe pass (requires seeding).",
    ]) {
      expect(findContent("docs/x.md", line), line).toEqual([]);
    }
  });

  it("credential pairs are a docs/config rule — source plumbing is check-secrets' job", () => {
    const line = cat("login('admin@dim.test', '", "Zq8vT", "2mLp!')");
    expect(findContent("lib/x.ts", line)).toEqual([]);
    expect(findContent("docs/x.md", line).map((f) => f.kind)).toEqual(["credential_pair"]);
  });

  it("looksLikePasswordLiteral rejects words, paths, brackets and placeholders", () => {
    for (const v of [
      "(requires",
      "reset-link",
      "scripts/seed.ts",
      "<password>",
      "SHARED_PASSWORD",
    ]) {
      expect(looksLikePasswordLiteral(v), v).toBe(false);
    }
    expect(looksLikePasswordLiteral(cat("Zq8vT", "2mLp"))).toBe(true);
  });

  // check-secrets' isPlaceholder calls anything CONTAINING `$ % < > [ ] { }` a
  // placeholder. Reused here it waved real passwords through; these are the
  // shapes that slipped.
  it.each([
    ["a $ inside the value", cat("Log in as `admin@dim.test` / `Zq8", "$", "vT2mLp`")],
    ["a % inside the value", cat("admin@dim.test password: Zq8", "%", "vT2mLp")],
    ["a { inside the value", cat("admin@dim.test / Zq8", "{", "vT2mLp")],
    ["a comma inside the value", cat("admin@dim.test contraseña: ab1", ",", "cd9;Qz")],
    ["a trailing paren", cat("(admin@dim.test, password Zq8vT", "2mLp)")],
  ])("RED: a credential pair with %s fires", (_, line) => {
    expect(findContent("docs/x.md", line).map((f) => f.kind)).toEqual(["credential_pair"]);
  });

  it("RED: the two-line form (e-mail, then a password line) fires on the password line", () => {
    const src = cat("- usuario: admin@dim.test\n", "- contraseña: Zq8", "$", "vT2mLp\n");
    const f = findContent("docs/x.md", src);
    expect(f.map((x) => [x.kind, x.line])).toEqual([["credential_pair", 2]]);
  });

  it("the two-line form stays quiet for a placeholder, and for code", () => {
    const placeholder = "- usuario: admin@dim.test\n- contraseña: `<password>`";
    expect(findContent("docs/x.md", placeholder)).toEqual([]);
    const src = cat("const u = 'admin@dim.test';\n", "const password = 'Zq8", "$", "vT2mLp';");
    expect(findContent("lib/x.ts", src)).toEqual([]);
  });

  it("isPlaceholderValue decides on the WHOLE value", () => {
    for (const v of [
      "<password>",
      "${SEED_PASSWORD}",
      "$SEED_PASSWORD",
      "%SEED_PASSWORD%",
      "env(SEED_PASSWORD)",
      "changeme",
      "your-password",
      "tu_contraseña",
      "xxxx",
      "********",
      "SEED_DEMO_PASSWORD",
      "process.env.SEED_PASSWORD",
      "",
    ]) {
      expect(isPlaceholderValue(v), v).toBe(true);
    }
    for (const v of [
      cat("Zq8", "$", "vT2mLp"),
      cat("Zq8", "%", "vT2mLp"),
      cat("<Zq8vT", "2mLp"),
      cat("Zq8vT", "2mLp}"),
      "hello-world",
    ]) {
      expect(isPlaceholderValue(v), v).toBe(false);
    }
  });
});

describe("env files — only an empty template may be tracked", () => {
  it("empty keys, placeholders, comments and local-stack defaults pass", () => {
    const src = [
      "# local stack",
      "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321",
      "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      "SUPABASE_SERVICE_ROLE_KEY=",
      'RESEND_API_KEY=""',
      "CRON_SECRET=<openssl rand -hex 32>",
    ].join("\n");
    expect(envKeysWithValues(src)).toEqual([]);
  });

  it("a remote URL or a literal value is a finding, named by key and line", () => {
    const src = cat(
      "A=\n",
      "SUPABASE_URL=https://",
      "abcdefghijkl.supabase.co",
      "\nB=",
      "hello-world",
    );
    expect(envKeysWithValues(src)).toEqual([
      { line: 2, key: "SUPABASE_URL" },
      { line: 3, key: "B" },
    ]);
  });

  it("only .env-named files are env files", () => {
    expect(findContent("docs/x.md", "FOO=bar-baz-qux")).toEqual([]);
    expect(findContent(".envrc", "FOO=bar")).toEqual([]);
  });
});

describe("non-vacuity — stale entries and an empty docs scan fail", () => {
  it("a category that matches nothing is reported stale", () => {
    const cats = [{ path: "docs/gone/", reason: "r" }];
    expect(scanBoundary([], cats, []).unusedCategories).toEqual(cats);
  });

  it("an exception that matches nothing is reported stale", () => {
    const ex = [{ path: "gone.md", kind: "private_path_shape" as const, reason: "r" }];
    expect(scanBoundary([], PUBLIC_DOC_CATEGORIES, ex).unusedExceptions).toEqual(ex);
  });

  it("counts the docs files it saw (the CLI fails on zero)", () => {
    const r = scanBoundary([{ path: "lib/x.ts", src: "" }], PUBLIC_DOC_CATEGORIES, []);
    expect(r.docsSeen).toBe(0);
  });

  it("an exception suppresses exactly its kind at its path", () => {
    const ex = [{ path: "docs/reviews/x.md", kind: "private_path_shape" as const, reason: "r" }];
    const cats = [{ path: "docs/reviews/", reason: "r" }];
    const r = scanBoundary([{ path: "docs/reviews/x.md", src: "" }], cats, ex);
    expect(r.findings).toEqual([]);
    expect(r.excepted).toBe(1);
  });

  it("an exception for one kind does not silence a second kind at the same path", () => {
    const ex = [{ path: "docs/reviews/x.md", kind: "private_path_shape" as const, reason: "r" }];
    const cats = [{ path: "docs/reviews/", reason: "r" }];
    const src = cat("Log in as admin@dim.test / Zq8vT", "2mLp!");
    const r = scanBoundary([{ path: "docs/reviews/x.md", src }], cats, ex);
    expect(r.excepted).toBe(1);
    expect(r.findings.map((f) => f.kind)).toEqual(["credential_pair"]);
  });
});

describe("self-scan", () => {
  it("the fence and this test contain nothing the fence would report", () => {
    for (const path of [
      "scripts/check-public-boundary.ts",
      "__tests__/check-public-boundary.test.ts",
    ]) {
      expect(findContent(path, readFileSync(path, "utf8")), path).toEqual([]);
    }
  });
});
