// Parity fence for the conventions canon.
//
// `docs/architecture/conventions-canon.json` is the source of truth: 512 rules
// harvested from the repo's own prose, each classified against the enforcer that
// can actually FAIL when the rule is broken. `pnpm canon:render` turns it into
// `docs/architecture/conventions-canon.md` (index) plus one page per scope under
// `docs/architecture/conventions-canon/`.
//
// This file pins the four things that make that canon worth reading:
//
//   (a) The markdown is a RENDER, byte for byte. The renderer is re-run
//       in-process and every file it emits must equal the file committed at that
//       path — the index and all seven scope pages. Not "the same ids with the
//       same status": the same BYTES. A hand edit ANYWHERE in a rendered file
//       turns this red — a reworded Rule, a softened Basis, an invented Source
//       quote, a paragraph added to the index prose. The previous version of
//       this fence re-parsed the tables and compared three of the six columns,
//       which left Rule, Source, Basis and the whole of the index editable in
//       silence: a canon whose verdicts are pinned and whose RULE TEXT is not
//       can be made to say anything.
//   (b) Every enforcer path the canon cites EXISTS, and is a FILE. A canon that
//       cites a file deleted three refactors ago is worse than no canon: it
//       reads as evidence and is not. Three citations were already stale when
//       this fence was first run (two `lib/domain/opened-reason-*.ts` paths that
//       moved to `src/modules/cases/domain/`, one citation that packed a symbol
//       name into its `:line` suffix) — that is the failure mode, and it is not
//       theoretical. A directory passes `existsSync` and enforces nothing, so
//       the check is `isFile`, not "something is there".
//   (c) The census covers what its inputs can see, and states which those are:
//       every `lint:*` key in `package.json`, every `scripts/check-*.{ts,mjs}`,
//       every `__tests__/**` test whose FILENAME carries fence, parity or
//       coverage, and the files listed in `EXTRA_FENCES` — enforcement the
//       filename glob cannot see, which would otherwise be neither cited, nor
//       unmapped, nor even detected as missing. Each is either cited by a row or
//       listed in the JSON's `unmapped` array. That array's length is pinned
//       EXACTLY: growing it and shrinking it are both deliberate edits here.
//       Machinery outside those four inputs is outside the census, and this
//       fence does not claim otherwise.
//   (d) Row ids are unique and sorted, so a diff of the JSON reads as a diff of
//       the canon rather than as a reshuffle.
//
// DB-less by construction: it reads the repo, nothing else.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CANON_INDEX,
  CANON_SCOPE_DIR,
  type Canon,
  FACTS_JSON,
  REPO_ROOT,
  enforcerLines,
  enforcerPath,
  factsGeneratedAt,
  loadCanon,
  renderCanon,
} from "@/scripts/conventions-canon-render";

const canon: Canon = loadCanon(REPO_ROOT);

// The `unmapped` length, pinned EXACTLY. Measured at d7dbf25f7 against the whole
// census below, plus three entries for fences that postdate that snapshot: the
// facts fence, and the two dead-domain fences of 2026-09-07 —
// __tests__/contact-email-domain-fence.test.tsx, which lands with
// lib/ui/contact.ts, and __tests__/public-hostname-fence.test.ts, which lands
// with the owned-domain registry in lib/infra/site-url.ts. None can be cited
// from a row without that row claiming `verifiedAt: d7dbf25f7` for prose that
// did not exist yet. A ceiling would let the list grow up to it in silence; a
// floor would let it be emptied. Both directions are a hand edit, and both are
// reviewable.
//
// 5 -> 6 on 2026-09-11, and this is the hand edit the paragraph above asks for.
// The sixth is `__tests__/state-endorsement-fence.test.ts`: no citizen-facing
// file may name an Argentine state body as if it backed, operated or issued
// miMAR. It joins the list for the same reason as the others - the rule was
// never written in prose, so no row can cite a source for it without inventing
// one. It came out of a live finding, not a hypothetical: the landing hero
// carried "Republica Argentina - Ministerio de Salud" above the H1, and the
// phone credential printed it in a slot whose style key is `footAuthority`, on
// the screen its own header calls the thing a funcionario is asked to accept as
// identification. No convenio exists.
//
// 6 -> 7 on 2026-09-11, later the same day, and this one is different from the
// six above in a way worth stating: its rule IS written in prose. CLAUDE.md's
// fourth red signature says it in one sentence - no assertion may compare a
// clock read on the host against a column with `defaultNow()`. What was missing
// was never the prose, it was the enforcement, and the cure
// (`__tests__/_helpers/db-now.ts`) had exactly two importers on the day
// `__tests__/db-clock-window-fence.test.ts` landed.
//
// It joins the list anyway, and for the same mechanical reason as the rest: the
// sentence lives in CLAUDE.md, which the d7dbf25f7 canon snapshot does not
// harvest, so no row can cite a source for it without claiming a `verifiedAt`
// for a document the extraction never read. That is a limit of where the canon
// looks, not a judgement about the rule.
//
// 7 -> 8 on 2026-09-18: `__tests__/gob-synthetic-exclusion-fence.test.ts`
// (pilot item T1-P1). Its rule - no seed-tagged row reaches a govt or national
// reader of /gob - is written in the pilot plan (decision D3; private companion
// repo, dim-interno:docs/handoff/rumbo-al-piloto.md),
// which the d7dbf25f7 snapshot does not harvest, so it joins the list for the
// same mechanical reason as the clock fence above.
//
// 8 -> 9 on 2026-09-25: `__tests__/lost-routing-web-mobile-parity.test.ts`
// (stage A of the SDD change localidades-por-id). Its rule — web and app route
// a lost report to the same authority — gets its canon row with the change's
// stage E; until then it waits here, on purpose.
//
// 9 -> 13 on 2026-09-25: `scripts/check-place-resolver-single-entry.ts`,
// `scripts/check-province-map-single-source.ts` and their `lint:place-resolver`
// / `lint:province-map` keys (stage B of the same change). Same reason: their
// canon rows land with stage E.
//
// 13 -> 14 on 2026-09-26: `__tests__/schema-check-parity.test.ts` (stage C
// review of the same change): every live CHECK on the place and authority
// tables is declared in db/schema.ts, because db:bootstrap pushes it before
// replaying migrations. Same reason: its canon row lands with stage E.
const UNMAPPED_COUNT = 14;

/**
 * Enforcement the filename glob below cannot see.
 *
 * The census globs `__tests__/**` for names carrying fence / parity / coverage.
 * `__tests__/architecture-facts.test.ts` is a fence by every measure that
 * matters — it is the doc-drift fence for every number the architecture docs
 * state — and carries none of those three words, so before this list existed it
 * was neither cited by a row, nor listed as unmapped, nor reported as escaping.
 * A census blind to its own sibling is the exact shape of the rot it exists to
 * catch. Add a path here when a fence's NAME hides it.
 */
const EXTRA_FENCES = ["__tests__/architecture-facts.test.ts"];

/** Read a committed doc, LF-normalised: `.gitattributes` sets `* text=auto eol=lf`. */
const readDoc = (rel: string): string =>
  readFileSync(join(REPO_ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** Where two texts first diverge, for a failure message a human can act on. */
function firstDivergence(actual: string, expected: string): string {
  const a = actual.split("\n");
  const b = expected.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    return (
      ` first difference at line ${i + 1}:\n` +
      `  on disk: ${JSON.stringify(a[i] ?? "<end of file>").slice(0, 240)}\n` +
      `  rendered: ${JSON.stringify(b[i] ?? "<end of file>").slice(0, 240)}`
    );
  }
  return "";
}

// ---------------------------------------------------------------------------
// Census inputs
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

const lintKeys = Object.keys(pkg.scripts)
  .filter((k) => k.startsWith("lint:"))
  .sort();

const checkScripts = readdirSync(join(REPO_ROOT, "scripts"))
  .filter((n) => /^check-.*\.(ts|mjs)$/.test(n))
  .map((n) => `scripts/${n}`)
  .sort();

/** `__tests__/**` files whose name carries fence / parity / coverage, plus the extras. */
function fenceTests(): string[] {
  const acc = new Set<string>(EXTRA_FENCES);
  const walk = (rel: string): void => {
    for (const ent of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${ent.name}`;
      if (ent.isDirectory()) walk(child);
      else if (/\.test\.tsx?$/.test(ent.name) && /(fence|parity|coverage)/i.test(ent.name))
        acc.add(child);
    }
  };
  walk("__tests__");
  return [...acc].sort();
}

/** Every repo path cited by any row's `enforcer`. */
const citedPaths = new Set(
  canon.rows.flatMap((r) => (r.enforcer ?? []).map((e) => enforcerPath(e))),
);

/**
 * `lint:*` keys cited by name, as WHOLE TOKENS.
 *
 * A substring test answers yes for `lint:authz` the moment any row cites
 * `lint:authz-scoping`, and the key that actually escaped the canon is then
 * reported as mapped. Tokenise, then compare exactly.
 */
const citedLintKeys = new Set(
  canon.rows.flatMap((r) => r.enforcer ?? []).flatMap((entry) => entry.match(/lint:[\w-]+/g) ?? []),
);

const unmappedIds = new Set(canon.unmapped.map((u) => u.id));

/** The `scripts/*.ts|mjs` a `lint:*` key runs, when it runs one. */
function lintScriptPath(key: string): string | null {
  return /(scripts\/[\w.-]+\.(?:ts|mjs))/.exec(pkg.scripts[key])?.[1] ?? null;
}

// ---------------------------------------------------------------------------

describe("conventions canon — JSON is the source of truth", () => {
  it("(d) row ids are unique and sorted", () => {
    const ids = canon.rows.map((r) => r.id);
    expect(new Set(ids).size, "duplicate row id in conventions-canon.json").toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
  });

  it("row count matches the stats block and the totals rendered in the index", () => {
    expect(canon.stats.rows).toBe(canon.rows.length);
    const byStatus: Record<string, number> = {};
    for (const r of canon.rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    expect(canon.stats.byStatus).toEqual(byStatus);

    const index = readDoc(CANON_INDEX);
    const fact = (key: string): number => {
      const m = new RegExp(`<!-- fact:${key} -->(\\d+)<!-- /fact -->`).exec(index);
      expect(m, `${CANON_INDEX} is missing the fact:${key} marker`).not.toBeNull();
      return Number((m as RegExpExecArray)[1]);
    };
    expect(fact("canon_rows")).toBe(canon.rows.length);
    expect(fact("canon_enforced")).toBe(byStatus.ENFORCED ?? 0);
    expect(fact("canon_partial")).toBe(byStatus.PARTIAL ?? 0);
    expect(fact("canon_unenforced")).toBe(byStatus.UNENFORCED ?? 0);
  });
});

describe("conventions canon — the markdown is a faithful render", () => {
  const rendered = renderCanon(canon);

  it("(a) every rendered file is byte-identical to the file committed at its path", () => {
    for (const [rel, expected] of rendered) {
      const actual = readDoc(rel);
      expect(
        actual,
        `${rel} is not what the renderer produces — hand edits do not survive here. Change` +
          ` docs/architecture/conventions-canon.json and run \`pnpm canon:render\`.${firstDivergence(actual, expected)}`,
      ).toEqual(expected);
    }
  });

  it("(a) the render covers the index and one page per scope, and nothing else", () => {
    const scopes = [...new Set(canon.rows.map((r) => r.scope))].sort();
    expect([...rendered.keys()].sort()).toEqual(
      [CANON_INDEX, ...scopes.map((s) => `${CANON_SCOPE_DIR}/${s}.md`)].sort(),
    );
    // An orphan page left behind by a removed scope is invisible to byte
    // equality: nothing renders it, so nothing compares it.
    const onDisk = readdirSync(join(REPO_ROOT, CANON_SCOPE_DIR))
      .filter((n) => n.endsWith(".md"))
      .sort();
    expect(onDisk, `${CANON_SCOPE_DIR} holds a page no scope renders`).toEqual(
      scopes.map((s) => `${s}.md`),
    );
  });

  it("(a) the index links to every scope page", () => {
    const index = readDoc(CANON_INDEX);
    for (const scope of new Set(canon.rows.map((r) => r.scope))) {
      expect(index, `${CANON_INDEX} does not link to the ${scope} page`).toContain(
        `./conventions-canon/${scope}.md`,
      );
    }
  });

  it("(a) every scope page carries the header block and the canon columns", () => {
    for (const scope of new Set(canon.rows.map((r) => r.scope))) {
      const rel = `${CANON_SCOPE_DIR}/${scope}.md`;
      const text = readDoc(rel);
      expect(text, `${rel} lost the snapshot header`).toContain(`> Snapshot: \`${canon.sha}\``);
      expect(text, `${rel} lost the canon table columns`).toContain(
        "| Id | Rule | Source | Status | Enforcer | Basis |",
      );
    }
  });

  it("(a) the header states the date facts.json was generated, not one the render invented", () => {
    const generatedAt = (
      JSON.parse(readFileSync(join(REPO_ROOT, FACTS_JSON), "utf8")) as { generatedAt: string }
    ).generatedAt;
    expect(factsGeneratedAt(REPO_ROOT)).toBe(generatedAt);
    for (const rel of rendered.keys()) {
      expect(readDoc(rel), `${rel} states a header date that is not facts.json's`).toContain(
        `\`${FACTS_JSON}\` generated ${generatedAt}`,
      );
    }
  });
});

describe("conventions canon — the evidence resolves", () => {
  it("(b) every cited enforcer path is a file on disk", () => {
    const dangling: string[] = [];
    for (const row of canon.rows) {
      for (const entry of row.enforcer ?? []) {
        const path = enforcerPath(entry);
        if (!path) continue;
        // A directory satisfies `existsSync` and enforces nothing: `scripts/`
        // exists, and "the rule is enforced by `scripts/`" is not a citation.
        let isFile = false;
        try {
          isFile = statSync(join(REPO_ROOT, path)).isFile();
        } catch {
          isFile = false;
        }
        if (!isFile) dangling.push(`${row.id}: ${entry}`);
      }
    }
    expect(dangling, "canon rows cite enforcer paths that are not files on disk").toEqual([]);
  });

  it("(b) an enforcer citation pinned to ONE line points at code, not at a comment", () => {
    // THE DEFECT CLASS THIS CATCHES is the canon's own version of a green
    // check that measured nothing: a row whose `enforcer` cites the paragraph
    // in the fence's header that DESCRIBES the rule, rather than the line that
    // fails when the rule is broken. It reads as evidence, it survives review
    // because the path is real and the file is a fence, and it is satisfied by
    // prose. CANON-527 cited scripts/check-mobile-icon-vocabulary.ts:29 and
    // :35 — two bullet points in a comment block — which is how this was
    // found. `sources` is exempt on purpose: a source citation is SUPPOSED to
    // point at the prose that states the rule.
    //
    // Scoped to single-line citations. A range (`:1-25`, `:1,183-207`) names a
    // region whose first line is routinely the file's header comment, and
    // demanding otherwise would fail rows whose evidence is honest.
    const RANGE_FREE = /^\d+$/;
    const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;
    const violations: string[] = [];
    let checked = 0;
    for (const row of canon.rows) {
      for (const entry of row.enforcer ?? []) {
        const lines = enforcerLines(entry);
        if (!RANGE_FREE.test(lines)) continue;
        const path = enforcerPath(entry);
        let source: string;
        try {
          source = readFileSync(join(REPO_ROOT, path), "utf8");
        } catch {
          continue; // the (b) test above owns "the path resolves"
        }
        const sourceLines = source.split("\n");
        const line = sourceLines[Number(lines) - 1];
        checked += 1;
        // A line number past the end of the file is not "nothing to check" —
        // it is a citation pointing at code that does not exist, which rule
        // (b) exists to catch. Silently skipping it let `enforcer:
        // "scripts/foo.ts:9999"` pass this test forever.
        if (line === undefined) {
          violations.push(
            `${row.id}: ${entry} → cites line ${lines} but the file has ${sourceLines.length} lines`,
          );
          continue;
        }
        if (COMMENT_LINE.test(line)) violations.push(`${row.id}: ${entry} → ${line.trim()}`);
      }
    }
    // Non-vacuity: a change to the citation format that made every entry a
    // range would empty the loop and pass. Say what was actually read.
    expect(checked, "no single-line enforcer citation was examined").toBeGreaterThan(20);
    expect(
      violations,
      "canon rows cite a COMMENT line, or a line past the end of the file, as the enforcer",
    ).toEqual([]);
  });

  it("(b) every `source` path that looks like a repo path exists on disk", () => {
    const REPO_PATH =
      /^(app|lib|src|db|scripts|packages|apps|components|__tests__|\.github|docs|e2e)\//;
    const dangling: string[] = [];
    for (const row of canon.rows) {
      for (const entry of row.sources ?? []) {
        const path = enforcerPath(entry);
        if (!REPO_PATH.test(path)) continue;
        let exists = false;
        try {
          statSync(join(REPO_ROOT, path));
          exists = true;
        } catch {
          exists = false;
        }
        if (!exists) dangling.push(`${row.id}: ${entry}`);
      }
    }
    expect(dangling, "canon rows cite source paths that do not exist").toEqual([]);
  });
});

describe("conventions canon — nothing in the census escapes it", () => {
  it("(c) every lint:* key is cited by a row or listed as unmapped", () => {
    const escaped = lintKeys.filter((key) => {
      if (citedLintKeys.has(key)) return false;
      const path = lintScriptPath(key);
      if (path && citedPaths.has(path)) return false;
      return !unmappedIds.has(key);
    });
    expect(escaped, "lint:* keys neither cited by a canon row nor listed in `unmapped`").toEqual(
      [],
    );
  });

  it("(c) every scripts/check-*.{ts,mjs} is cited by a row or listed as unmapped", () => {
    const escaped = checkScripts.filter((p) => !citedPaths.has(p) && !unmappedIds.has(p));
    expect(escaped, "check scripts neither cited by a canon row nor listed in `unmapped`").toEqual(
      [],
    );
  });

  it("(c) every fence/parity/coverage test and every EXTRA_FENCES entry is cited or unmapped", () => {
    const census = fenceTests();
    for (const extra of EXTRA_FENCES) {
      expect(census, `${extra} is listed in EXTRA_FENCES but the census dropped it`).toContain(
        extra,
      );
    }
    const escaped = census.filter((p) => !citedPaths.has(p) && !unmappedIds.has(p));
    expect(escaped, "fence tests neither cited by a canon row nor listed in `unmapped`").toEqual(
      [],
    );
  });

  it("(c) the unmapped list is exactly as long as it was pinned", () => {
    expect(
      canon.unmapped.length,
      `unmapped is pinned at ${UNMAPPED_COUNT}. It grew when new machinery escaped the canon (cite it from a row instead) or shrank when a row learned to cite one. Either way, change this number on purpose.`,
    ).toBe(UNMAPPED_COUNT);
  });

  it("(c) every unmapped entry still exists in the tree", () => {
    const stale = canon.unmapped.filter((u) => {
      if (!u.path) return false;
      try {
        statSync(join(REPO_ROOT, u.path));
        return false;
      } catch {
        return true;
      }
    });
    expect(
      stale.map((u) => u.id),
      "`unmapped` lists machinery that no longer exists",
    ).toEqual([]);
  });
});
